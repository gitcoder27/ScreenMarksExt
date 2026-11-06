"use strict";

const path = require("node:path");
const { createStorageArea } = require("./helpers");
const { createWorkflow, flush } = require("./workflow-helpers");

// Separate VM worlds share a single worker writer, a serialized Chrome storage
// double, browser-assigned tab senders and broadcast storage events. Target
// content initialization is explicit, so tests can hold a new tab loading.
function createJumpBrowser(seed = {}) {
  const store = createStorageArea(seed);
  const changed = [];
  const realSet = store.local.set;
  store.local.set = (values, callback) => {
    const changes = {};
    for (const [key, value] of Object.entries(values)) changes[key] = { oldValue: store.raw(key), newValue: value };
    realSet(values, callback);
    for (const listener of changed) listener(changes, "local");
  };
  const world = () => createWorkflow({}, { store, changed, manageChanges: false });
  const worker = world();
  const listeners = {};
  const event = (name) => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
  const tabs = new Map();
  const operations = [];
  let nextTabId = 100;
  let navigate = null;
  worker.context.chrome.runtime.onInstalled = event("installed");
  worker.context.chrome.runtime.onStartup = event("startup");
  worker.context.chrome.commands = { onCommand: event("command") };
  worker.context.chrome.action = { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} };
  worker.context.chrome.tabs = {
    onUpdated: event("updated"),
    query: async () => [...tabs.values()],
    async create(options) {
      const tab = { id: nextTabId++, ...options };
      tabs.set(tab.id, tab);
      operations.push({ type: "create", ...tab });
      return tab;
    },
    async update(id, options) {
      operations.push({ type: "navigate", id, ...options, pending: store.raw("pendingJump") });
      if (navigate) await navigate(id, options);
      const tab = { ...tabs.get(id), ...options };
      tabs.set(id, tab);
      return tab;
    },
    async remove(id) { operations.push({ type: "remove", id }); tabs.delete(id); }
  };
  // These worlds model worker wakes inside an already-checked extension
  // load, so the once-per-load migration pass is already done (see
  // service-worker.test.js for the migration check itself).
  const session = { migrationsChecked: true };
  worker.context.chrome.storage.session = {
    get: async (key) => (key in session ? { [key]: session[key] } : {}),
    set: async (values) => { Object.assign(session, values); }
  };
  worker.context.importScripts = (...files) => {
    for (const file of files) worker.load(path.posix.normalize(`src/background/${file}`));
  };
  worker.load("src/background/service-worker.js");

  function connect(work, id, url) {
    work.context.location = new URL(url);
    tabs.set(id, { id, url });
    work.context.chrome.runtime.sendMessage = (message, callback) => {
      work.messages.push(message);
      const promise = worker.send(message, { url, tab: { id, url }, frameId: 0 });
      if (callback) { promise.then(callback); return; }
      return promise;
    };
    return work;
  }

  function content(id, snapshot, seek = async () => ({ ok: true })) {
    const work = connect(world(), id, snapshot.rawUrl);
    let current = { ...snapshot };
    const seeks = [];
    work.context.SceneMarks.VideoDetector = { createVideoDetector: () => ({
      getSnapshot: () => ({ ...current }), start() {}, stop() {}, scheduleScan() {},
      async seekTo(seconds, behavior, options) {
        seeks.push(seconds);
        return seek(seconds, behavior, options);
      }
    }) };
    work.load("src/content/overlay.js");
    work.load("src/content/content-script.js");
    return { ...work, seeks, setSnapshot(value) { current = { ...current, ...value }; } };
  }

  async function library(id = 50) {
    const work = connect(world(), id, "chrome-extension://scenemarks/src/library/library.html");
    work.context.window = work.context;
    work.context.scrollY = 0;
    work.context.scrollTo = () => {};
    work.load("src/library/library.js");
    await work.document.emit("DOMContentLoaded");
    await work.get("expandAllButton").emit("click");
    return work;
  }

  const extensionSender = { url: "chrome-extension://scenemarks/src/library/library.html" };
  return {
    store, worker, tabs, operations, listeners, content, library,
    setNavigate(fn) { navigate = fn; },
    open: (payload) => worker.send({ type: "SCENEMARKS_OPEN_VIDEO_AT_SCENE", payload }, extensionSender),
    async settle() { await flush(); await flush(); }
  };
}

module.exports = { createJumpBrowser };
