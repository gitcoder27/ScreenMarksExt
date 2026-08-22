(function attachOverlay(root) {
  const SceneMarks = root.SceneMarks || {};
  const { formatRange, formatSeconds } = SceneMarks.Time;

  const TOAST_ICONS = Object.freeze({ success: "\u2713", error: "!", info: "\u2022" });
  const TOAST_AUTO_HIDE_MS = 3200;

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
    let isCollapsed = false;
    let toastTimer = null;
    let latestState = null;
    let viewMode = "current";
    let lastRandomPickKey = null;
    let favoritesOnly = false;
    const expandedVideoKeys = new Set();

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
    toast.title = "Dismiss";
    toast.append(toastIcon, toastMessage);
    document.documentElement.append(toast);
    toast.addEventListener("click", hideToast);

    librarySearch.addEventListener("input", () => renderLibrary(latestState));

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
    }

    function toggleCollapse() {
      isCollapsed = !isCollapsed;
      host.classList.toggle("is-collapsed", isCollapsed);
      collapseButton.textContent = isCollapsed ? "+" : "-";
      collapseButton.setAttribute(
        "aria-label",
        isCollapsed ? "Expand SceneMarks overlay" : "Collapse SceneMarks overlay"
      );
    }

    function hideToast() {
      root.clearTimeout(toastTimer);
      toast.classList.remove("is-visible");
    }

    function showToast(message, type) {
      const kind = type === "success" || type === "error" ? type : "info";
      root.clearTimeout(toastTimer);
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
        return;
      }

      scenes.forEach((scene) => {
        currentSceneList.append(renderSceneRow({ scene, video: state.video, isCurrentVideo: true }));
      });
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
      const main = createElement("div", "scenemarks-overlay__scene-main");
      const time = createElement("span", "scenemarks-overlay__scene-time", formatRange(scene.startSeconds, scene.endSeconds));
      const note = createElement("span", "scenemarks-overlay__scene-note", scene.note || "Saved timestamp");
      const rowActions = createElement("div", "scenemarks-overlay__scene-actions");
      const jump = createButton("scenemarks-overlay__jump", "Jump", () => jumpToScene(video, scene, isCurrentVideo));
      const favorite = createFavoriteButton(scene.favorite, "timestamp", () => toggleSceneFavorite(video, scene));
      const remove = createButton("scenemarks-overlay__delete", "\u00d7", () => removeScene(video, scene));

      remove.title = "Delete scene";
      remove.setAttribute("aria-label", `Delete scene at ${formatRange(scene.startSeconds, scene.endSeconds)}`);
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

    function moveTo(clientX, clientY) {
      const margin = 8;
      const width = host.offsetWidth || 340;
      const height = host.offsetHeight || 260;
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
      panelStart = {
        x: host.offsetLeft || root.innerWidth - host.offsetWidth - 22,
        y: host.offsetTop || root.innerHeight - host.offsetHeight - 22
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
      moveTo(panelStart.x + deltaX, panelStart.y + deltaY);
    });

    header.addEventListener("pointerup", () => {
      pointerStart = null;
      panelStart = null;
    });

    setViewMode("current");

    return {
      destroy,
      refresh,
      render,
      setEnabled,
      showToast,
      getLatestState: () => latestState
    };
  }

  SceneMarks.Overlay = { createOverlay };
  root.SceneMarks = SceneMarks;
})(globalThis);
