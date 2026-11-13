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
  // The row whose Edit / Delete menu is open, kept across re-renders.
  let openMenuSceneId = null;
  // The list is scrolled to the mark nearest the playback time once, when
  // the popup opens; later refreshes keep the scroll where the user left it.
  let scrolledToNearest = false;

  const PLATFORM_NAMES = Object.freeze({
    netflix: "Netflix", prime: "Prime Video", hotstar: "Hotstar", youtube: "YouTube"
  });

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

  function createMoreButton(sceneId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scene-more";
    button.textContent = "\u22ef";
    button.title = "Edit or delete";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(openMenuSceneId === sceneId));
    button.addEventListener("click", () => toggleSceneMenu(sceneId));
    return button;
  }

  function toggleSceneMenu(sceneId) {
    openMenuSceneId = openMenuSceneId === sceneId ? null : sceneId;
    elements.sceneList.querySelectorAll("[data-scene-id]").forEach((row) => {
      const open = row.dataset.sceneId === openMenuSceneId;
      row.classList.toggle("is-menu-open", open);
      const more = row.querySelector(".scene-more");
      if (more) more.setAttribute("aria-expanded", String(open));
    });
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

  // One compact row: where SceneMarks runs, the site switch and the
  // pause-everywhere switch.
  function renderSiteControls() {
    const disabledSite = getDisabledSite();
    const paused = isPausedEverywhere();

    if (paused) {
      elements.siteStateLabel.textContent = "Paused on every site";
      elements.siteDomainLabel.textContent = "";
    } else if (activeHostname) {
      elements.siteStateLabel.textContent = disabledSite ? "Off on " : "On for ";
      elements.siteDomainLabel.textContent = disabledSite || mainDomainForHost(activeHostname) || activeHostname;
    } else {
      elements.siteStateLabel.textContent = "On for every site";
      elements.siteDomainLabel.textContent = "";
    }

    elements.siteToggleButton.hidden = !activeHostname || paused;
    if (activeHostname) {
      elements.siteToggleButton.textContent = disabledSite ? "Turn on here" : "Turn off here";
      elements.siteToggleButton.classList.toggle("is-off", Boolean(disabledSite));
      elements.siteToggleButton.title = disabledSite
        ? "Turn SceneMarks back on for this site"
        : "Stop SceneMarks hotkeys, overlay and saving on this site and its subdomains";
    }

    elements.pauseAllButton.textContent = paused ? "Resume" : "Pause all";
    elements.pauseAllButton.title = paused ? "Run SceneMarks on websites again" : "Pause SceneMarks on every site";
    elements.pauseAllButton.classList.toggle("is-off", paused);
    elements.pauseAllButton.setAttribute("aria-pressed", String(paused));
  }

  function inactiveMessage() {
    const where = isPausedEverywhere() ? "paused on every site" : `off on ${getDisabledSite()}`;
    return `SceneMarks is ${where}: its hotkeys and overlay leave this page alone. Jumps from the library still work.`;
  }

  // Pages SceneMarks cannot run on (browser pages, the store) are not an
  // error: the message stays neutral.
  function renderUnavailable(message) {
    elements.platformLabel.textContent = "No video on this page";
    elements.videoPanel.hidden = true;
    elements.videoRow.hidden = true;
    elements.sceneCountLabel.textContent = "0";
    clearNode(elements.sceneList);
    renderOverlayToggle();
    renderSiteControls();

    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Open a page with a video to save moments.";
    elements.sceneList.append(empty);
    setStatus(message, false);
  }

  function platformText(context) {
    if (!context.detected) {
      return "No video on this page yet";
    }
    const name = PLATFORM_NAMES[context.platform];
    return name ? `Video on ${name}` : "Video on this page";
  }

  function renderVideoRow(context, video) {
    const title = (video && video.title) || context.title || "";
    elements.videoRow.hidden = !context.detected && !video;
    elements.videoTitleLabel.textContent = title || "Untitled video";
    elements.videoTitleLabel.title = title;
    // A video can be starred once something is saved for it.
    elements.videoFavoriteButton.hidden = !video;
    if (video) {
      elements.videoFavoriteButton.textContent = video.favorite ? "\u2605" : "\u2606";
      elements.videoFavoriteButton.classList.toggle("is-favorite", Boolean(video.favorite));
      elements.videoFavoriteButton.title = video.favorite ? "Unfavorite this video" : "Favorite this video";
      elements.videoFavoriteButton.setAttribute("aria-label", elements.videoFavoriteButton.title);
      elements.videoFavoriteButton.setAttribute("aria-pressed", String(Boolean(video.favorite)));
    }
  }

  function renderContext(response) {
    const context = response.context;
    const scenes = response.scenes || [];

    elements.platformLabel.textContent = platformText(context);
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
      setStatus("Start playback, wait for the player to load, then press Retry.", false);
    } else {
      setStatus("", false);
    }

    renderVideoRow(context, response.video);
    renderRangeButton(response);
    renderScenes(context, scenes);
  }

  async function toggleVideoFavorite() {
    const video = latestContext && latestContext.video;
    if (!video) return;
    let response = null;
    try {
      response = await Storage.updateVideo(video.videoKey, { favorite: !video.favorite });
    } catch (error) {
      setStatus(storageErrorMessage(error), true);
      return;
    }

    if (!response || !response.ok) {
      setStatus((response && response.error) || "Could not update favorite.", true);
      return;
    }

    await refreshContext();
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
      : "Mark Start";
    elements.rangeButton.title = isCurrentDraft
      ? "Save the range that started at this time"
      : "Start a scene range at the current time";
    elements.cancelRangeButton.hidden = !isCurrentDraft;
  }

  async function cancelRange() {
    const videoKey = latestContext && latestContext.context ? latestContext.context.videoKey : null;
    if (!videoKey) return;
    let response = null;
    try {
      response = await Storage.cancelRange(videoKey);
    } catch (error) {
      setStatus(storageErrorMessage(error), true);
      return;
    }

    const cancelled = Boolean(response && response.ok);
    await refreshContext();
    setStatus(cancelled ? "Range cancelled." : "No range is open on this video.", !cancelled);
  }

  // The saved time closest to the playback position, or -1.
  function nearestSceneIndex(scenes, seconds) {
    if (!Number.isFinite(seconds)) return -1;
    let best = -1;
    scenes.forEach((scene, index) => {
      if (best === -1 || Math.abs(scene.startSeconds - seconds) < Math.abs(scenes[best].startSeconds - seconds)) {
        best = index;
      }
    });
    return best;
  }

  // One line per saved time: the time (and a note snippet only when there
  // is a note), the star, and a menu holding Edit and Delete. Clicking the
  // row jumps.
  function renderScenes(context, scenes) {
    clearNode(elements.sceneList);

    if (!scenes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = context.detected
        ? "Nothing saved for this video yet."
        : "Saved times appear here once a video is found.";
      elements.sceneList.append(empty);
      armedDelete = null;
      openMenuSceneId = null;
      return;
    }

    if (openMenuSceneId && !scenes.some((scene) => scene.id === openMenuSceneId)) {
      openMenuSceneId = null;
    }
    const nearest = context.detected ? nearestSceneIndex(scenes, context.currentTimeSeconds) : -1;
    let nearestRow = null;

    scenes.forEach((scene, index) => {
      const row = document.createElement("div");
      row.className = ["scene-row", index === nearest ? "is-nearest" : "", scene.id === openMenuSceneId ? "is-menu-open" : ""]
        .filter(Boolean).join(" ");
      row.dataset.sceneId = scene.id;

      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "scene-jump";
      jump.title = `Jump to ${formatSeconds(scene.startSeconds)}`;
      const time = document.createElement("span");
      time.className = "scene-time";
      time.textContent = formatRange(scene.startSeconds, scene.endSeconds);
      jump.append(time);
      if (scene.note) {
        const note = document.createElement("span");
        note.className = "scene-note";
        note.textContent = scene.note;
        jump.append(note);
      }
      jump.addEventListener("click", () => jumpToScene(scene));

      const menu = document.createElement("div");
      menu.className = "scene-menu";
      menu.append(
        createButton("Edit", () => editScene(context.videoKey, scene)),
        createDeleteButton(context.videoKey, scene)
      );

      row.append(
        jump,
        createFavoriteButton(scene.favorite, () => toggleSceneFavorite(context.videoKey, scene)),
        createMoreButton(scene.id),
        menu
      );
      // Clicks on the row's padding jump too.
      row.addEventListener("click", (event) => {
        if (event.target === row) jumpToScene(scene);
      });
      elements.sceneList.append(row);
      if (index === nearest) nearestRow = row;
    });

    syncArmedDelete();
    if (nearestRow && !scrolledToNearest) {
      scrolledToNearest = true;
      if (typeof nearestRow.scrollIntoView === "function") nearestRow.scrollIntoView({ block: "center" });
    }
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

  async function captureActionContext() {
    const response = await sendToActiveTab({ type: MESSAGE_TYPES.GET_CONTEXT });
    if (!response.ok || !response.context || !response.context.detected) {
      setStatus(response.error || "No active video detected.", true);
      return null;
    }
    latestContext = response;
    return {
      capture: { videoKey: response.context.videoKey, seconds: response.context.currentTimeSeconds }
    };
  }

  // Saves at once; a note or tags can be added later with Edit.
  async function saveMoment() {
    const captured = await captureActionContext();
    if (!captured) return;
    await saveTimestampValue({ capture: captured.capture }, false);
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
    setStatus(`Saved ${formatSeconds(value.capture.seconds)}.`, false);
  }

  async function handleRangeButton() {
    const captured = await captureActionContext();
    if (!captured) return;
    const draft = latestContext.activeRangeDraft;
    const isCurrentDraft = draft && draft.videoKey === latestContext.context.videoKey;

    if (!isCurrentDraft) {
      const response = await sendToActiveTab({ type: MESSAGE_TYPES.START_RANGE, payload: { capture: captured.capture } });
      if (response.conflict) {
        const overwrite = confirm("A range is already started on another video. Discard it and start here?");
        if (overwrite) {
          await sendToActiveTab({ type: MESSAGE_TYPES.START_RANGE, payload: { overwrite: true, capture: captured.capture } });
        }
      } else if (!response.ok) {
        setStatus(response.error || "Could not mark range start.", true);
      }
      await refreshContext();
      return;
    }

    const value = await openSceneDialog({
      title: "Save Scene Range",
      timeLabel: `${formatSeconds(draft.startSeconds)} -> ${formatSeconds(captured.capture.seconds)}`,
      confirmLabel: "Save Range"
    });

    if (!value) {
      return;
    }

    await saveRangeValue({ ...value, capture: captured.capture }, false);
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
        return;
      }
      await refreshContext();
      setStatus("Not saved: that range is already saved. The range is still open; mark a new end or cancel it.", false);
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

    // Turning off stores the displayed hostname and covers its subdomains; turning
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
      "siteStateLabel",
      "siteDomainLabel",
      "siteToggleButton",
      "pauseAllButton",
      "statusBox",
      "videoPanel",
      "toggleOverlayButton",
      "currentTimeLabel",
      "durationLabel",
      "saveMomentButton",
      "rangeButton",
      "cancelRangeButton",
      "sceneCountLabel",
      "sceneList",
      "openLibraryButton",
      "openOptionsButton",
      "videoRow",
      "videoFavoriteButton",
      "videoTitleLabel",
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
    elements.cancelRangeButton.addEventListener("click", cancelRange);
    elements.toggleOverlayButton.addEventListener("click", toggleOverlay);
    elements.openLibraryButton.addEventListener("click", () => openExtensionPage("src/library/library.html"));
    elements.openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
    elements.videoFavoriteButton.addEventListener("click", toggleVideoFavorite);
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
