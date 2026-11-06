"use strict";
// The offscreen voice engine (src/voice/voice-engine.js) in a fake
// browser: a fake microphone "speaks" synthetic words through the real
// capture pipeline and matcher, a fake worker answers its messages, and a
// fake clock drives the timers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { TAKES, createRandom, loadVoiceFeatures, synthWord, vadUtterance } = require("./voice-synth");

const ROOT = path.join(__dirname, "..", "..");
const VoiceFeatures = loadVoiceFeatures();
const ENGINE_URL = "chrome-extension://scenemarks/src/voice/offscreen.html";
const WORKER_SENDER = { url: "chrome-extension://scenemarks/src/background/service-worker.js" };

function trainedProfile(words = ["next", "back", "skip"]) {
  const commands = {};
  for (const word of words) {
    commands[word] = [0, 1, 2].map((take) => VoiceFeatures.extractFeatures(vadUtterance(VoiceFeatures, word, TAKES[take])));
  }
  return { featureVersion: 3, commands };
}

function loadEngine({ voice = {}, profile = trainedProfile(), listen = true } = {}) {
  const clock = { now: Date.parse("2026-11-06T10:00:00Z") };
  const timers = [];
  let timerId = 0;
  const schedule = (fn, ms, every) => {
    const id = ++timerId;
    timers.push({ id, fn, at: clock.now + Math.max(0, ms || 0), every });
    return id;
  };
  const cancel = (id) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };

  const sent = [];
  const channels = [];
  const runtimeListeners = [];
  const mic = { opened: 0, stopped: 0, node: null };
  const config = { voice: { enabled: true, sensitivity: 0.5, micDeviceId: "", micLabel: "", autoOffMinutes: 0, onlyWithVideo: false, ...voice }, profile, listen };

  class FakeChannel {
    constructor() { channels.push(this); }
    postMessage(message) {
      channels.filter((channel) => channel !== this && channel.onmessage)
        .forEach((channel) => channel.onmessage({ data: message }));
    }
  }
  class FakeDate extends Date {
    static now() { return clock.now; }
  }

  const context = vm.createContext({
    console, URL, performance, Promise,
    Date: FakeDate,
    setTimeout: (fn, ms) => schedule(fn, ms),
    clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: cancel,
    BroadcastChannel: FakeChannel,
    location: { href: ENGINE_URL },
    document: { currentScript: null },
    navigator: {
      permissions: { query: async () => ({ state: "granted" }) },
      mediaDevices: {
        enumerateDevices: async () => [],
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
        this.destination = {};
      }
      createMediaStreamSource() { return { connect: (node) => node, disconnect() {} }; }
      // The capture's fallback when the sink node is not pulled.
      createGain() { return { gain: {}, connect: (node) => node }; }
      close() { return Promise.resolve(); }
    },
    AudioWorkletNode: class {
      constructor() { this.port = {}; mic.node = this; }
      connect(node) { return node; }
      disconnect() {}
    },
    chrome: {
      runtime: {
        getURL: (relative) => `chrome-extension://scenemarks/${relative}`,
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        sendMessage: async (message) => {
          if (message.type === "SCENEMARKS_VOICE_GET_CONFIG") return { ok: true, ...config };
          sent.push(message);
          return { ok: true, message: "Done" };
        }
      }
    }
  });
  context.globalThis = context;
  for (const file of ["src/shared/constants.js", "src/voice/voice-features.js", "src/voice/voice-capture.js", "src/voice/voice-engine.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }

  const random = createRandom(4);
  const page = new FakeChannel();
  let status = null;
  page.onmessage = (event) => {
    if (event.data && event.data.kind === "engine-status") status = event.data;
  };

  async function settle() {
    for (let n = 0; n < 6; n += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    config, mic, sent, page,
    commands: () => sent.filter((message) => message.type === "SCENEMARKS_VOICE_COMMAND").map((message) => message.payload.command),
    async advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.now = Math.max(clock.now, due.at);
        if (due.every) due.at += due.every; else cancel(due.id);
        due.fn();
        await settle();
      }
      clock.now = end;
      await settle();
    },
    async say(word, take = 3) {
      const quiet = (ms) => Float32Array.from({ length: ms * 16 }, () => random() * 0.0004);
      const audio = new Float32Array([...quiet(1200), ...synthWord(word, TAKES[take]), ...quiet(900)]);
      for (let start = 0; start + 1600 <= audio.length; start += 1600) {
        mic.node.port.onmessage({ data: audio.slice(start, start + 1600) });
      }
      await settle();
    },
    async status() {
      page.postMessage({ command: "status-request" });
      await this.advance(100);
      return status;
    },
    send(message, sender = WORKER_SENDER) {
      runtimeListeners.forEach((listener) => listener(message, sender));
      return settle();
    },
    settle
  };
}

test("the engine sends a recognized word to the worker, and nothing for other speech", async () => {
  const engine = loadEngine();
  await engine.settle();
  assert.equal(engine.mic.opened, 1);
  await engine.say("next");
  await engine.advance(1000);
  await engine.say("hello", 0);
  await engine.advance(1000);
  await engine.say("skip", 4);
  assert.deepEqual(engine.commands(), ["next", "skip"]);
  const status = await engine.status();
  assert.equal(status.state, "listening");
  assert.equal(status.counters.recognized, 2);
  assert.equal(status.lastHeard.command, "skip");
  assert.equal(status.lastHeard.outcome, "sent");
});

test("a word right after a command waits out the cooldown", async () => {
  const engine = loadEngine();
  await engine.settle();
  await engine.say("next");
  await engine.say("back"); // Same instant on the fake clock.
  assert.deepEqual(engine.commands(), ["next"]);
  assert.equal((await engine.status()).lastHeard.outcome, "cooldown");
  await engine.advance(800);
  await engine.say("back");
  assert.deepEqual(engine.commands(), ["next", "back"]);
});

test("while the options page records or tests, words are heard but run nothing", async () => {
  const engine = loadEngine();
  await engine.settle();
  engine.page.postMessage({ command: "suspend", ms: 4000 });
  await engine.say("next");
  assert.deepEqual(engine.commands(), []);
  const status = await engine.status();
  assert.equal(status.state, "suspended");
  assert.equal(status.lastHeard.outcome, "test-only");
  await engine.advance(4000);
  await engine.say("next");
  assert.deepEqual(engine.commands(), ["next"]);
});

test("with no words recorded the microphone stays closed", async () => {
  const engine = loadEngine({ profile: { featureVersion: 3, commands: {} } });
  await engine.settle();
  assert.equal(engine.mic.opened, 0);
  assert.equal((await engine.status()).state, "not-trained");

  const stale = loadEngine({ profile: { ...trainedProfile(["next", "back"]), featureVersion: 0 } });
  await stale.settle();
  assert.equal(stale.mic.opened, 0);
  assert.equal((await stale.status()).state, "retrain");
});

test("only-with-video opens the mic for a video tab and closes it a few seconds after", async () => {
  const engine = loadEngine({ voice: { onlyWithVideo: true }, listen: false });
  await engine.settle();
  assert.equal(engine.mic.opened, 0);
  assert.equal((await engine.status()).state, "waiting-for-video");

  await engine.send({ type: "SCENEMARKS_VOICE_SET_LISTENING", payload: { listen: true } });
  assert.equal(engine.mic.opened, 1);

  // A brief "no video" during a tab switch does not close it.
  await engine.send({ type: "SCENEMARKS_VOICE_SET_LISTENING", payload: { listen: false } });
  await engine.advance(2000);
  await engine.send({ type: "SCENEMARKS_VOICE_SET_LISTENING", payload: { listen: true } });
  await engine.advance(6000);
  assert.equal(engine.mic.stopped, 0);

  await engine.send({ type: "SCENEMARKS_VOICE_SET_LISTENING", payload: { listen: false } });
  await engine.advance(5100);
  assert.equal(engine.mic.stopped, 1);
  assert.equal((await engine.status()).state, "waiting-for-video");

  // Only extension contexts may steer it.
  await engine.send({ type: "SCENEMARKS_VOICE_SET_LISTENING", payload: { listen: true } }, { url: "https://evil.example/" });
  assert.equal(engine.mic.opened, 1);
});

test("the engine asks about idleness once a minute only when auto-off is set", async () => {
  const idleChecks = (engine) => engine.sent.filter((message) => message.type === "SCENEMARKS_VOICE_IDLE_CHECK").length;
  const never = loadEngine();
  await never.settle();
  await never.advance(3 * 60 * 1000);
  assert.equal(idleChecks(never), 0);

  const auto = loadEngine({ voice: { autoOffMinutes: 15 } });
  await auto.settle();
  await auto.advance(3 * 60 * 1000);
  assert.equal(idleChecks(auto), 3);
});

test("new templates or a mic change reload the engine", async () => {
  const engine = loadEngine({ profile: { featureVersion: 3, commands: {} } });
  await engine.settle();
  assert.equal(engine.mic.opened, 0);
  engine.config.profile = trainedProfile(["next", "back"]);
  await engine.send({ type: "SCENEMARKS_VOICE_CONFIG_CHANGED" });
  assert.equal(engine.mic.opened, 1);
  await engine.say("back");
  assert.deepEqual(engine.commands(), ["back"]);

  engine.config.voice = { ...engine.config.voice, micDeviceId: "usb", micLabel: "USB Mic" };
  await engine.send({ type: "SCENEMARKS_VOICE_CONFIG_CHANGED" });
  await engine.advance(600); // The restart is debounced.
  assert.equal(engine.mic.opened, 2);
});
