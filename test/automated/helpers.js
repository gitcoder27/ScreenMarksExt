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
// so evaluate them in this context instead of using require().
function loadSharedModules() {
  delete globalThis.SceneMarks;
  SHARED_FILES.forEach((file) => {
    const code = fs.readFileSync(path.join(SHARED_DIR, file), "utf8");
    vm.runInThisContext(code, { filename: `src/shared/${file}` });
  });
  return globalThis.SceneMarks;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// In-memory chrome.storage.local double with the callback signature storage.js
// expects. Values are deep-copied on get and set to mimic the real API's
// serialization, so tests assert persisted data rather than live references.
function installChromeStorageMock(seedState) {
  const store = new Map();
  let writes = 0;
  if (seedState !== undefined) {
    store.set("scenemarksState", clone(seedState));
  }

  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          const names = keys === null || keys === undefined
            ? Array.from(store.keys())
            : [].concat(keys);
          names.forEach((name) => {
            if (store.has(name)) {
              result[name] = clone(store.get(name));
            }
          });
          callback(result);
        },
        set(values, callback) {
          Object.entries(values).forEach(([name, value]) => store.set(name, clone(value)));
          writes += 1;
          callback();
        }
      }
    }
  };

  return {
    get writes() {
      return writes;
    },
    readState() {
      return clone(store.get("scenemarksState"));
    }
  };
}

module.exports = { clone, installChromeStorageMock, loadSharedModules };
