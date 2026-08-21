(function initializeLibrary() {
  const Storage = SceneMarks.Storage;
  const { formatRange } = SceneMarks.Time;
  const elements = {};
  let state = null;
  const expandedVideoKeys = new Set();

  function byId(id) {
    return document.getElementById(id);
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
      .map((video) => ({
        ...video,
        scenes: video.scenes.filter((scene) => {
          const favoriteMatch = !favoritesOnly || video.favorite || scene.favorite;
          const queryMatch = sceneMatches(scene, query) || videoMatches({ ...video, scenes: [] }, query);
          return favoriteMatch && queryMatch;
        })
      }))
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
    const videos = getFilteredVideos();
    const sceneCount = videos.reduce((total, video) => total + video.scenes.length, 0);

    clearNode(elements.libraryList);
    elements.summaryBox.textContent = `${videos.length} videos, ${sceneCount} scenes`;

    if (!videos.length) {
      elements.libraryList.append(createElement("p", "empty-state", "No saved scenes match the current filters."));
      return;
    }

    videos.forEach((video) => elements.libraryList.append(renderVideo(video)));
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

  function handleLibraryKeydown(event) {
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
      createButton("Delete Video", () => deleteVideo(video.videoKey))
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

    render();
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
      createButton("Delete", () => deleteScene(video.videoKey, scene.id))
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

    const pendingResult = await Storage.setPendingJump({
      videoKey: video.videoKey,
      sceneId: scene.id,
      seconds: scene.startSeconds,
      url
    });

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

  async function deleteVideo(videoKey) {
    if (!confirm("Delete this video and all of its saved scenes?")) {
      return;
    }

    await Storage.deleteVideo(videoKey);
    await loadState();
  }

  async function deleteScene(videoKey, sceneId) {
    if (!confirm("Delete this saved scene?")) {
      return;
    }

    await Storage.deleteScene(videoKey, sceneId);
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

    await Storage.updateScene(videoKey, scene.id, { note, tags });
    await loadState();
  }

  async function toggleVideoFavorite(videoKey, favorite) {
    const result = await Storage.updateVideo(videoKey, { favorite });
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
    await Storage.updateScene(videoKey, scene.id, { favorite: !scene.favorite });
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

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await Storage.importState(parsed, { merge: true });
      elements.importInput.value = "";
      await loadState();
      elements.summaryBox.textContent = "Import complete.";
    } catch (error) {
      elements.summaryBox.textContent = `Import failed: ${error.message}`;
    }
  }

  async function loadState() {
    state = await Storage.getState();
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
      "expandAllButton",
      "collapseAllButton",
      "summaryBox",
      "libraryList",
      "exportButton",
      "importInput"
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function bindEvents() {
    elements.openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
    elements.searchInput.addEventListener("input", render);
    elements.platformFilter.addEventListener("change", render);
    elements.favoritesOnly.addEventListener("change", render);
    elements.randomVideoButton.addEventListener("click", pickRandomVideo);
    elements.expandAllButton.addEventListener("click", expandAllVideos);
    elements.collapseAllButton.addEventListener("click", collapseAllVideos);
    elements.exportButton.addEventListener("click", exportData);
    elements.importInput.addEventListener("change", () => importData(elements.importInput.files[0]));
    document.addEventListener("keydown", handleLibraryKeydown);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindElements();
    bindEvents();
    installStorageSync();
    await loadState();
  });
})();
