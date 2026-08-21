importScripts(
  "../shared/constants.js",
  "../shared/time.js",
  "../shared/ids.js",
  "../shared/schema.js",
  "../shared/storage.js"
);

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
  "src/shared/migrations.js",
  "src/content/video-detector.js",
  "src/content/overlay.js",
  "src/content/content-script.js"
];

const OVERLAY_CSS_FILE = "src/content/overlay.css";

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
    await sendTabMessage(tabId, { type: "SCENEMARKS_PING" });
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
        await sendTabMessage(tabId, { type: "SCENEMARKS_PING" });
        return true;
      } catch (_error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return true;
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
    await ensureContentScript(tab.id);
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

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-library") {
    openLibrary();
    return;
  }

  const type = command === "mark-scene-range"
    ? "SCENEMARKS_TOGGLE_RANGE"
    : "SCENEMARKS_QUICK_SAVE";

  forwardToActiveTab({
    type,
    payload: { quick: true, source: "browser-command" }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "SCENEMARKS_OPEN_LIBRARY") {
    openLibrary().then(sendResponse);
    return true;
  }

  if (message.type === "SCENEMARKS_OPEN_VIDEO_URL") {
    openVideoUrl(message.payload && message.payload.url).then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEO) {
    openRandomVideo().then(sendResponse);
    return true;
  }

  if (message.type === SceneMarks.Constants.MESSAGE_TYPES.PICK_RANDOM_VIDEO) {
    pickRandomVideoCandidate(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "SCENEMARKS_GET_ACTIVE_TAB_CONTEXT") {
    forwardToActiveTab({ type: "SCENEMARKS_GET_VIDEO_CONTEXT" }).then(sendResponse);
    return true;
  }

  if (message.type === "SCENEMARKS_FORWARD_TO_ACTIVE_TAB") {
    forwardToActiveTab(message.payload).then(sendResponse);
    return true;
  }

  return false;
});
