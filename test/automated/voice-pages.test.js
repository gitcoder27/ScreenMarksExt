"use strict";
// The voice UI on extension pages: the popup's voice row and the options
// page's recording screen, loaded into the fake DOM with a fake microphone
// that "speaks" synthetic words through the real capture pipeline.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkflow, flush } = require("./workflow-helpers");
const { TAKES, createRandom, loadVoiceFeatures, synthWord, vadUtterance } = require("./voice-synth");

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
    await Storage.saveVoiceSamples(word, [0, 1, 2].map((take) => VoiceFeatures.extractFeatures(vadUtterance(VoiceFeatures, word, TAKES[take]))));
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

function recordButtonFor(work, index) {
  const row = work.get("voiceWordList").children[index];
  return row.children.find((node) => node.className === "voice-word__actions").children[0];
}

test("a take that sounds different from the other two is re-taken before saving", async () => {
  const work = await loadOptionsVoice();
  await recordButtonFor(work, 0).emit("click"); // next
  await settle();
  work.mic.say("next", 0);
  await settle();
  work.mic.say("next", 1);
  await settle();
  work.mic.say("pause", 2); // A slip: the wrong word.
  await settle();
  assert.match(work.get("voiceTrainStatus").textContent, /take 3 sounded different/);
  assert.equal(work.messages.filter((message) => message.type === "SCENEMARKS_STORAGE_RPC").length, 0);

  work.mic.say("next", 2);
  await settle();
  await settle();
  const saved = (await work.context.SceneMarks.Storage.getVoiceProfile()).commands.next;
  assert.equal(saved.length, 3);
  assert.match(work.get("voiceTrainStatus").textContent, /Saved "next"/);
});

test("ignored sounds keep the prompt and advise only when they repeat", async () => {
  const work = await loadOptionsVoice();
  await recordButtonFor(work, 2).emit("click"); // pause
  await settle();
  const rejectedTap = () => {
    // A struck, ringing tap: what a finger on the laptop sounds like.
    const random = createRandom(3);
    const tap = Float32Array.from({ length: 600 * 16 }, (_, i) => 0.8 * (random() * Math.exp(-i / 80)
      + 0.3 * Math.sin((2 * Math.PI * 1500 * i) / 16000) * Math.exp(-i / 1920)));
    const quiet = Float32Array.from({ length: 1200 * 16 }, () => random() * 0.0004);
    const audio = new Float32Array([...quiet, ...tap, ...quiet]);
    for (let start = 0; start + 1600 <= audio.length; start += 1600) work.mic.node.port.onmessage({ data: audio.slice(start, start + 1600) });
  };
  rejectedTap();
  await settle();
  const status = work.get("voiceTrainStatus");
  assert.equal(status.textContent, 'Say "pause" (or your own word) · take 1 of 3 · ignored a tap or click');
  assert.equal(status.classList.contains ? status.classList.contains("is-error") : false, false);
  rejectedTap();
  rejectedTap();
  await settle();
  assert.match(status.textContent, /three times\. Keep the mic away from taps/);
});

test("the troubleshooting recording holds the session audio and the gate's decisions", async () => {
  const work = await loadOptionsVoice();
  const downloads = [];
  work.context.Blob = class { constructor(parts) { this.text = parts.join(""); } };
  work.context.URL = { createObjectURL: (blob) => { downloads.push(blob.text); return "blob:x"; }, revokeObjectURL() {} };
  work.context.btoa = (binary) => Buffer.from(binary, "binary").toString("base64");
  work.document.body.append = () => {};
  work.context.document.createElement = (tag) => {
    const element = new (require("./workflow-helpers").FakeElement)(tag);
    element.click = () => {};
    return element;
  };

  await recordButtonFor(work, 0).emit("click");
  await settle();
  work.mic.say("next", 0);
  await settle();
  await work.get("voiceSaveRecordingButton").emit("click");
  assert.equal(downloads.length, 1);
  const file = JSON.parse(downloads[0]);
  assert.equal(file.kind, "scenemarks-voice-recording");
  assert.equal(file.sampleRate, 16000);
  const seconds = Buffer.from(file.pcm16Base64, "base64").length / 2 / 16000;
  assert.ok(seconds > 2 && seconds < 4, String(seconds));
  assert.deepEqual(file.events.map((event) => [event.kind, event.command, event.outcome]), [["record", "next", "word"]]);
});
