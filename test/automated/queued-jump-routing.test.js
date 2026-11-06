"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJumpBrowser } = require("./queued-jump-browser");
const { deferred } = require("./workflow-helpers");

const KEY = "youtube:abcdEFGH123";
const URL = "https://www.youtube.com/watch?v=abcdEFGH123";
const SNAPSHOT = { detected: true, videoKey: KEY, platform: "youtube", rawUrl: URL, canonicalUrl: URL, currentTimeSeconds: 1 };
const JUMP = { videoKey: KEY, sceneId: "scene", seconds: 42, url: URL };
const VIDEO = { videoKey: KEY, platform: "youtube", title: "Saved video", canonicalUrl: URL,
  scenes: [{ id: "scene", startSeconds: 42, note: "private note" }] };

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test("Library jump stays owned by the slow new tab while an existing same-video tab is ready", async () => {
  for (const settings of [{}, { extensionEnabled: false }, { disabledSites: ["youtube.com"] }]) {
    const browser = createJumpBrowser({ settings, [`video:${KEY}`]: VIDEO });
    const existing = browser.content(1, SNAPSHOT);
    await browser.settle();
    const library = await browser.library();
    const jump = descendants(library.get("libraryList")).find((node) => node.tagName === "BUTTON" && node.textContent === "Jump");
    assert.ok(jump);
    await jump.emit("click");
    await browser.settle();
    assert.equal(library.messages.filter((message) => message.type === "SCENEMARKS_STORAGE_RPC").length, 0);
    assert.equal(library.messages.at(-1).type, "SCENEMARKS_OPEN_VIDEO_AT_SCENE");
    const pending = browser.store.raw("pendingJump");
    assert.equal(pending.targetTabId, 100);
    assert.equal(browser.operations[0].url, "about:blank");
    assert.equal(browser.operations[1].pending.targetTabId, 100); // Owned BEFORE navigation.
    await existing.advance(100);
    await existing.advance(10000);
    assert.deepEqual(existing.seeks, []);
    assert.equal(browser.store.raw("pendingJump").requestId, pending.requestId);

    // The target has not initialized until now. No tab activation/user gesture
    // or enabled-site setting is needed for its queued jump to land.
    const target = browser.content(100, SNAPSHOT);
    await browser.settle();
    await target.advance(1000);
    await browser.settle();
    assert.deepEqual(target.seeks, [42]);
    assert.deepEqual(existing.seeks, []);
    assert.equal(browser.store.raw("pendingJump"), null);
    assert.ok(browser.store.writeLog.every((write) => write.set.join() === "pendingJump"));
  }
});

test("only the intended tab retries a temporarily unready seek", async () => {
  const browser = createJumpBrowser();
  const existing = browser.content(1, SNAPSHOT);
  await browser.open(JUMP);
  let ready = false;
  const target = browser.content(100, SNAPSHOT, async () => ({ ok: ready }));
  await browser.settle();
  await existing.advance(1000);
  await target.advance(1000);
  assert.deepEqual(existing.seeks, []);
  assert.deepEqual(target.seeks, [42]);
  assert.notEqual(browser.store.raw("pendingJump"), null);
  ready = true;
  await target.advance(1000);
  await browser.settle();
  assert.deepEqual(target.seeks, [42, 42]);
  assert.equal(browser.store.raw("pendingJump"), null);
});

test("replacing an in-flight jump with a different destination cannot let the old tab consume or run it", async () => {
  const browser = createJumpBrowser();
  await browser.open(JUMP);
  const seeking = deferred();
  const first = browser.content(100, SNAPSHOT, () => seeking.promise);
  await browser.settle();
  await first.advance(1000);
  assert.deepEqual(first.seeks, [42]);
  await browser.open({ ...JUMP, seconds: 99 });
  const replacement = browser.store.raw("pendingJump");
  assert.equal(replacement.targetTabId, 101);
  await first.advance(100);
  seeking.resolve({ ok: true });
  await browser.settle();
  await first.advance(10000);
  assert.deepEqual(first.seeks, [42]);
  assert.equal(browser.store.raw("pendingJump").requestId, replacement.requestId);
  const second = browser.content(101, SNAPSHOT);
  await browser.settle();
  await second.advance(1000);
  await browser.settle();
  assert.deepEqual(second.seeks, [99]);
  assert.equal(browser.store.raw("pendingJump"), null);
});

test("worker sender checks reject spoofed ownership, subframes, and direct queue publication", async () => {
  const browser = createJumpBrowser();
  await browser.open(JUMP);
  const pending = browser.store.raw("pendingJump");
  const args = [KEY, pending.requestId, pending.targetTabId];
  const consume = { type: "SCENEMARKS_STORAGE_RPC", payload: { method: "consumePendingJump", args } };
  const before = browser.store.writes;
  for (const sender of [
    { url: URL, tab: { id: 1 }, frameId: 0 },
    { url: URL, tab: { id: 100 }, frameId: 1 },
    { url: "chrome-extension://scenemarks/src/library/library.html" }, {}
  ]) {
    const response = await browser.worker.send(consume, sender);
    assert.equal(response.result.ok, false);
  }
  const denied = await browser.worker.send({ type: "SCENEMARKS_STORAGE_RPC", payload: { method: "setPendingJump", args: [JUMP] } }, { url: URL, tab: { id: 1 }, frameId: 0 });
  assert.equal(denied.ok, false);
  const noOpen = await browser.worker.send({ type: "SCENEMARKS_OPEN_VIDEO_AT_SCENE", payload: JUMP }, { url: URL, tab: { id: 1 }, frameId: 0 });
  assert.equal(noOpen.ok, false);
  assert.equal(browser.store.writes, before);
  const consumed = await browser.worker.send(consume, { url: URL, tab: { id: 100 }, frameId: 0 });
  assert.equal(consumed.result.ok, true);
  assert.equal(browser.store.raw("pendingJump"), null);
});

test("legacy ownerless requests remain readable but no matching tab may claim them", async () => {
  const legacy = { ...JUMP, createdAt: new Date().toISOString() };
  const browser = createJumpBrowser({ pendingJump: legacy });
  const existing = browser.content(1, SNAPSHOT);
  const other = browser.content(2, SNAPSHOT);
  await browser.settle();
  await existing.advance(1000);
  await other.advance(1000);
  assert.deepEqual(existing.seeks, []);
  assert.deepEqual(other.seeks, []);
  assert.deepEqual(browser.store.raw("pendingJump"), legacy);
  assert.equal(browser.store.writes, 0);
  await browser.open(JUMP); // Deliberate re-open safely replaces the old request.
  const target = browser.content(100, SNAPSHOT);
  await browser.settle();
  await target.advance(1000);
  await browser.settle();
  assert.deepEqual(target.seeks, [42]);
  assert.equal(browser.store.raw("pendingJump"), null);
});

test("a failed opening clears only its own request and removes its unused tab", async () => {
  const browser = createJumpBrowser();
  let newer;
  browser.setNavigate(async (id) => {
    if (id === 100) {
      newer = await browser.worker.context.SceneMarks.Storage.setPendingJump({ ...JUMP, seconds: 99, targetTabId: 101 });
      throw new Error("navigation failed");
    }
  });
  const response = await browser.open(JUMP);
  assert.equal(response.ok, false);
  assert.match(response.error, /navigation failed/);
  assert.equal(browser.store.raw("pendingJump").requestId, newer.pendingJump.requestId);
  assert.equal(browser.tabs.has(100), false);
  const target = browser.content(101, SNAPSHOT);
  await browser.settle();
  await target.advance(1000);
  await browser.settle();
  assert.deepEqual(target.seeks, [99]);
});

test("invalid or unwritable opening creates no navigated tab and preserves the previous jump", async () => {
  const browser = createJumpBrowser();
  for (const payload of [{ ...JUMP, url: "javascript:alert(1)" }, { ...JUMP, seconds: -1 }]) {
    assert.equal((await browser.open(payload)).ok, false);
  }
  assert.deepEqual(browser.operations, []);
  await browser.open(JUMP);
  const previous = browser.store.raw("pendingJump");
  const realSet = browser.store.local.set;
  browser.store.local.set = (_values, callback) => {
    browser.worker.context.chrome.runtime.lastError = { message: "quota exceeded" };
    callback();
    browser.worker.context.chrome.runtime.lastError = null;
  };
  const failed = await browser.open({ ...JUMP, seconds: 99 });
  browser.store.local.set = realSet;
  assert.equal(failed.ok, false);
  assert.match(failed.error, /quota/);
  assert.equal(browser.store.raw("pendingJump").requestId, previous.requestId);
  assert.equal(browser.tabs.has(101), false);
  assert.equal(browser.operations.filter((op) => op.type === "navigate").length, 1);
});

test("owned jumps retain their destination and request token through video migrations", async () => {
  const legacyKey = "generic:https://www.youtube.com:/watch";
  const legacyVideo = { ...VIDEO, videoKey: legacyKey, platform: "generic", rawUrls: [URL] };
  const browser = createJumpBrowser({ schemaVersion: 2, [`video:${legacyKey}`]: legacyVideo });
  const existing = browser.content(1, SNAPSHOT);
  await browser.open({ ...JUMP, videoKey: legacyKey });
  const before = browser.store.raw("pendingJump");
  await browser.worker.context.SceneMarks.Migrations.runAll();
  const migrated = browser.store.raw("pendingJump");
  assert.equal(migrated.videoKey, KEY);
  assert.equal(migrated.targetTabId, 100);
  assert.equal(migrated.requestId, before.requestId);
  assert.equal(browser.store.raw(`video:${KEY}`).scenes[0].note, "private note");
  const writes = browser.store.writes;
  await browser.worker.context.SceneMarks.Migrations.runAll();
  assert.equal(browser.store.writes, writes);
  await existing.advance(1000);
  assert.deepEqual(existing.seeks, []);
  const target = browser.content(100, SNAPSHOT);
  await browser.settle();
  await target.advance(1000);
  await browser.settle();
  assert.deepEqual(target.seeks, [42]);
  assert.equal(browser.store.raw("pendingJump"), null);
});

test("a destination can retry its tab identity lookup without disabling other content behavior", async () => {
  const browser = createJumpBrowser();
  await browser.open(JUMP);
  const target = browser.content(100, SNAPSHOT);
  const realSend = target.context.chrome.runtime.sendMessage;
  let unavailable = true;
  target.context.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === "SCENEMARKS_GET_TAB_ID" && unavailable) return Promise.resolve({ ok: false, tabId: null });
    return realSend(message, callback);
  };
  await browser.settle();
  await target.advance(1000);
  assert.deepEqual(target.seeks, []);
  assert.notEqual(browser.store.raw("pendingJump"), null);
  unavailable = false;
  await target.advance(1000);
  await browser.settle();
  assert.deepEqual(target.seeks, [42]);
  assert.equal(browser.store.raw("pendingJump"), null);
});

test("browser startup invalidates old-session tab ownership while ordinary worker wakes preserve it", async () => {
  const pendingJump = { ...JUMP, requestId: "old-session", targetTabId: 100, createdAt: new Date().toISOString() };
  const browser = createJumpBrowser({ schemaVersion: 3, pendingJump });
  await browser.settle();
  assert.equal(browser.store.reads, 0); // Bare worker wake.
  assert.equal(browser.store.raw("pendingJump").targetTabId, 100);
  for (const listener of browser.listeners.startup) listener();
  await browser.settle();
  assert.equal(browser.store.raw("pendingJump"), null);
  const restored = browser.content(100, SNAPSHOT);
  await browser.settle();
  await restored.advance(1000);
  assert.deepEqual(restored.seeks, []);
});

test("a slow first tab allocation cannot publish over a more recent Library opening", async () => {
  const browser = createJumpBrowser();
  const allocated = deferred();
  const create = browser.worker.context.chrome.tabs.create;
  let count = 0;
  browser.worker.context.chrome.tabs.create = async (options) => {
    if (++count === 1) await allocated.promise;
    return create(options);
  };
  const first = browser.open(JUMP);
  const second = browser.open({ ...JUMP, seconds: 99 });
  await browser.settle();
  assert.equal(count, 1);
  assert.equal(browser.store.raw("pendingJump"), undefined);
  allocated.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(browser.store.raw("pendingJump").seconds, 99);
  assert.equal(browser.store.raw("pendingJump").targetTabId, 101);
});
