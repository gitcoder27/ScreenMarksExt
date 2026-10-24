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
// start costs.
function loadWorker(seedEntries, options) {
  const listeners = {};
  const event = (name) => ({
    addListener(fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    }
  });
  const store = createStorageArea(seedEntries);
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
      },
      onUpdated: event("tabs.onUpdated")
    },
    storage: { local: store.local, onChanged: event("storage.onChanged") }
  };

  const file = path.join(WORKER_DIR, "service-worker.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { badges, context, listeners, openedTabs, store };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test("a worker wake does not read storage; install and browser start migrate", async () => {
  // A schema-1 library holding a video saved before the YouTube adapter.
  const { listeners, store } = loadWorker({
    scenemarksState: { videos: { [LEGACY_KEY]: legacyVideo() }, settings: { duplicateThresholdSeconds: 7 } }
  });
  await settle();
  assert.equal(store.reads, 0);

  // Install/update splits the blob into per-video keys, then re-keys the
  // generic video.
  listeners.onInstalled.forEach((listener) => listener({ reason: "update" }));
  await settle();
  assert.deepEqual(store.keys(), ["schemaVersion", "settings", `video:${MIGRATED_KEY}`]);
  assert.equal(store.raw("schemaVersion"), 2);
  assert.equal(store.raw("settings").duplicateThresholdSeconds, 7);
  assert.deepEqual(store.raw(`video:${MIGRATED_KEY}`).scenes.map((scene) => scene.id), ["scene_1"]);

  // Nothing left to migrate: browser start reads but does not rewrite.
  const writesBefore = store.writes;
  listeners.onStartup.forEach((listener) => listener());
  await settle();
  assert.equal(store.writes, writesBefore);
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
