(function initializeSceneMarksContent(root) {
  // A leftover token alone cannot block re-injection: after an extension
  // reload the previous copy is dead while its token stays set, so ownership
  // is decided by that copy's liveness probe, which reads the chrome binding
  // of its own injection context.
  if (root.__SceneMarksContentLoaded) {
    let previousCopyIsLive = false;
    try {
      previousCopyIsLive = typeof root.__SceneMarksLivenessProbe === "function"
        && root.__SceneMarksLivenessProbe() === true;
    } catch (_error) {
      previousCopyIsLive = false;
    }

    if (previousCopyIsLive) {
      return;
    }
  }

  const CONTEXT_TOKEN = `${Date.now()}-${Math.random()}`;
  root.__SceneMarksContentLoaded = CONTEXT_TOKEN;
  // chrome is per-injection-context, so a dead orphan's probe returns false
  // while a live copy's returns true.
  const livenessProbe = () => {
    try {
      return Boolean(root.chrome && root.chrome.runtime && root.chrome.runtime.id);
    } catch (_error) {
      return false;
    }
  };
  root.__SceneMarksLivenessProbe = livenessProbe;

  const SceneMarks = root.SceneMarks;
  const { MESSAGE_TYPES } = SceneMarks.Constants;
  const { formatRange, formatSeconds } = SceneMarks.Time;
  // Mutations must go through the service-worker RPC client (single writer)
  // so concurrent tabs cannot lose each other's read-modify-write updates;
  // reads stay local to this context.
  const Storage = SceneMarks.Storage.createClient();
  let settings = null;
  let overlay = null;
  let overlayRefreshTimer = null;
  let pendingJumpTimer = null;
  let contextDead = false;
  let hotkeyListener = null;
  let stopNavigationWatcher = null;

  function isContextDead() {
    if (contextDead) {
      return true;
    }

    try {
      // chrome.runtime.id becomes undefined once the context is invalidated
      // (extension reload/update). Accessing it does not throw; checking it
      // is the canonical probe for a dead content-script context.
      return !chrome.runtime.id;
    } catch (_error) {
      return true;
    }
  }

  function tearDownDeadContext() {
    if (contextDead) {
      return;
    }

    contextDead = true;
    root.clearTimeout(overlayRefreshTimer);
    root.clearTimeout(pendingJumpTimer);
    if (stopNavigationWatcher) {
      stopNavigationWatcher();
      stopNavigationWatcher = null;
    }
    detector.stop();

    if (hotkeyListener) {
      root.removeEventListener("keydown", hotkeyListener, true);
      hotkeyListener = null;
    }

    if (overlay) {
      overlay.destroy();
      overlay = null;
    }

    // Let a later injected copy (after extension reload) take over, but do not
    // clobber a replacement script that has already been injected.
    if (root.__SceneMarksContentLoaded === CONTEXT_TOKEN) {
      root.__SceneMarksContentLoaded = false;
    }

    // The global probe holds whatever the last injected copy installed, so it
    // may already belong to a successor; only clear it while it is still ours.
    if (root.__SceneMarksLivenessProbe === livenessProbe) {
      root.__SceneMarksLivenessProbe = null;
    }
  }

  function isInvalidContextError(error) {
    return error && /Extension context invalidated/i.test(String(error.message || error));
  }

  // Converts an async entry point into one that silently tears down on a dead
  // extension context instead of producing uncaught promise rejections.
  function guard(fn) {
    return (...args) => {
      if (isContextDead()) {
        tearDownDeadContext();
        return { ok: false, error: "SceneMarks was reloaded. Refresh the page to reactivate it." };
      }

      return Promise.resolve()
        .then(() => fn(...args))
        .catch((error) => {
          if (isInvalidContextError(error)) {
            tearDownDeadContext();
            return { ok: false, error: "SceneMarks was reloaded. Refresh the page to reactivate it." };
          }

          throw error;
        });
    };
  }

  const detector = SceneMarks.VideoDetector.createVideoDetector({
    onContextChange: () => {
      scheduleOverlayRefresh(1000);
      schedulePendingJumpCheck(500);
    },
    onPlaybackTick: (seconds) => {
      if (overlay && !isContextDead()) {
        overlay.updatePlaybackTime(seconds);
      }
    }
  });

  function errorResponse(error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error || "Unknown SceneMarks error.")
    };
  }

  async function loadSettings() {
    const state = await Storage.getState();
    settings = state.settings;
    return settings;
  }

  function getSettingsSync() {
    return settings || SceneMarks.Constants.DEFAULT_SETTINGS;
  }

  function isTextInputTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
  }

  function parseShortcut(shortcut) {
    const parts = String(shortcut || "")
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    const parsed = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: ""
    };

    for (const part of parts) {
      const value = part.toLowerCase();
      if (value === "alt" || value === "option") {
        parsed.altKey = true;
      } else if (value === "ctrl" || value === "control") {
        parsed.ctrlKey = true;
      } else if (value === "cmd" || value === "command" || value === "meta") {
        parsed.metaKey = true;
      } else if (value === "shift") {
        parsed.shiftKey = true;
      } else {
        parsed.key = value;
      }
    }

    return parsed.key ? parsed : null;
  }

  // Saved settings keep the human key token ("S", "3", ","), which is matched
  // against event.code because event.key shifts under layouts and modifier
  // composing (macOS Alt+Shift+S yields key "Í"), while event.code does not.
  const KEY_TOKEN_TO_CODE = {
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "-": "Minus",
    "=": "Equal",
    "`": "Backquote",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    insert: "Insert",
    delete: "Delete",
    space: "Space",
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace"
  };

  // Inverse of the options-page recorder's code-to-token mapping; every entry
  // must round-trip.
  function tokenToCode(token) {
    if (/^[a-z]$/.test(token)) {
      return `Key${token.toUpperCase()}`;
    }

    if (/^[0-9]$/.test(token)) {
      return `Digit${token}`;
    }

    if (/^f\d{1,2}$/.test(token)) {
      return token.toUpperCase();
    }

    return KEY_TOKEN_TO_CODE[token] || null;
  }

  function shortcutMatches(event, shortcut) {
    const parsed = parseShortcut(shortcut);
    if (!parsed) {
      return false;
    }

    const expectedCode = tokenToCode(parsed.key);
    const keyMatches = expectedCode !== null
      ? event.code === expectedCode
      : event.key.toLowerCase() === parsed.key;

    return event.altKey === parsed.altKey
      && event.ctrlKey === parsed.ctrlKey
      && event.metaKey === parsed.metaKey
      && event.shiftKey === parsed.shiftKey
      && keyMatches;
  }

  function getCurrentSnapshot() {
    return detector.getSnapshot();
  }

  function requireDetectedVideo() {
    const snapshot = getCurrentSnapshot();
    if (!snapshot.detected) {
      return {
        ok: false,
        snapshot,
        error: "No video detected \u2014 start playback first"
      };
    }

    if (snapshot.platform === "generic" && getSettingsSync().enableGenericSites === false) {
      return {
        ok: false,
        snapshot,
        error: "Generic site support is disabled in SceneMarks settings."
      };
    }

    return { ok: true, snapshot };
  }

  async function getContextResponse() {
    const snapshot = getCurrentSnapshot();
    const state = await Storage.getState();
    const savedVideo = snapshot.videoKey ? state.videos[snapshot.videoKey] || null : null;

    return {
      ok: true,
      context: snapshot,
      video: savedVideo,
      videos: state.videos,
      scenes: savedVideo ? savedVideo.scenes : [],
      activeRangeDraft: state.activeRangeDraft,
      pendingJump: state.pendingJump,
      settings: state.settings
    };
  }

  async function saveTimestamp(payload) {
    const detected = requireDetectedVideo();
    if (!detected.ok) {
      return detected;
    }

    const currentSettings = getSettingsSync();
    const note = payload && payload.note ? payload.note : "";

    if (payload && payload.quick && currentSettings.quickSaveRequiresNote && !note.trim()) {
      return { ok: false, requiresNote: true, error: "Quick save requires a note in settings" };
    }

    const result = await Storage.saveScene(
      detected.snapshot,
      {
        type: "timestamp",
        startSeconds: detected.snapshot.currentTimeSeconds,
        endSeconds: null,
        note,
        tags: payload && payload.tags,
        favorite: payload && payload.favorite
      },
      { allowDuplicate: payload && payload.allowDuplicate === true }
    );

    if (result.duplicate && payload && payload.quick) {
      return { ok: false, duplicate: true, error: "A nearby scene already exists" };
    }

    if (result.ok) {
      scheduleOverlayRefresh(100);
    }

    return result;
  }

  async function startRange(payload) {
    const detected = requireDetectedVideo();
    if (!detected.ok) {
      return detected;
    }

    const result = await Storage.startRange(
      detected.snapshot,
      detected.snapshot.currentTimeSeconds,
      { overwrite: payload && payload.overwrite === true }
    );

    if (result.ok) {
      scheduleOverlayRefresh(100);
      return {
        ...result,
        message: `Range start ${formatSeconds(result.draft.startSeconds)}`
      };
    }

    return result;
  }

  async function endRange(payload) {
    const detected = requireDetectedVideo();
    if (!detected.ok) {
      return detected;
    }

    const result = await Storage.endRange(detected.snapshot, detected.snapshot.currentTimeSeconds, payload || {});
    if (result.ok) {
      scheduleOverlayRefresh(100);
      return {
        ...result,
        message: `Range saved ${formatRange(result.scene.startSeconds, result.scene.endSeconds)}`
      };
    }

    return result;
  }

  async function toggleRange(payload) {
    const detected = requireDetectedVideo();
    if (!detected.ok) {
      return detected;
    }

    const state = await Storage.getState();
    if (state.activeRangeDraft && state.activeRangeDraft.videoKey === detected.snapshot.videoKey) {
      return endRange(payload);
    }

    return startRange(payload);
  }

  // Jump feedback includes where you landed among the video's saved scenes
  // (the exact set the hotkeys cycle through), e.g. "Jumped to 04:12 (4/10)".
  function jumpMessage(scene, index, total) {
    return `Jumped to ${formatSeconds(scene.startSeconds)} (${index + 1}/${total})`;
  }

  async function jumpToNextScene() {
    const detected = requireDetectedVideo();
    if (!detected.ok) {
      return detected;
    }

    const scenes = await Storage.getScenesForVideo(detected.snapshot.videoKey);
    if (!scenes.length) {
      return { ok: false, error: "No saved timestamps for this video." };
    }

    const currentSeconds = detected.snapshot.currentTimeSeconds;
    const nextIndex = scenes.findIndex((scene) => scene.startSeconds > currentSeconds + 0.1);
    const nextScene = nextIndex >= 0 ? scenes[nextIndex] : scenes[0];
    const result = await seekTo({ seconds: nextScene.startSeconds });

    return result.ok
      ? { ok: true, message: jumpMessage(nextScene, Math.max(nextIndex, 0), scenes.length) }
      : result;
  }

  async function jumpToPreviousScene() {
    const detected = requireDetectedVideo();
    if (!detected.ok) {
      return detected;
    }

    const scenes = await Storage.getScenesForVideo(detected.snapshot.videoKey);
    if (!scenes.length) {
      return { ok: false, error: "No saved timestamps for this video." };
    }

    const currentSeconds = detected.snapshot.currentTimeSeconds;
    // Anchor on the most recent timestamp at or before the current position:
    // right after a backwards jump that is the timestamp playback just left,
    // otherwise it is the nearest previous one. Skip the anchor and land on
    // the timestamp before it, so repeated presses keep cycling backwards
    // instead of re-landing on the same timestamp while playback creeps
    // forward. With no anchor (before the first timestamp) or none before
    // the anchor, wrap to the last timestamp.
    let anchorIndex = -1;
    for (let i = scenes.length - 1; i >= 0; i -= 1) {
      if (scenes[i].startSeconds <= currentSeconds + 0.1) {
        anchorIndex = i;
        break;
      }
    }

    const previousIndex = anchorIndex >= 1 ? anchorIndex - 1 : scenes.length - 1;
    const previousScene = scenes[previousIndex];
    const result = await seekTo({ seconds: previousScene.startSeconds });

    return result.ok
      ? { ok: true, message: jumpMessage(previousScene, previousIndex, scenes.length) }
      : result;
  }

  async function seekTo(payload) {
    const currentSettings = getSettingsSync();
    const behavior = payload && payload.behavior ? payload.behavior : currentSettings.defaultJumpBehavior;
    const result = await detector.seekTo(payload && payload.seconds, behavior);
    if (result.ok) {
      scheduleOverlayRefresh(250);
    }

    return result;
  }

  async function deleteScene(payload) {
    if (!payload || !payload.videoKey || !payload.sceneId) {
      return { ok: false, error: "Missing scene deletion details." };
    }

    return Storage.deleteScene(payload.videoKey, payload.sceneId);
  }

  async function updateScene(payload) {
    if (!payload || !payload.videoKey || !payload.sceneId) {
      return { ok: false, error: "Missing scene update details." };
    }

    return Storage.updateScene(payload.videoKey, payload.sceneId, payload.updates || {});
  }

  function getVideoUrl(video) {
    return video && (video.canonicalUrl || (Array.isArray(video.rawUrls) && video.rawUrls[0])) || "";
  }

  async function openVideoAtScene(video, scene) {
    const url = getVideoUrl(video);
    if (!video || !scene || !url) {
      return { ok: false, error: "This saved video does not have an openable URL." };
    }

    const pendingResult = await Storage.setPendingJump({
      videoKey: video.videoKey,
      sceneId: scene.id,
      seconds: scene.startSeconds,
      url
    });

    if (!pendingResult.ok) {
      return pendingResult;
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OPEN_VIDEO_URL,
      payload: { url }
    });

    return response && response.ok ? { ok: true } : response || { ok: false, error: "Could not open video." };
  }

  async function handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.PING:
        return { ok: true };
      case MESSAGE_TYPES.GET_CONTEXT:
        return getContextResponse();
      case MESSAGE_TYPES.QUICK_SAVE:
        return saveTimestamp({ ...(message.payload || {}), quick: true });
      case MESSAGE_TYPES.SAVE_TIMESTAMP:
        return saveTimestamp(message.payload || {});
      case MESSAGE_TYPES.START_RANGE:
        return startRange(message.payload || {});
      case MESSAGE_TYPES.END_RANGE:
        return endRange(message.payload || {});
      case MESSAGE_TYPES.TOGGLE_RANGE:
        return toggleRange(message.payload || {});
      case MESSAGE_TYPES.SEEK_TO:
        return seekTo(message.payload || {});
      case MESSAGE_TYPES.DELETE_SCENE:
        return deleteScene(message.payload || {});
      case MESSAGE_TYPES.UPDATE_SCENE:
        return updateScene(message.payload || {});
      default:
        return { ok: false, error: "Unknown SceneMarks message." };
    }
  }

  function installMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (isContextDead()) {
        return false;
      }

      handleMessage(message)
        .then(sendResponse)
        .catch((error) => {
          if (isInvalidContextError(error)) {
            tearDownDeadContext();
            return;
          }

          sendResponse(errorResponse(error));
        });
      return true;
    });
  }

  // history.pushState/replaceState cannot be observed from this isolated
  // world (the page's main world keeps its own unpatched history), so SPA
  // navigations are watched through the Navigation API; only engines without
  // it fall back to polling location.href.
  function installNavigationWatcher() {
    const stopFunctions = [];
    const notify = () => detector.scheduleScan();

    const onPopState = () => notify();
    root.addEventListener("popstate", onPopState, { passive: true });
    stopFunctions.push(() => root.removeEventListener("popstate", onPopState));

    const navigation = root.navigation;
    if (navigation && typeof navigation.addEventListener === "function") {
      const onNavigate = () => notify();
      navigation.addEventListener("navigate", onNavigate);
      stopFunctions.push(() => navigation.removeEventListener("navigate", onNavigate));
    } else {
      let lastHref = root.location.href;
      let pollTimer = null;
      const pollForHrefChange = () => {
        if (root.location.href !== lastHref) {
          lastHref = root.location.href;
          notify();
        }

        pollTimer = root.setTimeout(pollForHrefChange, 1000);
      };

      pollTimer = root.setTimeout(pollForHrefChange, 1000);
      stopFunctions.push(() => root.clearTimeout(pollTimer));
    }

    return () => {
      stopFunctions.forEach((stop) => stop());
      stopFunctions.length = 0;
    };
  }

  async function openLibrary() {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OPEN_LIBRARY });
  }

  async function openRandomVideoFromLibrary() {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OPEN_RANDOM_VIDEO
    });

    return response || { ok: false, error: "Could not open a random video." };
  }

  async function pickRandomVideoFromLibrary(payload) {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PICK_RANDOM_VIDEO,
      payload: payload || {}
    });

    return response || { ok: false, error: "Could not pick a random video." };
  }

  async function toggleOverlayVisibility() {
    // Atomic flip in the service worker; the result carries the settings as
    // they are after the flip, avoiding a stale read-then-write here.
    const result = await Storage.toggleFloatingButton();
    settings = result.settings;
    const enabled = Boolean(settings && settings.enableFloatingButton);

    if (overlay) {
      overlay.setEnabled(enabled);
    }

    return { ok: true, message: enabled ? "Overlay shown" : "Overlay hidden" };
  }

  function installPageHotkeys() {
    hotkeyListener = async (event) => {
      if (isContextDead()) {
        tearDownDeadContext();
        return;
      }

      const currentSettings = getSettingsSync();
      if (!currentSettings.enablePageHotkeys || event.repeat || isTextInputTarget(event.target)) {
        return;
      }

      const hotkeys = currentSettings.hotkeys || {};
      let action = null;

      if (shortcutMatches(event, hotkeys.quickSave)) {
        action = async () => {
          const result = await saveTimestamp({ quick: true });
          return result.ok && result.scene
            ? { ...result, message: `Saved ${formatSeconds(result.scene.startSeconds)}` }
            : result;
        };
      } else if (shortcutMatches(event, hotkeys.toggleRange)) {
        action = () => toggleRange({ quick: true });
      } else if (shortcutMatches(event, hotkeys.startRange)) {
        action = () => startRange({ quick: true });
      } else if (shortcutMatches(event, hotkeys.endRange)) {
        action = () => endRange({ quick: true });
      } else if (shortcutMatches(event, hotkeys.nextScene)) {
        action = jumpToNextScene;
      } else if (shortcutMatches(event, hotkeys.previousScene)) {
        action = jumpToPreviousScene;
      } else if (shortcutMatches(event, hotkeys.randomVideo)) {
        action = openRandomVideoFromLibrary;
      } else if (shortcutMatches(event, hotkeys.toggleOverlay)) {
        action = toggleOverlayVisibility;
      } else if (shortcutMatches(event, hotkeys.openLibrary)) {
        action = openLibrary;
      }

      if (!action) {
        return;
      }

      event.preventDefault();
      let result;
      try {
        result = await action();
      } catch (error) {
        if (isInvalidContextError(error)) {
          tearDownDeadContext();
        }
        return;
      }

      if (overlay && result && result.error) {
        overlay.showToast(result.error, "error");
      } else if (overlay && result && result.message) {
        overlay.showToast(result.message, "success");
      } else if (overlay && result && result.ok) {
        overlay.showToast("Done", "info");
      }
    };

    root.addEventListener("keydown", hotkeyListener, true);
  }

  function installStorageListener() {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (isContextDead() || areaName !== "local" || !changes.scenemarksState) {
        return;
      }

      try {
        await loadSettings();
        if (overlay) {
          overlay.setEnabled(getSettingsSync().enableFloatingButton);
          scheduleOverlayRefresh(100);
        }
      } catch (error) {
        if (isInvalidContextError(error)) {
          tearDownDeadContext();
        }
      }
    });
  }

  function scheduleOverlayRefresh(delayMs) {
    root.clearTimeout(overlayRefreshTimer);
    overlayRefreshTimer = root.setTimeout(() => {
      if (!overlay || isContextDead()) {
        return;
      }

      overlay.refresh().catch((error) => {
        if (isInvalidContextError(error)) {
          tearDownDeadContext();
        }
      });
    }, Number.isFinite(delayMs) ? delayMs : 250);
  }

  function schedulePendingJumpCheck(delayMs) {
    root.clearTimeout(pendingJumpTimer);
    pendingJumpTimer = root.setTimeout(() => {
      if (isContextDead()) {
        return;
      }

      attemptPendingJump().catch((error) => {
        if (isInvalidContextError(error)) {
          tearDownDeadContext();
          return;
        }

        if (overlay) {
          overlay.showToast(error.message || "Could not complete queued jump", "error");
        }
      });
    }, Number.isFinite(delayMs) ? delayMs : 500);
  }

  async function attemptPendingJump() {
    if (isContextDead()) {
      return;
    }

    const snapshot = getCurrentSnapshot();
    if (!snapshot.detected || !snapshot.videoKey) {
      return;
    }

    const result = await Storage.consumePendingJump(snapshot.videoKey);
    if (!result.ok) {
      return;
    }

    const seekResult = await seekTo({ seconds: result.pendingJump.seconds });
    if (overlay) {
      overlay.showToast(
        seekResult.ok
          ? `Jumped to ${formatSeconds(result.pendingJump.seconds)}`
          : seekResult.error || "Queued jump could not seek yet",
        seekResult.ok ? "success" : "error"
      );
    }
  }

  async function initOverlay() {
    // An orphaned copy of this script (from before an extension reload) may
    // still have its overlay or toast mounted; remove it before creating ours.
    document.querySelectorAll(".scenemarks-overlay, .scenemarks-toast").forEach((staleNode) => staleNode.remove());

    overlay = SceneMarks.Overlay.createOverlay({
      getState: guard(getContextResponse),
      quickSave: guard(() => saveTimestamp({ quick: true })),
      toggleRange: guard(() => toggleRange({ quick: true })),
      seekTo: guard((seconds) => seekTo({ seconds })),
      deleteScene: guard((payload) => deleteScene(payload)),
      updateSceneFavorite: guard(async (payload) => {
        if (!payload || !payload.videoKey || !payload.sceneId) {
          return { ok: false, error: "Missing favorite details." };
        }

        return Storage.updateScene(payload.videoKey, payload.sceneId, { favorite: payload.favorite === true });
      }),
      updateVideoFavorite: guard(async (payload) => {
        if (!payload || !payload.videoKey) {
          return { ok: false, error: "Missing favorite details." };
        }

        return Storage.updateVideo(payload.videoKey, { favorite: payload.favorite === true });
      }),
      openVideoAtScene: guard(openVideoAtScene),
      pickRandomVideo: guard((payload) => pickRandomVideoFromLibrary(payload))
    });
    overlay.setEnabled(getSettingsSync().enableFloatingButton);
  }

  async function init() {
    installMessageListener();
    await loadSettings();
    detector.start();
    stopNavigationWatcher = installNavigationWatcher();
    installPageHotkeys();
    installStorageListener();
    await initOverlay();
    schedulePendingJumpCheck(1000);
  }

  init().catch((error) => {
    if (isInvalidContextError(error)) {
      tearDownDeadContext();
      return;
    }

    console.warn("SceneMarks initialization failed:", error);
  });
})(globalThis);
