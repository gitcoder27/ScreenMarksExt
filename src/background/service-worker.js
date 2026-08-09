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
  "src/content/site-adapters/index.js",
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
