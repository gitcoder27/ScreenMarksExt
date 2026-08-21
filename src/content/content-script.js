(function initializeSceneMarksContent(root) {
  if (root.__SceneMarksContentLoaded) {
    return;
  }
  const CONTEXT_TOKEN = `${Date.now()}-${Math.random()}`;
  root.__SceneMarksContentLoaded = CONTEXT_TOKEN;

  const SceneMarks = root.SceneMarks;
  const { MESSAGE_TYPES } = SceneMarks.Constants;
  const { formatSeconds } = SceneMarks.Time;
  const Storage = SceneMarks.Storage;
  let settings = null;
  let overlay = null;
  let overlayRefreshTimer = null;
  let pendingJumpTimer = null;
  let contextDead = false;
  let hotkeyListener = null;

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

  function shortcutMatches(event, shortcut) {
    const parsed = parseShortcut(shortcut);
    if (!parsed) {
      return false;
    }

    return event.altKey === parsed.altKey
      && event.ctrlKey === parsed.ctrlKey
      && event.metaKey === parsed.metaKey
      && event.shiftKey === parsed.shiftKey
      && event.key.toLowerCase() === parsed.key;
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
        error: "No active video detected. Start playback or reload the page, then try again."
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
      return { ok: false, requiresNote: true, error: "Quick save requires a note in settings." };
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
      return { ok: false, duplicate: true, error: "A nearby scene already exists." };
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
        message: `Range start marked at ${formatSeconds(result.draft.startSeconds)}.`
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
      return { ...result, message: "Scene range saved." };
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
    const nextScene = scenes.find((scene) => scene.startSeconds > currentSeconds + 0.1) || scenes[0];
    const result = await seekTo({ seconds: nextScene.startSeconds });

    return result.ok
      ? { ok: true, message: `Jumped to ${formatSeconds(nextScene.startSeconds)}.` }
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

    const previousScene = anchorIndex >= 1 ? scenes[anchorIndex - 1] : scenes[scenes.length - 1];
    const result = await seekTo({ seconds: previousScene.startSeconds });

    return result.ok
      ? { ok: true, message: `Jumped to ${formatSeconds(previousScene.startSeconds)}.` }
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

  function installUrlWatcher() {
    const notify = () => {
      root.setTimeout(() => detector.scheduleScan(), 150);
    };
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      notify();
      return result;
    };

    history.replaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      notify();
      return result;
    };

    root.addEventListener("popstate", notify, { passive: true });
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

  async function toggleOverlayVisibility() {
    const enabled = !getSettingsSync().enableFloatingButton;
    settings = await Storage.updateSettings({ enableFloatingButton: enabled });

    if (overlay) {
      overlay.setEnabled(enabled);
    }

    return { ok: true, message: enabled ? "Overlay shown." : "Overlay hidden." };
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
        action = () => saveTimestamp({ quick: true });
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
        overlay.showToast(result.error);
      } else if (overlay && result && result.message) {
        overlay.showToast(result.message);
      } else if (overlay && result && result.ok) {
        overlay.showToast("SceneMarks action complete.");
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
          overlay.showToast(error.message || "Could not complete queued jump.");
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
          ? `Jumped to ${formatSeconds(result.pendingJump.seconds)}.`
          : seekResult.error || "Queued jump could not seek yet."
      );
    }
  }

  async function initOverlay() {
    // An orphaned copy of this script (from before an extension reload) may
    // still have its overlay mounted; remove it before creating ours.
    document.querySelectorAll(".scenemarks-overlay").forEach((staleHost) => staleHost.remove());

    overlay = SceneMarks.Overlay.createOverlay({
      getState: guard(getContextResponse),
      quickSave: guard(() => saveTimestamp({ quick: true })),
      toggleRange: guard(() => toggleRange({ quick: true })),
      seekTo: guard((seconds) => seekTo({ seconds })),
      deleteScene: guard((payload) => deleteScene(payload)),
      openVideoAtScene: guard(openVideoAtScene)
    });
    overlay.setEnabled(getSettingsSync().enableFloatingButton);
  }

  async function init() {
    installMessageListener();
    if (SceneMarks.Migrations && SceneMarks.Migrations.migrateLegacyGenericVideos) {
      await SceneMarks.Migrations.migrateLegacyGenericVideos();
    }
    await loadSettings();
    detector.start();
    installUrlWatcher();
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
