"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { beforeEach, test } = require("node:test");

// Minimal media element double: a currentTime write starts a seek that
// completes asynchronously, like a real player, and every write is counted.
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this._currentTime = 0;
    this.seeking = false;
    this.paused = false;
    this.ended = false;
    this.duration = 3600;
    this.readyState = 4;
    this.controls = true;
    this.seekWrites = [];
    this.playCalls = 0;
    this.pauseCalls = 0;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    this.seekWrites.push(value);
    this.startSeek(value);
  }

  // Also used to simulate the site's own seek (e.g. "resume where you left off").
  startSeek(value, delayMs) {
    this._currentTime = value;
    this.seeking = true;
    this.dispatchEvent(new Event("seeking"));
    setTimeout(() => {
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
    }, delayMs === undefined ? 20 : delayMs);
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  getBoundingClientRect() {
    return { width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 };
  }

  closest() {
    return null;
  }
}

let video;
let videoScans;

// Records the observer the detector creates so tests can feed it mutations.
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeMutationObserver.last = this;
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }
}

function loadDetector(options) {
  delete globalThis.SceneMarks;
  videoScans = 0;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.innerWidth = 1920;
  globalThis.innerHeight = 1080;
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.document = {
    documentElement: {},
    querySelectorAll: () => {
      videoScans += 1;
      return [video];
    }
  };
  const file = path.join(__dirname, "..", "..", "src", "content", "video-detector.js");
  vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: "src/content/video-detector.js" });
  return globalThis.SceneMarks.VideoDetector.createVideoDetector(options || {});
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAGE_MUTATION = { target: { nodeType: 1, closest: () => null } };

test("an orphaned detector stops scanning once its extension context is gone", async () => {
  let alive = true;
  let deadCalls = 0;
  const detector = loadDetector({
    isAlive: () => alive,
    onDead: () => {
      deadCalls += 1;
      detector.stop();
    }
  });
  video.paused = true;
  detector.start();
  await wait(450);
  assert.equal(videoScans, 1);

  // A mutation schedules a scan; the context dies before it runs.
  FakeMutationObserver.last.callback([PAGE_MUTATION]);
  alive = false;
  await wait(450);
  assert.equal(videoScans, 1);
  assert.equal(deadCalls, 1);
  assert.equal(FakeMutationObserver.last.disconnected, true);

  // Mutations that still arrive never schedule another scan.
  FakeMutationObserver.last.callback([PAGE_MUTATION]);
  await wait(450);
  assert.equal(videoScans, 1);
});

beforeEach(() => {
  video = new FakeVideo();
});

test("seekTo skips the currentTime write when already at the target", async () => {
  const detector = loadDetector();
  video._currentTime = 100.1;

  const result = await detector.seekTo(100, "preserve-play-state");

  assert.equal(result.ok, true);
  assert.deepEqual(video.seekWrites, []);
});

test("seekTo writes currentTime when the target is farther than the epsilon", async () => {
  const detector = loadDetector();
  video._currentTime = 10;

  const result = await detector.seekTo(100, "preserve-play-state");

  assert.equal(result.ok, true);
  assert.deepEqual(video.seekWrites, [100]);
});

test("seekTo does not call play() on a video that is already playing", async () => {
  const detector = loadDetector();

  await detector.seekTo(50, "play-after-jump");
  assert.equal(video.playCalls, 0);

  video.paused = true;
  await detector.seekTo(80, "play-after-jump");
  assert.equal(video.playCalls, 1);
});

test("seekTo keeps a paused video paused under preserve-play-state", async () => {
  const detector = loadDetector();
  video.paused = true;

  await detector.seekTo(50, "preserve-play-state");

  assert.equal(video.playCalls, 0);
  assert.equal(video.paused, true);
});

test("verified seekTo retries once when the site re-seeks after the jump", async () => {
  const detector = loadDetector();
  let overridden = false;
  video.addEventListener("seeked", () => {
    if (!overridden) {
      overridden = true;
      // The site's resume logic moves playback elsewhere right after our seek.
      video.startSeek(5);
    }
  });

  const result = await detector.seekTo(300, "preserve-play-state", { verify: true });

  assert.equal(result.ok, true);
  assert.deepEqual(video.seekWrites, [300, 300]);
  assert.equal(video.currentTime, 300);
});

test("verified seekTo fails when the player keeps overriding the jump", async () => {
  const detector = loadDetector();
  video.addEventListener("seeked", () => {
    if (video.currentTime !== 5) {
      video.startSeek(5);
    }
  });

  const result = await detector.seekTo(300, "preserve-play-state", { verify: true });

  assert.equal(result.ok, false);
  assert.equal(video.seekWrites.length, 2);
});

test("verified seekTo waits for an in-progress site seek before seeking", async () => {
  const detector = loadDetector();
  video.startSeek(42, 200);

  const result = await detector.seekTo(300, "preserve-play-state", { verify: true });

  assert.equal(result.ok, true);
  assert.deepEqual(video.seekWrites, [300]);
  assert.equal(video.currentTime, 300);
});
