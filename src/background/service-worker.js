importScripts(
  "../shared/constants.js",
  "../shared/time.js",
  "../shared/ids.js",
  "../shared/schema.js",
  "../shared/storage.js",
  "../content/site-adapters/generic.js",
  "../content/site-adapters/netflix.js",
  "../content/site-adapters/prime-video.js",
  "../content/site-adapters/hotstar.js",
  "../content/site-adapters/youtube.js",
  "../content/site-adapters/index.js",
  "../shared/migrations.js"
);

// Migrations: the split of the schema-1 blob into per-video keys, then the
// re-keying of videos saved before their site had an adapter. Both are safe
// to re-run and write nothing when there is nothing to migrate.
//
// They run once per extension load, not on every worker wake (MV3 workers
// stop after ~30 s idle and each wake would pay for it). "Once per load" is
// tracked with a chrome.storage.session flag, which the browser clears when
// the extension is disabled, re-enabled or reloaded and when the browser
// restarts. install/update and browser start alone are not enough: enabling
// a disabled unpacked extension fires neither, so a library still in the old
// layout would stay invisible. An import forces a run.
const MIGRATIONS_CHECKED_FLAG = "migrationsChecked";
let migrationRun = null;

async function runMigrationsOncePerLoad() {
  const session = chrome.storage.session;
  if (session) {
    const flags = await session.get(MIGRATIONS_CHECKED_FLAG);
    if (flags[MIGRATIONS_CHECKED_FLAG]) {
      return;
    }
  }

  await SceneMarks.Migrations.runAll();
  if (session) {
    await session.set({ [MIGRATIONS_CHECKED_FLAG]: true });
  }
}

function runMigrations({ force = false } = {}) {
  // Concurrent triggers (worker start plus onInstalled) share one run.
  if (!migrationRun || force) {
    const run = force ? SceneMarks.Migrations.runAll() : runMigrationsOncePerLoad();
    migrationRun = run.catch((error) => {
      console.warn("SceneMarks migration failed:", error);
    });
  }

  return migrationRun;
}

runMigrations();
chrome.runtime.onInstalled.addListener(() => runMigrations());
chrome.runtime.onStartup.addListener(() => runMigrations());
// Tab IDs are only meaningful within a browser session. A normal MV3 worker
// wake preserves ownership; browser startup must not reuse an old tab ID.
chrome.runtime.onStartup.addListener(() => {
  SceneMarks.Storage.getState({ videoKeys: [] }).then((state) => {
    const pending = state.pendingJump;
    return pending && pending.targetTabId !== null
      ? SceneMarks.Storage.clearPendingJump(pending.requestId) : null;
  }).catch((error) => console.warn("SceneMarks queued-jump reset failed:", error));
});

const CONTENT_SCRIPT_FILES = [
  "src/shared/constants.js",
  "src/shared/time.js",
  "src/shared/ids.js",
  "src/shared/schema.js",
  "src/shared/storage.js",
  "src/content/site-adapters/generic.js",
  "src/content/site-adapters/netflix.js",
  "src/content/site-adapters/prime-video.js",
  "src/content/site-adapters/hotstar.js",
  "src/content/site-adapters/youtube.js",
  "src/content/site-adapters/index.js",
  "src/content/video-detector.js",
  "src/content/overlay.js",
  "src/content/content-script.js"
];

const OVERLAY_CSS_FILE = "src/content/overlay.css";

// The worker is the single storage writer: only mutation methods may be
// invoked from other contexts via STORAGE_RPC; reads and internal helpers
// are excluded on purpose.
const STORAGE_RPC_METHODS = new Set([
  "saveScene",
  "startRange",
  "endRange",
  "deleteScene",
  "updateScene",
  "updateVideo",
  "updateSettings",
  "consumePendingJump",
  "clearPendingJump",
  "deleteVideo",
  "importState",
  "clearAllData",
  "toggleFloatingButton",
  "setSiteEnabled"
]);

// Library replacement/deletion and global jump cancellation belong to
// extension pages. Content scripts may complete only their own queued jump.
const EXTENSION_PAGE_ONLY_RPC_METHODS = new Set(["importState", "clearAllData", "clearPendingJump"]);

// sender.url is set by the browser, so a page (or a compromised renderer)
// cannot claim an extension-page URL. Extension pages opened in a tab
// (library, options) also carry sender.tab, so that cannot be the test.
function isExtensionPageSender(sender) {
  return Boolean(sender && typeof sender.url === "string"
    && sender.url.startsWith(chrome.runtime.getURL("")));
}

function senderTabId(sender) {
  const id = sender && sender.tab && sender.tab.id;
  return sender && sender.frameId === 0 && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: SceneMarks.Constants.MESSAGE_TYPES.PING });
    return true;
  } catch (_error) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: [OVERLAY_CSS_FILE]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await sendTabMessage(tabId, { type: SceneMarks.Constants.MESSAGE_TYPES.PING });
        return true;
      } catch (_error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return false;
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function forwardToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab found." };
  }

  const tabUrl = tab.url || "";
  const isSupportedPage = /^https?:/i.test(tabUrl) || tabUrl.startsWith("file://");
  if (!isSupportedPage) {
    return { ok: false, error: "SceneMarks runs on web pages. Open a page with a video first." };
  }

  try {
    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      return { ok: false, error: "SceneMarks could not start on this page. Reload the tab and try again." };
    }

    return await sendTabMessage(tab.id, message);
  } catch (error) {
    return {
      ok: false,
      error: error.message || "SceneMarks could not run on this page."
    };
  }
}

async function openLibrary() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/library/library.html") });
  return { ok: true };
}

async function openVideoUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!["http:", "https:", "file:"].includes(url.protocol)) {
      return { ok: false, error: "Unsupported video URL." };
    }

    await chrome.tabs.create({ url: url.href });
    return { ok: true };
  } catch (_error) {
    return { ok: false, error: "Invalid video URL." };
  }
}

async function openVideoAtScene(payload) {
  const { Storage, Schema } = SceneMarks;
  // Validate before allocating a tab. The placeholder is not published.
  const target = Schema.normalizePendingJump({
    ...payload, targetTabId: 0, createdAt: new Date().toISOString()
  });
  if (!target) return { ok: false, error: "Invalid jump target." };

  let tab = null;
  let requestId = null;
  try {
    // about:blank cannot run our content script. Publish ownership before
    // navigating, even when an existing tab is already playing this video.
    tab = await chrome.tabs.create({ url: "about:blank" });
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0) throw new Error("Could not allocate a destination tab.");
    const queued = await Storage.setPendingJump({ ...target, targetTabId: tab.id });
    if (!queued.ok) throw new Error(queued.error);
    requestId = queued.pendingJump.requestId;
    await chrome.tabs.update(tab.id, { url: target.url });
    return { ok: true, tabId: tab.id };
  } catch (error) {
    // A newer opening may have replaced this request while navigation failed.
    if (requestId) {
      try {
        await Storage.clearPendingJump(requestId);
      } catch (cleanupError) {
        console.warn("SceneMarks queued-jump cleanup failed:", cleanupError);
      }
    }
    if (tab && Number.isSafeInteger(tab.id) && tab.id >= 0) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    return { ok: false, error: error.message || "Could not open video at this scene." };
  }
}

// Keep publication in click order even if creating the first tab is slow.
// Storage itself still uses its single writer queue for every mutation.
let sceneOpenQueue = Promise.resolve();
function queueVideoAtScene(payload) {
  const opening = sceneOpenQueue.then(() => openVideoAtScene(payload));
  sceneOpenQueue = opening.then(() => {}, () => {});
  return opening;
}

function normalizeUrlKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!["http:", "https:", "file:"].includes(url.protocol)) {
      return null;
    }

    const adapter = SceneMarks.Adapters.getAdapter(url);
    return adapter.getVideoKey(url) || SceneMarks.Adapters.GenericAdapter.getVideoKey(url);
  } catch (_error) {
    return null;
  }
}

function getVideoUrlKeys(video) {
  const urls = [video && video.canonicalUrl, ...((video && video.rawUrls) || [])];
  const keys = new Set();

  for (const raw of urls) {
    const key = normalizeUrlKey(raw);
    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

async function getOpenTabUrlKeys() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const openUrlKeys = new Set();

  for (const tab of tabs || []) {
    const key = normalizeUrlKey(tab && tab.url);
    if (key) {
      openUrlKeys.add(key);
    }
  }

  return openUrlKeys;
}

function isOpenInTab(video, openUrlKeys) {
  for (const key of getVideoUrlKeys(video)) {
    if (openUrlKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// Uniform sample without replacement: a partial Fisher-Yates shuffle over a
// copy of the pool, so picking N never degenerates into taking the first N.
function sampleRandom(items, count) {
  const pool = items.slice();
  const limit = Math.min(count, pool.length);

  for (let index = 0; index < limit; index += 1) {
    const swap = index + Math.floor(Math.random() * (pool.length - index));
    const held = pool[index];
    pool[index] = pool[swap];
    pool[swap] = held;
  }

  return pool.slice(0, limit);
}

// Shared picker behind the library page and overlay Random buttons: it
// restricts the pool to videoKeys when provided, drops videos already open
// in this window's tabs, and avoids repeating excludeVideoKey (the previous
// pick) whenever alternatives exist. It returns the pick without opening it.
async function pickRandomVideoCandidate(payload) {
  const options = payload && typeof payload === "object" ? payload : {};
  const state = await SceneMarks.Storage.getState();
  let videos = Object.values(state.videos);

  if (Array.isArray(options.videoKeys)) {
    const allowed = new Set(options.videoKeys);
    videos = videos.filter((video) => allowed.has(video.videoKey));
  }

  const openUrlKeys = await getOpenTabUrlKeys();
  const candidates = videos.filter((video) => {
    const openableUrl = video.canonicalUrl || (Array.isArray(video.rawUrls) ? video.rawUrls[0] : null);
    return Boolean(openableUrl) && !isOpenInTab(video, openUrlKeys);
  });

  if (!candidates.length) {
    return { ok: false, error: "Every matching video is already open in a tab in this window." };
  }

  const pool = options.excludeVideoKey && candidates.length > 1
    ? candidates.filter((video) => video.videoKey !== options.excludeVideoKey)
    : candidates;
  const picked = pickRandom(pool);

  return {
    ok: true,
    video: picked,
    remainingCount: candidates.length - 1
  };
}

async function openRandomVideo() {
  const state = await SceneMarks.Storage.getState();
  const videos = Object.values(state.videos);

  if (!videos.length) {
    return { ok: false, error: "SceneMarks library is empty." };
  }

  const openUrlKeys = await getOpenTabUrlKeys();
  const candidates = videos.filter((video) => {
    const openableUrl = video.canonicalUrl || (Array.isArray(video.rawUrls) ? video.rawUrls[0] : null);
    return Boolean(openableUrl)
      && Array.isArray(video.scenes)
      && video.scenes.length > 0
      && !isOpenInTab(video, openUrlKeys);
  });

  if (!candidates.length) {
    return { ok: false, error: "Every saved video is already open in a tab in this window." };
  }

  const picked = pickRandom(candidates);
  const url = picked.canonicalUrl || picked.rawUrls[0];
  await chrome.tabs.create({ url });

  return {
    ok: true,
    message: `Opening random video: ${picked.title || picked.canonicalUrl || "saved video"}`,
    remainingCount: candidates.length - 1,
    videoKey: picked.videoKey
  };
}

// Batch version of the Random pick: samples `count` distinct videos from the
// caller-filtered pool, skipping ones already open in this window, and opens
// each in a background tab so the library page keeps focus.
async function openRandomVideos(payload) {
  const options = payload && typeof payload === "object" ? payload : {};
  const requested = Math.floor(Number(options.count));
  if (!Number.isFinite(requested) || requested < 1) {
    return { ok: false, error: "Choose how many videos to open (1 or more)." };
  }

  const count = Math.min(requested, SceneMarks.Constants.MAX_RANDOM_OPEN_COUNT);

  const state = await SceneMarks.Storage.getState();
  let videos = Object.values(state.videos);

  if (Array.isArray(options.videoKeys)) {
    const allowed = new Set(options.videoKeys);
    videos = videos.filter((video) => allowed.has(video.videoKey));
  }

  const openUrlKeys = await getOpenTabUrlKeys();
  const candidates = videos.filter((video) => {
    const openableUrl = video.canonicalUrl || (Array.isArray(video.rawUrls) ? video.rawUrls[0] : null);
    return Boolean(openableUrl) && !isOpenInTab(video, openUrlKeys);
  });

  if (!candidates.length) {
    return { ok: false, error: "Every matching video is already open in a tab in this window." };
  }

  const picked = sampleRandom(candidates, count);
  for (const video of picked) {
    await chrome.tabs.create({ url: video.canonicalUrl || video.rawUrls[0], active: false });
  }

  return {
    ok: true,
    openedCount: picked.length,
    requestedCount: count,
    videos: picked.map((video) => ({ videoKey: video.videoKey, title: video.title }))
  };
}

// The toolbar badge reads OFF on tabs where SceneMarks is paused or
// switched off for the site. Badges are set per tab and refreshed when a
// tab navigates or the switches change; the settings are cached for the
// life of the worker and kept current from storage.onChanged.
let badgeSettings = null;

async function getBadgeSettings() {
  if (!badgeSettings) {
    badgeSettings = await SceneMarks.Storage.getSettings();
  }

  return badgeSettings;
}

// null for pages SceneMarks never runs on (chrome://, the store), which
// keep a blank badge.
function pageHostname(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    return ["http:", "https:", "file:"].includes(url.protocol) ? url.hostname : null;
  } catch (_error) {
    return null;
  }
}

async function updateBadge(tabId, url, settings) {
  const hostname = pageHostname(url);
  const off = hostname !== null && !SceneMarks.Schema.isEnabledForHost(settings, hostname);
  await chrome.action.setBadgeText({ tabId, text: off ? "OFF" : "" });
  if (off) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#64748b" });
  }
}

async function updateAllBadges() {
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab && tab.id);
  if (!tabs.length) {
    return;
  }

  const settings = await getBadgeSettings();
  await Promise.all(tabs.map((tab) => updateBadge(tab.id, tab.url, settings).catch(() => {})));
}

function refreshAllBadges() {
  updateAllBadges().catch((error) => {
    console.warn("SceneMarks badge update failed:", error);
  });
}

chrome.runtime.onInstalled.addListener(refreshAllBadges);
chrome.runtime.onStartup.addListener(refreshAllBadges);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // "complete" also re-applies a badge the browser reset on navigation.
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  getBadgeSettings()
    .then((settings) => updateBadge(tabId, tab.url, settings))
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = changes[SceneMarks.Constants.STORAGE_KEYS.SETTINGS];
  if (areaName !== "local" || !change) {
    return;
  }

  const previous = SceneMarks.Schema.normalizeSettings(change.oldValue);
  badgeSettings = SceneMarks.Schema.normalizeSettings(change.newValue);
  if (previous.extensionEnabled !== badgeSettings.extensionEnabled
    || previous.disabledSites.join(" ") !== badgeSettings.disabledSites.join(" ")) {
    refreshAllBadges();
  }
  if (previous.voice.micDeviceId !== badgeSettings.voice.micDeviceId
    || previous.voice.micLabel !== badgeSettings.voice.micLabel) {
    notifyVoiceConfigChanged().catch(() => {});
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-library") {
    openLibrary();
    return;
  }

  const type = command === "mark-scene-range"
    ? SceneMarks.Constants.MESSAGE_TYPES.TOGGLE_RANGE
    : SceneMarks.Constants.MESSAGE_TYPES.QUICK_SAVE;

  forwardToActiveTab({
    type,
    payload: { quick: true, source: "browser-command" }
  });
});

// Voice (Phase 0 spike): the microphone lives in an offscreen document, so
// the permission belongs to the extension origin, not to the video site.
const VOICE_OFFSCREEN_PATH = "src/voice/offscreen.html";

async function hasVoiceDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(VOICE_OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function startVoiceDocument() {
  if (!chrome.offscreen) {
    return { ok: false, error: "This browser has no chrome.offscreen API." };
  }
  if (await hasVoiceDocument()) {
    return { ok: true, alreadyRunning: true };
  }
  await chrome.offscreen.createDocument({
    url: VOICE_OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Listen for the user's spoken SceneMarks commands."
  });
  return { ok: true };
}

function isVoiceDocumentSender(sender) {
  return Boolean(sender && sender.url === chrome.runtime.getURL(VOICE_OFFSCREEN_PATH));
}

// Only what the engine needs, never the rest of settings.
async function getVoiceConfig() {
  const { voice } = await SceneMarks.Storage.getSettings();
  return { ok: true, micDeviceId: voice.micDeviceId, micLabel: voice.micLabel };
}

async function notifyVoiceConfigChanged() {
  if (await hasVoiceDocument()) {
    chrome.runtime.sendMessage({ type: SceneMarks.Constants.MESSAGE_TYPES.VOICE_CONFIG_CHANGED })
      .catch(() => {});
  }
}

async function stopVoiceDocument() {
  if (chrome.offscreen && await hasVoiceDocument()) {
    await chrome.offscreen.closeDocument();
  }
  return { ok: true };
}

async function handleStorageRpc(payload, sender) {
  const method = payload && typeof payload.method === "string" ? payload.method : null;
  if (!payload || typeof payload !== "object" || !STORAGE_RPC_METHODS.has(method)) {
    return { ok: false, error: "SceneMarks storage RPC rejected an unknown or disallowed method." };
  }

  if (EXTENSION_PAGE_ONLY_RPC_METHODS.has(method) && !isExtensionPageSender(sender)) {
    return { ok: false, error: "SceneMarks storage RPC rejected a method that only extension pages may call." };
  }

  const args = Array.isArray(payload.args) ? payload.args : [];
  // Never trust a caller-supplied ownership argument. Even a same-video tab
  // with the correct request token can consume only its own top-frame jump.
  const result = method === "consumePendingJump"
    ? await SceneMarks.Storage.consumePendingJump(args[0], args[1], senderTabId(sender))
    : await SceneMarks.Storage[method](...args);
  if (method === "importState") {
    // An import can bring back keys saved before an adapter existed.
    runMigrations({ force: true });
  }

  return { ok: true, result };
}

// Every async handler answers, even on failure: an unanswered message
// leaves the caller with only "message port closed".
function respondWith(promise, sendResponse) {
  promise.then(sendResponse, (error) => {
    sendResponse({ ok: false, error: (error && error.message) || String(error) });
  });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_LIBRARY) {
    return respondWith(openLibrary(), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_VIDEO_URL) {
    return respondWith(openVideoUrl(message.payload && message.payload.url), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_VIDEO_AT_SCENE) {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "Only SceneMarks pages may open a video at a saved scene." });
      return false;
    }
    return respondWith(queueVideoAtScene(message.payload), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.GET_TAB_ID) {
    const tabId = senderTabId(sender);
    sendResponse({ ok: tabId !== null, tabId });
    return false;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEO) {
    return respondWith(openRandomVideo(), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEOS) {
    return respondWith(openRandomVideos(message.payload), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.PICK_RANDOM_VIDEO) {
    return respondWith(pickRandomVideoCandidate(message.payload), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.GET_ACTIVE_TAB_CONTEXT) {
    return respondWith(forwardToActiveTab({ type: SceneMarks.Constants.MESSAGE_TYPES.GET_CONTEXT }), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.FORWARD_TO_ACTIVE_TAB) {
    // Only the popup forwards commands; a page must not drive other tabs.
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "Only SceneMarks pages may forward commands to the active tab." });
      return false;
    }

    return respondWith(forwardToActiveTab(message.payload), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_GET_CONFIG) {
    if (!isVoiceDocumentSender(sender)) {
      sendResponse({ ok: false, error: "Only the SceneMarks voice engine may read its config." });
      return false;
    }
    return respondWith(getVoiceConfig(), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_SPIKE_START
    || message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_SPIKE_STOP) {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "Only SceneMarks pages may control voice listening." });
      return false;
    }
    const run = message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_SPIKE_START
      ? startVoiceDocument()
      : stopVoiceDocument();
    return respondWith(run, sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.STORAGE_RPC) {
    return respondWith(handleStorageRpc(message.payload, sender), sendResponse);
  }

  return false;
});
