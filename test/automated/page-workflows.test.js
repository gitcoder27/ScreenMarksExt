"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkflow, FakeElement, flush, keyboard } = require("./workflow-helpers");

async function loadPopup({ range = false, conflict = false } = {}) {
  const work = createWorkflow();
  let seconds = 30;
  let videoKey = "youtube:abcdEFGH123";
  const captures = [];
  let attempts = 0;
  const response = () => ({
    ok: true, context: { detected: true, videoKey, currentTimeSeconds: seconds, platform: "youtube", durationSeconds: 600 },
    scenes: [], settings: work.context.SceneMarks.Schema.normalizeSettings({}),
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

test("popup captures fresh time when opening a moment dialog and retains it through duplicate retry", async () => {
  const work = await loadPopup({ conflict: true });
  work.setTime(60);
  const pending = work.get("saveMomentButton").emit("click");
  await flush();
  assert.equal(work.get("dialogTime").textContent, "Time: 01:00");
  work.setTime(80);
  work.get("noteInput").value = "typed for twenty seconds";
  await work.get("sceneForm").emit("submit");
  await pending;
  assert.equal(work.captures.length, 2);
  assert.equal(work.captures[0].payload.capture.seconds, 60);
  assert.equal(work.captures[1].payload.capture.seconds, 60);
  assert.equal(work.captures[1].payload.allowDuplicate, true);
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
