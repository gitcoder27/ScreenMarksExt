(function attachOverlay(root) {
  const SceneMarks = root.SceneMarks || {};
  const { ARMED_DELETE_TIMEOUT_MS } = SceneMarks.Constants;
  const { formatRange, formatSeconds } = SceneMarks.Time;

  const TOAST_ICONS = Object.freeze({ success: "\u2713", error: "!", info: "\u2022" });
  const TOAST_AUTO_HIDE_MS = 3200;
  // A beat longer than the 180ms toast fade so the exit transition finishes
  // before the toast leaves the top layer.
  const TOAST_FADE_MS = 200;
  // After the user scrolls or presses on the current-scene list, auto-scroll
  // to the highlighted row stays off this long so browsing is not interrupted.
  const AUTO_SCROLL_SUPPRESSION_MS = 8000;
  // Every keystroke rebuilds the whole library DOM, so renders are bounded to
  // one per pause in typing.
  const LIBRARY_SEARCH_DEBOUNCE_MS = 150;

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
  }

  function createButton(className, label, onClick) {
    const button = createElement("button", className, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function createFavoriteButton(isFavorite, label, onClick) {
    const button = createButton(
      isFavorite ? "scenemarks-overlay__favorite is-favorite" : "scenemarks-overlay__favorite",
      isFavorite ? "\u2605" : "\u2606",
      onClick
    );
    button.title = isFavorite ? `Unfavorite ${label}` : `Favorite ${label}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(Boolean(isFavorite)));
    return button;
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.firstChild.remove();
    }
  }

  function getVideoUrl(video) {
    return video && (video.canonicalUrl || (video.rawUrls && video.rawUrls[0])) || "";
  }

  function createOverlay(actions) {
    const host = createElement("section", "scenemarks-overlay");
    const header = createElement("div", "scenemarks-overlay__header");
    const titleWrap = createElement("div", "scenemarks-overlay__title-wrap");
    const title = createElement("h2", "scenemarks-overlay__title", "SceneMarks");
    const subtitle = createElement("p", "scenemarks-overlay__subtitle", "Checking video...");
    const count = createElement("span", "scenemarks-overlay__count", "0");
    const body = createElement("div", "scenemarks-overlay__body");
    const tabs = createElement("div", "scenemarks-overlay__tabs");
    const currentTab = createButton("scenemarks-overlay__tab is-active", "Current", () => setViewMode("current"));
    const libraryTab = createButton("scenemarks-overlay__tab", "Library", () => setViewMode("library"));
    const currentPanel = createElement("div", "scenemarks-overlay__panel");
    const libraryPanel = createElement("div", "scenemarks-overlay__panel");
    const status = createElement("p", "scenemarks-overlay__status");
    const actionsRow = createElement("div", "scenemarks-overlay__actions");
    const saveButton = createButton("scenemarks-overlay__primary", "Save", handleQuickSave);
    const rangeButton = createButton("scenemarks-overlay__secondary", "Range", handleToggleRange);
    const refreshButton = createButton("scenemarks-overlay__icon", "R", handleRefresh);
    const collapseButton = createButton("scenemarks-overlay__icon", "-", toggleCollapse);
    const currentSceneList = createElement("div", "scenemarks-overlay__list");
    const librarySearch = createElement("input", "scenemarks-overlay__search");
    const libraryControls = createElement("div", "scenemarks-overlay__library-controls");
    const randomVideoButton = createButton("scenemarks-overlay__mini-action", "Random", handleRandomVideo);
    const favoritesButton = createButton("scenemarks-overlay__mini-action", "Favorites", toggleFavoritesOnly);
    const expandAllButton = createButton("scenemarks-overlay__mini-action", "Expand All", expandAllLibraryVideos);
    const collapseAllButton = createButton("scenemarks-overlay__mini-action", "Collapse All", collapseAllLibraryVideos);
    const libraryList = createElement("div", "scenemarks-overlay__library");
    // Lives outside the panel host so hotkey feedback stays visible even when
    // the overlay itself is hidden.
    const toast = createElement("div", "scenemarks-toast");
    const toastIcon = createElement("span", "scenemarks-toast__icon");
    const toastMessage = createElement("span", "scenemarks-toast__message");
    let pointerStart = null;
    let panelStart = null;
    let didDrag = false;
    // Header-drag layout batch: host dimensions captured once per drag and
    // the latest move target, applied by a single pending animation frame.
    let dragDims = null;
    let dragTarget = null;
    let dragFrame = null;
    let isCollapsed = false;
    let toastTimer = null;
    let toastLayerTimer = null;
    let librarySearchTimer = null;
    // The Popover API lifts toasts above fullscreen players; without it the
    // plain fixed-position toast still works outside fullscreen.
    const supportsToastPopover = typeof toast.showPopover === "function";
    // Two-step delete state: which scene's delete button is armed, plus its
    // auto-disarm timer.
    let armedDelete = null;
    let armedDeleteTimer = null;
    let latestState = null;
    let viewMode = "current";
    let lastRandomPickKey = null;
    let favoritesOnly = false;
    const expandedVideoKeys = new Set();
    // Playback-follow state for the Current tab. Updated by the lightweight
    // detector tick (updatePlaybackTime); never touches storage or rebuilds.
    let latestPlaybackSeconds = null;
    let activeHighlightRow = null;
    let suppressAutoScrollUntil = 0;
    let autoScrollPaused = false;

    host.setAttribute("aria-label", "SceneMarks saved scene overlay");
    header.title = "Drag SceneMarks panel";
    refreshButton.setAttribute("aria-label", "Refresh SceneMarks overlay");
    collapseButton.setAttribute("aria-label", "Collapse SceneMarks overlay");
    librarySearch.type = "search";
    librarySearch.placeholder = "Search saved scenes";
    titleWrap.append(title, subtitle);
    header.append(titleWrap, count, refreshButton, collapseButton);
    tabs.append(currentTab, libraryTab);
    actionsRow.append(saveButton, rangeButton);
    currentPanel.append(status, actionsRow, currentSceneList);
    libraryControls.append(randomVideoButton, favoritesButton, expandAllButton, collapseAllButton);
    libraryPanel.append(librarySearch, libraryControls, libraryList);
    body.append(tabs, currentPanel, libraryPanel);
    host.append(header, body);

    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    // popover=manual lets showToast() move the toast into the top layer, the
    // only surface rendered above a fullscreen player. Visibility stays
    // driven by the is-visible class, and the all:initial CSS reset already
    // overrides the popover user-agent styles.
    toast.setAttribute("popover", "manual");
    toast.title = "Dismiss";
    toast.append(toastIcon, toastMessage);
    document.documentElement.append(toast);
    toast.addEventListener("click", hideToast);

    librarySearch.addEventListener("input", () => {
      root.clearTimeout(librarySearchTimer);
      librarySearchTimer = root.setTimeout(() => {
        librarySearchTimer = null;
        renderLibrary(latestState);
      }, LIBRARY_SEARCH_DEBOUNCE_MS);
    });

    function armAutoScrollSuppression() {
      suppressAutoScrollUntil = Date.now() + AUTO_SCROLL_SUPPRESSION_MS;
    }

    currentSceneList.addEventListener("pointerdown", armAutoScrollSuppression, { passive: true });
    currentSceneList.addEventListener("wheel", armAutoScrollSuppression, { passive: true });

    async function handleQuickSave() {
      const result = await actions.quickSave();
      if (result.ok && result.scene) {
        showToast(`Saved ${formatSeconds(result.scene.startSeconds)}`, "success");
      } else {
        showToast(result.error || "Could not save", "error");
      }
      await refresh();
    }

    async function handleToggleRange() {
      const result = await actions.toggleRange();
      showToast(
        result.ok ? result.message || "Range updated" : result.error || "Could not update range",
        result.ok ? "success" : "error"
      );
      await refresh();
    }

    async function handleRefresh() {
      await refresh();
      showToast("Overlay refreshed", "info");
    }

    function setViewMode(nextMode) {
      viewMode = nextMode === "library" ? "library" : "current";
      currentTab.classList.toggle("is-active", viewMode === "current");
      libraryTab.classList.toggle("is-active", viewMode === "library");
      currentPanel.hidden = viewMode !== "current";
      libraryPanel.hidden = viewMode !== "library";
      renderHeader(latestState);
      if (viewMode === "current") {
        applyCurrentHighlight();
      }
    }

    function toggleCollapse() {
      isCollapsed = !isCollapsed;
      host.classList.toggle("is-collapsed", isCollapsed);
      collapseButton.textContent = isCollapsed ? "+" : "-";
      collapseButton.setAttribute(
        "aria-label",
        isCollapsed ? "Expand SceneMarks overlay" : "Collapse SceneMarks overlay"
      );
      if (!isCollapsed) {
        applyCurrentHighlight();
      }
    }

    // Fullscreen players render only the fullscreen element, which paints
    // above top-layer entries inserted before it. Re-showing the popover on
    // every toast re-inserts it at the end of that order, so it stays visible
    // even over a player that entered fullscreen after the previous toast.
    function raiseToastLayer() {
      if (!supportsToastPopover) {
        return;
      }

      try {
        if (toast.matches(":popover-open")) {
          toast.hidePopover();
        }
        toast.showPopover();
      } catch (_error) {
        // The toast still shows on normal pages without the top layer.
      }
    }

    function lowerToastLayer() {
      if (!supportsToastPopover) {
        return;
      }

      try {
        if (toast.matches(":popover-open")) {
          toast.hidePopover();
        }
      } catch (_error) {
        // Leaving the toast in the top layer is harmless.
      }
    }

    function hideToast() {
      root.clearTimeout(toastTimer);
      root.clearTimeout(toastLayerTimer);
      toast.classList.remove("is-visible");
      toastLayerTimer = root.setTimeout(lowerToastLayer, TOAST_FADE_MS);
    }

    function showToast(message, type) {
      const kind = type === "success" || type === "error" ? type : "info";
      root.clearTimeout(toastTimer);
      root.clearTimeout(toastLayerTimer);
      raiseToastLayer();
      toast.className = `scenemarks-toast is-${kind}`;
      toastIcon.textContent = TOAST_ICONS[kind];
      toastMessage.textContent = message || "";
      // Reading offsetWidth restarts the entrance transition when a new
      // toast replaces one that is still visible.
      void toast.offsetWidth;
      toast.classList.add("is-visible");
      toastTimer = root.setTimeout(hideToast, TOAST_AUTO_HIDE_MS);
    }

    function setEnabled(enabled) {
      host.hidden = !enabled;
      if (enabled && !host.isConnected) {
        document.documentElement.append(host);
      }
      if (enabled) {
        refresh();
      }
    }

    function destroy() {
      root.clearTimeout(toastTimer);
      root.clearTimeout(toastLayerTimer);
      root.clearTimeout(armedDeleteTimer);
      root.clearTimeout(librarySearchTimer);
      librarySearchTimer = null;
      if (dragFrame !== null) {
        root.cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }
      dragTarget = null;
      dragDims = null;
      armedDelete = null;
      lowerToastLayer();
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
      host.remove();
      toast.remove();
    }

    async function refresh() {
      if (host.hidden) {
        return;
      }

      const state = await actions.getState();
      render(state);
    }

    function render(state) {
      latestState = state;
      const context = state && state.context;
      if (context && context.detected && Number.isFinite(context.currentTimeSeconds)) {
        latestPlaybackSeconds = context.currentTimeSeconds;
      }

      renderHeader(state);
      renderStatus(state);
      renderCurrentScenes(state);
      renderLibrary(state);
      setViewMode(viewMode);
    }

    function renderHeader(state) {
      const context = state && state.context;
      const videos = state && state.videos ? Object.values(state.videos) : [];
      const totalScenes = videos.reduce((total, video) => total + video.scenes.length, 0);
      const currentCount = state && Array.isArray(state.scenes) ? state.scenes.length : 0;
      const platform = context && context.detected ? context.platform : "No video";

      subtitle.textContent = viewMode === "library"
        ? "Saved library"
        : context && context.detected ? `${platform} video` : "No active video";
      count.textContent = String(viewMode === "library" ? totalScenes : currentCount);
    }

    function renderStatus(state) {
      const context = state && state.context;
      const draft = state && state.activeRangeDraft;
      const hasDraft = draft && context && draft.videoKey === context.videoKey;

      if (!context || !context.detected) {
        status.textContent = "No active video detected.";
        saveButton.disabled = true;
        rangeButton.disabled = true;
        rangeButton.textContent = "Range";
        return;
      }

      saveButton.disabled = false;
      rangeButton.disabled = false;
      rangeButton.textContent = hasDraft ? "End Range" : "Start Range";
      status.textContent = hasDraft
        ? `Range started at ${formatSeconds(draft.startSeconds)}`
        : `Current time ${formatSeconds(context.currentTimeSeconds)}`;
    }

    function renderCurrentScenes(state) {
      const scenes = state && Array.isArray(state.scenes) ? state.scenes : [];
      clearNode(currentSceneList);

      if (!scenes.length) {
        currentSceneList.append(createElement("p", "scenemarks-overlay__empty", "No saved timestamps for this video."));
        armedDelete = null;
        applyCurrentHighlight();
        return;
      }

      scenes.forEach((scene) => {
        currentSceneList.append(renderSceneRow({ scene, video: state.video, isCurrentVideo: true }));
      });

      syncArmedDeleteRow();
      applyCurrentHighlight();
    }

    // Picks the scene the Current tab should spotlight for a playback position:
    // a saved range that contains it wins, otherwise the most recent timestamp
    // at or before it. Scenes arrive sorted by startSeconds, so the first
    // scene past the position ends the search.
    function findActiveScene(scenes, seconds) {
      let active = null;

      for (const scene of scenes) {
        if (scene.startSeconds > seconds) {
          break;
        }

        if (scene.endSeconds !== null && seconds <= scene.endSeconds) {
          return scene;
        }

        active = scene;
      }

      return active;
    }

    // Lightweight per-tick update driven by the video detector. Only toggles
    // the highlight class and occasionally scrolls; never reads storage and
    // never rebuilds the list.
    function updatePlaybackTime(seconds) {
      const time = Number(seconds);
      if (!Number.isFinite(time)) {
        return;
      }

      latestPlaybackSeconds = time;

      if (host.hidden || isCollapsed || viewMode !== "current") {
        // Arm a one-time re-sync so the list follows playback again on the
        // first tick after the Current view becomes visible.
        autoScrollPaused = true;
        return;
      }

      applyCurrentHighlight({ allowAutoScroll: true });
    }

    // Re-applies the highlight class to the freshly rendered rows. Auto-scroll
    // is left to the tick path so refreshes never yank the list.
    function applyCurrentHighlight(options) {
      const allowAutoScroll = Boolean(options && options.allowAutoScroll);
      if (host.hidden || isCollapsed || viewMode !== "current") {
        return;
      }

      const scenes = latestState && Array.isArray(latestState.scenes) ? latestState.scenes : [];
      const active = latestPlaybackSeconds !== null && scenes.length
        ? findActiveScene(scenes, latestPlaybackSeconds)
        : null;
      const nextRow = active
        ? currentSceneList.querySelector(`[data-scene-id="${CSS.escape(active.id)}"]`)
        : null;
      const rowChanged = nextRow !== activeHighlightRow;

      if (rowChanged) {
        if (activeHighlightRow) {
          activeHighlightRow.classList.remove("is-active");
        }

        activeHighlightRow = nextRow;

        if (nextRow) {
          nextRow.classList.add("is-active");
        }
      }

      if (!allowAutoScroll || !nextRow) {
        return;
      }

      if (Date.now() < suppressAutoScrollUntil) {
        autoScrollPaused = true;
        return;
      }

      // While the highlighted scene is unchanged the row is already settled,
      // so scrolling is skipped; the one exception is right after a
      // suppression window lifts, which re-syncs the list with playback once.
      if (!rowChanged && !autoScrollPaused) {
        return;
      }

      autoScrollPaused = false;
      nextRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function renderLibrary(state) {
      favoritesButton.classList.toggle("is-active", favoritesOnly);
      favoritesButton.setAttribute("aria-pressed", String(favoritesOnly));

      clearNode(libraryList);

      const videos = getFilteredVideos(state);
      if (!videos.length) {
        libraryList.append(createElement(
          "p",
          "scenemarks-overlay__empty",
          favoritesOnly ? "No favorites match." : "No saved scenes match."
        ));
        return;
      }

      videos.forEach((video) => {
        libraryList.append(renderVideoGroup(video, state));
      });
    }

    function toggleFavoritesOnly() {
      favoritesOnly = !favoritesOnly;
      renderLibrary(latestState);
    }

    function expandAllLibraryVideos() {
      getFilteredVideos(latestState).forEach((video) => expandedVideoKeys.add(video.videoKey));
      renderLibrary(latestState);
    }

    function collapseAllLibraryVideos() {
      getFilteredVideos(latestState).forEach((video) => expandedVideoKeys.delete(video.videoKey));
      renderLibrary(latestState);
    }

    async function handleRandomVideo() {
      const videos = getFilteredVideos(latestState);
      if (!videos.length) {
        showToast("No saved scenes match", "info");
        return;
      }

      // The background picker drops videos already open in this window's
      // tabs and avoids repeating the previous pick.
      const result = await actions.pickRandomVideo({
        videoKeys: videos.map((video) => video.videoKey),
        excludeVideoKey: lastRandomPickKey
      });

      if (!result || !result.ok) {
        lastRandomPickKey = null;
        showToast((result && result.error) || "Could not pick a random video", "error");
        return;
      }

      lastRandomPickKey = result.video.videoKey;
      expandedVideoKeys.add(result.video.videoKey);
      renderLibrary(latestState);

      requestAnimationFrame(() => {
        const group = libraryList.querySelector(`[data-video-key="${CSS.escape(result.video.videoKey)}"]`);
        if (!group) {
          return;
        }

        group.scrollIntoView({ behavior: "smooth", block: "center" });
        group.classList.add("is-random-pick");
        group.addEventListener("animationend", () => group.classList.remove("is-random-pick"), { once: true });
      });

      showToast(`Random pick: ${result.video.title || result.video.canonicalUrl || "saved video"}`, "success");
    }

    function getFilteredVideos(state) {
      const query = librarySearch.value.trim().toLowerCase();
      const videos = state && state.videos ? Object.values(state.videos) : [];

      return videos
        .filter((video) => !favoritesOnly || video.favorite || video.scenes.some((scene) => scene.favorite))
        .map((video) => ({
          ...video,
          scenes: video.scenes.filter((scene) =>
            matchesQuery(video, scene, query) && (!favoritesOnly || video.favorite || scene.favorite)
          )
        }))
        .filter((video) => video.scenes.length > 0)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    function matchesQuery(video, scene, query) {
      if (!query) {
        return true;
      }

      const text = [
        video.title,
        video.platform,
        video.canonicalUrl,
        scene.note,
        ...(scene.tags || []),
        formatRange(scene.startSeconds, scene.endSeconds)
      ].join(" ").toLowerCase();

      return text.includes(query);
    }

    function renderVideoGroup(video, state) {
      const group = createElement("article", "scenemarks-overlay__video");
      group.dataset.videoKey = video.videoKey;
      const isExpanded = expandedVideoKeys.has(video.videoKey);
      group.classList.toggle("is-collapsed", !isExpanded);

      const headerRow = createElement("div", "scenemarks-overlay__video-row");
      const headerButton = createButton("scenemarks-overlay__video-header", "", () => toggleVideoGroup(video.videoKey));
      headerButton.setAttribute("aria-expanded", String(isExpanded));
      const titleText = video.title || video.canonicalUrl || video.videoKey;
      const caret = createElement("span", "scenemarks-overlay__video-caret", isExpanded ? "-" : "+");
      const titleNode = createElement("span", "scenemarks-overlay__video-title", titleText);
      const meta = createElement("span", "scenemarks-overlay__video-meta", `${video.platform} - ${video.scenes.length} scenes`);
      const favoriteButton = createFavoriteButton(video.favorite, "video", () => toggleVideoFavorite(video));
      const sceneContainer = createElement("div", "scenemarks-overlay__video-scenes");

      headerButton.append(caret, titleNode, meta);
      headerRow.append(headerButton, favoriteButton);
      group.append(headerRow);

      sceneContainer.hidden = !isExpanded;
      video.scenes.slice(0, 10).forEach((scene) => {
        sceneContainer.append(renderSceneRow({
          scene,
          video,
          isCurrentVideo: state && state.context && state.context.videoKey === video.videoKey
        }));
      });

      if (isExpanded && video.scenes.length > 10) {
        sceneContainer.append(createElement("p", "scenemarks-overlay__more", `${video.scenes.length - 10} more saved scenes`));
      }

      group.append(sceneContainer);
      return group;
    }

    function toggleVideoGroup(videoKey) {
      if (expandedVideoKeys.has(videoKey)) {
        expandedVideoKeys.delete(videoKey);
      } else {
        expandedVideoKeys.add(videoKey);
      }

      renderLibrary(latestState);
    }

    function renderSceneRow({ scene, video, isCurrentVideo }) {
      const row = createElement("div", "scenemarks-overlay__scene");
      row.dataset.sceneId = scene.id;
      row.dataset.videoKey = video.videoKey;
      const main = createElement("div", "scenemarks-overlay__scene-main");
      const time = createElement("span", "scenemarks-overlay__scene-time", formatRange(scene.startSeconds, scene.endSeconds));
      const note = createElement("span", "scenemarks-overlay__scene-note", scene.note || "Saved timestamp");
      const rowActions = createElement("div", "scenemarks-overlay__scene-actions");
      const jump = createButton("scenemarks-overlay__jump", "Jump", () => jumpToScene(video, scene, isCurrentVideo));
      const favorite = createFavoriteButton(scene.favorite, "timestamp", () => toggleSceneFavorite(video, scene));
      const remove = createButton("scenemarks-overlay__delete", "\u00d7", () => handleDeletePress(video, scene, remove));

      remove.dataset.label = `Delete scene at ${formatRange(scene.startSeconds, scene.endSeconds)}`;
      remove.title = "Delete scene";
      remove.setAttribute("aria-label", remove.dataset.label);
      rowActions.append(jump, favorite, remove);
      main.append(time, note);
      row.append(main, rowActions);
      return row;
    }

    async function toggleSceneFavorite(video, scene) {
      const result = await actions.updateSceneFavorite({
        videoKey: video.videoKey,
        sceneId: scene.id,
        favorite: !scene.favorite
      });
      showToast(
        result.ok ? (scene.favorite ? "Timestamp unfavorited" : "Timestamp favorited") : result.error || "Could not update favorite",
        result.ok ? "success" : "error"
      );
      await refresh();
    }

    async function toggleVideoFavorite(video) {
      const result = await actions.updateVideoFavorite({
        videoKey: video.videoKey,
        favorite: !video.favorite
      });
      showToast(
        result.ok ? (video.favorite ? "Video unfavorited" : "Video favorited") : result.error || "Could not update favorite",
        result.ok ? "success" : "error"
      );
      await refresh();
    }

    async function removeScene(video, scene) {
      const result = await actions.deleteScene({ videoKey: video.videoKey, sceneId: scene.id });
      showToast(result.ok ? "Scene deleted" : result.error || "Could not delete scene", result.ok ? "success" : "error");
      await refresh();
    }

    // Two-step delete: the first press arms the row (red highlight, the x
    // becomes a confirm check) and only a second press on that same button
    // deletes. Pressing anything else, Escape, or the timeout disarms.
    function styleArmedDeleteRow(row, armed) {
      const button = row.querySelector(".scenemarks-overlay__delete");
      row.classList.toggle("is-armed", armed);
      button.classList.toggle("is-armed", armed);
      button.textContent = armed ? "\u2713" : "\u00d7";
      button.title = armed ? "Click again to delete" : "Delete scene";
      button.setAttribute("aria-label", armed ? "Click again to confirm delete" : button.dataset.label || "Delete scene");
    }

    function findSceneRow(sceneId) {
      return host.querySelector(`[data-scene-id="${CSS.escape(sceneId)}"]`);
    }

    function armDelete(videoKey, sceneId, row) {
      if (armedDelete && armedDelete.sceneId !== sceneId) {
        const previousRow = findSceneRow(armedDelete.sceneId);
        if (previousRow) {
          styleArmedDeleteRow(previousRow, false);
        }
      }

      armedDelete = { sceneId, videoKey };
      styleArmedDeleteRow(row, true);
      root.clearTimeout(armedDeleteTimer);
      armedDeleteTimer = root.setTimeout(disarmDelete, ARMED_DELETE_TIMEOUT_MS);
    }

    function disarmDelete() {
      root.clearTimeout(armedDeleteTimer);
      armedDeleteTimer = null;
      if (!armedDelete) {
        return;
      }

      const row = findSceneRow(armedDelete.sceneId);
      if (row) {
        styleArmedDeleteRow(row, false);
      }
      armedDelete = null;
    }

    function handleDeletePress(video, scene, button) {
      if (armedDelete && armedDelete.sceneId === scene.id && armedDelete.videoKey === video.videoKey) {
        disarmDelete();
        removeScene(video, scene);
        return;
      }

      armDelete(video.videoKey, scene.id, button.closest(".scenemarks-overlay__scene"));
    }

    // Refreshes rebuild every row, so the armed styling is re-applied by
    // scene id after each render. A stale arm (scene deleted, or the video
    // context moved on) disarms instead of letting a later click delete.
    function syncArmedDeleteRow() {
      if (!armedDelete) {
        return;
      }

      const row = findSceneRow(armedDelete.sceneId);
      if (!row || row.dataset.videoKey !== armedDelete.videoKey) {
        armedDelete = null;
        return;
      }

      styleArmedDeleteRow(row, true);
    }

    function handleDocumentPointerDown(event) {
      if (!armedDelete) {
        return;
      }

      const target = event.target;
      const row = target instanceof Element ? target.closest(".scenemarks-overlay__scene") : null;
      if (row && target.closest(".scenemarks-overlay__delete") && row.dataset.sceneId === armedDelete.sceneId) {
        return;
      }

      disarmDelete();
    }

    function handleDocumentKeyDown(event) {
      if (event.key === "Escape") {
        disarmDelete();
      }
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    document.addEventListener("keydown", handleDocumentKeyDown, true);

    async function jumpToScene(video, scene, isCurrentVideo) {
      const result = isCurrentVideo
        ? await actions.seekTo(scene.startSeconds)
        : await actions.openVideoAtScene(video, scene);
      const successMessage = isCurrentVideo
        ? `Jumped to ${formatSeconds(scene.startSeconds)}`
        : `Opening video at ${formatSeconds(scene.startSeconds)}`;

      showToast(result.ok ? successMessage : result.error || "Could not jump", result.ok ? "success" : "error");
      await refresh();
    }

    function moveTo(clientX, clientY, dims) {
      const margin = 8;
      const width = dims && dims.w ? dims.w : 340;
      const height = dims && dims.h ? dims.h : 260;
      const x = Math.min(Math.max(clientX, margin), root.innerWidth - width - margin);
      const y = Math.min(Math.max(clientY, margin), root.innerHeight - height - margin);
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    }

    header.addEventListener("pointerdown", (event) => {
      if (event.target instanceof HTMLButtonElement) {
        return;
      }

      pointerStart = { x: event.clientX, y: event.clientY };
      dragDims = { w: host.offsetWidth, h: host.offsetHeight };
      panelStart = {
        x: host.offsetLeft || root.innerWidth - dragDims.w - 22,
        y: host.offsetTop || root.innerHeight - dragDims.h - 22
      };
      didDrag = false;
      header.setPointerCapture(event.pointerId);
    });

    header.addEventListener("pointermove", (event) => {
      if (!pointerStart || !panelStart) {
        return;
      }

      const deltaX = event.clientX - pointerStart.x;
      const deltaY = event.clientY - pointerStart.y;
      if (Math.hypot(deltaX, deltaY) < 6 && !didDrag) {
        return;
      }

      didDrag = true;
      // Reading layout per move would force a synchronous reflow each time,
      // so the write is batched into at most one animation frame and later
      // moves just update the target while a frame is pending.
      dragTarget = { x: panelStart.x + deltaX, y: panelStart.y + deltaY };
      if (dragFrame === null) {
        dragFrame = root.requestAnimationFrame(() => {
          dragFrame = null;
          if (dragTarget) {
            moveTo(dragTarget.x, dragTarget.y, dragDims);
          }
        });
      }
    });

    header.addEventListener("pointerup", () => {
      pointerStart = null;
      panelStart = null;
      if (dragFrame !== null) {
        root.cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }

      // Apply the last target synchronously so releasing the panel never
      // drops the final move to the cancelled frame; re-applying an already
      // written position is a no-op.
      if (dragTarget) {
        moveTo(dragTarget.x, dragTarget.y, dragDims);
      }

      dragTarget = null;
      dragDims = null;
    });

    setViewMode("current");

    return {
      destroy,
      refresh,
      render,
      setEnabled,
      showToast,
      updatePlaybackTime,
      getLatestState: () => latestState
    };
  }

  SceneMarks.Overlay = { createOverlay };
  root.SceneMarks = SceneMarks;
})(globalThis);
