"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHARED_DIR = path.join(__dirname, "..", "..", "src", "shared");
// Same order as manifest.json content_scripts[0].js so load-order bugs show
// up here the same way they would in the browser.
const SHARED_FILES = [
  "constants.js",
  "time.js",
  "ids.js",
  "schema.js",
  "storage.js"
];

// The shared modules are classic scripts that attach to globalThis.SceneMarks,
// so evaluate them in this context instead of using require(). The worker
// alone also loads migrations.js (after the site adapters, which the
// generic re-keying needs but the storage split does not).
function loadSharedModules(options) {
  const files = options && options.withMigrations ? [...SHARED_FILES, "migrations.js"] : SHARED_FILES;
  delete globalThis.SceneMarks;
  files.forEach((file) => {
    const code = fs.readFileSync(path.join(SHARED_DIR, file), "utf8");
    vm.runInThisContext(code, { filename: `src/shared/${file}` });
  });
  return globalThis.SceneMarks;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const VIDEO_PREFIX = "video:";

// The schema-2 entries for a { videoKey: video } map.
function videoEntries(videos) {
  const entries = {};
  Object.values(videos).forEach((video) => {
    entries[`${VIDEO_PREFIX}${video.videoKey}`] = video;
  });
  return entries;
}

// In-memory chrome.storage.local double with the callback signature
// storage.js expects. Values are deep-copied on get and set to mimic the
// real API's serialization, so tests assert persisted data rather than live
// references. Every set/remove/clear call is logged with the keys it
// touched, which is what a storage.onChanged event would carry.
function createStorageArea(seedEntries) {
  const store = new Map(Object.entries(clone(seedEntries || {})));
  const writeLog = [];
  // Each get call's keys, sorted, or null for a read of everything.
  const readLog = [];

  const local = {
    get(keys, callback) {
      const everything = keys === null || keys === undefined;
      readLog.push(everything ? null : [].concat(keys).sort());
      const names = everything ? Array.from(store.keys()) : [].concat(keys);
      const result = {};
      names.forEach((name) => {
        if (store.has(name)) {
          result[name] = clone(store.get(name));
        }
      });
      callback(result);
    },
    set(values, callback) {
      Object.entries(values).forEach(([name, value]) => store.set(name, clone(value)));
      writeLog.push({ set: Object.keys(values).sort(), remove: [] });
      callback();
    },
    remove(keys, callback) {
      const names = [].concat(keys);
      names.forEach((name) => store.delete(name));
      writeLog.push({ set: [], remove: names.sort() });
      callback();
    },
    clear(callback) {
      const names = Array.from(store.keys()).sort();
      store.clear();
      writeLog.push({ set: [], remove: names });
      callback();
    }
  };

  return {
    local,
    readLog,
    writeLog,
    get reads() {
      return readLog.length;
    },
    get writes() {
      return writeLog.length;
    },
    keys() {
      return Array.from(store.keys()).sort();
    },
    raw(name) {
      return clone(store.get(name));
    },
    // The stored entries reassembled into the state shape tests assert on.
    readState() {
      const state = {
        videos: {},
        settings: clone(store.get("settings")),
        activeRangeDraft: store.has("activeRangeDraft") ? clone(store.get("activeRangeDraft")) : null,
        pendingJump: store.has("pendingJump") ? clone(store.get("pendingJump")) : null
      };
      store.forEach((value, name) => {
        if (name.startsWith(VIDEO_PREFIX)) {
          state.videos[name.slice(VIDEO_PREFIX.length)] = clone(value);
        }
      });
      return state;
    }
  };
}

function installChromeStorageMock(seedEntries) {
  const area = createStorageArea(seedEntries);
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: { local: area.local }
  };
  return area;
}

module.exports = {
  clone,
  createStorageArea,
  installChromeStorageMock,
  loadSharedModules,
  videoEntries
};
