(function initializePopup() {
  const { MESSAGE_TYPES } = SceneMarks.Constants;
  const { formatRange, formatSeconds } = SceneMarks.Time;
  const Storage = SceneMarks.Storage;
  const elements = {};
  let latestContext = null;
  let latestSettings = null;
  let pendingDialogResolve = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(message, isError) {
    elements.statusBox.textContent = message || "";
    elements.statusBox.classList.toggle("is-error", Boolean(isError));
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }

        resolve(response || { ok: false, error: "No response from SceneMarks." });
      });
    });
  }

  function sendToActiveTab(message) {
    return sendRuntimeMessage({
      type: MESSAGE_TYPES.FORWARD_TO_ACTIVE_TAB,
      payload: message
    });
  }

  function openExtensionPage(path) {
    chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.firstChild.remove();
    }
  }

  function createButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function createFavoriteButton(isFavorite, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = isFavorite ? "favorite-toggle is-favorite" : "favorite-toggle";
    button.textContent = isFavorite ? "\u2605" : "\u2606";
    button.title = isFavorite ? "Unfavorite timestamp" : "Favorite timestamp";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(Boolean(isFavorite)));
    button.addEventListener("click", onClick);
    return button;
  }

  function openSceneDialog(options) {
    elements.dialogTitle.textContent = options.title;
    elements.dialogTime.textContent = options.timeLabel;
    elements.confirmDialogButton.textContent = options.confirmLabel || "Save";
    elements.noteInput.value = options.note || "";
    elements.tagsInput.value = Array.isArray(options.tags) ? options.tags.join(", ") : "";
    elements.sceneDialog.showModal();
    elements.noteInput.focus();

    return new Promise((resolve) => {
      pendingDialogResolve = resolve;
    });
  }

  function closeSceneDialog(value) {
    if (!pendingDialogResolve) {
      return;
    }

    const resolve = pendingDialogResolve;
    pendingDialogResolve = null;
    elements.sceneDialog.close();
    resolve(value);
  }

  function getDialogValue() {
    return {
      note: elements.noteInput.value,
      tags: elements.tagsInput.value
    };
  }

  async function refreshContext() {
    setStatus("Checking for an active video...", false);
    const response = await sendRuntimeMessage({ type: MESSAGE_TYPES.GET_ACTIVE_TAB_CONTEXT });

    if (!response.ok) {
      latestContext = null;
      await loadLocalSettings();
      renderUnavailable(response.error || "SceneMarks is not available on this page.");
      return;
    }

    latestContext = response;
    latestSettings = response.settings;
    renderContext(response);
  }

  async function loadLocalSettings() {
    const state = await Storage.getState();
    latestSettings = state.settings;
    renderOverlayToggle();
  }

  function renderUnavailable(message) {
    elements.platformLabel.textContent = "No video context";
    elements.videoPanel.hidden = true;
    elements.sceneCountLabel.textContent = "0";
    clearNode(elements.sceneList);
    renderOverlayToggle();

    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Open a supported streaming page or click the popup on a page with an HTML5 video.";
    elements.sceneList.append(empty);
    setStatus(message, true);
  }

  function renderContext(response) {
    const context = response.context;
    const scenes = response.scenes || [];
    const title = context.title || context.rawUrl || "Current page";

    elements.platformLabel.textContent = context.detected
      ? `${context.platform} detected`
      : "No active video detected";
    elements.videoPanel.hidden = !context.detected;
    elements.currentTimeLabel.textContent = context.detected ? formatSeconds(context.currentTimeSeconds) : "--:--";
    elements.durationLabel.textContent = context.durationSeconds === null
      ? "--:--"
      : formatSeconds(context.durationSeconds);
    elements.sceneCountLabel.textContent = String(scenes.length);
    renderOverlayToggle();

    if (!context.detected) {
      setStatus("No active video detected. Start playback, wait for the player to load, then retry.", true);
    } else {
      setStatus(title, false);
    }

    renderRangeButton(response);
    renderScenes(context, scenes);
  }

  function renderOverlayToggle() {
    const enabled = latestSettings ? latestSettings.enableFloatingButton : false;
    elements.toggleOverlayButton.textContent = enabled ? "Overlay On" : "Overlay Off";
    elements.toggleOverlayButton.setAttribute("aria-pressed", String(enabled));
    elements.toggleOverlayButton.title = enabled
      ? "Disable the draggable SceneMarks page overlay"
      : "Enable the draggable SceneMarks page overlay";
  }

  function renderRangeButton(response) {
    const draft = response.activeRangeDraft;
    const context = response.context;
    const isCurrentDraft = draft && context && draft.videoKey === context.videoKey;

    elements.rangeButton.textContent = isCurrentDraft
      ? `Mark End (${formatSeconds(draft.startSeconds)})`
      : "Mark Scene Start";
  }

  function renderScenes(context, scenes) {
    clearNode(elements.sceneList);

    if (!scenes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = context.detected
        ? "No scenes saved for this video yet."
        : "Saved scenes appear here after a video is detected.";
      elements.sceneList.append(empty);
      return;
    }

    scenes.forEach((scene) => {
      const row = document.createElement("article");
      row.className = "scene-row";

      const top = document.createElement("div");
      top.className = "scene-row__top";

      const time = document.createElement("span");
      time.className = "scene-time";
      time.textContent = formatRange(scene.startSeconds, scene.endSeconds);

      const note = document.createElement("p");
      note.className = "scene-note";
      note.textContent = scene.note || "No note";

      top.append(time, note);
      row.append(top);

      if (scene.tags && scene.tags.length) {
        const tags = document.createElement("p");
        tags.className = "scene-tags";
        tags.textContent = scene.tags.map((tag) => `#${tag}`).join(" ");
        row.append(tags);
      }

      const actions = document.createElement("div");
      actions.className = "scene-actions";
      actions.append(
        createButton("Jump", () => jumpToScene(scene)),
        createFavoriteButton(scene.favorite, () => toggleSceneFavorite(context.videoKey, scene)),
        createButton("Edit", () => editScene(context.videoKey, scene)),
        createButton("Delete", () => deleteScene(context.videoKey, scene.id))
      );
      row.append(actions);
      elements.sceneList.append(row);
    });
  }

  async function toggleSceneFavorite(videoKey, scene) {
    const response = await Storage.updateScene(videoKey, scene.id, { favorite: !scene.favorite });

    if (!response.ok) {
      setStatus(response.error || "Could not update favorite.", true);
      return;
    }

    await refreshContext();
  }

  async function saveMoment() {
    if (!latestContext || !latestContext.context.detected) {
      setStatus("No active video detected.", true);
      return;
    }

    const value = await openSceneDialog({
      title: "Save Moment",
      timeLabel: `Time: ${formatSeconds(latestContext.context.currentTimeSeconds)}`,
      confirmLabel: "Save"
    });

    if (!value) {
      return;
    }

    await saveTimestampValue(value, false);
  }

  async function saveTimestampValue(value, allowDuplicate) {
    const response = await sendToActiveTab({
      type: MESSAGE_TYPES.SAVE_TIMESTAMP,
      payload: { ...value, allowDuplicate }
    });

    if (response.duplicate && !allowDuplicate) {
      const shouldSave = confirm("A nearby scene already exists. Save anyway?");
      if (shouldSave) {
        await saveTimestampValue(value, true);
      }
      return;
    }

    if (!response.ok) {
      setStatus(response.error || "Could not save scene.", true);
      return;
    }

    await refreshContext();
  }

  async function handleRangeButton() {
    if (!latestContext || !latestContext.context.detected) {
      setStatus("No active video detected.", true);
      return;
    }

    const draft = latestContext.activeRangeDraft;
    const isCurrentDraft = draft && draft.videoKey === latestContext.context.videoKey;

    if (!isCurrentDraft) {
      const response = await sendToActiveTab({ type: MESSAGE_TYPES.START_RANGE, payload: {} });
      if (response.conflict) {
        const overwrite = confirm("A range is already started on another video. Discard it and start here?");
        if (overwrite) {
          await sendToActiveTab({ type: MESSAGE_TYPES.START_RANGE, payload: { overwrite: true } });
        }
      } else if (!response.ok) {
        setStatus(response.error || "Could not mark range start.", true);
      }
      await refreshContext();
      return;
    }

    const value = await openSceneDialog({
      title: "Save Scene Range",
      timeLabel: `${formatSeconds(draft.startSeconds)} -> ${formatSeconds(latestContext.context.currentTimeSeconds)}`,
      confirmLabel: "Save Range"
    });

    if (!value) {
      return;
    }

    await saveRangeValue(value, false);
  }

  async function saveRangeValue(value, allowDuplicate) {
    const response = await sendToActiveTab({
      type: MESSAGE_TYPES.END_RANGE,
      payload: { ...value, allowDuplicate }
    });

    if (response.duplicate && !allowDuplicate) {
      const shouldSave = confirm("A nearby scene range already exists. Save anyway?");
      if (shouldSave) {
        await saveRangeValue(value, true);
      }
      return;
    }

    if (!response.ok) {
      setStatus(response.error || "Could not save range.", true);
      return;
    }

    await refreshContext();
  }

  async function jumpToScene(scene) {
    const response = await sendToActiveTab({
      type: MESSAGE_TYPES.SEEK_TO,
      payload: { seconds: scene.startSeconds }
    });

    setStatus(response.ok ? `Jumped to ${formatSeconds(scene.startSeconds)}.` : response.error, !response.ok);
  }

  async function editScene(videoKey, scene) {
    const value = await openSceneDialog({
      title: "Edit Scene",
      timeLabel: formatRange(scene.startSeconds, scene.endSeconds),
      confirmLabel: "Save",
      note: scene.note,
      tags: scene.tags
    });

    if (!value) {
      return;
    }

    const response = await sendToActiveTab({
      type: MESSAGE_TYPES.UPDATE_SCENE,
      payload: {
        videoKey,
        sceneId: scene.id,
        updates: value
      }
    });

    if (!response.ok) {
      setStatus(response.error || "Could not update scene.", true);
      return;
    }

    await refreshContext();
  }

  async function deleteScene(videoKey, sceneId) {
    if (!confirm("Delete this saved scene?")) {
      return;
    }

    const response = await sendToActiveTab({
      type: MESSAGE_TYPES.DELETE_SCENE,
      payload: { videoKey, sceneId }
    });

    if (!response.ok) {
      setStatus(response.error || "Could not delete scene.", true);
      return;
    }

    await refreshContext();
  }

  async function toggleOverlay() {
    const currentEnabled = latestSettings ? latestSettings.enableFloatingButton : false;
    latestSettings = await Storage.updateSettings({ enableFloatingButton: !currentEnabled });
    renderOverlayToggle();
    setStatus(latestSettings.enableFloatingButton ? "Overlay panel enabled." : "Overlay panel disabled.", false);
  }

  function bindElements() {
    [
      "platformLabel",
      "refreshButton",
      "statusBox",
      "videoPanel",
      "toggleOverlayButton",
      "currentTimeLabel",
      "durationLabel",
      "saveMomentButton",
      "rangeButton",
      "sceneCountLabel",
      "sceneList",
      "openLibraryButton",
      "openOptionsButton",
      "hotkeysButton",
      "sceneDialog",
      "sceneForm",
      "dialogTitle",
      "dialogTime",
      "noteInput",
      "tagsInput",
      "cancelDialogButton",
      "confirmDialogButton"
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function bindEvents() {
    elements.refreshButton.addEventListener("click", refreshContext);
    elements.saveMomentButton.addEventListener("click", saveMoment);
    elements.rangeButton.addEventListener("click", handleRangeButton);
    elements.toggleOverlayButton.addEventListener("click", toggleOverlay);
    elements.openLibraryButton.addEventListener("click", () => openExtensionPage("src/library/library.html"));
    elements.openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
    elements.hotkeysButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
    elements.cancelDialogButton.addEventListener("click", () => closeSceneDialog(null));
    elements.sceneForm.addEventListener("submit", (event) => {
      event.preventDefault();
      closeSceneDialog(getDialogValue());
    });
    elements.sceneDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeSceneDialog(null);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    refreshContext();
  });
})();
