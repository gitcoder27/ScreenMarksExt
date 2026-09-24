(function initializeLibrary() {
  const Storage = SceneMarks.Storage.createClient();
  const { formatRange } = SceneMarks.Time;
  // The list re-renders from scratch, so keystrokes are batched into one
  // render shortly after typing stops.
  const SEARCH_RENDER_DEBOUNCE_MS = 150;
  const RELOAD_MESSAGE = "SceneMarks was reloaded. Refresh this page to continue.";
  const elements = {};
  let state = null;
  let searchRenderTimer = null;
  const expandedVideoKeys = new Set();

  function byId(id) {
    return document.getElementById(id);
  }

  function isDeadContextError(error) {
    return /Extension context invalidated/i.test(String((error && error.message) || error));
  }

  // Storage mutations are RPC calls into the service worker; a rejection
  // (e.g. the extension was reloaded mid-call) must land in the summary box
  // instead of escaping as an unhandled rejection from listeners.
  async function runStorageAction(action) {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      elements.summaryBox.textContent = isDeadContextError(error) ? RELOAD_MESSAGE : error.message;
      return { ok: false };
    }
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.firstChild.remove();
    }
  }

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

  function createButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function createFavoriteButton(isFavorite, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = isFavorite ? "favorite-toggle is-favorite" : "favorite-toggle";
    button.textContent = isFavorite ? "\u2605" : "\u2606";
    button.title = isFavorite ? `Unfavorite ${label}` : `Favorite ${label}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(Boolean(isFavorite)));
    button.addEventListener("click", onClick);
    return button;
  }

  function normalizeSearch(value) {
    return String(value || "").trim().toLowerCase();
  }

  function sceneMatches(scene, query) {
    if (!query) {
      return true;
    }

    const haystack = [
      scene.note,
      ...(scene.tags || []),
      formatRange(scene.startSeconds, scene.endSeconds)
    ].join(" ").toLowerCase();

    return haystack.includes(query);
  }

  function videoMatches(video, query) {
    if (!query) {
      return true;
    }

    const haystack = [
      video.title,
      video.platform,
      video.canonicalUrl,
      ...video.rawUrls
    ].join(" ").toLowerCase();

    return haystack.includes(query) || video.scenes.some((scene) => sceneMatches(scene, query));
  }

  function getFilteredVideos() {
    const query = normalizeSearch(elements.searchInput.value);
    const platform = elements.platformFilter.value;
    const favoritesOnly = elements.favoritesOnly.checked;

    return Object.values(state.videos)
      .filter((video) => platform === "all" || video.platform === platform)
      .filter((video) => videoMatches(video, query))
      .map((video) => {
        // A metadata hit (title, platform, URL) surfaces every scene of the
        // video, while a note/tag hit surfaces only the matching scenes.
        // videoMatches is invariant across a video's scenes; evaluate the
        // metadata-only form once instead of per scene.
        const metadataMatch = videoMatches({ ...video, scenes: [] }, query);
        return {
          ...video,
          scenes: video.scenes.filter((scene) => {
            const favoriteMatch = !favoritesOnly || video.favorite || scene.favorite;
            const queryMatch = sceneMatches(scene, query) || metadataMatch;
            return favoriteMatch && queryMatch;
          })
        };
      })
      .filter((video) => {
        if (favoritesOnly) {
          return video.favorite || video.scenes.length > 0;
        }

        return video.scenes.length > 0 || videoMatches(video, query);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  let lastPlatformSignature = null;

  function renderPlatformOptions() {
    const selected = elements.platformFilter.value || "all";
    const platforms = Array.from(new Set(Object.values(state.videos).map((video) => video.platform))).sort();
    const signature = platforms.join("|");

    if (signature === lastPlatformSignature) {
      return;
    }

    lastPlatformSignature = signature;
    clearNode(elements.platformFilter);

    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "All platforms";
    elements.platformFilter.append(allOption);

    platforms.forEach((platform) => {
      const option = document.createElement("option");
      option.value = platform;
      option.textContent = platform;
      elements.platformFilter.append(option);
    });

    elements.platformFilter.value = platforms.includes(selected) ? selected : "all";
  }

  function render() {
    renderPlatformOptions();
    const scrollY = window.scrollY;
    const videos = getFilteredVideos();
    const sceneCount = videos.reduce((total, video) => total + video.scenes.length, 0);
    const favoriteVideoCount = videos.filter((video) => video.favorite).length;
    const favoriteSceneCount = videos.reduce(
      (total, video) => total + video.scenes.filter((scene) => scene.favorite).length,
      0
    );

    clearNode(elements.libraryList);
    elements.summaryBox.textContent = `${videos.length} videos, ${sceneCount} scenes`
      + (favoriteVideoCount ? `, ${favoriteVideoCount} favorited videos` : "")
      + (favoriteSceneCount ? `, ${favoriteSceneCount} favorited timestamps` : "");

    if (!videos.length) {
      elements.libraryList.append(createElement("p", "empty-state", "No saved scenes match the current filters."));
    } else {
      videos.forEach((video) => elements.libraryList.append(renderVideo(video)));
    }

    // Rebuilding every card drops the browser's scroll anchor and can clamp
    // the scroll offset while the list is momentarily shorter. Restore the
    // position so re-renders (search, filters, deletes) stay in place.
    if (window.scrollY !== scrollY) {
      window.scrollTo(0, scrollY);
    }
  }

  let lastRandomPickKey = null;

  async function pickRandomVideo() {
    const videos = getFilteredVideos();

    if (!videos.length) {
      elements.summaryBox.textContent = "No videos to pick from under the current filters.";
      return;
    }

    // The background picker drops videos already open in this window's
    // tabs, so the pick is always a video you have not opened yet.
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SceneMarks.Constants.MESSAGE_TYPES.PICK_RANDOM_VIDEO,
        payload: {
          videoKeys: videos.map((video) => video.videoKey),
          excludeVideoKey: lastRandomPickKey
        }
      });
    } catch (_error) {
      // Fall through to the shared error handling below.
    }

    if (!response || !response.ok) {
      lastRandomPickKey = null;
      elements.summaryBox.textContent = (response && response.error) || "Random pick is unavailable right now.";
      return;
    }

    lastRandomPickKey = response.video.videoKey;
    expandedVideoKeys.add(response.video.videoKey);
    render();

    requestAnimationFrame(() => {
      const card = elements.libraryList.querySelector(`[data-video-key="${CSS.escape(response.video.videoKey)}"]`);
      if (!card) {
        return;
      }

      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("is-random-pick");
      card.addEventListener("animationend", () => card.classList.remove("is-random-pick"), { once: true });
    });

    elements.summaryBox.textContent = `Random pick: ${response.video.title || "Untitled video"}`;
  }

  async function openRandomVideos() {
    const requested = Math.floor(Number(elements.randomOpenCount.value));
    if (!Number.isFinite(requested) || requested < 1) {
      elements.summaryBox.textContent = "Enter how many videos to open (1 or more).";
      return;
    }

    elements.randomOpenCount.value = String(requested);

    const videos = getFilteredVideos();
    if (!videos.length) {
      elements.summaryBox.textContent = "No videos to pick from under the current filters.";
      return;
    }

    elements.openRandomVideosButton.disabled = true;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEOS,
        payload: {
          videoKeys: videos.map((video) => video.videoKey),
          count: requested
        }
      });
    } catch (_error) {
      // Fall through to the shared error handling below.
    } finally {
      elements.openRandomVideosButton.disabled = false;
    }

    if (!response || !response.ok) {
      elements.summaryBox.textContent = (response && response.error) || "Opening random videos is unavailable right now.";
      return;
    }

    const titles = response.videos.map((video) => video.title || "Untitled video");
    const shown = titles.slice(0, 5).join(", ");
    const shortfall = response.openedCount < response.requestedCount
      ? ` (only ${response.openedCount} not already open)`
      : "";
    const suffix = titles.length > 5 ? `, and ${titles.length - 5} more` : "";
    elements.summaryBox.textContent = `Opened ${response.openedCount} random ${response.openedCount === 1 ? "video" : "videos"}${shortfall}: ${shown}${suffix}`;
  }

  function handleLibraryKeydown(event) {
    if (elements.confirmDialog.open) {
      return;
    }

    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    if (event.key.toLowerCase() !== "r") {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
      return;
    }

    event.preventDefault();
    pickRandomVideo();
  }

  function expandAllVideos() {
    getFilteredVideos().forEach((video) => expandedVideoKeys.add(video.videoKey));
    render();
  }

  function collapseAllVideos() {
    getFilteredVideos().forEach((video) => expandedVideoKeys.delete(video.videoKey));
    render();
  }

  function renderVideo(video) {
    const card = createElement("article", "video-card");
    const isCollapsed = isVideoCollapsed(video.videoKey);
    card.classList.toggle("is-collapsed", isCollapsed);
    card.dataset.videoKey = video.videoKey;

    const header = createElement("div", "video-card__header");
    const details = createElement("div");
    const platform = createElement("span", "platform-pill", video.platform);
    const title = document.createElement("button");
    title.type = "button";
    title.className = "video-title-button";
    title.setAttribute("aria-expanded", String(!isCollapsed));
    title.addEventListener("click", () => toggleVideoCollapse(video.videoKey));

    const caret = createElement("span", "video-title-caret", isCollapsed ? "+" : "-");
    const titleText = createElement("span", "video-title", video.title || "Untitled video");
    const sceneCount = createElement("span", "video-title-count", `${video.scenes.length} scenes`);
    const url = createElement("p", "video-url", video.canonicalUrl || video.rawUrls[0] || video.videoKey);
    const actions = createElement("div", "video-actions");

    title.append(caret, titleText, sceneCount);
    actions.append(
      createFavoriteButton(video.favorite, "video", () => toggleVideoFavorite(video.videoKey, !video.favorite)),
      createButton("Open", () => openVideo(video)),
      createButton("Delete Video", () => deleteVideo(video))
    );

    details.append(platform, title, url);
    header.append(details, actions);
    card.append(header);

    const sceneTable = createElement("div", "scene-table");
    sceneTable.hidden = isCollapsed;
    video.scenes.forEach((scene) => sceneTable.append(renderScene(video, scene)));
    card.append(sceneTable);

    return card;
  }

  function isVideoCollapsed(videoKey) {
    return !expandedVideoKeys.has(videoKey);
  }

  function toggleVideoCollapse(videoKey) {
    if (expandedVideoKeys.has(videoKey)) {
      expandedVideoKeys.delete(videoKey);
    } else {
      expandedVideoKeys.add(videoKey);
    }

    // Toggle the existing card in place: a full re-render here would drop the
    // scroll position (and the clicked button's focus) every time.
    const card = elements.libraryList.querySelector(`[data-video-key="${CSS.escape(videoKey)}"]`);
    if (!card) {
      render();
      return;
    }

    const isCollapsed = !expandedVideoKeys.has(videoKey);
    card.classList.toggle("is-collapsed", isCollapsed);

    const titleButton = card.querySelector(".video-title-button");
    if (titleButton) {
      titleButton.setAttribute("aria-expanded", String(!isCollapsed));
      const caret = titleButton.querySelector(".video-title-caret");
      if (caret) {
        caret.textContent = isCollapsed ? "+" : "-";
      }
    }
  }

  function renderScene(video, scene) {
    const row = createElement("div", "scene-row");
    const time = createElement("div", "scene-time", formatRange(scene.startSeconds, scene.endSeconds));
    const body = createElement("div");
    const note = createElement("p", "scene-note", scene.note || "No note");
    const actions = createElement("div", "scene-actions");

    body.append(note);
    if (scene.tags && scene.tags.length) {
      body.append(createElement("p", "scene-tags", scene.tags.map((tag) => `#${tag}`).join(" ")));
    }

    actions.append(
      createButton("Jump", () => openVideoAtScene(video, scene)),
      createButton("Open", () => openVideo(video)),
      createFavoriteButton(scene.favorite, "timestamp", () => toggleFavorite(video.videoKey, scene)),
      createButton("Edit", () => editScene(video.videoKey, scene)),
      createButton("Copy Text", () => copyShareText(video, scene)),
      createButton("Delete", () => deleteScene(video, scene))
    );

    row.append(time, body, actions);
    return row;
  }

  function openVideo(video) {
    const url = video.canonicalUrl || video.rawUrls[0];
    if (!url) {
      return;
    }

    chrome.tabs.create({ url });
  }

  async function openVideoAtScene(video, scene) {
    const url = video.canonicalUrl || video.rawUrls[0];
    if (!url) {
      elements.summaryBox.textContent = "This saved video does not have an openable URL.";
      return;
    }

    const pendingAction = await runStorageAction(() => Storage.setPendingJump({
      videoKey: video.videoKey,
      sceneId: scene.id,
      seconds: scene.startSeconds,
      url
    }));

    if (!pendingAction.ok) {
      return;
    }

    const pendingResult = pendingAction.value;
    if (!pendingResult.ok) {
      elements.summaryBox.textContent = pendingResult.error || "Could not queue timestamp jump.";
      return;
    }

    chrome.runtime.sendMessage({
      type: SceneMarks.Constants.MESSAGE_TYPES.OPEN_VIDEO_URL,
      payload: { url }
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response || !response.ok) {
        elements.summaryBox.textContent = error
          ? error.message
          : response && response.error ? response.error : "Could not open video.";
        return;
      }

      elements.summaryBox.textContent = "Opening video and queued timestamp jump.";
    });
  }

  let pendingConfirmResolve = null;

  function openConfirmDialog(options) {
    elements.confirmDialogTitle.textContent = options.title;
    elements.confirmDialogDescription.textContent = options.description || "";
    elements.confirmDeleteButton.textContent = options.confirmLabel || "Delete";
    elements.confirmDialog.showModal();

    return new Promise((resolve) => {
      pendingConfirmResolve = resolve;
    });
  }

  function closeConfirmDialog(confirmed) {
    if (!pendingConfirmResolve) {
      return;
    }

    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    elements.confirmDialog.close();
    resolve(confirmed);
  }

  async function deleteVideo(video) {
    const title = video.title || video.canonicalUrl || video.videoKey;
    const sceneWord = video.scenes.length === 1 ? "scene" : "scenes";
    const confirmed = await openConfirmDialog({
      title: "Delete this video?",
      description: `"${title}" and its ${video.scenes.length} saved ${sceneWord} will be removed from your library. This cannot be undone.`,
      confirmLabel: "Delete Video"
    });

    if (!confirmed) {
      return;
    }

    const action = await runStorageAction(() => Storage.deleteVideo(video.videoKey));
    if (!action.ok) {
      return;
    }

    await loadState();
  }

  async function deleteScene(video, scene) {
    const note = scene.note ? ` \u2014 "${scene.note}"` : "";
    const confirmed = await openConfirmDialog({
      title: "Delete this timestamp?",
      description: `${formatRange(scene.startSeconds, scene.endSeconds)}${note} will be removed from "${video.title || video.canonicalUrl || video.videoKey}". This cannot be undone.`,
      confirmLabel: "Delete Timestamp"
    });

    if (!confirmed) {
      return;
    }

    const action = await runStorageAction(() => Storage.deleteScene(video.videoKey, scene.id));
    if (!action.ok) {
      return;
    }

    await loadState();
  }

  async function editScene(videoKey, scene) {
    const note = prompt("Edit note", scene.note || "");
    if (note === null) {
      return;
    }

    const tags = prompt("Edit tags, comma separated", (scene.tags || []).join(", "));
    if (tags === null) {
      return;
    }

    const action = await runStorageAction(() => Storage.updateScene(videoKey, scene.id, { note, tags }));
    if (!action.ok) {
      return;
    }

    await loadState();
  }

  async function toggleVideoFavorite(videoKey, favorite) {
    const action = await runStorageAction(() => Storage.updateVideo(videoKey, { favorite }));
    if (!action.ok) {
      return;
    }

    const result = action.value;
    if (!result.ok) {
      elements.summaryBox.textContent = result.error || "Could not update video favorite.";
      return;
    }

    elements.summaryBox.textContent = favorite
      ? "Video added to favorites."
      : "Video removed from favorites.";
    await loadState();
  }

  async function toggleFavorite(videoKey, scene) {
    const action = await runStorageAction(() => Storage.updateScene(videoKey, scene.id, { favorite: !scene.favorite }));
    if (!action.ok) {
      return;
    }

    await loadState();
  }

  async function copyShareText(video, scene) {
    const lines = [
      `${video.title || "Saved scene"}`,
      scene.endSeconds === null
        ? `Time: ${formatRange(scene.startSeconds, scene.endSeconds)}`
        : `Range: ${formatRange(scene.startSeconds, scene.endSeconds)}`,
      `Platform: ${video.platform}`
    ];

    if (scene.note) {
      lines.push(`Note: ${scene.note}`);
    }

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      elements.summaryBox.textContent = "Share text copied.";
    } catch (_error) {
      elements.summaryBox.textContent = "Clipboard copy failed. Select and copy manually from the scene note.";
    }
  }

  async function exportData() {
    const exportState = await Storage.getState();
    const blob = new Blob([JSON.stringify(exportState, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `scenemarks-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function importData(file) {
    if (!file) {
      return;
    }

    let parsed = null;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (error) {
      elements.summaryBox.textContent = `Import failed: ${error.message}`;
      return;
    }

    const action = await runStorageAction(() => Storage.importState(parsed, { merge: true }));
    if (!action.ok) {
      return;
    }

    elements.importInput.value = "";
    await loadState();
    elements.summaryBox.textContent = "Import complete.";
  }

  async function loadState() {
    const action = await runStorageAction(() => Storage.getState());
    if (!action.ok) {
      return;
    }

    state = action.value;
    render();
  }

  function installStorageSync() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.scenemarksState) {
        loadState();
      }
    });
  }

  function bindElements() {
    [
      "openOptionsButton",
      "searchInput",
      "platformFilter",
      "favoritesOnly",
      "randomVideoButton",
      "randomOpenCount",
      "openRandomVideosButton",
      "expandAllButton",
      "collapseAllButton",
      "summaryBox",
      "libraryList",
      "exportButton",
      "importInput",
      "confirmDialog",
      "confirmDialogTitle",
      "confirmDialogDescription",
      "confirmCancelButton",
      "confirmDeleteButton"
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function bindEvents() {
    elements.openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
    elements.searchInput.addEventListener("input", () => {
      window.clearTimeout(searchRenderTimer);
      searchRenderTimer = window.setTimeout(render, SEARCH_RENDER_DEBOUNCE_MS);
    });
    elements.platformFilter.addEventListener("change", render);
    elements.favoritesOnly.addEventListener("change", render);
    elements.randomVideoButton.addEventListener("click", pickRandomVideo);
    elements.openRandomVideosButton.addEventListener("click", openRandomVideos);
    elements.randomOpenCount.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        openRandomVideos();
      }
    });
    elements.expandAllButton.addEventListener("click", expandAllVideos);
    elements.collapseAllButton.addEventListener("click", collapseAllVideos);
    elements.exportButton.addEventListener("click", exportData);
    elements.importInput.addEventListener("change", () => importData(elements.importInput.files[0]));
    elements.confirmCancelButton.addEventListener("click", () => closeConfirmDialog(false));
    elements.confirmDeleteButton.addEventListener("click", () => closeConfirmDialog(true));
    elements.confirmDialog.addEventListener("cancel", (event) => {
      // Esc fires the native "cancel"; resolve it through the same path
      // as the Cancel button instead of leaving the promise pending.
      event.preventDefault();
      closeConfirmDialog(false);
    });
    document.addEventListener("keydown", handleLibraryKeydown);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindElements();
    bindEvents();
    installStorageSync();
    await loadState();
  });
})();
