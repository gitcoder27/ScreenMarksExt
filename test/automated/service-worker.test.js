"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

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
// storage reads, so a test can tell what a bare worker start costs.
function loadWorker(seedState) {
  const listeners = {};
  const event = (name) => ({
    addListener(fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    }
  });
  const store = { reads: 0, writes: 0, value: JSON.parse(JSON.stringify(seedState)) };
  const openedTabs = [];

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
    tabs: {
      query: async () => [],
      create: async (options) => {
        openedTabs.push(options);
      }
    },
    storage: {
      local: {
        get(_keys, callback) {
          store.reads += 1;
          setImmediate(() => callback({ scenemarksState: JSON.parse(JSON.stringify(store.value)) }));
        },
        set(values, callback) {
          store.writes += 1;
          store.value = JSON.parse(JSON.stringify(values.scenemarksState));
          setImmediate(callback);
        }
      }
    }
  };

  const file = path.join(WORKER_DIR, "service-worker.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { listeners, openedTabs, store };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test("a worker wake does not read storage; install and browser start migrate", async () => {
  const { listeners, store } = loadWorker({ videos: { [LEGACY_KEY]: legacyVideo() } });
  await settle();
  assert.equal(store.reads, 0);

  listeners.onInstalled.forEach((listener) => listener({ reason: "update" }));
  await settle();
  assert.equal(store.writes, 1);
  assert.deepEqual(Object.keys(store.value.videos), [MIGRATED_KEY]);

  // Nothing left to migrate: browser start reads but does not rewrite.
  listeners.onStartup.forEach((listener) => listener());
  await settle();
  assert.equal(store.writes, 1);
});

test("an import of legacy data is migrated right after it lands", async () => {
  const { listeners, store } = loadWorker({ videos: {} });
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
  assert.deepEqual(Object.keys(store.value.videos), [MIGRATED_KEY]);
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
  const { listeners, openedTabs } = loadWorker({ videos });

  const response = await new Promise((resolve) => {
    listeners.onMessage[0]({ type: "SCENEMARKS_OPEN_RANDOM_VIDEOS", payload: { count: 50 } }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.openedCount, 10);
  assert.equal(response.requestedCount, 10);
  assert.equal(openedTabs.length, 10);
});
