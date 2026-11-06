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
