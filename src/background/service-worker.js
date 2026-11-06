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
//
// The same once-per-load pass brings back the voice document: offscreen
// documents close on exactly the events that clear this flag.
const MIGRATIONS_CHECKED_FLAG = "migrationsChecked";
let migrationRun = null;
let voiceDocumentWork = Promise.resolve();
// Set by onStartup, which fires as the first worker of a browser session
// starts, before the once-per-load pass's storage reads come back.
let browserStarting = false;

async function runMigrationsOncePerLoad() {
  const session = chrome.storage.session;
  if (session) {
    const flags = await session.get(MIGRATIONS_CHECKED_FLAG);
    if (flags[MIGRATIONS_CHECKED_FLAG]) {
      return;
    }
  }

  await SceneMarks.Migrations.runAll();
  const settings = await SceneMarks.Storage.getSettings();
  // After a browser restart voice stays off unless the user asked for it
  // to resume (onStartup turns the setting off; this avoids even opening).
  await syncVoiceDocument(settings.voice.enabled && (!browserStarting || settings.voice.resumeOnStartup));
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
chrome.runtime.onStartup.addListener(() => {
  browserStarting = true;
  turnVoiceOffAfterRestart().catch((error) => console.warn("SceneMarks voice startup rule failed:", error));
});
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
  "setSiteEnabled",
  "saveVoiceSamples",
  "addVoiceSample",
  "clearVoiceProfile"
]);

// Library replacement/deletion and global jump cancellation belong to
// extension pages. Content scripts may complete only their own queued jump.
// Voice templates are recorded only on the options page.
const EXTENSION_PAGE_ONLY_RPC_METHODS = new Set([
  "importState", "clearAllData", "clearPendingJump", "saveVoiceSamples", "addVoiceSample", "clearVoiceProfile"
]);

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
  const lineup = { windowId: null, tabIds: [] };
  for (const video of picked) {
    const tab = await chrome.tabs.create({ url: video.canonicalUrl || video.rawUrls[0], active: false });
    if (tab && Number.isSafeInteger(tab.id)) {
      lineup.tabIds.push(tab.id);
      if (lineup.windowId === null && Number.isSafeInteger(tab.windowId)) lineup.windowId = tab.windowId;
    }
  }
  // The batch becomes the voice lineup that "skip" and "return" move
  // through. Each batch replaces the previous one.
  if (lineup.tabIds.length) {
    await saveVoiceLineup(lineup);
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
  if (tab.active && changeInfo.status === "complete") {
    refreshVoiceListening().catch(() => {});
  }

  getBadgeSettings()
    .then((settings) => updateBadge(tabId, tab.url, settings))
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  const { STORAGE_KEYS } = SceneMarks.Constants;
  // New or cleared voice templates: the engine reloads them.
  if (changes[STORAGE_KEYS.VOICE_PROFILE]) {
    notifyVoiceConfigChanged().catch(() => {});
  }

  const change = changes[STORAGE_KEYS.SETTINGS];
  if (!change) {
    return;
  }

  const previous = SceneMarks.Schema.normalizeSettings(change.oldValue);
  badgeSettings = SceneMarks.Schema.normalizeSettings(change.newValue);
  if (previous.extensionEnabled !== badgeSettings.extensionEnabled
    || previous.disabledSites.join(" ") !== badgeSettings.disabledSites.join(" ")) {
    refreshAllBadges();
  }
  // Turning voice on or off opens or closes the microphone document; any
  // other voice setting (mic, sensitivity) is reloaded by the engine.
  if (previous.voice.enabled !== badgeSettings.voice.enabled) {
    syncVoiceDocument(badgeSettings.voice.enabled);
  } else if (JSON.stringify(previous.voice) !== JSON.stringify(badgeSettings.voice)) {
    notifyVoiceConfigChanged().catch(() => {});
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-library") {
    openLibrary();
    return;
  }

  if (command === "toggle-voice") {
    toggleVoiceFromShortcut().catch((error) => console.warn("SceneMarks voice toggle failed:", error));
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

// ---------------------------------------------------------------------
// Voice commands. The microphone lives in an offscreen document
// (src/voice/), so the permission belongs to the extension origin, not to
// the video site, and the prompt never appears on Netflix or YouTube. The
// document exists exactly while settings.voice.enabled is on.
const VOICE_OFFSCREEN_PATH = "src/voice/offscreen.html";
const PAGE_VOICE_ACTIONS = new Set(["next", "back", "pause", "play", "mark"]);

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

async function openVoiceDocument() {
  if (!chrome.offscreen || await hasVoiceDocument()) {
    return;
  }
  // Auto-off counts idle time from when voice was turned on.
  await markVoiceActivity();
  try {
    await chrome.offscreen.createDocument({
      url: VOICE_OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Listen for the user's spoken SceneMarks commands."
    });
  } catch (error) {
    // A racing create already made it.
    if (!/single offscreen/i.test(String(error && error.message))) throw error;
  }
}

async function closeVoiceDocument() {
  if (chrome.offscreen && await hasVoiceDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// Creates and closes are serialized so a quick on/off/on cannot race.
function syncVoiceDocument(enabled) {
  voiceDocumentWork = voiceDocumentWork
    .then(() => (enabled ? openVoiceDocument() : closeVoiceDocument()))
    .catch((error) => console.warn("SceneMarks voice document sync failed:", error));
  return voiceDocumentWork;
}

function isVoiceDocumentSender(sender) {
  return Boolean(sender && sender.url === chrome.runtime.getURL(VOICE_OFFSCREEN_PATH));
}

// Only what the engine needs, never the rest of settings. `listen` is
// whether the mic should be open now ("only while a video tab is active").
async function getVoiceConfig() {
  const [settings, profile] = await Promise.all([
    SceneMarks.Storage.getSettings(),
    SceneMarks.Storage.getVoiceProfile()
  ]);
  const listen = settings.voice.onlyWithVideo ? (await getActivePlayback()).detected : true;
  return { ok: true, voice: settings.voice, profile, listen };
}

// ---- When to listen -------------------------------------------------
async function turnVoiceOffAfterRestart() {
  const settings = await SceneMarks.Storage.getSettings();
  if (settings.voice.enabled && !settings.voice.resumeOnStartup) {
    await SceneMarks.Storage.updateSettings({ voice: { enabled: false } });
  }
}

// What the active tab's player is doing, asked without injecting: a tab
// without our content script has no video we can control anyway.
async function getActivePlayback() {
  const tab = await getVoiceTargetTab();
  if (!tab || !isWebPageUrl(tab.url)) {
    return { detected: false, playing: false };
  }
  try {
    const state = await sendTabMessage(tab.id, {
      type: SceneMarks.Constants.MESSAGE_TYPES.VOICE_ACTION,
      payload: { action: "playback-state" }
    });
    return { detected: Boolean(state && state.detected), playing: Boolean(state && state.playing) };
  } catch (_error) {
    return { detected: false, playing: false };
  }
}

// "Only while a video tab is active": recomputed when the active tab,
// the focused window or the active tab's video changes. The engine
// ignores repeats and waits a moment before closing the mic.
async function refreshVoiceListening() {
  const settings = await getBadgeSettings();
  if (!settings.voice.enabled || !settings.voice.onlyWithVideo || !(await hasVoiceDocument())) {
    return;
  }
  const { detected } = await getActivePlayback();
  chrome.runtime.sendMessage({
    type: SceneMarks.Constants.MESSAGE_TYPES.VOICE_SET_LISTENING,
    payload: { listen: detected }
  }).catch(() => {});
}

chrome.tabs.onActivated.addListener(() => {
  refreshVoiceListening().catch(() => {});
});
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    // WINDOW_ID_NONE: another app took focus; the browser window that
    // had it is still the one being watched.
    if (windowId !== chrome.windows.WINDOW_ID_NONE) refreshVoiceListening().catch(() => {});
  });
}

// Auto-off: the time voice was last needed lives in session storage, so
// it survives the worker sleeping between the engine's minute checks.
const VOICE_ACTIVITY_KEY = "voiceLastActivityAt";

async function markVoiceActivity() {
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [VOICE_ACTIVITY_KEY]: Date.now() });
  }
}

async function checkVoiceIdle() {
  const settings = await SceneMarks.Storage.getSettings();
  const minutes = settings.voice.autoOffMinutes;
  if (!settings.voice.enabled || !minutes || !chrome.storage.session) {
    return { ok: true, idle: false };
  }
  // A tab making sound (with headphones, or even with the Mac muted) or a
  // video playing silently in the active tab counts as watching.
  const audible = await chrome.tabs.query({ audible: true });
  const playing = audible.length > 0 || (await getActivePlayback()).playing;
  const last = (await chrome.storage.session.get(VOICE_ACTIVITY_KEY))[VOICE_ACTIVITY_KEY];
  if (playing || !Number.isFinite(last)) {
    await markVoiceActivity();
    return { ok: true, idle: false };
  }
  if (Date.now() - last < minutes * 60 * 1000) {
    return { ok: true, idle: false };
  }
  await SceneMarks.Storage.updateSettings({ voice: { enabled: false } });
  return { ok: true, idle: true };
}

async function notifyVoiceConfigChanged() {
  if (await hasVoiceDocument()) {
    chrome.runtime.sendMessage({ type: SceneMarks.Constants.MESSAGE_TYPES.VOICE_CONFIG_CHANGED })
      .catch(() => {});
  }
}

// The tab the user is looking at: the active tab of the last focused
// window (the popup is not open while speaking, so this is the video).
async function getVoiceTargetTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

function isWebPageUrl(url) {
  return /^https?:/i.test(url || "") || String(url || "").startsWith("file://");
}

async function sendVoiceAction(tab, payload) {
  if (!tab || !Number.isSafeInteger(tab.id) || !isWebPageUrl(tab.url)) {
    return { ok: false, error: "No video page is active." };
  }
  try {
    if (!(await ensureContentScript(tab.id))) {
      return { ok: false, error: "SceneMarks could not start on this page." };
    }
    return await sendTabMessage(tab.id, { type: SceneMarks.Constants.MESSAGE_TYPES.VOICE_ACTION, payload });
  } catch (error) {
    return { ok: false, error: error.message || "SceneMarks could not run on this page." };
  }
}

// Short fixed feedback on the active page, e.g. after the shortcut.
async function announceOnActiveTab(message) {
  const tab = await getVoiceTargetTab();
  if (tab && isWebPageUrl(tab.url)) {
    await sendVoiceAction(tab, { action: "announce", message }).catch(() => {});
  }
}

// ---- The lineup: "skip" and "return" --------------------------------
// The tabs a batch Open Random opened, in order, kept in
// chrome.storage.session: in memory, invisible to content scripts, and
// nothing added to storage.local.
const VOICE_LINEUP_KEY = "voiceLineup";
const TAB_LOAD_TIMEOUT_MS = 10000;

async function getVoiceLineup() {
  const session = chrome.storage.session;
  if (!session) return { windowId: null, tabIds: [] };
  const stored = (await session.get(VOICE_LINEUP_KEY))[VOICE_LINEUP_KEY];
  const tabIds = stored && Array.isArray(stored.tabIds) ? stored.tabIds.filter(Number.isSafeInteger) : [];
  return { windowId: stored && Number.isSafeInteger(stored.windowId) ? stored.windowId : null, tabIds };
}

async function saveVoiceLineup(lineup) {
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [VOICE_LINEUP_KEY]: lineup });
  }
}

// Pure: where "skip" (direction 1) or "return" (-1) goes. The lineup wins
// when it has open tabs: the tab after (before) the active one, wrapping,
// or its first (last) tab when the active tab is not in it. Without a
// lineup, the next (previous) web tab in the active window, wrapping.
// Returns { tabId, position, total, kind } or null when there is nowhere
// else to go.
function pickVoiceSwitchTarget(direction, activeTabId, lineupTabIds, windowTabIds) {
  const pick = (ids, kind) => {
    const index = ids.indexOf(activeTabId);
    if (!ids.length || (ids.length === 1 && index === 0)) return null;
    const target = index === -1
      ? (direction > 0 ? 0 : ids.length - 1)
      : (index + direction + ids.length) % ids.length;
    return { tabId: ids[target], position: target + 1, total: ids.length, kind };
  };
  return lineupTabIds.length ? pick(lineupTabIds, "lineup") : pick(windowTabIds, "tabs");
}

// Background tabs may still be loading (or be discarded and reload on
// activation); the content script can only take the command once the
// page has loaded.
async function waitForTabLoad(tabId) {
  const deadline = Date.now() + TAB_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete") return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

async function announceVoiceError(tab, heard, message) {
  if (tab && isWebPageUrl(tab.url)) {
    await sendVoiceAction(tab, { action: "announce", heard, message, isError: true }).catch(() => {});
  }
  return { ok: false, error: message };
}

async function switchVideoTab(direction, heard) {
  const current = await getVoiceTargetTab();
  const allTabs = await chrome.tabs.query({});
  const openIds = new Set(allTabs.map((tab) => tab.id));
  const lineup = await getVoiceLineup();
  const liveLineup = lineup.tabIds.filter((id) => openIds.has(id));
  if (liveLineup.length !== lineup.tabIds.length) {
    await saveVoiceLineup({ ...lineup, tabIds: liveLineup });
  }
  const windowTabs = current
    ? allTabs.filter((tab) => tab.windowId === current.windowId && isWebPageUrl(tab.url))
      .sort((a, b) => a.index - b.index).map((tab) => tab.id)
    : [];

  const target = pickVoiceSwitchTarget(direction, current ? current.id : null, liveLineup, windowTabs);
  if (!target) {
    return announceVoiceError(current, heard, liveLineup.length
      ? "This is the only video in the lineup"
      : "No other video tab to switch to");
  }

  // Leave the current video paused, not playing in the background.
  if (current && isWebPageUrl(current.url)) {
    await sendTabMessage(current.id, {
      type: SceneMarks.Constants.MESSAGE_TYPES.VOICE_ACTION,
      payload: { action: "pause", silent: true }
    }).catch(() => {});
  }

  const targetTab = allTabs.find((tab) => tab.id === target.tabId);
  await chrome.tabs.update(target.tabId, { active: true });
  if (targetTab && current && targetTab.windowId !== current.windowId && chrome.windows) {
    await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
  }
  await waitForTabLoad(target.tabId);
  const tab = await chrome.tabs.get(target.tabId).catch(() => targetTab);
  return sendVoiceAction(tab, {
    action: "startAtFirstMark",
    heard,
    position: target.position,
    total: target.total,
    kind: target.kind
  });
}

// "random": a random saved video that is not open yet, opened at its first
// saved timestamp through the same owned queued jump the Library uses.
async function openRandomVideoAtFirstMark() {
  const state = await SceneMarks.Storage.getState();
  const openUrlKeys = await getOpenTabUrlKeys();
  const candidates = Object.values(state.videos).filter((video) => {
    const openableUrl = video.canonicalUrl || (Array.isArray(video.rawUrls) ? video.rawUrls[0] : null);
    return Boolean(openableUrl) && video.scenes.length > 0 && !isOpenInTab(video, openUrlKeys);
  });
  if (!candidates.length) {
    return announceVoiceError(await getVoiceTargetTab(), "random", Object.keys(state.videos).length
      ? "Every saved video is already open"
      : "The SceneMarks library is empty");
  }

  const video = pickRandom(candidates);
  const first = video.scenes[0];
  const result = await queueVideoAtScene({
    url: video.canonicalUrl || video.rawUrls[0],
    videoKey: video.videoKey,
    sceneId: first.id,
    seconds: first.startSeconds
  });
  if (!result.ok) {
    return result;
  }
  // It joins the end of the lineup, so "return" comes back to it.
  const lineup = await getVoiceLineup();
  if (lineup.tabIds.length) {
    await saveVoiceLineup({ ...lineup, tabIds: [...lineup.tabIds, result.tabId] });
  }
  return { ok: true, message: "Opening a random video at its first mark" };
}

async function handleVoiceCommand(payload) {
  const command = payload && payload.command;
  const known = SceneMarks.Constants.VOICE_COMMANDS.some(({ id }) => id === command);
  if (!known) {
    return { ok: false, error: "Unknown voice command." };
  }
  // A document left over from a quick off/on must not act once voice is off.
  const settings = await SceneMarks.Storage.getSettings();
  if (!settings.voice.enabled) {
    return { ok: false, error: "Voice commands are off." };
  }
  if (settings.voice.autoOffMinutes) {
    await markVoiceActivity();
  }

  if (PAGE_VOICE_ACTIONS.has(command)) {
    return sendVoiceAction(await getVoiceTargetTab(), { action: command, heard: command });
  }
  if (command === "skip" || command === "return") {
    return switchVideoTab(command === "skip" ? 1 : -1, command);
  }
  return openRandomVideoAtFirstMark();
}

async function toggleVoiceFromShortcut() {
  const enabled = await SceneMarks.Storage.toggleVoiceEnabled();
  if (!enabled) {
    await announceOnActiveTab("Voice commands off");
    return;
  }
  const profile = await SceneMarks.Storage.getVoiceProfile();
  await announceOnActiveTab(Object.keys(profile.commands).length
    ? "Voice commands on"
    : "Voice commands on. Record your words in Settings first.");
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

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_IDLE_CHECK) {
    if (!isVoiceDocumentSender(sender)) {
      sendResponse({ ok: false, error: "Only the SceneMarks voice engine may ask." });
      return false;
    }
    return respondWith(checkVoiceIdle(), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_VIDEO_PRESENCE) {
    // A hint only: the worker re-asks the active tab itself.
    if (senderTabId(sender) !== null && sender.tab.active) {
      refreshVoiceListening().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.VOICE_COMMAND) {
    if (!isVoiceDocumentSender(sender)) {
      sendResponse({ ok: false, error: "Only the SceneMarks voice engine may send voice commands." });
      return false;
    }
    return respondWith(handleVoiceCommand(message.payload), sendResponse);
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.STORAGE_RPC) {
    return respondWith(handleStorageRpc(message.payload, sender), sendResponse);
  }

  return false;
});
