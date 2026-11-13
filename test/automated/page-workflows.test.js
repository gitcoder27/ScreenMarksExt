"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkflow, FakeElement, flush, keyboard } = require("./workflow-helpers");

async function loadPopup({ range = false, conflict = false, scenes = [], video = null } = {}) {
  const work = createWorkflow();
  let seconds = 30;
  let videoKey = "youtube:abcdEFGH123";
  const captures = [];
  let attempts = 0;
  const response = () => ({
    ok: true, context: { detected: true, videoKey, currentTimeSeconds: seconds, platform: "youtube", durationSeconds: 600 },
    scenes, video, settings: work.context.SceneMarks.Schema.normalizeSettings({}),
    activeRangeDraft: range ? { videoKey, startSeconds: 10 } : null
  });
  work.context.chrome.runtime.sendMessage = (message, callback) => {
    work.messages.push(message);
    let result = { ok: true };
    if (message.type === "SCENEMARKS_GET_ACTIVE_TAB_CONTEXT") result = response();
    if (message.type === "SCENEMARKS_FORWARD_TO_ACTIVE_TAB") {
      if (message.payload.type === "SCENEMARKS_GET_VIDEO_CONTEXT") result = response();
      else {
        captures.push(message.payload);
        if (conflict && attempts++ === 0) {
          result = { ok: false, duplicate: true };
          seconds = 99;
        }
      }
    }
    callback(result);
  };
  work.load("src/popup/popup.js");
  await work.document.emit("DOMContentLoaded");
  return { ...work, captures,
    setTime(value) { seconds = value; },
    setKey(value) { videoKey = value; } };
}

test("popup Save Moment saves at once, with no dialog, and keeps its time through a duplicate retry", async () => {
  const work = await loadPopup({ conflict: true });
  work.setTime(60);
  await work.get("saveMomentButton").emit("click");
  assert.equal(work.get("sceneDialog").open, undefined);
  assert.equal(work.captures.length, 2);
  assert.equal(work.captures[0].type, "SCENEMARKS_SAVE_TIMESTAMP");
  assert.equal(work.captures[0].payload.capture.seconds, 60);
  assert.equal(work.captures[0].payload.note, undefined);
  // The page moved on to 99 s before the retry; the save keeps 01:00.
  assert.equal(work.captures[1].payload.capture.seconds, 60);
  assert.equal(work.captures[1].payload.allowDuplicate, true);
  assert.equal(work.get("statusBox").textContent, "Saved 01:00.");
});

test("popup range confirmation carries the displayed end time through retries", async () => {
  const work = await loadPopup({ range: true, conflict: true });
  work.setTime(60);
  const pending = work.get("rangeButton").emit("click");
  await flush();
  assert.equal(work.get("dialogTime").textContent, "00:10 -> 01:00");
  work.setTime(80);
  await work.get("sceneForm").emit("submit");
  await pending;
  assert.equal(work.captures.length, 2);
  assert.equal(work.captures[1].payload.capture.seconds, 60);
});

test("popup range start overwrite retains the action's identity and timestamp", async () => {
  const work = await loadPopup();
  const real = work.context.chrome.runtime.sendMessage;
  let attempts = 0;
  work.context.chrome.runtime.sendMessage = (message, callback) => {
    if (message.payload?.type === "SCENEMARKS_START_RANGE" && attempts++ === 0) {
      work.captures.push(message.payload);
      work.setTime(100);
      callback({ ok: false, conflict: true });
      return;
    }
    real(message, callback);
  };
  work.setTime(60);
  await work.get("rangeButton").emit("click");
  assert.equal(work.captures.length, 2);
  assert.equal(work.captures[1].payload.capture.seconds, 60);
  assert.equal(work.captures[1].payload.overwrite, true);
});

test("popup offers Cancel range only while this video has an open range, and cancels through the worker", async () => {
  const idle = await loadPopup();
  assert.equal(idle.get("cancelRangeButton").hidden, true);

  const work = await loadPopup({ range: true });
  assert.equal(work.get("cancelRangeButton").hidden, false);
  await work.get("cancelRangeButton").emit("click");
  const rpc = work.messages.filter((message) => message.type === "SCENEMARKS_STORAGE_RPC").at(-1);
  assert.equal(rpc.payload.method, "cancelRange");
  assert.deepEqual([...rpc.payload.args], ["youtube:abcdEFGH123"]);
});

function popupScene(id, startSeconds, extra = {}) {
  return { id, type: "timestamp", startSeconds, endSeconds: null, note: "", tags: [], favorite: false, ...extra };
}

test("popup rows are one line: time, star and a menu, a note only when there is one; the nearest is marked", async () => {
  const scenes = [popupScene("a", 10), popupScene("b", 28, { note: "the good bit", tags: ["x"] }), popupScene("c", 90, { favorite: true })];
  const work = await loadPopup({ scenes, video: { videoKey: "youtube:abcdEFGH123", title: "Movie", favorite: false } });
  const rows = work.get("sceneList").children;
  assert.equal(rows.length, 3);
  const parts = (row) => row.children.map((node) => node.className);
  assert.deepEqual(parts(rows[0]), ["scene-jump", "favorite-toggle", "scene-more", "scene-menu"]);
  assert.deepEqual(rows[0].children[0].children.map((node) => node.textContent), ["00:10"]);
  assert.deepEqual(rows[1].children[0].children.map((node) => node.textContent), ["00:28", "the good bit"]);
  assert.equal(rows[2].children[1].textContent, "\u2605");
  // Playback is at 00:30: the row at 00:28 is the nearest.
  assert.deepEqual(rows.map((row) => /is-nearest/.test(row.className)), [false, true, false]);
  // Clicking the time jumps; Edit and Delete sit in the menu.
  await rows[2].children[0].emit("click");
  const seek = work.messages.filter((message) => message.payload && message.payload.type === "SCENEMARKS_SEEK_TO").at(-1);
  assert.equal(seek.payload.payload.seconds, 90);
  assert.deepEqual(rows[0].children[3].children.map((node) => node.textContent), ["Edit", "Delete"]);
});

test("popup stars the video through updateVideo, and shows no star before anything is saved", async () => {
  const fresh = await loadPopup();
  assert.equal(fresh.get("videoFavoriteButton").hidden, true);
  assert.equal(fresh.get("platformLabel").textContent, "Video on YouTube");

  const work = await loadPopup({ scenes: [popupScene("a", 10)], video: { videoKey: "youtube:abcdEFGH123", title: "Movie", favorite: false } });
  assert.equal(work.get("videoFavoriteButton").hidden, false);
  assert.equal(work.get("videoTitleLabel").textContent, "Movie");
  await work.get("videoFavoriteButton").emit("click");
  const rpc = work.messages.filter((message) => message.type === "SCENEMARKS_STORAGE_RPC").at(-1);
  assert.equal(rpc.payload.method, "updateVideo");
  assert.deepEqual(JSON.parse(JSON.stringify(rpc.payload.args)), ["youtube:abcdEFGH123", { favorite: true }]);
});

async function loadOptions() {
  const work = createWorkflow();
  const record = new FakeElement("button");
  record.dataset.recordHotkey = "quickSaveHotkey";
  work.document.querySelectorAll = (selector) => selector === "[data-record-hotkey]" ? [record] : [];
  work.load("src/options/options.js");
  await work.document.emit("DOMContentLoaded");
  return { ...work, record };
}

test("Settings synchronizes pristine fields and sends only dirty fields across contexts", async () => {
  const work = await loadOptions();
  const Storage = work.context.SceneMarks.Storage;
  work.get("defaultJumpBehavior").value = "pause-after-jump";
  await Storage.updateSettings({ enableFloatingButton: false, hotkeys: { nextScene: "X" } });
  assert.equal(work.get("enableFloatingButton").checked, false);
  assert.equal(work.get("nextSceneHotkey").value, "X");
  assert.equal(work.get("defaultJumpBehavior").value, "pause-after-jump");
  work.get("quickSaveHotkey").value = "Q";
  await work.get("settingsForm").emit("submit");
  const sent = work.messages.filter((item) => item.type === "SCENEMARKS_STORAGE_RPC").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.payload.args[0])), {
    defaultJumpBehavior: "pause-after-jump", hotkeys: { quickSave: "Q" }
  });
  const saved = await Storage.getSettings();
  assert.equal(saved.enableFloatingButton, false);
  assert.equal(saved.hotkeys.nextScene, "X");
  assert.equal(saved.hotkeys.quickSave, "Q");
});

test("Settings preserves edits made while a save is in flight", async () => {
  const work = await loadOptions();
  const original = work.context.chrome.runtime.sendMessage;
  let release;
  work.context.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === "SCENEMARKS_STORAGE_RPC") release = () => original(message, callback);
    else return original(message, callback);
  };
  work.get("quickSaveHotkey").value = "Q";
  const saving = work.get("settingsForm").emit("submit");
  work.get("quickSaveHotkey").value = "W";
  release();
  await saving;
  assert.equal(work.get("quickSaveHotkey").value, "W");
});

test("all supported recorded keyboard codes round-trip to the content matcher", async () => {
  const options = await loadOptions();
  const content = createWorkflow();
  content.context.SceneMarks.VideoDetector = { createVideoDetector: () => ({
    getSnapshot: () => ({ detected: true, videoKey: "key", platform: "youtube", currentTimeSeconds: 10 }),
    start() {}, stop() {}, scheduleScan() {}, seekTo: async () => ({ ok: true })
  }) };
  content.load("src/content/overlay.js");
  content.load("src/content/content-script.js");
  await flush();
  const codes = [
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`),
    ..."0123456789".split("").flatMap((digit) => [`Digit${digit}`, `Numpad${digit}`]),
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
    "Comma", "Period", "Slash", "Backslash", "Semicolon", "Quote", "BracketLeft", "BracketRight", "Minus", "Equal", "Backquote",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Insert", "Delete", "Space", "Enter", "Tab", "Backspace",
    "NumpadEnter", "NumpadDecimal", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadEqual", "NumpadComma", "NumpadParenLeft", "NumpadParenRight", "NumpadClear", "NumpadClearEntry"
  ];
  for (const code of codes) {
    await options.record.emit("click");
    await options.document.emit("keydown", keyboard(code));
    const recorded = options.get("quickSaveHotkey").value;
    await content.context.SceneMarks.Storage.updateSettings({ hotkeys: { quickSave: recorded } });
    let matched = false;
    await content.events.emit("keydown", keyboard(code, { stopImmediatePropagation() { matched = true; } }));
    assert.equal(matched, true, `${code} recorded as ${recorded}`);
  }
});
