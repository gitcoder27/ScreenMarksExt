"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkflow, deferred, FakeElement, flush, keyboard } = require("./workflow-helpers");

const SNAPSHOT = {
  detected: true, videoKey: "generic:v2:https://example.com/watch?id=A", platform: "generic",
  canonicalUrl: "https://example.com/watch?id=A", rawUrl: "https://example.com/watch?id=A",
  currentTimeSeconds: 60, durationSeconds: 600, title: "Current video"
};
function loadContent(options = {}) {
  const work = createWorkflow(options.seed);
  let snapshot = { ...SNAPSHOT };
  let detectorOptions;
  const seeks = [];
  work.context.SceneMarks.VideoDetector = {
    createVideoDetector(callbacks) {
      detectorOptions = callbacks;
      return {
        getSnapshot: () => ({ ...snapshot }), start() {}, stop() {}, scheduleScan() {},
        getActiveVideo: () => (options.video === undefined ? null : options.video),
        async seekTo(seconds, behavior, opts) {
          seeks.push({ seconds, behavior, opts });
          return options.seek ? options.seek(seconds, opts) : { ok: true };
        }
      };
    }
  };
  if (options.settingsPromise) {
    const client = work.context.SceneMarks.Storage.createClient();
    work.context.SceneMarks.Storage.createClient = () => ({ ...client, getSettings: () => options.settingsPromise });
  }
  work.load("src/content/overlay.js");
  work.load("src/content/content-script.js");
  return { ...work, seeks, snapshot: () => snapshot,
    setSnapshot(value) { snapshot = { ...snapshot, ...value }; },
    detectorOptions: () => detectorOptions };
}

function pageText(work) {
  const visit = (node) => [node.textContent, ...node.children.map(visit)].join(" ");
  return visit(work.document.body);
}

test("overlay never reads saved content and synthetic page events cannot invoke actions", async () => {
  const work = loadContent();
  await flush();
  assert.deepEqual(work.store.readLog, [["activeRangeDraft", "pendingJump", "settings"]]);
  const host = work.document.body.children[0];
  const buttons = host.children[1].children.filter((node) => node.tagName === "BUTTON");
  for (const button of buttons) await button.emit("click", { isTrusted: false });
  assert.equal(work.messages.length, 0);
  assert.equal(work.store.writes, 0);
  await buttons.at(-1).emit("click", { isTrusted: true });
  assert.equal(work.messages.at(-1).type, "SCENEMARKS_OPEN_LIBRARY");
  assert.equal(work.store.reads, 1);
  assert.doesNotMatch(pageText(work), /confidential/);

  // A valid save returns user content internally; it must never enter DOM.
  work.context.SceneMarks.Storage.saveScene = async () => ({ ok: true, scene: { note: "confidential" } });
  await buttons[0].emit("click", { isTrusted: true });
  assert.doesNotMatch(pageText(work), /confidential/);
});

test("capture commands use the frozen timestamp and reject changed video identity", async () => {
  const work = loadContent();
  await flush();
  work.setSnapshot({ currentTimeSeconds: 90 });
  const capture = { videoKey: SNAPSHOT.videoKey, seconds: 60 };
  const response = await work.send({ type: "SCENEMARKS_SAVE_TIMESTAMP", payload: { capture, note: "typed later" } });
  assert.equal(response.ok, true);
  assert.equal(response.scene.startSeconds, 60);
  work.setSnapshot({ videoKey: "generic:v2:https://example.com/watch?id=B" });
  const changed = await work.send({ type: "SCENEMARKS_SAVE_TIMESTAMP", payload: { capture } });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /video changed/);
  assert.equal(work.store.readState().videos[SNAPSHOT.videoKey].scenes.length, 1);
});

test("captured range boundaries survive confirmation delays and duplicate retries", async () => {
  const work = loadContent();
  await flush();
  const capture = (seconds) => ({ videoKey: SNAPSHOT.videoKey, seconds });
  await work.send({ type: "SCENEMARKS_START_RANGE", payload: { capture: capture(10) } });
  await work.send({ type: "SCENEMARKS_END_RANGE", payload: { capture: capture(20) } });
  await work.send({ type: "SCENEMARKS_START_RANGE", payload: { capture: capture(10) } });
  const payload = { capture: capture(20), note: "later" };
  const duplicate = await work.send({ type: "SCENEMARKS_END_RANGE", payload });
  assert.equal(duplicate.duplicate, true);
  work.setSnapshot({ currentTimeSeconds: 120 });
  const result = await work.send({ type: "SCENEMARKS_END_RANGE", payload: { ...payload, allowDuplicate: true } });
  assert.equal(result.scene.startSeconds, 10);
  assert.equal(result.scene.endSeconds, 20);
});

test("hotkeys install before settings resolve, suppress accepted matches, and pass other events", async () => {
  const loading = deferred();
  const work = loadContent({ settingsPromise: loading.promise });
  assert.equal(work.events.listeners.keydown.length, 1);
  let prevented = 0;
  let stopped = 0;
  const event = keyboard("KeyS", { preventDefault() { prevented += 1; }, stopImmediatePropagation() { stopped += 1; } });
  await work.events.emit("keydown", event);
  assert.equal(prevented, 0);
  loading.resolve(work.context.SceneMarks.Schema.normalizeSettings({ hotkeys: { quickSave: "S" } }));
  await flush();
  const match = { ...event, altKey: false, shiftKey: false };
  const pending = work.events.emit("keydown", match);
  assert.equal(prevented, 1); // Synchronous suppression, before storage RPC.
  assert.equal(stopped, 1);
  await pending;
  for (const other of [
    { code: "KeyX", key: "X" }, { repeat: true }, { isTrusted: false },
    { target: new FakeElement("textarea") },
    { composedPath: () => [new FakeElement("input")] }
  ]) await work.events.emit("keydown", { ...match, ...other });
  assert.equal(prevented, 1);
  await work.context.SceneMarks.Storage.setSiteEnabled("example.com", false);
  await work.events.emit("keydown", match);
  assert.equal(prevented, 1);
});

test("failed queued jumps retry automatically until readiness and stop after consumption", async () => {
  let ready = false;
  const work = loadContent({ seek: async () => ({ ok: ready }) });
  await flush();
  await work.context.SceneMarks.Storage.setPendingJump({ videoKey: SNAPSHOT.videoKey, sceneId: "s", targetTabId: 1, seconds: 42, url: SNAPSHOT.rawUrl });
  await work.advance(100);
  assert.equal(work.seeks.length, 1);
  assert.notEqual(work.store.raw("pendingJump"), null);
  assert.doesNotMatch(pageText(work), /could not seek|blocked/i);
  ready = true;
  await work.advance(1000);
  assert.equal(work.seeks.length, 2);
  assert.equal(work.store.raw("pendingJump"), null);
  await work.advance(10000);
  assert.equal(work.seeks.length, 2);
});

test("replacement during an in-flight seek survives and is scheduled next", async () => {
  const seeking = deferred();
  let calls = 0;
  const work = loadContent({ seek: () => ++calls === 1 ? seeking.promise : Promise.resolve({ ok: true }) });
  await flush();
  const jump = { videoKey: SNAPSHOT.videoKey, sceneId: "s", targetTabId: 1, url: SNAPSHOT.rawUrl };
  const a = await work.context.SceneMarks.Storage.setPendingJump({ ...jump, seconds: 10 });
  await work.advance(100);
  const b = await work.context.SceneMarks.Storage.setPendingJump({ ...jump, seconds: 20 });
  assert.notEqual(a.pendingJump.requestId, b.pendingJump.requestId);
  await work.advance(100); // The storage listener fires while A is seeking.
  seeking.resolve({ ok: true });
  await flush();
  assert.equal(work.store.raw("pendingJump").requestId, b.pendingJump.requestId);
  await work.advance(1000);
  assert.equal(work.seeks.length, 2);
  assert.equal(work.seeks[1].seconds, 20);
  assert.equal(work.store.raw("pendingJump"), null);
});

test("queued retries stop on cancellation, expiry, and navigation", async () => {
  for (const stop of ["cancel", "expire", "navigate"]) {
    const work = loadContent({ seek: async () => ({ ok: false }) });
    await flush();
    const Storage = work.context.SceneMarks.Storage;
    await Storage.setPendingJump({ videoKey: SNAPSHOT.videoKey, sceneId: "s", targetTabId: 1, seconds: 10, url: SNAPSHOT.rawUrl });
    await work.advance(100);
    if (stop === "cancel") await Storage.clearPendingJump();
    if (stop === "expire") work.store.local.set({ pendingJump: { ...work.store.raw("pendingJump"), createdAt: "2020-01-01" } }, () => {});
    if (stop === "navigate") work.setSnapshot({ videoKey: "other" });
    await work.advance(10000);
    assert.equal(work.seeks.length, 1, stop);
  }
});

// ---- Voice actions -------------------------------------------------------
function fakeVideo({ blockPlay = false } = {}) {
  const calls = [];
  return {
    calls,
    paused: false,
    pause() { calls.push("pause"); this.paused = true; },
    play() {
      calls.push("play");
      if (blockPlay) return Promise.reject(new Error("NotAllowedError"));
      this.paused = false;
      return Promise.resolve();
    }
  };
}

function seededScenes(note = "confidential note") {
  const key = SNAPSHOT.videoKey;
  return {
    [`video:${key}`]: {
      videoKey: key, platform: "generic", title: "Secret title", canonicalUrl: SNAPSHOT.canonicalUrl,
      rawUrls: [SNAPSHOT.rawUrl], createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
      scenes: [
        { id: "a", startSeconds: 30, note, createdAt: "2025-01-01T00:00:00.000Z" },
        { id: "b", startSeconds: 90, note, createdAt: "2025-01-01T00:00:00.000Z" }
      ]
    }
  };
}

function voice(work, action, extra = {}) {
  return work.send({ type: "SCENEMARKS_VOICE_ACTION", payload: { action, heard: action, ...extra } });
}

test("voice next and back jump between saved timestamps and say so without saved text", async () => {
  const work = loadContent({ seed: seededScenes() });
  await flush();
  const next = await voice(work, "next");
  assert.equal(next.ok, true);
  assert.equal(next.message, "Jumped to 01:30 (2/2)");
  assert.deepEqual(work.seeks.map(({ seconds }) => seconds), [90]);
  assert.match(pageText(work), /Voice: next · Jumped to 01:30 \(2\/2\)/);

  work.setSnapshot({ currentTimeSeconds: 90 });
  assert.equal((await voice(work, "back")).message, "Jumped to 00:30 (1/2)");
  assert.doesNotMatch(pageText(work), /confidential|Secret title/);
  // Only fixed fields travel back to the worker.
  assert.deepEqual(Object.keys(next).sort(), ["error", "message", "ok"]);
});

test("voice pause and play drive the video, and a blocked play says how to continue", async () => {
  const video = fakeVideo();
  const work = loadContent({ video });
  await flush();
  assert.equal((await voice(work, "pause")).message, "Paused");
  assert.equal((await voice(work, "play")).message, "Playing");
  assert.deepEqual(video.calls, ["pause", "play"]);

  const blocked = loadContent({ video: fakeVideo({ blockPlay: true }) });
  await flush();
  const result = await voice(blocked, "play");
  assert.equal(result.ok, false);
  assert.match(result.error, /press Space/);

  const none = loadContent({ video: null });
  await flush();
  assert.equal((await voice(none, "pause")).ok, false);
});

test("voice mark saves the current time even when quick save asks for a note", async () => {
  const work = loadContent({ seed: { settings: { quickSaveRequiresNote: true } } });
  await flush();
  const result = await voice(work, "mark");
  assert.equal(result.ok, true);
  assert.equal(result.message, "Saved 01:00");
  assert.deepEqual(work.store.readState().videos[SNAPSHOT.videoKey].scenes.map((scene) => scene.startSeconds), [60]);
  // The hotkey path still asks for a note.
  const hotkey = await work.send({ type: "SCENEMARKS_QUICK_SAVE", payload: {} });
  assert.equal(hotkey.requiresNote, true);
});

test("voice actions are refused where SceneMarks is switched off", async () => {
  const video = fakeVideo();
  const work = loadContent({ video, seed: { ...seededScenes(), settings: { disabledSites: ["example.com"] } } });
  await flush();
  for (const action of ["next", "back", "pause", "play", "mark", "announce"]) {
    const result = await voice(work, action);
    assert.equal(result.ok, false, action);
    assert.equal(result.inactive, true, action);
  }
  assert.deepEqual(work.seeks, []);
  assert.deepEqual(video.calls, []);
  assert.doesNotMatch(pageText(work), /Voice:/);
});

test("unknown voice actions do nothing", async () => {
  const work = loadContent();
  await flush();
  const result = await voice(work, "delete-everything");
  assert.equal(result.ok, false);
  assert.equal(work.store.writes, 0);
});
