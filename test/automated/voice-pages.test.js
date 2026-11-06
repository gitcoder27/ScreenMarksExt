"use strict";
// The voice UI on extension pages: the popup's voice row and the options
// page's recording screen, loaded into the fake DOM with a fake microphone
// that "speaks" synthetic words through the real capture pipeline.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkflow, flush } = require("./workflow-helpers");
const { TAKES, createRandom, synthWord } = require("./voice-synth");

function installVoiceBrowser(work) {
  const channels = [];
  const posted = [];
  class FakeChannel {
    constructor() { channels.push(this); }
    postMessage(message) {
      posted.push(message);
      channels.filter((channel) => channel !== this && channel.onmessage)
        .forEach((channel) => channel.onmessage({ data: message }));
    }
  }
  const mic = { node: null, opened: 0, stopped: 0 };
  Object.assign(work.context, {
    BroadcastChannel: FakeChannel,
    performance,
    setInterval: () => 0,
    clearInterval() {},
    window: { close() { mic.windowClosed = true; } },
    navigator: {
      permissions: { query: async () => ({ state: "granted" }) },
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "default", label: "Default - External Microphone" },
          { kind: "audioinput", deviceId: "built-in", label: "MacBook Air Microphone" }
        ],
        getUserMedia: async () => {
          mic.opened += 1;
          return {
            getAudioTracks: () => [{ label: "MacBook Air Microphone", addEventListener() {} }],
            getTracks: () => [{ stop() { mic.stopped += 1; } }]
          };
        },
        addEventListener() {},
        removeEventListener() {}
      }
    },
    AudioContext: class {
      constructor({ sampleRate }) {
        this.sampleRate = sampleRate;
        this.state = "running";
        this.audioWorklet = { addModule: async () => {} };
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      close() { return Promise.resolve(); }
    },
    AudioWorkletNode: class {
      constructor() { this.port = {}; mic.node = this; }
      disconnect() {}
    }
  });
  work.context.chrome.tabs.create = async (options) => { mic.openedTab = options.url; };
  const random = createRandom(9);
  mic.say = (word, take = 0) => {
    const quiet = (ms) => Float32Array.from({ length: ms * 16 }, () => random() * 0.0004);
    const audio = new Float32Array([...quiet(1200), ...synthWord(word, TAKES[take]), ...quiet(900)]);
    for (let start = 0; start + 1600 <= audio.length; start += 1600) {
      mic.node.port.onmessage({ data: audio.slice(start, start + 1600) });
    }
  };
  return { channels, posted, mic, engine: () => channels[0] };
}

async function settle() {
  for (let n = 0; n < 5; n += 1) {
    await flush();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function text(node) {
  return [node.textContent, ...node.children.map(text)].join(" ");
}

async function loadOptionsVoice(seed) {
  const work = createWorkflow(seed);
  const browser = installVoiceBrowser(work);
  // A stand-in for the offscreen engine, listening on the status channel.
  const engine = new work.context.BroadcastChannel();
  engine.onmessage = () => {};
  work.load("src/voice/voice-features.js");
  work.load("src/voice/voice-capture.js");
  work.load("src/options/voice-options.js");
  await work.document.emit("DOMContentLoaded");
  await settle();
  return { ...work, ...browser };
}

test("options lists every voice command and records three takes through the worker", async () => {
  const work = await loadOptionsVoice();
  const rows = work.get("voiceWordList").children;
  assert.equal(rows.length, 8);
  assert.match(text(rows[0]), /Next saved timestamp/);
  assert.match(text(rows[0]), /Not recorded/);

  const recordButton = rows[0].children.find((node) => node.className === "voice-word__actions").children[0];
  await recordButton.emit("click");
  await settle();
  assert.equal(work.mic.opened, 1);
  assert.ok(work.posted.some((message) => message.command === "suspend"), "the engine is told to hold commands");
  assert.match(work.get("voiceTrainStatus").textContent, /1 of 3/);

  for (const take of [0, 1, 2]) {
    work.mic.say("next", take);
    await settle();
  }
  await settle();

  const rpc = work.messages.filter((message) => message.type === "SCENEMARKS_STORAGE_RPC")
    .map((message) => message.payload.method);
  assert.deepEqual(rpc, ["saveVoiceSamples"]);
  const profile = await work.context.SceneMarks.Storage.getVoiceProfile();
  assert.equal(profile.commands.next.length, 3);
  assert.ok(work.mic.stopped >= 1, "the microphone is released after recording");
  assert.match(work.get("voiceTrainStatus").textContent, /Saved/);
});

test("options test mode reports the heard word without running anything", async () => {
  const work = await loadOptionsVoice();
  const Storage = work.context.SceneMarks.Storage;
  const VoiceFeatures = work.context.SceneMarks.VoiceFeatures;
  for (const word of ["next", "back", "skip"]) {
    await Storage.saveVoiceSamples(word, [0, 1, 2].map((take) => VoiceFeatures.extractFeatures(synthWord(word, TAKES[take]))));
  }
  for (const listener of work.changed) listener({ voiceProfile: { newValue: {} } }, "local");
  await settle();
  assert.match(text(work.get("voiceWordList")), /Recognized 3 of 3/);

  await work.get("voiceTestButton").emit("click");
  await settle();
  work.mic.say("skip", 3);
  await settle();
  assert.match(work.get("voiceTestResult").textContent, /Heard "skip"/);
  assert.ok(!work.messages.some((message) => message.type === "SCENEMARKS_VOICE_COMMAND"));
});

async function loadPopupVoice(seed) {
  const work = createWorkflow(seed);
  const browser = installVoiceBrowser(work);
  work.load("src/popup/popup-voice.js");
  await work.document.emit("DOMContentLoaded");
  await settle();
  return { ...work, ...browser };
}

test("popup voice row turns voice on and shows what the engine reports", async () => {
  const work = await loadPopupVoice();
  assert.equal(work.get("voiceStatusLabel").textContent, "Off");
  assert.match(text(work.get("voiceDetailLabel")), /Record your words/);
  assert.ok(work.posted.some((message) => message.command === "status-request"));

  await work.get("voiceToggleButton").emit("click");
  await settle();
  assert.equal(work.store.readState().settings.voice.enabled, true);
  assert.equal(work.get("voiceStatusLabel").textContent, "Not trained");

  const Storage = work.context.SceneMarks.Storage;
  await Storage.saveVoiceSamples("next", [{ frames: 1, data: new Array(13).fill(0) }]);
  for (const listener of work.changed) listener({ voiceProfile: { newValue: {} } }, "local");
  await settle();
  const engine = new work.context.BroadcastChannel();
  engine.postMessage({
    kind: "engine-status", at: Date.now(), state: "listening", capture: {},
    lastHeard: { command: "next", outcome: "sent", at: Date.now(), result: "Jumped to 01:30 (2/2)" }
  });
  assert.equal(work.get("voiceStatusLabel").textContent, "Listening");
  assert.match(text(work.get("voiceDetailLabel")), /Last: "next" .* Jumped to 01:30/);

  engine.postMessage({ kind: "engine-status", at: Date.now(), state: "mic-error", capture: { errorName: "NotAllowedError" } });
  assert.equal(work.get("voiceStatusLabel").textContent, "Mic blocked");
});
