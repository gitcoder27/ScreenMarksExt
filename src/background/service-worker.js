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

// Safe to re-run on every worker start: it performs no storage write when
// nothing needs migrating.
SceneMarks.Migrations.migrateLegacyGenericVideos().catch((error) => {
  console.warn("SceneMarks legacy migration failed:", error);
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
  "setPendingJump",
  "consumePendingJump",
  "clearPendingJump",
  "deleteVideo",
  "importState",
  "clearAllData",
  "toggleFloatingButton"
]);

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

function normalizeUrlKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!["http:", "https:", "file:"].includes(url.protocol)) {
      return null;
    }

    // Ignore most query params and fragments: players append tracking
    // noise (trackId, ref, etc.) that would defeat exact-URL matching.
    // YouTube is the exception: its video id lives in ?v=, so dropping it
    // would collapse every watch URL to the same key and make one open
    // YouTube tab exclude the whole platform.
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
    let key = `${url.protocol}//${host}${path}`;
    if (/(^|\.)youtube\.com$/.test(host) && path === "/watch") {
      const videoId = url.searchParams.get("v");
      if (videoId) {
        key += `?v=${videoId.toLowerCase()}`;
      }
    }

    return key;
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

  if (Array.isArray(options.videoKeys) && options.videoKeys.length) {
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

  const state = await SceneMarks.Storage.getState();
  let videos = Object.values(state.videos);

  if (Array.isArray(options.videoKeys) && options.videoKeys.length) {
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

  const picked = sampleRandom(candidates, requested);
  for (const video of picked) {
    await chrome.tabs.create({ url: video.canonicalUrl || video.rawUrls[0], active: false });
  }

  return {
    ok: true,
    openedCount: picked.length,
    requestedCount: requested,
    videos: picked.map((video) => ({ videoKey: video.videoKey, title: video.title }))
  };
}

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

async function handleStorageRpc(payload) {
  const method = payload && typeof payload.method === "string" ? payload.method : null;
  if (!payload || typeof payload !== "object" || !STORAGE_RPC_METHODS.has(method)) {
    return { ok: false, error: "SceneMarks storage RPC rejected an unknown or disallowed method." };
  }

  const args = Array.isArray(payload.args) ? payload.args : [];
  const result = await SceneMarks.Storage[method](...args);
  return { ok: true, result };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_LIBRARY) {
    openLibrary().then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_VIDEO_URL) {
    openVideoUrl(message.payload && message.payload.url).then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEO) {
    openRandomVideo().then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEOS) {
    openRandomVideos(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.PICK_RANDOM_VIDEO) {
    pickRandomVideoCandidate(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.GET_ACTIVE_TAB_CONTEXT) {
    forwardToActiveTab({ type: SceneMarks.Constants.MESSAGE_TYPES.GET_CONTEXT }).then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.FORWARD_TO_ACTIVE_TAB) {
    forwardToActiveTab(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.STORAGE_RPC) {
    handleStorageRpc(message.payload)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({ ok: false, error: (error && error.message) || String(error) });
      });
    return true;
  }

  return false;
});
