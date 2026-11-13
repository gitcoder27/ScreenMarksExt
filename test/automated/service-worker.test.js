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
  // Offscreen document creates/closes, runtime broadcasts and tab messages.
  const offscreenLog = [];
  const runtimeMessages = [];
  const tabMessages = [];
  const updatedTabs = [];
  let offscreenOpen = Boolean(options && options.offscreenOpen);

  const context = vm.createContext({ console, crypto, setImmediate, setTimeout, clearTimeout, URL, TextEncoder, btoa });
  // chrome.downloads double: `disk` is the downloads folder (path -> text),
  // overwritten in place like conflictAction "overwrite"; `downloads` logs
  // each download call and `erased` each erase.
  const disk = new Map();
  const downloadLog = [];
  const erased = [];
  const downloadItems = new Map();
  const downloadListeners = new Set();
  const alarms = new Map();
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
      getContexts: async () => (offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      sendMessage: async (message) => {
        runtimeMessages.push(message);
      },
      onInstalled: event("onInstalled"),
      onStartup: event("onStartup"),
      onMessage: event("onMessage")
    },
    commands: { onCommand: event("onCommand") },
    alarms: {
      get: async (name) => alarms.get(name),
      create: async (name, info) => {
        alarms.set(name, { name, ...info });
      },
      onAlarm: event("alarms.onAlarm")
    },
    downloads: {
      download: async (options) => {
        downloadLog.push(options);
        if (options && options.fail) throw new Error("fail");
        const id = downloadLog.length;
        const match = /^data:application\/json;base64,(.*)$/.exec(options.url);
        const text = Buffer.from(match[1], "base64").toString("utf8");
        const finalName = (options && options.forceName) || options.filename;
        disk.set(finalName, text);
        downloadItems.set(id, { id, state: "in_progress", filename: `/downloads/${finalName}` });
        setImmediate(() => {
          downloadItems.get(id).state = "complete";
          downloadListeners.forEach((listener) => listener({ id, state: { previous: "in_progress", current: "complete" } }));
        });
        return id;
      },
      search: async ({ id }) => (downloadItems.has(id) ? [{ ...downloadItems.get(id) }] : []),
      erase: async ({ id }) => {
        erased.push(id);
        downloadItems.delete(id);
        return [id];
      },
      removeFile: async () => {},
      onChanged: {
        addListener: (listener) => downloadListeners.add(listener),
        removeListener: (listener) => downloadListeners.delete(listener)
      }
    },
    windows: { update: async () => {} },
    offscreen: {
      createDocument: async ({ url }) => {
        offscreenLog.push(["create", url]);
        offscreenOpen = true;
      },
      closeDocument: async () => {
        offscreenLog.push(["close"]);
        offscreenOpen = false;
      }
    },
    scripting: { insertCSS: async () => {}, executeScript: async () => {} },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        badges[tabId] = text;
      },
      setBadgeBackgroundColor: async () => {}
    },
    // Tabs without an `active` or `windowId` field match any filter on it,
    // so the older tests' bare tab lists keep working.
    tabs: {
      query: async (filter = {}) => openTabs.filter((tab) =>
        (filter.active === undefined || tab.active === undefined || tab.active === filter.active)
        && (filter.audible === undefined || tab.audible === undefined || tab.audible === filter.audible)
        && (filter.windowId === undefined || tab.windowId === undefined || tab.windowId === filter.windowId)),
      get: async (id) => {
        const tab = openTabs.find((item) => item.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { status: "complete", ...tab };
      },
      create: async (options) => {
        openedTabs.push(options);
        return { id: 1000 + openedTabs.length, windowId: 1, ...options };
      },
      update: async (id, options) => {
        updatedTabs.push({ id, ...options });
        const tab = openTabs.find((item) => item.id === id);
        if (tab && options.active) {
          openTabs.forEach((item) => {
            if (item.windowId === tab.windowId) item.active = item === tab;
          });
        }
        return { id, ...options };
      },
      remove: async () => {},
      sendMessage: (tabId, message, callback) => {
        tabMessages.push({ tabId, message });
        const reply = options && options.tabReply ? options.tabReply(tabId, message) : { ok: true };
        setImmediate(() => callback(reply));
      },
      onUpdated: event("tabs.onUpdated"),
      onActivated: event("tabs.onActivated")
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
  return {
    badges, context, listeners, openedTabs, store, session, offscreenLog, runtimeMessages, tabMessages, updatedTabs,
    alarms, disk, downloadLog, erased
  };
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

test("a batch Open Random opens as many tabs as asked, up to the videos available", async () => {
  const videos = {};
  for (let index = 0; index < 25; index += 1) {
    const id = `video${String(index).padStart(6, "0")}`;
    videos[`youtube:${id}`] = {
      ...legacyVideo(),
      videoKey: `youtube:${id}`,
      platform: "youtube",
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      rawUrls: []
    };
  }
  const open = (count) => {
    const { listeners, openedTabs } = loadWorker(videoEntries(videos));
    return new Promise((resolve) => {
      listeners.onMessage[0]({ type: "SCENEMARKS_OPEN_RANDOM_VIDEOS", payload: { count } }, {}, resolve);
    }).then((response) => ({ response, openedTabs }));
  };

  const twenty = await open(20);
  assert.equal(twenty.response.ok, true);
  assert.equal(twenty.response.openedCount, 20);
  assert.equal(twenty.response.requestedCount, 20);
  assert.equal(twenty.openedTabs.length, 20);
  assert.equal(new Set(twenty.openedTabs.map((tab) => tab.url)).size, 20);

  const tooMany = await open(50);
  assert.equal(tooMany.response.openedCount, 25);
  assert.equal(tooMany.response.requestedCount, 50);
  assert.equal(tooMany.openedTabs.length, 25);
});

test("the worker's RPC whitelist matches the storage client's mutation methods", () => {
  const { context } = loadWorker({});
  const whitelist = vm.runInContext("Array.from(STORAGE_RPC_METHODS).sort()", context);
  const clientMethods = vm.runInContext(
    "Object.keys(SceneMarks.Storage.createClient()).filter((name) => !['getState', 'getScenesForVideo', 'getSettings', 'getVoiceProfile', 'getBackupStatus'].includes(name)).sort()",
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

function sendToWorker(listeners, message, sender) {
  return new Promise((resolve) => {
    const handled = listeners.onMessage[0](message, sender, resolve);
    if (!handled) {
      setImmediate(() => resolve(undefined));
    }
  });
}

test("only the offscreen voice document may read the voice config", async () => {
  const { listeners } = loadWorker({
    settings: { voice: { micDeviceId: "mic-1", micLabel: "MacBook Pro Microphone" } }
  });
  await settle();
  const type = "SCENEMARKS_VOICE_GET_CONFIG";

  const fromPage = await sendToWorker(listeners, { type }, {
    url: "https://www.netflix.com/watch/1", tab: { id: 4 }, frameId: 0
  });
  assert.equal(fromPage.ok, false);

  const fromOptions = await sendToWorker(listeners, { type }, {
    url: "chrome-extension://scenemarks/src/options/options.html"
  });
  assert.equal(fromOptions.ok, false);

  const fromEngine = await sendToWorker(listeners, { type }, {
    url: "chrome-extension://scenemarks/src/voice/offscreen.html"
  });
  assert.equal(fromEngine.ok, true);
  assert.equal(fromEngine.voice.micDeviceId, "mic-1");
  assert.equal(fromEngine.voice.micLabel, "MacBook Pro Microphone");
  assert.deepEqual({ ...fromEngine.profile.commands }, {});
  assert.equal("hotkeys" in fromEngine.voice, false);
});

const ENGINE_SENDER = { url: "chrome-extension://scenemarks/src/voice/offscreen.html" };
const VIDEO_TAB = { id: 7, url: "https://www.youtube.com/watch?v=abcdEFGH123", active: true, windowId: 1, index: 0 };

function settingsChange(listeners, oldVoice, newVoice) {
  listeners["storage.onChanged"].forEach((listener) => listener({
    settings: { oldValue: { voice: oldVoice }, newValue: { voice: newVoice } }
  }, "local"));
}

test("voice commands are accepted only from the offscreen engine, and only while voice is on", async () => {
  const work = loadWorker({ settings: { voice: { enabled: true } } }, { tabs: [VIDEO_TAB] });
  await settle();
  const type = "SCENEMARKS_VOICE_COMMAND";

  for (const sender of [
    { url: "https://www.youtube.com/watch?v=x", tab: { id: 7 }, frameId: 0 },
    { url: "chrome-extension://scenemarks/src/options/options.html" },
    { url: "chrome-extension://scenemarks/src/popup/popup.html" }
  ]) {
    const response = await sendToWorker(work.listeners, { type, payload: { command: "next" } }, sender);
    assert.equal(response.ok, false);
  }
  assert.equal(work.tabMessages.length, 0);

  assert.equal((await sendToWorker(work.listeners, { type, payload: { command: "dance" } }, ENGINE_SENDER)).ok, false);

  const ran = await sendToWorker(work.listeners, { type, payload: { command: "next" } }, ENGINE_SENDER);
  assert.equal(ran.ok, true);
  assert.equal(work.tabMessages.length, 2); // PING, then the action.
  assert.deepEqual({ ...work.tabMessages[1].message.payload }, { action: "next", heard: "next" });
  assert.equal(work.tabMessages[1].message.type, "SCENEMARKS_VOICE_ACTION");
  assert.equal(work.tabMessages[1].tabId, 7);

  // Turned off (a stale engine may still speak): nothing runs.
  await work.context.SceneMarks.Storage.updateSettings({ voice: { enabled: false } });
  const off = await sendToWorker(work.listeners, { type, payload: { command: "pause" } }, ENGINE_SENDER);
  assert.equal(off.ok, false);
  assert.equal(work.tabMessages.length, 2);
});

test("voice page actions are refused when the active tab is not a web page", async () => {
  const work = loadWorker({ settings: { voice: { enabled: true } } }, {
    tabs: [{ id: 3, url: "chrome://extensions/", active: true, windowId: 1, index: 0 }]
  });
  await settle();
  const response = await sendToWorker(work.listeners, {
    type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "play" }
  }, ENGINE_SENDER);
  assert.equal(response.ok, false);
  assert.equal(work.tabMessages.length, 0);
});

test("turning voice on or off opens or closes the offscreen document", async () => {
  const work = loadWorker({}, { tabs: [] });
  await settle();
  assert.deepEqual(work.offscreenLog, []); // Off by default: no microphone.

  settingsChange(work.listeners, { enabled: false }, { enabled: true });
  await settle();
  assert.deepEqual(work.offscreenLog, [["create", "src/voice/offscreen.html"]]);

  // Other voice settings reload the engine instead.
  settingsChange(work.listeners, { enabled: true, sensitivity: 0.5 }, { enabled: true, sensitivity: 0.8 });
  await settle();
  assert.deepEqual(work.runtimeMessages.map((message) => message.type), ["SCENEMARKS_VOICE_CONFIG_CHANGED"]);

  settingsChange(work.listeners, { enabled: true }, { enabled: false });
  await settle();
  assert.deepEqual(work.offscreenLog.at(-1), ["close"]);
});

test("a new extension load reopens the voice document when voice is on", async () => {
  const work = loadWorker({ schemaVersion: 3, settings: { voice: { enabled: true } } }, { tabs: [] });
  await settle();
  assert.deepEqual(work.offscreenLog, [["create", "src/voice/offscreen.html"]]);

  // A later wake in the same load (document still open) does nothing.
  const again = loadWorker(null, { store: work.store, session: work.session, offscreenOpen: true, tabs: [] });
  await settle();
  assert.deepEqual(again.offscreenLog, []);
});

test("new voice templates make the engine reload", async () => {
  const work = loadWorker({ settings: { voice: { enabled: true } } }, { tabs: [], offscreenOpen: true });
  await settle();
  work.listeners["storage.onChanged"].forEach((listener) => listener({ voiceProfile: { newValue: {} } }, "local"));
  await settle();
  assert.deepEqual(work.runtimeMessages.map((message) => message.type), ["SCENEMARKS_VOICE_CONFIG_CHANGED"]);
});

test("the toggle-voice shortcut flips voice and announces it on the page", async () => {
  const work = loadWorker({}, { tabs: [VIDEO_TAB] });
  await settle();
  work.listeners.onCommand.forEach((listener) => listener("toggle-voice"));
  await settle();
  assert.equal(work.store.raw("settings").voice.enabled, true);
  const announce = work.tabMessages.find(({ message }) => message.type === "SCENEMARKS_VOICE_ACTION");
  assert.equal(announce.message.payload.action, "announce");
  assert.match(announce.message.payload.message, /Record your words/);

  work.listeners.onCommand.forEach((listener) => listener("toggle-voice"));
  await settle();
  assert.equal(work.store.raw("settings").voice.enabled, false);
});

test("voice template RPCs are for extension pages only", async () => {
  const { listeners } = loadWorker({});
  await settle();
  for (const method of ["saveVoiceSamples", "clearVoiceProfile"]) {
    const response = await sendToWorker(listeners, {
      type: "SCENEMARKS_STORAGE_RPC", payload: { method, args: ["next", []] }
    }, { url: "https://www.netflix.com/watch/1", tab: { id: 4 }, frameId: 0 });
    assert.equal(response.ok, false, method);
  }
});

// ---- Lineup: skip / return / random -------------------------------------
function pickTarget(work, ...args) {
  work.context.__args = args;
  const result = vm.runInContext("pickVoiceSwitchTarget(...__args)", work.context);
  return result && { ...result };
}

test("the lineup pick wraps both ways and starts at the ends from outside it", () => {
  const work = loadWorker({});
  const lineup = [11, 12, 13];
  assert.deepEqual(pickTarget(work, 1, 11, lineup, []), { tabId: 12, position: 2, total: 3, kind: "lineup" });
  assert.deepEqual(pickTarget(work, 1, 13, lineup, []), { tabId: 11, position: 1, total: 3, kind: "lineup" });
  assert.deepEqual(pickTarget(work, -1, 11, lineup, []), { tabId: 13, position: 3, total: 3, kind: "lineup" });
  // Active tab outside the lineup: skip goes to the first, return to the last.
  assert.deepEqual(pickTarget(work, 1, 99, lineup, [99, 98]), { tabId: 11, position: 1, total: 3, kind: "lineup" });
  assert.deepEqual(pickTarget(work, -1, 99, lineup, [99, 98]), { tabId: 13, position: 3, total: 3, kind: "lineup" });
  // Only the active tab is left: nowhere to go.
  assert.equal(pickTarget(work, 1, 11, [11], [11, 5]), null);
  // No lineup: the adjacent web tab in the window, wrapping.
  assert.deepEqual(pickTarget(work, 1, 6, [], [5, 6, 7]), { tabId: 7, position: 3, total: 3, kind: "tabs" });
  assert.deepEqual(pickTarget(work, 1, 7, [], [5, 6, 7]), { tabId: 5, position: 1, total: 3, kind: "tabs" });
  assert.deepEqual(pickTarget(work, -1, 5, [], [5, 6, 7]), { tabId: 7, position: 3, total: 3, kind: "tabs" });
  assert.equal(pickTarget(work, 1, 5, [], [5]), null);
});

function videoEntry(id, scenes = [{ id: `${id}-a`, startSeconds: 83 }, { id: `${id}-b`, startSeconds: 140 }]) {
  return {
    videoKey: `youtube:${id}`, platform: "youtube", title: id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`, rawUrls: [],
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    scenes: scenes.map((scene) => ({ createdAt: "2025-01-01T00:00:00.000Z", ...scene }))
  };
}

test("a batch Open Random becomes the voice lineup, in opening order", async () => {
  const videos = Object.fromEntries(["vidAAAAAAA1", "vidBBBBBBB2", "vidCCCCCCC3"].map((id) => [id, videoEntry(id)]));
  const work = loadWorker(videoEntries(videos), { tabs: [] });
  await settle();
  const response = await sendToWorker(work.listeners, {
    type: "SCENEMARKS_OPEN_RANDOM_VIDEOS", payload: { count: 3 }
  }, { url: "chrome-extension://scenemarks/src/library/library.html" });
  assert.equal(response.openedCount, 3);
  assert.deepEqual(work.openedTabs.map((tab) => tab.active), [false, false, false]);
  assert.deepEqual(JSON.parse(JSON.stringify(work.session.voiceLineup)), { windowId: 1, tabIds: [1001, 1002, 1003] });
});

function lineupBrowser({ activeId = 21, lineup = [21, 22, 23], extraTabs = [] } = {}) {
  const tabs = [
    { id: 21, windowId: 1, index: 0, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" },
    { id: 22, windowId: 1, index: 1, url: "https://www.youtube.com/watch?v=vidBBBBBBB2" },
    { id: 23, windowId: 1, index: 2, url: "https://www.youtube.com/watch?v=vidCCCCCCC3" },
    ...extraTabs
  ].map((tab) => ({ ...tab, active: tab.id === activeId }));
  const work = loadWorker({ settings: { voice: { enabled: true } } }, { tabs });
  work.session.voiceLineup = { windowId: 1, tabIds: lineup };
  return { work, tabs };
}

function voiceActions(work) {
  return work.tabMessages.filter(({ message }) => message.type === "SCENEMARKS_VOICE_ACTION")
    .map(({ tabId, message }) => ({ tabId, ...message.payload }));
}

test("skip pauses the current video, activates the next lineup tab and starts it at its first mark", async () => {
  const { work } = lineupBrowser();
  await settle();
  const response = await sendToWorker(work.listeners, {
    type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "skip" }
  }, ENGINE_SENDER);
  assert.equal(response.ok, true);
  assert.deepEqual(work.updatedTabs, [{ id: 22, active: true }]);
  assert.deepEqual(voiceActions(work), [
    { tabId: 21, action: "pause", silent: true },
    { tabId: 22, action: "startAtFirstMark", heard: "skip", position: 2, total: 3, kind: "lineup" }
  ]);

  // "return" from there goes back to the first video.
  await sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "return" } }, ENGINE_SENDER);
  assert.deepEqual(work.updatedTabs.at(-1), { id: 21, active: true });
  assert.equal(voiceActions(work).at(-1).position, 1);
});

test("skip leaves out closed lineup tabs and forgets them", async () => {
  // Tab 22 was closed.
  const { work } = lineupBrowser({ lineup: [21, 22, 23] });
  work.context.chrome.tabs.query = async () => [
    { id: 21, windowId: 1, index: 0, active: true, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" },
    { id: 23, windowId: 1, index: 1, active: false, url: "https://www.youtube.com/watch?v=vidCCCCCCC3" }
  ];
  await settle();
  await sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "skip" } }, ENGINE_SENDER);
  assert.deepEqual(work.updatedTabs, [{ id: 23, active: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(work.session.voiceLineup.tabIds)), [21, 23]);
  assert.deepEqual(voiceActions(work).at(-1), {
    tabId: 23, action: "startAtFirstMark", heard: "skip", position: 2, total: 2, kind: "lineup"
  });
});

test("without a lineup, skip moves to the next web tab in the window", async () => {
  const { work } = lineupBrowser({
    activeId: 23, lineup: [],
    extraTabs: [{ id: 24, windowId: 1, index: 3, url: "chrome://settings/" }]
  });
  await settle();
  await sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "skip" } }, ENGINE_SENDER);
  // chrome://settings is skipped and the order wraps.
  assert.deepEqual(work.updatedTabs, [{ id: 21, active: true }]);
  assert.equal(voiceActions(work).at(-1).kind, "tabs");
});

test("skip with nowhere to go says so on the current page and switches nothing", async () => {
  const { work } = lineupBrowser({ activeId: 21, lineup: [21] });
  await settle();
  const response = await sendToWorker(work.listeners, {
    type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "skip" }
  }, ENGINE_SENDER);
  assert.equal(response.ok, false);
  assert.match(response.error, /only video in the lineup/);
  assert.deepEqual(work.updatedTabs, []);
  const announce = voiceActions(work).at(-1);
  assert.equal(announce.action, "announce");
  assert.equal(announce.isError, true);
});

test("random opens an unopened saved video through an owned jump to its first mark", async () => {
  const videos = { vidAAAAAAA1: videoEntry("vidAAAAAAA1"), vidBBBBBBB2: videoEntry("vidBBBBBBB2") };
  const tabs = [{ id: 21, windowId: 1, index: 0, active: true, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" }];
  const work = loadWorker({ ...videoEntries(videos), settings: { voice: { enabled: true } } }, { tabs });
  work.session.voiceLineup = { windowId: 1, tabIds: [21] };
  await settle();
  const response = await sendToWorker(work.listeners, {
    type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "random" }
  }, ENGINE_SENDER);
  assert.equal(response.ok, true);
  // vidAAAAAAA1 is already open, so B is the only candidate.
  const jump = work.store.raw("pendingJump");
  assert.equal(jump.videoKey, "youtube:vidBBBBBBB2");
  assert.equal(jump.seconds, 83);
  assert.equal(jump.sceneId, "vidBBBBBBB2-a");
  assert.equal(jump.targetTabId, 1001);
  assert.deepEqual(work.updatedTabs, [{ id: 1001, url: "https://www.youtube.com/watch?v=vidBBBBBBB2" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(work.session.voiceLineup.tabIds)), [21, 1001]);
});

test("random with every saved video open reports it", async () => {
  const videos = { vidAAAAAAA1: videoEntry("vidAAAAAAA1") };
  const tabs = [{ id: 21, windowId: 1, index: 0, active: true, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" }];
  const work = loadWorker({ ...videoEntries(videos), settings: { voice: { enabled: true } } }, { tabs });
  await settle();
  const response = await sendToWorker(work.listeners, {
    type: "SCENEMARKS_VOICE_COMMAND", payload: { command: "random" }
  }, ENGINE_SENDER);
  assert.equal(response.ok, false);
  assert.match(response.error, /already open/);
  assert.equal(work.openedTabs.length, 0);
});

// ---- When to listen: restart, auto-off, only with a video -----------------
test("a browser restart turns voice off unless it is set to resume", async () => {
  const off = loadWorker({ schemaVersion: 3, settings: { voice: { enabled: true } } }, { tabs: [] });
  off.listeners.onStartup.forEach((listener) => listener());
  await settle();
  assert.equal(off.store.raw("settings").voice.enabled, false);
  assert.deepEqual(off.offscreenLog, []); // The mic never opened.

  const resume = loadWorker({ schemaVersion: 3, settings: { voice: { enabled: true, resumeOnStartup: true } } }, { tabs: [] });
  resume.listeners.onStartup.forEach((listener) => listener());
  await settle();
  assert.equal(resume.store.raw("settings").voice.enabled, true);
  assert.deepEqual(resume.offscreenLog, [["create", "src/voice/offscreen.html"]]);
});

function idleCheck(work, sender = ENGINE_SENDER) {
  return sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_IDLE_CHECK" }, sender);
}

test("auto-off turns voice off after the set time with nothing playing", async () => {
  const quietTab = { id: 7, url: "https://www.youtube.com/watch?v=abcdEFGH123", active: true, windowId: 1, index: 0, audible: false };
  const work = loadWorker({ settings: { voice: { enabled: true, autoOffMinutes: 15 } } }, {
    tabs: [quietTab],
    tabReply: (_tabId, message) => (message.payload && message.payload.action === "playback-state"
      ? { ok: true, detected: true, playing: false } : { ok: true })
  });
  await settle();
  assert.equal((await idleCheck(work, { url: "https://evil.example/" })).ok, false);

  // Voice opened just now: not idle yet.
  assert.equal((await idleCheck(work)).idle, false);
  // A paused video in the active tab is not watching.
  work.session.voiceLastActivityAt = Date.now() - 16 * 60 * 1000;
  assert.equal((await idleCheck(work)).idle, true);
  assert.equal(work.store.raw("settings").voice.enabled, false);
});

test("auto-off counts a tab making sound or a playing video as watching", async () => {
  const tab = { id: 7, url: "https://www.youtube.com/watch?v=abcdEFGH123", active: true, windowId: 1, index: 0, audible: true };
  const work = loadWorker({ settings: { voice: { enabled: true, autoOffMinutes: 15 } } }, { tabs: [tab] });
  await settle();
  work.session.voiceLastActivityAt = Date.now() - 60 * 60 * 1000;
  assert.equal((await idleCheck(work)).idle, false);
  assert.ok(Date.now() - work.session.voiceLastActivityAt < 1000);
  assert.equal(work.store.raw("settings").voice.enabled, true);

  // Never with auto-off set to 0.
  const never = loadWorker({ settings: { voice: { enabled: true } } }, { tabs: [] });
  await settle();
  never.session.voiceLastActivityAt = 0;
  assert.equal((await idleCheck(never)).idle, false);
});

test("only-with-video tells the engine to listen when the active tab has a video", async () => {
  let hasVideo = false;
  const tab = { id: 7, url: "https://www.youtube.com/watch?v=abcdEFGH123", active: true, windowId: 1, index: 0 };
  const work = loadWorker({ settings: { voice: { enabled: true, onlyWithVideo: true } } }, {
    tabs: [tab],
    offscreenOpen: true,
    tabReply: (_tabId, message) => (message.payload && message.payload.action === "playback-state"
      ? { ok: true, detected: hasVideo, playing: hasVideo } : { ok: true })
  });
  await settle();
  const config = await sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_GET_CONFIG" }, ENGINE_SENDER);
  assert.equal(config.listen, false);

  hasVideo = true;
  work.listeners["tabs.onActivated"].forEach((listener) => listener({ tabId: 7, windowId: 1 }));
  await settle();
  const listening = work.runtimeMessages.filter((message) => message.type === "SCENEMARKS_VOICE_SET_LISTENING");
  assert.deepEqual(listening.map((message) => message.payload.listen), [true]);

  // A content hint from a background tab is ignored; from the active tab it re-checks.
  hasVideo = false;
  await sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_VIDEO_PRESENCE", payload: { detected: false } },
    { url: tab.url, tab: { id: 9, active: false }, frameId: 0 });
  await sendToWorker(work.listeners, { type: "SCENEMARKS_VOICE_VIDEO_PRESENCE", payload: { detected: false } },
    { url: tab.url, tab: { id: 7, active: true }, frameId: 0 });
  await settle();
  assert.deepEqual(work.runtimeMessages.filter((message) => message.type === "SCENEMARKS_VOICE_SET_LISTENING")
    .map((message) => message.payload.listen), [true, false]);
});

test("without only-with-video, tab switches send the engine nothing", async () => {
  const tab = { id: 7, url: "https://www.youtube.com/watch?v=abcdEFGH123", active: true, windowId: 1, index: 0 };
  const work = loadWorker({ settings: { voice: { enabled: true } } }, { tabs: [tab], offscreenOpen: true });
  await settle();
  work.listeners["tabs.onActivated"].forEach((listener) => listener({ tabId: 7, windowId: 1 }));
  await settle();
  assert.deepEqual(work.runtimeMessages, []);
  assert.equal(work.tabMessages.length, 0);
});

// ---- H1: one Random, lineup hotkeys ---------------------------------------
test("the Random hotkey opens an unopened video through an owned jump to its first mark", async () => {
  const videos = { vidAAAAAAA1: videoEntry("vidAAAAAAA1"), vidBBBBBBB2: videoEntry("vidBBBBBBB2") };
  const tabs = [{ id: 21, windowId: 1, index: 0, active: true, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" }];
  const work = loadWorker(videoEntries(videos), { tabs });
  await settle();
  const response = await sendToWorker(work.listeners, { type: "SCENEMARKS_OPEN_RANDOM_VIDEO" }, { tab: { id: 21 }, frameId: 0 });
  assert.equal(response.ok, true);
  assert.equal(response.nothingToOpen, undefined);
  const jump = work.store.raw("pendingJump");
  assert.equal(jump.videoKey, "youtube:vidBBBBBBB2");
  assert.equal(jump.seconds, 83);
  assert.equal(jump.targetTabId, 1001);
  // Nothing left to open: a plain error, and no announcement (the hotkey
  // shows its own toast).
  tabs.push({ id: 1001, windowId: 1, index: 1, active: false, url: "https://www.youtube.com/watch?v=vidBBBBBBB2" });
  const none = await sendToWorker(work.listeners, { type: "SCENEMARKS_OPEN_RANDOM_VIDEO" }, { tab: { id: 21 }, frameId: 0 });
  assert.equal(none.ok, false);
  assert.equal(none.nothingToOpen, undefined);
  assert.equal(voiceActions(work).length, 0);
});

test("batch Open Random tabs start at their first mark the first time they are shown", async () => {
  const videos = Object.fromEntries(["vidAAAAAAA1", "vidBBBBBBB2"].map((id) => [id, videoEntry(id)]));
  const tabs = [];
  const work = loadWorker(videoEntries(videos), { tabs });
  await settle();
  await sendToWorker(work.listeners, { type: "SCENEMARKS_OPEN_RANDOM_VIDEOS", payload: { count: 2 } },
    { url: "chrome-extension://scenemarks/src/library/library.html" });
  tabs.push({ id: 1001, windowId: 1, index: 0, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" },
    { id: 1002, windowId: 1, index: 1, url: "https://www.youtube.com/watch?v=vidBBBBBBB2" });
  const activate = async (tabId) => {
    work.listeners["tabs.onActivated"].forEach((listener) => listener({ tabId, windowId: 1 }));
    await settle();
  };
  await activate(1002);
  assert.deepEqual(voiceActions(work), [{ tabId: 1002, action: "startAtFirstMark", position: 2, total: 2, kind: "lineup" }]);
  // Shown again later: left alone.
  await activate(1002);
  await activate(77);
  assert.equal(voiceActions(work).length, 1);
});

test("lineup hotkeys step from the active tab, and start the target at its first mark", async () => {
  const { work } = lineupBrowser({ activeId: 21, lineup: [21, 22, 23] });
  work.session.lineupUnstarted = [22, 23];
  await settle();
  const sender = (id, active = true) => ({ tab: { id, active, windowId: 1, url: "https://www.youtube.com/watch?v=vidAAAAAAA1" }, frameId: 0,
    url: "https://www.youtube.com/watch?v=vidAAAAAAA1" });
  const response = await sendToWorker(work.listeners, { type: "SCENEMARKS_LINEUP_NEXT" }, sender(21));
  assert.equal(response.ok, true);
  assert.deepEqual(work.updatedTabs, [{ id: 22, active: true }]);
  assert.deepEqual(voiceActions(work), [
    { tabId: 21, action: "pause", silent: true },
    { tabId: 22, action: "startAtFirstMark", position: 2, total: 3, kind: "lineup" }
  ]);
  // Started by the step, so its first activation does not start it again.
  assert.deepEqual([...work.session.lineupUnstarted], [23]);

  await sendToWorker(work.listeners, { type: "SCENEMARKS_LINEUP_PREVIOUS" }, sender(21));
  assert.deepEqual(work.updatedTabs.at(-1), { id: 23, active: true });
});

test("lineup step messages are refused from pages, extension pages and background tabs, and do nothing without a lineup", async () => {
  const { work } = lineupBrowser({ activeId: 21, lineup: [21, 22, 23] });
  await settle();
  for (const sender of [
    {},
    { url: "chrome-extension://scenemarks/src/popup/popup.html" },
    { url: "chrome-extension://scenemarks/src/library/library.html", tab: { id: 30, active: true }, frameId: 0 },
    { url: "https://example.com/", tab: { id: 22, active: false }, frameId: 0 },
    { url: "https://example.com/", tab: { id: 21, active: true }, frameId: 3 }
  ]) {
    const response = await sendToWorker(work.listeners, { type: "SCENEMARKS_LINEUP_NEXT" }, sender);
    assert.equal(response.ok, false);
  }
  assert.deepEqual(work.updatedTabs, []);
  assert.deepEqual(work.tabMessages, []);

  const empty = lineupBrowser({ activeId: 21, lineup: [] });
  await settle();
  const response = await sendToWorker(empty.work.listeners, { type: "SCENEMARKS_LINEUP_NEXT" },
    { url: "https://www.youtube.com/watch?v=vidAAAAAAA1", tab: { id: 21, active: true }, frameId: 0 });
  assert.equal(response.ok, false);
  assert.match(response.error, /No lineup/);
  assert.deepEqual(empty.work.updatedTabs, []);
  assert.deepEqual(empty.work.tabMessages, []);
});

// ---- Automatic backup -------------------------------------------------
const LIBRARY_PAGE = { url: "chrome-extension://scenemarks/src/library/library.html" };
const OPTIONS_PAGE = { url: "chrome-extension://scenemarks/src/options/options.html" };

function backupLibrary(count = 3) {
  const ids = ["vidAAAAAAA1", "vidBBBBBBB2", "vidCCCCCCC3", "vidDDDDDDD4"].slice(0, count);
  return videoEntries(Object.fromEntries(ids.map((id) => [id, videoEntry(id)])));
}

async function backupWorker(seed, settings) {
  const work = loadWorker({ ...seed, settings: { backup: { enabled: true, intervalHours: 24 }, ...settings } });
  await settle();
  return work;
}

function fireAlarm(work) {
  work.listeners["alarms.onAlarm"].forEach((listener) => listener({ name: "scenemarks-backup" }));
  return settle();
}

function backupNow(work, sender = OPTIONS_PAGE) {
  return sendToWorker(work.listeners, { type: "SCENEMARKS_BACKUP_NOW" }, sender);
}

test("the worker arms an hourly backup alarm", async () => {
  const work = await backupWorker(backupLibrary());
  assert.equal(work.alarms.get("scenemarks-backup").periodInMinutes, 60);
});

test("a due backup writes the library to the first file, overwriting, then erases the download entry", async () => {
  const work = await backupWorker(backupLibrary());
  await fireAlarm(work);
  assert.equal(work.downloadLog.length, 1);
  const call = work.downloadLog[0];
  assert.equal(call.filename, "SceneMarks/scenemarks-backup-1.json");
  assert.equal(call.conflictAction, "overwrite");
  assert.equal(call.saveAs, false);
  assert.deepEqual(work.erased, [1]);
  const status = work.store.raw("backupStatus");
  assert.equal(status.slot, 1);
  assert.equal(status.videoCount, 3);
  assert.equal(status.sceneCount, 6);
  assert.equal(status.error, "");
});

test("disabled, not due, or unchanged: no download and no storage write", async () => {
  // Disabled.
  const off = await backupWorker(backupLibrary(), { backup: { enabled: false } });
  let writes = off.store.writes;
  await fireAlarm(off);
  assert.equal(off.downloadLog.length, 0);
  assert.equal(off.store.writes, writes);

  // Not due: backed up an hour ago with a 24-hour interval.
  const work = await backupWorker(backupLibrary());
  await fireAlarm(work);
  writes = work.store.writes;
  await fireAlarm(work);
  assert.equal(work.downloadLog.length, 1);
  assert.equal(work.store.writes, writes);

  // Due again but unchanged: the idle pass downloads and writes nothing.
  const status = work.store.raw("backupStatus");
  work.store.local.set({ backupStatus: { ...status, lastBackupAt: "2020-01-01T00:00:00.000Z" } }, () => {});
  writes = work.store.writes;
  await fireAlarm(work);
  assert.equal(work.downloadLog.length, 1);
  assert.equal(work.store.writes, writes);
  // "Back up now" also skips an unchanged library, and says so.
  const response = await backupNow(work);
  assert.equal(response.ok, true);
  assert.equal(response.skipped, "unchanged");
  assert.equal(work.downloadLog.length, 1);
  assert.equal(work.store.writes, writes);
});

test("ten backups with a change between each use only the two files, alternating", async () => {
  const work = await backupWorker(backupLibrary());
  for (let index = 0; index < 10; index += 1) {
    const response = await backupNow(work);
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.skipped, undefined);
    const saved = await work.context.SceneMarks.Storage.saveScene(
      { videoKey: "youtube:vidAAAAAAA1", platform: "youtube", canonicalUrl: "https://www.youtube.com/watch?v=vidAAAAAAA1" },
      { startSeconds: 1000 + index * 60 }
    );
    assert.equal(saved.ok, true);
  }
  assert.deepEqual(work.downloadLog.map((call) => call.filename.slice(-6)), [
    "1.json", "2.json", "1.json", "2.json", "1.json", "2.json", "1.json", "2.json", "1.json", "2.json"
  ]);
  assert.deepEqual([...work.disk.keys()].sort(), [
    "SceneMarks/scenemarks-backup-1.json", "SceneMarks/scenemarks-backup-2.json"
  ]);
  // The newer file holds one more scene than the older.
  const newer = JSON.parse(work.disk.get("SceneMarks/scenemarks-backup-2.json"));
  const older = JSON.parse(work.disk.get("SceneMarks/scenemarks-backup-1.json"));
  assert.equal(newer.videos["youtube:vidAAAAAAA1"].scenes.length, older.videos["youtube:vidAAAAAAA1"].scenes.length + 1);
  assert.equal(work.erased.length, 10);
});

test("a backup file imports back into an empty library unchanged", async () => {
  const work = await backupWorker(backupLibrary(4));
  await backupNow(work);
  const file = work.disk.get("SceneMarks/scenemarks-backup-1.json");

  const fresh = loadWorker({});
  await settle();
  const response = await sendToWorker(fresh.listeners, {
    type: "SCENEMARKS_STORAGE_RPC", payload: { method: "importState", args: [JSON.parse(file), { merge: true }] }
  }, LIBRARY_PAGE);
  assert.equal(response.ok, true);
  assert.equal(response.result.videoCount, 4);
  await settle();
  const restored = fresh.store.readState().videos;
  const original = work.store.readState().videos;
  assert.deepEqual(Object.keys(restored).sort(), Object.keys(original).sort());
  for (const key of Object.keys(original)) {
    assert.deepEqual(restored[key].scenes.map((scene) => [scene.id, scene.startSeconds]),
      original[key].scenes.map((scene) => [scene.id, scene.startSeconds]));
  }
});

test("an empty library is never backed up, so it cannot overwrite a good copy", async () => {
  const work = await backupWorker({});
  const writes = work.store.writes;
  await fireAlarm(work);
  const response = await backupNow(work);
  assert.equal(response.skipped, "empty");
  assert.equal(work.downloadLog.length, 0);
  assert.equal(work.store.writes, writes);
});

test("an idle alarm pass makes zero storage writes and touches only small keys", async () => {
  const work = await backupWorker(backupLibrary(), { backup: { enabled: false } });
  const writes = work.store.writes;
  const reads = work.store.readLog.length;
  await fireAlarm(work);
  assert.equal(work.store.writes, writes);
  assert.ok(work.store.readLog.slice(reads).every((keys) => keys && !keys.some((key) => key.startsWith("video:"))));
});

test("a failed backup records the error once and keeps the last good slot", async () => {
  const work = await backupWorker(backupLibrary());
  await backupNow(work);
  const download = work.context.chrome.downloads.download;
  work.context.chrome.downloads.download = async () => {
    throw new Error("disk full");
  };
  await work.context.SceneMarks.Storage.deleteScene("youtube:vidAAAAAAA1", "vidAAAAAAA1-a");
  const failed = await backupNow(work);
  assert.equal(failed.ok, false);
  const status = work.store.raw("backupStatus");
  assert.equal(status.slot, 1);
  assert.match(status.error, /disk full/);
  const writes = work.store.writes;
  await backupNow(work);
  assert.equal(work.store.writes, writes);
  // The next good backup goes to the other file and clears the error.
  work.context.chrome.downloads.download = download;
  await backupNow(work);
  assert.equal(work.store.raw("backupStatus").slot, 2);
  assert.equal(work.store.raw("backupStatus").error, "");
});

test("a renamed download is deleted, so the folder never gets a third file", async () => {
  const work = await backupWorker(backupLibrary());
  const removed = [];
  const download = work.context.chrome.downloads.download;
  work.context.chrome.downloads.download = (options) => download({ ...options, forceName: "SceneMarks/scenemarks-backup-1 (1).json" });
  work.context.chrome.downloads.removeFile = async (id) => {
    removed.push(id);
  };
  const response = await backupNow(work);
  assert.equal(response.ok, false);
  assert.deepEqual(removed, [1]);
  assert.equal(work.store.raw("backupStatus").slot, 0);
});

test("only extension pages may start a backup", async () => {
  const work = await backupWorker(backupLibrary());
  const response = await backupNow(work, { url: "https://example.com/", tab: { id: 4, active: true }, frameId: 0 });
  assert.equal(response.ok, false);
  assert.equal(work.downloadLog.length, 0);
});

test("turning backup on backs up soon", async () => {
  const work = await backupWorker(backupLibrary(), { backup: { enabled: false } });
  const before = work.store.raw("settings");
  await work.context.SceneMarks.Storage.updateSettings({ backup: { enabled: true } });
  const after = work.store.raw("settings");
  work.listeners["storage.onChanged"].forEach((listener) => listener({ settings: { oldValue: before, newValue: after } }, "local"));
  await settle();
  assert.equal(work.downloadLog.length, 1);
  assert.equal(after.backup.intervalHours, 24);
});
