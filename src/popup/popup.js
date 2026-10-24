(function initializePopup() {
  const { ARMED_DELETE_TIMEOUT_MS, MESSAGE_TYPES } = SceneMarks.Constants;
  const { formatRange, formatSeconds } = SceneMarks.Time;
  const { findDisabledSite, isEnabledForHost, mainDomainForHost } = SceneMarks.Schema;
  const Storage = SceneMarks.Storage.createClient();
  const elements = {};
  let latestContext = null;
  let latestSettings = null;
  // The active tab's hostname, or null on pages without a site to switch
  // off (file://, browser pages).
  let activeHostname = null;
  let pendingDialogResolve = null;
  // Two-step delete state: which scene's delete button is armed, plus its
  // auto-disarm timer.
  let armedDelete = null;
  let armedDeleteTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(message, isError) {
    elements.statusBox.textContent = message || "";
    elements.statusBox.classList.toggle("is-error", Boolean(isError));
  }

  function storageErrorMessage(error) {
    if (/Extension context invalidated/i.test(String((error && error.message) || error))) {
      return "SceneMarks was reloaded. Reopen the popup.";
    }

    return error.message;
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

  function createDeleteButton(videoKey, scene) {
    const button = createButton("Delete", () => handleDeletePress(videoKey, scene, button));
    button.className = "scene-delete";
    button.title = "Delete this saved scene";
    button.setAttribute("aria-label", button.title);
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
    latestSettings = await Storage.getSettings();
    renderOverlayToggle();
    renderSiteControls();
  }

  async function loadActiveHostname() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab && tab.url ? tab.url : "");
      activeHostname = /^https?:$/.test(url.protocol) && url.hostname ? url.hostname : null;
    } catch (_error) {
      activeHostname = null;
    }
  }

  function isPausedEverywhere() {
    return Boolean(latestSettings) && latestSettings.extensionEnabled === false;
  }

  function getDisabledSite() {
    return latestSettings && activeHostname ? findDisabledSite(latestSettings.disabledSites, activeHostname) : null;
  }

  function isActiveHere() {
    return !latestSettings || isEnabledForHost(latestSettings, activeHostname || "");
  }

  function renderSiteControls() {
    const disabledSite = getDisabledSite();
    const paused = isPausedEverywhere();

    elements.siteRow.hidden = !activeHostname;
    if (activeHostname) {
      elements.siteStateLabel.textContent = disabledSite ? "Off on" : "On for";
      elements.siteDomainLabel.textContent = disabledSite || mainDomainForHost(activeHostname) || activeHostname;
      elements.siteToggleButton.textContent = disabledSite ? "Turn on here" : "Turn off here";
      elements.siteToggleButton.classList.toggle("is-off", Boolean(disabledSite));
      elements.siteToggleButton.title = disabledSite
        ? "Turn SceneMarks back on for this site"
        : "Stop SceneMarks hotkeys, overlay and saving on this site and its subdomains";
    }

    elements.pauseStateLabel.textContent = paused ? "All sites: paused" : "All sites: on";
    elements.pauseAllButton.textContent = paused ? "Resume" : "Pause everywhere";
    elements.pauseAllButton.classList.toggle("is-off", paused);
    elements.pauseAllButton.setAttribute("aria-pressed", String(paused));
  }

  function inactiveMessage() {
    const where = isPausedEverywhere() ? "paused on every site" : `off on ${getDisabledSite()}`;
    return `SceneMarks is ${where}: its hotkeys and overlay leave this page alone. Jumps from the library still work.`;
  }

  function renderUnavailable(message) {
    elements.platformLabel.textContent = "No video context";
    elements.videoPanel.hidden = true;
    elements.sceneCountLabel.textContent = "0";
    clearNode(elements.sceneList);
    renderOverlayToggle();
    renderSiteControls();

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
    // Saving is refused on an inactive site, so its buttons are hidden;
    // the saved scenes stay listed and jumpable, like the library.
    elements.videoPanel.hidden = !context.detected || !isActiveHere();
    elements.currentTimeLabel.textContent = context.detected ? formatSeconds(context.currentTimeSeconds) : "--:--";
    elements.durationLabel.textContent = context.durationSeconds === null
      ? "--:--"
      : formatSeconds(context.durationSeconds);
    elements.sceneCountLabel.textContent = String(scenes.length);
    renderOverlayToggle();
    renderSiteControls();

    if (!isActiveHere()) {
      setStatus(inactiveMessage(), false);
    } else if (!context.detected) {
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
      armedDelete = null;
      return;
    }

    scenes.forEach((scene) => {
      const row = document.createElement("article");
      row.className = "scene-row";
      row.dataset.sceneId = scene.id;

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
        createDeleteButton(context.videoKey, scene)
      );
      row.append(actions);
      elements.sceneList.append(row);
    });

    syncArmedDelete();
  }

  async function toggleSceneFavorite(videoKey, scene) {
    let response = null;
    try {
      response = await Storage.updateScene(videoKey, scene.id, { favorite: !scene.favorite });
    } catch (error) {
      setStatus(storageErrorMessage(error), true);
      return;
    }

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

  // Two-step delete, matching the overlay: the first press arms the button
  // (red "Confirm?") and only a second press on that same button deletes.
  // Pressing anything else, Escape, or the timeout disarms.
  function styleArmedDeleteButton(button, armed) {
    button.classList.toggle("is-armed", armed);
    button.textContent = armed ? "Confirm?" : "Delete";
    button.title = armed ? "Click again to delete this scene" : "Delete this saved scene";
    button.setAttribute("aria-label", button.title);
  }

  function findDeleteButton(sceneId) {
    return elements.sceneList.querySelector(`[data-scene-id="${CSS.escape(sceneId)}"] .scene-delete`);
  }

  function armDelete(videoKey, sceneId, button) {
    if (armedDelete && armedDelete.sceneId !== sceneId) {
      const previousButton = findDeleteButton(armedDelete.sceneId);
      if (previousButton) {
        styleArmedDeleteButton(previousButton, false);
      }
    }

    armedDelete = { sceneId, videoKey };
    styleArmedDeleteButton(button, true);
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = setTimeout(disarmDelete, ARMED_DELETE_TIMEOUT_MS);
  }

  function disarmDelete() {
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = null;
    if (!armedDelete) {
      return;
    }

    const button = findDeleteButton(armedDelete.sceneId);
    if (button) {
      styleArmedDeleteButton(button, false);
    }
    armedDelete = null;
  }

  // Refreshes rebuild the scene rows, so the armed styling is re-applied by
  // scene id after each render; a row that no longer exists disarms.
  function syncArmedDelete() {
    if (!armedDelete) {
      return;
    }

    const button = findDeleteButton(armedDelete.sceneId);
    if (!button) {
      armedDelete = null;
      return;
    }

    styleArmedDeleteButton(button, true);
  }

  function handleDeletePress(videoKey, scene, button) {
    if (armedDelete && armedDelete.sceneId === scene.id && armedDelete.videoKey === videoKey) {
      disarmDelete();
      deleteScene(videoKey, scene.id);
      return;
    }

    armDelete(videoKey, scene.id, button);
  }

  async function deleteScene(videoKey, sceneId) {
    const response = await sendToActiveTab({
      type: MESSAGE_TYPES.DELETE_SCENE,
      payload: { videoKey, sceneId }
    });

    if (!response.ok) {
      setStatus(response.error || "Could not delete scene.", true);
      return;
    }

    await refreshContext();
    setStatus("Scene deleted.", false);
  }

  async function toggleOverlay() {
    let result = null;
    try {
      result = await Storage.toggleFloatingButton();
    } catch (error) {
      setStatus(storageErrorMessage(error), true);
      return;
    }

    latestSettings = result.settings;
    renderOverlayToggle();
    setStatus(latestSettings.enableFloatingButton ? "Overlay panel enabled." : "Overlay panel disabled.", false);
  }

  async function toggleSite() {
    if (!activeHostname) {
      return;
    }

    // Turning off stores the main domain so subdomains are covered; turning
    // on passes the full hostname so every entry covering it is removed.
    const turningOn = Boolean(getDisabledSite());
    let result = null;
    try {
      result = turningOn
        ? await Storage.setSiteEnabled(activeHostname, true)
        : await Storage.setSiteEnabled(mainDomainForHost(activeHostname), false);
    } catch (error) {
      setStatus(storageErrorMessage(error), true);
      return;
    }

    if (!result.ok) {
      setStatus(result.error || "Could not switch this site.", true);
      return;
    }

    latestSettings = result.settings;
    await refreshContext();
  }

  async function togglePauseEverywhere() {
    try {
      latestSettings = await Storage.updateSettings({ extensionEnabled: isPausedEverywhere() });
    } catch (error) {
      setStatus(storageErrorMessage(error), true);
      return;
    }

    await refreshContext();
  }

  function bindElements() {
    [
      "platformLabel",
      "refreshButton",
      "siteRow",
      "siteStateLabel",
      "siteDomainLabel",
      "siteToggleButton",
      "pauseStateLabel",
      "pauseAllButton",
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
    elements.siteToggleButton.addEventListener("click", toggleSite);
    elements.pauseAllButton.addEventListener("click", togglePauseEverywhere);
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
    // Any press outside the armed delete button disarms it, so a stray
    // second click elsewhere never deletes unexpectedly.
    document.addEventListener("pointerdown", (event) => {
      if (!armedDelete) {
        return;
      }

      const target = event.target;
      const row = target instanceof Element ? target.closest("[data-scene-id]") : null;
      if (row && row.dataset.sceneId === armedDelete.sceneId && target.closest(".scene-delete")) {
        return;
      }

      disarmDelete();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        disarmDelete();
      }
    }, true);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindElements();
    bindEvents();
    await loadActiveHostname();
    refreshContext();
  });
})();
