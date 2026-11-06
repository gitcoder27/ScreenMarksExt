"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const { createStorageArea, videoEntries } = require("./helpers");

const WORKER_DIR = path.join(__dirname, "..", "..", "src", "background");
const LEGACY_KEY = "generic:https://www.youtube.com:/watch";
const MIGRATED_KEY = "youtube:abcdEFGH123";

function legacyVideo() {
  return {
    videoKey: LEGACY_KEY,
    platform: "generic",
    title: "Old save",
    canonicalUrl: "https://www.youtube.com/watch?v=abcdEFGH123",
    rawUrls: ["https://www.youtube.com/watch?v=abcdEFGH123"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    scenes: [{ id: "scene_1", startSeconds: 10, createdAt: "2025-01-01T00:00:00.000Z" }]
  };
}

// Loads the real worker script, in a fresh context per call (its top-level
// consts cannot be declared twice), against a chrome double that counts
// storage reads and logs writes, so a test can tell what a bare worker
// start costs. Pass a previous result's `store` and `session` as options to
// simulate the worker waking again within the same extension load.
function loadWorker(seedEntries, options) {
  const { store: sharedStore, session: sharedSession } = options || {};
  const listeners = {};
  const event = (name) => ({
    addListener(fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    }
  });
  const store = sharedStore || createStorageArea(seedEntries);
  const session = sharedSession || {};
  const openedTabs = [];
  const openTabs = (options && options.tabs) || [];
  // The latest badge text set per tab id.
  const badges = {};

  const context = vm.createContext({ console, crypto, setImmediate, setTimeout, clearTimeout, URL });
  context.importScripts = (...files) => {
    files.forEach((file) => {
      const fullPath = path.join(WORKER_DIR, file);
      vm.runInContext(fs.readFileSync(fullPath, "utf8"), context, { filename: fullPath });
    });
  };
  context.chrome = {
    runtime: {
      lastError: null,
      getURL: (relative) => `chrome-extension://scenemarks/${relative}`,
      onInstalled: event("onInstalled"),
      onStartup: event("onStartup"),
      onMessage: event("onMessage")
    },
    commands: { onCommand: event("onCommand") },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        badges[tabId] = text;
      },
      setBadgeBackgroundColor: async () => {}
    },
    tabs: {
      query: async () => openTabs,
      create: async (options) => {
        openedTabs.push(options);
        return { id: 1000 + openedTabs.length, ...options };
      },
      update: async (id, options) => ({ id, ...options }),
      remove: async () => {},
      onUpdated: event("tabs.onUpdated")
    },
    storage: {
      local: store.local,
      onChanged: event("storage.onChanged"),
      // chrome.storage.session: survives worker restarts, cleared when the
      // extension is disabled, reloaded or the browser restarts.
      session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (values) => {
          Object.assign(session, values);
        }
      }
    }
  };

  const file = path.join(WORKER_DIR, "service-worker.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { badges, context, listeners, openedTabs, store, session };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test("enabling the extension migrates without an install or startup event", async () => {
  // Enabling a disabled unpacked extension fires neither onInstalled nor
  // onStartup: the worker has to notice the schema-1 blob on its own.
  const { store } = loadWorker({
    scenemarksState: { videos: { [LEGACY_KEY]: legacyVideo() }, settings: { duplicateThresholdSeconds: 7 } }
  });
  await settle();
  assert.deepEqual(store.keys(), ["schemaVersion", "settings", `video:${MIGRATED_KEY}`]);
  assert.equal(store.raw("schemaVersion"), 3);
  assert.equal(store.raw("settings").duplicateThresholdSeconds, 7);
  assert.deepEqual(store.raw(`video:${MIGRATED_KEY}`).scenes.map((scene) => scene.id), ["scene_1"]);
});

test("a later wake in the same load does not read storage; install and browser start re-check", async () => {
  const first = loadWorker({
    scenemarksState: { videos: { [LEGACY_KEY]: legacyVideo() } }
  });
  await settle();
  assert.equal(first.session.migrationsChecked, true);

  // The worker stopped and woke again: the session flag spares the reads.
  const readsBefore = first.store.reads;
  const writesBefore = first.store.writes;
  const { listeners } = loadWorker(null, { store: first.store, session: first.session });
  await settle();
  assert.equal(first.store.reads, readsBefore);

  // Nothing left to migrate: install and browser start share the settled
  // run, and a fresh load (empty session) reads but does not rewrite.
  listeners.onInstalled.forEach((listener) => listener({ reason: "update" }));
  listeners.onStartup.forEach((listener) => listener());
  await settle();
  // Browser start also checks the small pendingJump key to drop old-session
  // tab ownership; no migration read (legacy blob or video keys) happens.
  const startupReads = first.store.readLog.slice(readsBefore);
  assert.ok(startupReads.every((keys) => keys && !keys.includes("scenemarksState")
    && !keys.some((key) => key.startsWith("video:"))), JSON.stringify(startupReads));
  assert.equal(first.store.writes, writesBefore);

  loadWorker(null, { store: first.store, session: {} });
  await settle();
  assert.ok(first.store.reads > readsBefore);
  assert.equal(first.store.writes, writesBefore);
});

test("a wake without the session flag checks again (a failed pass never sets it)", async () => {
  const first = loadWorker({
    scenemarksState: { videos: { [LEGACY_KEY]: legacyVideo() } }
  });
  // A pass that died before setting the flag leaves it unset.
  delete first.session.migrationsChecked;
  const second = loadWorker(null, { store: first.store, session: first.session });
  await settle();
  assert.equal(second.session.migrationsChecked, true);
});

test("an import of legacy data is migrated right after it lands", async () => {
  const { listeners, store } = loadWorker({ schemaVersion: 2 });
  const response = await new Promise((resolve) => {
    listeners.onMessage[0](
      {
        type: "SCENEMARKS_STORAGE_RPC",
        payload: { method: "importState", args: [{ videos: { [LEGACY_KEY]: legacyVideo() } }, { merge: true }] }
      },
      { url: "chrome-extension://scenemarks/src/library/library.html" },
      resolve
    );
  });
  assert.equal(response.ok, true);

  await settle();
  assert.deepEqual(Object.keys(store.readState().videos), [MIGRATED_KEY]);
});

test("a batch Open Random opens at most the capped number of tabs", async () => {
  const videos = {};
  for (let index = 0; index < 15; index += 1) {
    const id = `video${String(index).padStart(6, "0")}`;
    videos[`youtube:${id}`] = {
      ...legacyVideo(),
      videoKey: `youtube:${id}`,
      platform: "youtube",
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      rawUrls: []
    };
  }
  const { listeners, openedTabs } = loadWorker(videoEntries(videos));

  const response = await new Promise((resolve) => {
    listeners.onMessage[0]({ type: "SCENEMARKS_OPEN_RANDOM_VIDEOS", payload: { count: 50 } }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.openedCount, 10);
  assert.equal(response.requestedCount, 10);
  assert.equal(openedTabs.length, 10);
});

test("the worker's RPC whitelist matches the storage client's mutation methods", () => {
  const { context } = loadWorker({});
  const whitelist = vm.runInContext("Array.from(STORAGE_RPC_METHODS).sort()", context);
  const clientMethods = vm.runInContext(
    "Object.keys(SceneMarks.Storage.createClient()).filter((name) => !['getState', 'getScenesForVideo', 'getSettings'].includes(name)).sort()",
    context
  );

  assert.deepEqual(whitelist, clientMethods);
  ["updateState", "updateRawKeys", "upsertVideo"].forEach((name) => assert.equal(whitelist.includes(name), false));
});

test("badges read OFF on switched-off and paused sites only", async () => {
  const tabs = [
    { id: 1, url: "https://www.youtube.com/watch?v=abc" },
    { id: 2, url: "https://music.youtube.com/" },
    { id: 3, url: "https://www.netflix.com/watch/1" },
    { id: 4, url: "chrome://extensions/" }
  ];
  const { badges, listeners } = loadWorker(
    { schemaVersion: 2, settings: { disabledSites: ["youtube.com"] } },
    { tabs }
  );

  listeners.onInstalled.forEach((listener) => listener({ reason: "update" }));
  await settle();
  assert.deepEqual(badges, { 1: "OFF", 2: "OFF", 3: "", 4: "" });

  // Pausing everywhere turns every web page's badge off.
  listeners["storage.onChanged"].forEach((listener) => listener({
    settings: {
      oldValue: { disabledSites: ["youtube.com"] },
      newValue: { disabledSites: ["youtube.com"], extensionEnabled: false }
    }
  }, "local"));
  await settle();
  assert.deepEqual(badges, { 1: "OFF", 2: "OFF", 3: "OFF", 4: "" });

  // A tab navigating re-applies its badge from the cached settings.
  listeners["storage.onChanged"].forEach((listener) => listener({
    settings: { oldValue: { extensionEnabled: false }, newValue: { disabledSites: ["netflix.com"] } }
  }, "local"));
  await settle();
  listeners["tabs.onUpdated"].forEach((listener) => listener(1, { url: "https://www.netflix.com/" }, { id: 1, url: "https://www.netflix.com/" }));
  await settle();
  assert.equal(badges[1], "OFF");
  assert.equal(badges[2], "");
});

test("open-tab matching uses service identity and preserves case-sensitive generic identity", async () => {
  const { context } = loadWorker({});
  const key = (url) => {
    context.testUrl = url;
    return vm.runInContext("normalizeUrlKey(testUrl)", context);
  };
  const watch = "https://www.youtube.com/watch?v=abcdEFGH123";
  assert.equal(key(watch), key("https://www.youtube.com/shorts/abcdEFGH123"));
  assert.equal(key(watch), key("https://youtu.be/abcdEFGH123?t=42"));
  assert.notEqual(key(watch), key("https://www.youtube.com/watch?v=abcdefgh123"));
  assert.notEqual(key("https://example.com/Watch?id=A"), key("https://example.com/watch?id=A"));
  assert.notEqual(key("https://example.com/watch?id=A"), key("https://example.com/watch?id=B"));
  assert.equal(key("https://example.com/watch?id=A&utm_source=mail"), key("https://example.com/watch?id=A"));
});

test("Random excludes YouTube short-link tabs and respects explicitly empty filters", async () => {
  const video = { ...legacyVideo(), videoKey: MIGRATED_KEY, platform: "youtube" };
  const work = loadWorker(videoEntries({ [MIGRATED_KEY]: video }), { tabs: [{ url: "https://youtu.be/abcdEFGH123" }] });
  for (const message of [
    { type: "SCENEMARKS_OPEN_RANDOM_VIDEO" },
    { type: "SCENEMARKS_PICK_RANDOM_VIDEO", payload: { videoKeys: [] } },
    { type: "SCENEMARKS_OPEN_RANDOM_VIDEOS", payload: { videoKeys: [], count: 3 } }
  ]) {
    const response = await new Promise((resolve) => work.listeners.onMessage[0](message, {}, resolve));
    assert.equal(response.ok, false);
  }
  assert.equal(work.openedTabs.length, 0);
  // Empty filters must also fail when a matching video is NOT open.
  const closed = loadWorker(videoEntries({ [MIGRATED_KEY]: video }));
  for (const type of ["SCENEMARKS_PICK_RANDOM_VIDEO", "SCENEMARKS_OPEN_RANDOM_VIDEOS"]) {
    const response = await new Promise((resolve) => closed.listeners.onMessage[0]({ type, payload: { videoKeys: [], count: 2 } }, {}, resolve));
    assert.equal(response.ok, false);
  }
  assert.equal(closed.openedTabs.length, 0);
  const unfiltered = await new Promise((resolve) => closed.listeners.onMessage[0]({ type: "SCENEMARKS_PICK_RANDOM_VIDEO" }, {}, resolve));
  assert.equal(unfiltered.ok, true);
});

test("generic re-keying merges an existing destination and atomically moves transient references", async () => {
  const now = new Date().toISOString();
  const destination = { ...legacyVideo(), videoKey: MIGRATED_KEY, platform: "youtube", title: "New title",
    scenes: [{ id: "new", startSeconds: 30 }] };
  const work = loadWorker({
    schemaVersion: 2,
    ...videoEntries({ old: legacyVideo(), destination }),
    activeRangeDraft: { videoKey: LEGACY_KEY, startSeconds: 40, createdAt: now },
    pendingJump: { videoKey: LEGACY_KEY, sceneId: "scene_1", seconds: 10, url: legacyVideo().canonicalUrl, createdAt: now, targetTabId: 1 }
  });
  await work.context.SceneMarks.Migrations.runAll();
  assert.equal(work.store.raw(`video:${LEGACY_KEY}`), undefined);
  const stored = work.store.raw(`video:${MIGRATED_KEY}`);
  assert.equal(stored.title, "New title");
  assert.deepEqual(stored.scenes.map((scene) => scene.id), ["scene_1", "new"]);
  assert.equal(work.store.raw("activeRangeDraft").videoKey, MIGRATED_KEY);
  assert.equal(work.store.raw("pendingJump").videoKey, MIGRATED_KEY);
  const rekeyWrite = work.store.writeLog.find((entry) => entry.set.includes(`video:${MIGRATED_KEY}`));
  assert.deepEqual(rekeyWrite.set, ["activeRangeDraft", "pendingJump", `video:${MIGRATED_KEY}`]);
  const finished = await work.context.SceneMarks.Storage.endRange({ videoKey: MIGRATED_KEY, platform: "youtube" }, 50);
  assert.equal(finished.ok, true);
  const jump = (await work.context.SceneMarks.Storage.getState({ videoKeys: [] })).pendingJump;
  assert.equal((await work.context.SceneMarks.Storage.consumePendingJump(MIGRATED_KEY, jump.requestId, 1)).ok, true);
  const writes = work.store.writes;
  await work.context.SceneMarks.Migrations.runAll();
  assert.equal(work.store.writes, writes);
});

test("schema-3 migration preserves query identities and retains ambiguous legacy scenes for repair", async () => {
  const keyA = "generic:https://example.com:/watch";
  const keyB = "generic:https://other.example:/watch";
  const source = { ...legacyVideo(), videoKey: keyA, platform: "generic",
    canonicalUrl: "https://example.com/watch", rawUrls: ["https://example.com/watch?id=A&utm_source=mail"] };
  const mixed = { ...source, videoKey: keyB, canonicalUrl: "https://other.example/watch",
    rawUrls: ["https://other.example/watch?id=A", "https://other.example/watch?id=B"] };
  const work = loadWorker({ schemaVersion: 2, ...videoEntries({ source, mixed }) });
  await work.context.SceneMarks.Migrations.runAll();
  const migrated = work.store.raw("video:generic:v2:https://example.com/watch?id=A");
  assert.equal(migrated.canonicalUrl, "https://example.com/watch?id=A");
  assert.equal(migrated.title, source.title);
  assert.deepEqual(migrated.scenes.map((scene) => scene.id), ["scene_1"]);
  assert.equal(work.store.raw(`video:${keyA}`), undefined);
  const retained = work.store.raw(`video:${keyB}`);
  assert.equal(retained.identityRepairRequired, true);
  assert.deepEqual(retained.scenes.map((scene) => scene.id), ["scene_1"]);
  assert.deepEqual(retained.rawUrls, mixed.rawUrls);
  const writes = work.store.writes;
  await work.context.SceneMarks.Migrations.runAll();
  assert.equal(work.store.writes, writes);
});

test("a failed re-key write preserves old data and transient references for retry", async () => {
  const now = new Date().toISOString();
  const work = loadWorker({ schemaVersion: 3, ...videoEntries({ old: legacyVideo() }),
    activeRangeDraft: { videoKey: LEGACY_KEY, startSeconds: 10, createdAt: now } });
  const realSet = work.store.local.set;
  work.store.local.set = (_values, callback) => {
    work.context.chrome.runtime.lastError = { message: "write failed" };
    callback();
    work.context.chrome.runtime.lastError = null;
  };
  await assert.rejects(work.context.SceneMarks.Migrations.runAll(), /write failed/);
  assert.ok(work.store.raw(`video:${LEGACY_KEY}`));
  assert.equal(work.store.raw("activeRangeDraft").videoKey, LEGACY_KEY);
  work.store.local.set = realSet;
  await work.context.SceneMarks.Migrations.runAll();
  assert.ok(work.store.raw(`video:${MIGRATED_KEY}`));
  assert.equal(work.store.raw("activeRangeDraft").videoKey, MIGRATED_KEY);
});

test("v2 generic saves still upgrade when a dedicated platform adapter becomes available", async () => {
  const old = { ...legacyVideo(), videoKey: "generic:v2:https://www.youtube.com/watch?v=abcdEFGH123" };
  const work = loadWorker({ schemaVersion: 3, ...videoEntries({ old }) });
  await work.context.SceneMarks.Migrations.runAll();
  assert.equal(work.store.raw(`video:${old.videoKey}`), undefined);
  assert.equal(work.store.raw(`video:${MIGRATED_KEY}`).title, old.title);
  const writes = work.store.writes;
  await work.context.SceneMarks.Migrations.runAll();
  assert.equal(work.store.writes, writes);
});
