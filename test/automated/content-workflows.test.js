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

test("overlay reads only the current video and synthetic page events cannot invoke actions", async () => {
  const work = loadContent();
  await flush();
  assert.deepEqual(work.store.readLog, [
    ["activeRangeDraft", "pendingJump", "settings"],
    ["activeRangeDraft", "pendingJump", "settings", `video:${SNAPSHOT.videoKey}`]
  ]);
  const host = work.document.body.children[0];
  const buttons = host.children[1].children.filter((node) => node.tagName === "BUTTON");
  for (const button of buttons) await button.emit("click", { isTrusted: false });
  assert.equal(work.messages.length, 0);
  assert.equal(work.store.writes, 0);
  await buttons.at(-1).emit("click", { isTrusted: true });
  assert.equal(work.messages.at(-1).type, "SCENEMARKS_OPEN_LIBRARY");
  assert.equal(work.store.reads, 2);
  assert.doesNotMatch(pageText(work), /confidential/);

  // A valid save returns user content internally; it must never enter DOM.
  work.context.SceneMarks.Storage.saveScene = async () => ({ ok: true, scene: { note: "confidential" } });
  await buttons[0].emit("click", { isTrusted: true });
  assert.doesNotMatch(pageText(work), /confidential/);
});

const OTHER_KEY = "generic:v2:https://example.com/watch?id=B";

function savedVideo(videoKey, scenes) {
  return {
    videoKey, platform: "generic", title: "confidential title", canonicalUrl: "https://example.com/watch",
    rawUrls: [], favorite: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    scenes: scenes.map((scene) => ({
      note: "confidential note", tags: ["confidential-tag"], endSeconds: null, favorite: false,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...scene
    }))
  };
}

function savedLibrary() {
  return {
    schemaVersion: 3,
    [`video:${SNAPSHOT.videoKey}`]: savedVideo(SNAPSHOT.videoKey, [
      { id: "late", startSeconds: 130 },
      { id: "range", startSeconds: 10, endSeconds: 25 }
    ]),
    [`video:${OTHER_KEY}`]: savedVideo(OTHER_KEY, [{ id: "other", startSeconds: 999 }])
  };
}

function overlayMarks(work) {
  const body = work.document.body.children[0].children[1];
  const section = body.children.find((node) => node.className === "scenemarks-overlay__marks");
  return { section, status: section.children[0], buttons: section.children[1].children };
}

const markTexts = (work) => overlayMarks(work).buttons.map((button) => button.textContent);

test("overlay lists every saved time of the current video and nothing else", async () => {
  const work = loadContent({ seed: savedLibrary() });
  await flush();
  assert.deepEqual(markTexts(work), ["00:10 -> 00:25", "02:10"]);
  assert.equal(overlayMarks(work).section.hidden, false);
  assert.equal(overlayMarks(work).status.textContent, "Saved timestamps (2)");
  assert.doesNotMatch(pageText(work), /confidential|16:39/);
  assert.equal(work.store.readLog.flat().includes(`video:${OTHER_KEY}`), false);
});

test("overlay timestamps jump on a trusted click and ignore synthetic ones", async () => {
  const work = loadContent({ seed: savedLibrary() });
  await flush();
  const [, late] = overlayMarks(work).buttons;
  await late.emit("click", { isTrusted: false });
  assert.equal(work.seeks.length, 0);
  await late.emit("click", { isTrusted: true });
  assert.equal(work.seeks.length, 1);
  assert.equal(work.seeks[0].seconds, 130);
  assert.equal(work.seeks[0].opts.expectedVideoKey, SNAPSHOT.videoKey);
  assert.equal(work.document.body.children[1].textContent, "Jumped to 02:10 (2/2)");
});

test("overlay list follows saves without a re-read and follows the video when it changes", async () => {
  const work = loadContent({ seed: savedLibrary() });
  await flush();
  const readsBefore = work.store.reads;
  const updated = savedVideo(SNAPSHOT.videoKey, [
    { id: "range", startSeconds: 10, endSeconds: 25 },
    { id: "new", startSeconds: 60 },
    { id: "late", startSeconds: 130 }
  ]);
  for (const listener of work.changed) listener({ [`video:${SNAPSHOT.videoKey}`]: { newValue: updated } }, "local");
  await flush();
  assert.deepEqual(markTexts(work), ["00:10 -> 00:25", "01:00", "02:10"]);
  assert.equal(work.store.reads, readsBefore);

  for (const listener of work.changed) listener({ [`video:${SNAPSHOT.videoKey}`]: { oldValue: updated } }, "local");
  assert.deepEqual(markTexts(work), []);
  assert.equal(overlayMarks(work).status.textContent, "No saved timestamps for this video.");

  work.setSnapshot({ videoKey: OTHER_KEY });
  work.detectorOptions().onContextChange();
  await flush();
  assert.deepEqual(markTexts(work), ["16:39"]);

  work.setSnapshot({ detected: false, videoKey: null });
  work.detectorOptions().onContextChange();
  await flush();
  assert.equal(overlayMarks(work).section.hidden, true);
});

test("a hidden overlay reads no video until it is shown", async () => {
  const seed = savedLibrary();
  seed.settings = { enableFloatingButton: false };
  const work = loadContent({ seed });
  await flush();
  assert.equal(work.store.readLog.flat().includes(`video:${SNAPSHOT.videoKey}`), false);
  await work.context.SceneMarks.Storage.updateSettings({ enableFloatingButton: true });
  await flush();
  assert.deepEqual(markTexts(work), ["00:10 -> 00:25", "02:10"]);
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

test("voice mark and a quick save both save at once, even with an old quickSaveRequiresNote setting", async () => {
  const work = loadContent({ seed: { settings: { quickSaveRequiresNote: true } } });
  await flush();
  const result = await voice(work, "mark");
  assert.equal(result.ok, true);
  assert.equal(result.message, "Saved 01:00");
  assert.deepEqual(work.store.readState().videos[SNAPSHOT.videoKey].scenes.map((scene) => scene.startSeconds), [60]);
  work.setSnapshot({ currentTimeSeconds: 120 });
  const quick = await work.send({ type: "SCENEMARKS_QUICK_SAVE", payload: {} });
  assert.equal(quick.ok, true);
  assert.equal(quick.message, "Saved 02:00");
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

test("startAtFirstMark waits for a late player, then plays from the first saved timestamp", async () => {
  const video = fakeVideo();
  const work = loadContent({ video, seed: seededScenes() });
  await flush();
  work.setSnapshot({ detected: false });
  const pending = voice(work, "startAtFirstMark", { heard: "skip", position: 2, total: 3, kind: "lineup" });
  await work.advance(250);
  await work.advance(250);
  assert.deepEqual(work.seeks, []);
  work.setSnapshot({ detected: true });
  await work.advance(250);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.message, "Video 2/3 · 00:30 (1/2)");
  assert.deepEqual(work.seeks.map(({ seconds, behavior }) => [seconds, behavior]), [[30, "play-after-jump"]]);
  assert.match(pageText(work), /Voice: skip · Video 2\/3 · 00:30 \(1\/2\)/);
  assert.doesNotMatch(pageText(work), /confidential|Secret title/);
});

test("startAtFirstMark just plays a video with no saved marks, and gives up after ~10 s", async () => {
  const video = fakeVideo();
  video.paused = true;
  const work = loadContent({ video });
  await flush();
  const plain = await voice(work, "startAtFirstMark", { heard: "return", position: 1, total: 4, kind: "tabs" });
  assert.equal(plain.message, "Tab 1/4 · No saved marks, playing");
  assert.deepEqual(video.calls, ["play"]);

  const empty = loadContent({ video: null });
  await flush();
  empty.setSnapshot({ detected: false });
  const pending = voice(empty, "startAtFirstMark", { heard: "skip", position: 1, total: 2, kind: "lineup" });
  for (let n = 0; n < 41; n += 1) await empty.advance(250);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /^Video 1\/2 · No video detected/);
});

test("the tab a switch leaves is paused without a toast", async () => {
  const video = fakeVideo();
  const work = loadContent({ video });
  await flush();
  const result = await work.send({ type: "SCENEMARKS_VOICE_ACTION", payload: { action: "pause", silent: true } });
  assert.deepEqual({ ...result }, { ok: true });
  assert.deepEqual(video.calls, ["pause"]);
  assert.doesNotMatch(pageText(work), /Paused/);
});

test("worker announcements show as toasts, errors styled as errors", async () => {
  const work = loadContent();
  await flush();
  const result = await voice(work, "announce", { heard: "skip", message: "No other video tab to switch to", isError: true });
  assert.equal(result.ok, false);
  assert.match(pageText(work), /Voice: skip · No other video tab to switch to/);
});

test("playback-state reports the player without a toast, and nothing where SceneMarks is off", async () => {
  const video = fakeVideo();
  const work = loadContent({ video });
  await flush();
  const state = await voice(work, "playback-state");
  assert.deepEqual({ ...state }, { ok: true, detected: true, playing: true });
  assert.doesNotMatch(pageText(work), /Voice:/);

  const off = loadContent({ video, seed: { settings: { extensionEnabled: false } } });
  await flush();
  assert.equal((await voice(off, "playback-state")).detected, undefined);
});

test("with only-with-video on, a tab reports its video appearing and going away", async () => {
  const work = loadContent({ seed: { settings: { voice: { enabled: true, onlyWithVideo: true } } } });
  await flush();
  const presence = () => work.messages.filter((message) => message.type === "SCENEMARKS_VOICE_VIDEO_PRESENCE")
    .map((message) => message.payload.detected);
  work.detectorOptions().onContextChange();
  work.detectorOptions().onContextChange();
  work.setSnapshot({ detected: false });
  work.detectorOptions().onContextChange();
  assert.deepEqual(presence(), [true, false]);

  const plain = loadContent({ seed: { settings: { voice: { enabled: true } } } });
  await flush();
  plain.detectorOptions().onContextChange();
  assert.equal(plain.messages.some((message) => message.type === "SCENEMARKS_VOICE_VIDEO_PRESENCE"), false);
});

function toastText(work) {
  return work.document.body.children.find((node) => /scenemarks-toast/.test(node.className)).textContent;
}

test("browser-command saves and range marks show the same toasts as the page hotkeys", async () => {
  const work = loadContent();
  await flush();
  const command = (type) => work.send({ type, payload: { quick: true, source: "browser-command" } });
  await command("SCENEMARKS_QUICK_SAVE");
  assert.equal(toastText(work), "Saved 01:00");
  work.setSnapshot({ currentTimeSeconds: 61 });
  await command("SCENEMARKS_QUICK_SAVE");
  assert.equal(toastText(work), "Already saved near 01:01");
  await command("SCENEMARKS_TOGGLE_RANGE");
  assert.equal(toastText(work), "Range started at 01:01");
  work.setSnapshot({ currentTimeSeconds: 90 });
  await command("SCENEMARKS_TOGGLE_RANGE");
  assert.equal(toastText(work), "Range saved 01:01 \u2192 01:30");
  work.setSnapshot({ detected: false });
  await command("SCENEMARKS_QUICK_SAVE");
  assert.equal(toastText(work), "No video found \u2014 start playback first");

  // The same saves from the popup (no source) leave the page alone.
  const quiet = loadContent();
  await flush();
  await quiet.send({ type: "SCENEMARKS_SAVE_TIMESTAMP", payload: {} });
  assert.equal(toastText(quiet), "");
});

test("a page hotkey and a browser command on a switched-off site save nothing and show nothing", async () => {
  const work = loadContent({ seed: { settings: { disabledSites: ["example.com"] } } });
  await flush();
  const result = await work.send({ type: "SCENEMARKS_QUICK_SAVE", payload: { quick: true, source: "browser-command" } });
  assert.equal(result.inactive, true);
  assert.equal(toastText(work), "");
  assert.equal(work.store.writes, 0);
});

test("overlay buttons say what happened, built from the playback time, and drop focus after a click", async () => {
  const work = loadContent();
  await flush();
  const buttons = work.document.body.children[0].children[1].children.filter((node) => node.tagName === "BUTTON");
  const [save, range] = buttons;
  let blurred = 0;
  save.blur = () => { blurred += 1; };
  await save.emit("click", { isTrusted: true, detail: 1 });
  assert.equal(toastText(work), "Saved 01:00");
  assert.equal(blurred, 1);
  await save.emit("click", { isTrusted: true, detail: 0 });
  assert.equal(toastText(work), "Already saved near 01:00");
  assert.equal(blurred, 1, "keyboard presses keep focus");
  work.setSnapshot({ currentTimeSeconds: 724 });
  await range.emit("click", { isTrusted: true, detail: 1 });
  assert.equal(toastText(work), "Range started at 12:04");
  work.setSnapshot({ currentTimeSeconds: 790 });
  await range.emit("click", { isTrusted: true, detail: 1 });
  assert.equal(toastText(work), "Range saved 12:04 \u2192 13:10");
  // A second range over the same span is rejected, and the toast says it
  // stays open.
  work.setSnapshot({ currentTimeSeconds: 725 });
  await range.emit("click", { isTrusted: true, detail: 1 });
  work.setSnapshot({ currentTimeSeconds: 791 });
  await range.emit("click", { isTrusted: true, detail: 1 });
  assert.equal(toastText(work), "Range 12:05 \u2192 13:11 is already saved \u00b7 still open from 12:05");
  assert.equal(work.store.readState().activeRangeDraft.startSeconds, 725);
  work.setSnapshot({ detected: false });
  await save.emit("click", { isTrusted: true, detail: 1 });
  assert.equal(toastText(work), "No video found \u2014 start playback first");
  assert.doesNotMatch(pageText(work), /confidential|Current video/);
});

test("the quick-save hotkey reports a duplicate instead of a bare error", async () => {
  const work = loadContent();
  await flush();
  await work.events.emit("keydown", keyboard("KeyS"));
  assert.equal(toastText(work), "Saved 01:00");
  await work.events.emit("keydown", keyboard("KeyS"));
  assert.equal(toastText(work), "Already saved near 01:00");
});

test("lineup hotkeys ask the worker to step, only for trusted keys, and say nothing on success", async () => {
  const work = loadContent();
  await flush();
  const sent = () => work.messages.filter((message) => /LINEUP/.test(message.type)).map((message) => message.type);
  await work.events.emit("keydown", keyboard("KeyK", { isTrusted: false }));
  await work.events.emit("keydown", keyboard("KeyJ", { isTrusted: false }));
  assert.deepEqual(sent(), []);
  await work.events.emit("keydown", keyboard("KeyK"));
  await work.events.emit("keydown", keyboard("KeyJ"));
  assert.deepEqual(sent(), ["SCENEMARKS_LINEUP_NEXT", "SCENEMARKS_LINEUP_PREVIOUS"]);
  assert.equal(toastText(work), "");

  // A refusal from the worker shows as a toast on this page.
  const real = work.context.chrome.runtime.sendMessage;
  work.context.chrome.runtime.sendMessage = (message, callback) => (/LINEUP/.test(message.type)
    ? Promise.resolve({ ok: false, error: "No lineup yet — use Open Random in the Library" })
    : real(message, callback));
  await work.events.emit("keydown", keyboard("KeyK"));
  assert.equal(toastText(work), "No lineup yet — use Open Random in the Library");

  const off = loadContent({ seed: { settings: { disabledSites: ["example.com"] } } });
  await flush();
  await off.events.emit("keydown", keyboard("KeyK"));
  assert.equal(off.messages.some((message) => /LINEUP/.test(message.type)), false);
});

test("the Random hotkey asks the worker to open a video at its first mark", async () => {
  const work = loadContent();
  await flush();
  await work.events.emit("keydown", keyboard("KeyR"));
  assert.equal(work.messages.at(-1).type, "SCENEMARKS_OPEN_RANDOM_VIDEO");
  assert.equal(toastText(work), "Opening a random video at its first mark");
});

test("the favorite hotkey saves a favorite, or favorites the saved time already there, and toasts only the time", async () => {
  const work = loadContent({ seed: savedLibrary() });
  await flush();
  await work.events.emit("keydown", keyboard("KeyF"));
  assert.equal(toastText(work), "Favorited 01:00");
  const scenes = () => work.store.readState().videos[SNAPSHOT.videoKey].scenes;
  assert.equal(scenes().find((scene) => scene.startSeconds === 60).favorite, true);

  // 02:11 is inside the window of the saved 02:10: that one is favorited.
  work.setSnapshot({ currentTimeSeconds: 131 });
  await work.events.emit("keydown", keyboard("KeyF"));
  assert.equal(toastText(work), "Favorited 02:10");
  assert.equal(scenes().find((scene) => scene.id === "late").favorite, true);
  assert.equal(scenes().length, 3);
  await work.events.emit("keydown", keyboard("KeyF"));
  assert.equal(toastText(work), "Already a favorite: 02:10");
  assert.doesNotMatch(pageText(work), /confidential/);
});
