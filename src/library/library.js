(function initializeLibrary(root) {
  const SceneMarks = root.SceneMarks;
  const { formatRange } = SceneMarks.Time;

  // ---- Pure view helpers. Exposed as SceneMarks.LibraryView for tests. ----

  const SORT_IDS = Object.freeze(["recent", "added", "scenes", "title", "platform"]);
  const DEFAULT_SORT = "recent";
  const SORT_STORAGE_KEY = "scenemarks.library.sort";
  const PLATFORM_LABELS = Object.freeze({
    netflix: "Netflix",
    prime: "Prime Video",
    hotstar: "Hotstar",
    youtube: "YouTube",
    generic: "Other sites",
    unknown: "Unknown"
  });
  const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function platformLabel(platform) {
    const value = String(platform || "unknown");
    return PLATFORM_LABELS[value] || value.charAt(0).toUpperCase() + value.slice(1);
  }

  function plural(count, singular, pluralWord) {
    return `${count} ${count === 1 ? singular : pluralWord || `${singular}s`}`;
  }

  // "Recently saved" is the newest scene's createdAt, falling back to the
  // video's. createdAt never changes after a save, so starring, editing a
  // note or a merge import (all of which bump updatedAt) leave the order be.
  function lastSavedAt(video) {
    let newest = "";
    for (const scene of video.scenes || []) {
      if (scene.createdAt && scene.createdAt > newest) {
        newest = scene.createdAt;
      }
    }
    return newest || video.createdAt || "";
  }

  function descending(left, right) {
    return left < right ? 1 : left > right ? -1 : 0;
  }

  function byTitle(left, right) {
    // Untitled videos go last; equal titles fall back to the key so the
    // order is total and does not shuffle between renders.
    return (!left.title) - (!right.title)
      || titleCollator.compare(left.title, right.title)
      || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  }

  function byRecent(left, right) {
    return descending(left.saved, right.saved) || byTitle(left, right);
  }

  const COMPARATORS = Object.freeze({
    recent: byRecent,
    added: (left, right) => descending(left.added, right.added) || byRecent(left, right),
    scenes: (left, right) => right.sceneCount - left.sceneCount || byRecent(left, right),
    title: byTitle,
    platform: (left, right) => titleCollator.compare(left.platform, right.platform) || byRecent(left, right)
  });

  function normalizeSortId(sortId) {
    return SORT_IDS.includes(sortId) ? sortId : DEFAULT_SORT;
  }

  // Sort keys are computed once per video, not once per comparison.
  function sortVideos(videos, sortId) {
    const comparator = COMPARATORS[normalizeSortId(sortId)];
    return videos
      .map((video) => ({
        video,
        key: video.videoKey,
        title: String(video.title || "").trim(),
        saved: lastSavedAt(video),
        added: video.createdAt || "",
        sceneCount: (video.scenes || []).length,
        platform: platformLabel(video.platform)
      }))
      .sort(comparator)
      .map((entry) => entry.video);
  }

  const FAVORITE_FILTERS = Object.freeze(["all", "videos", "moments"]);

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

  function metadataMatches(video, query) {
    if (!query) {
      return true;
    }

    return [
      video.title,
      video.platform,
      platformLabel(video.platform),
      video.canonicalUrl,
      ...(video.rawUrls || [])
    ].join(" ").toLowerCase().includes(query);
  }

  // Keeps the input order. Each result is the video with only the scenes
  // the filters let through:
  // - a title / platform / URL hit shows every scene, a note / tag / time
  //   hit only the matching scenes;
  // - favorites "videos": only starred videos, with all their scenes;
  // - favorites "moments": only starred scenes, in any video, and only
  //   videos that have one.
  function filterVideos(videos, filters) {
    const query = normalizeSearch(filters && filters.query);
    const platform = (filters && filters.platform) || "all";
    const favorites = FAVORITE_FILTERS.includes(filters && filters.favorites) ? filters.favorites : "all";
    const result = [];

    for (const video of videos) {
      if (platform !== "all" && video.platform !== platform) {
        continue;
      }
      if (favorites === "videos" && !video.favorite) {
        continue;
      }

      const metadataMatch = metadataMatches(video, query);
      const scenes = video.scenes.filter((scene) => (favorites !== "moments" || scene.favorite)
        && (metadataMatch || sceneMatches(scene, query)));
      if (scenes.length || (favorites !== "moments" && metadataMatch)) {
        result.push(scenes.length === video.scenes.length ? video : { ...video, scenes });
      }
    }

    return result;
  }

  SceneMarks.LibraryView = Object.freeze({
    SORT_IDS,
    DEFAULT_SORT,
    FAVORITE_FILTERS,
    platformLabel,
    lastSavedAt,
    sortVideos,
    filterVideos
  });

  if (typeof document === "undefined") {
    return;
  }

  // ---- The page. ----

  const Storage = SceneMarks.Storage.createClient();
  // The list re-renders from scratch, so keystrokes are batched into one
  // render shortly after typing stops.
  const SEARCH_RENDER_DEBOUNCE_MS = 150;
  const RELOAD_MESSAGE = "SceneMarks was reloaded. Refresh this page to continue.";
  const elements = {};
  let state = null;
  let searchRenderTimer = null;
  let sortId = DEFAULT_SORT;
  // Cards start collapsed, except under "Favorite moments", where the
  // starred rows are the result and start expanded. Each mode keeps its own
  // exceptions, so expanding in one does not leak into the other.
  const expandedVideoKeys = new Set();
  const collapsedMomentKeys = new Set();
  // The list renders the first PAGE_SIZE cards; "Show more" adds another
  // PAGE_SIZE. The actions (Play These, Random, Open Random) always use the
  // whole filtered list, never just the cards rendered so far.
  const PAGE_SIZE = 100;
  let renderLimit = PAGE_SIZE;
  // The cards in the list, in order, with the filtered video each shows (so
  // a collapsed card can build its rows when it is first expanded).
  const cards = new Map();
  // Video keys changed by storage events, applied once per frame.
  const pendingVideoKeys = new Set();
  let flushScheduled = false;

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
      elements.statusLine.textContent = isDeadContextError(error) ? RELOAD_MESSAGE : error.message;
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

  function getFilteredVideos() {
    // Sorted before filtering, on the whole videos, so the order does not
    // depend on which scenes the filters let through.
    return filterVideos(sortVideos(Object.values(state.videos), sortId), {
      query: elements.searchInput.value,
      platform: elements.platformFilter.value,
      favorites: elements.favoritesFilter.value
    });
  }

  function readSavedSort() {
    try {
      return normalizeSortId(root.localStorage.getItem(SORT_STORAGE_KEY));
    } catch (_error) {
      return DEFAULT_SORT;
    }
  }

  function saveSort(value) {
    try {
      root.localStorage.setItem(SORT_STORAGE_KEY, value);
    } catch (_error) {
      // The page works without it; the choice is just not remembered.
    }
  }

  function changeSort() {
    sortId = normalizeSortId(elements.sortSelect.value);
    elements.sortSelect.value = sortId;
    saveSort(sortId);
    render({ reset: true });
  }

  let lastPlatformSignature = null;

  function renderPlatformOptions() {
    const selected = elements.platformFilter.value || "all";
    const platforms = Array.from(new Set(Object.values(state.videos).map((video) => video.platform)))
      .sort((left, right) => titleCollator.compare(platformLabel(left), platformLabel(right)));
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
      option.textContent = platformLabel(platform);
      elements.platformFilter.append(option);
    });

    elements.platformFilter.value = platforms.includes(selected) ? selected : "all";
  }

  function renderSummary(videos) {
    let sceneCount = 0;
    let favoriteVideoCount = 0;
    let favoriteSceneCount = 0;
    for (const video of videos) {
      sceneCount += video.scenes.length;
      favoriteVideoCount += video.favorite ? 1 : 0;
      for (const scene of video.scenes) {
        favoriteSceneCount += scene.favorite ? 1 : 0;
      }
    }

    elements.summaryBox.textContent = `${plural(videos.length, "video")}, ${plural(sceneCount, "scene")}`
      + (favoriteVideoCount ? `, ${plural(favoriteVideoCount, "favorite video")}` : "")
      + (favoriteSceneCount ? `, ${plural(favoriteSceneCount, "favorite moment")}` : "");
  }

  function renderFooter(videos) {
    elements.emptyState.hidden = videos.length > 0;
    if (!videos.length) {
      elements.emptyState.textContent = emptyMessage();
    }

    const remaining = videos.length - Math.min(renderLimit, videos.length);
    elements.showMoreButton.hidden = remaining <= 0;
    if (remaining > 0) {
      elements.showMoreButton.textContent = `Show ${Math.min(PAGE_SIZE, remaining)} more (${remaining} not shown)`;
    }
  }

  // Full rebuild: filters, search, sort, Expand / Collapse All and the
  // first load. options.reset goes back to the first PAGE_SIZE cards.
  function render(options) {
    if (options && options.reset) {
      renderLimit = PAGE_SIZE;
    }
    closeRowMenu(false);
    renderPlatformOptions();
    const scrollY = window.scrollY;
    const videos = getFilteredVideos();

    clearNode(elements.libraryList);
    cards.clear();
    for (const video of videos.slice(0, renderLimit)) {
      const card = renderVideo(video);
      cards.set(video.videoKey, { card, video });
      elements.libraryList.append(card);
    }
    renderSummary(videos);
    renderFooter(videos);

    // Rebuilding every card drops the browser's scroll anchor and can clamp
    // the scroll offset while the list is momentarily shorter. Restore the
    // position so re-renders (search, filters, deletes) stay in place.
    if (window.scrollY !== scrollY) {
      window.scrollTo(0, scrollY);
    }
  }

  // Partial update: rebuild only the cards of changedKeys, add and remove
  // cards that entered or left the filtered list, and move cards only where
  // the order changed. Untouched cards keep their DOM, so focus and scroll
  // stay where they were; focus inside a rebuilt card moves to the same
  // control in its replacement.
  function updateList(changedKeys) {
    const platformBefore = elements.platformFilter.value;
    renderPlatformOptions();
    if (elements.platformFilter.value !== platformBefore) {
      render({ reset: true });
      return;
    }
    if (rowMenuTarget && changedKeys.has(rowMenuTarget.videoKey)) {
      closeRowMenu(false);
    }

    const focus = captureFocus();
    const videos = getFilteredVideos();
    const visible = videos.slice(0, renderLimit);
    const visibleKeys = new Set(visible.map((video) => video.videoKey));
    const list = elements.libraryList;

    for (const [videoKey, entry] of cards) {
      if (!visibleKeys.has(videoKey)) {
        entry.card.remove();
        cards.delete(videoKey);
      }
    }

    let anchor = list.firstChild;
    for (const video of visible) {
      let entry = cards.get(video.videoKey);
      if (!entry || changedKeys.has(video.videoKey)) {
        const card = renderVideo(video);
        if (entry) {
          if (anchor === entry.card) {
            anchor = card;
          }
          entry.card.replaceWith(card);
        }
        entry = { card, video };
        cards.set(video.videoKey, entry);
      } else {
        entry.video = video;
      }

      if (entry.card === anchor) {
        anchor = anchor.nextSibling;
      } else {
        list.insertBefore(entry.card, anchor);
      }
    }

    renderSummary(videos);
    renderFooter(videos);
    restoreFocus(focus, visible);
  }

  function scheduleUpdate(videoKeys) {
    videoKeys.forEach((videoKey) => pendingVideoKeys.add(videoKey));
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    const schedule = root.requestAnimationFrame || ((callback) => setTimeout(callback, 16));
    schedule(() => {
      flushScheduled = false;
      const changed = new Set(pendingVideoKeys);
      pendingVideoKeys.clear();
      if (state && changed.size) {
        updateList(changed);
      }
    });
  }

  function findDescendant(node, predicate) {
    for (const child of node.children || []) {
      if (predicate(child)) {
        return child;
      }
      const found = findDescendant(child, predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function sceneRows(card) {
    const table = findDescendant(card, (node) => node.dataset && node.dataset.sceneTable === "true");
    return table ? Array.from(table.children) : [];
  }

  function cardOf(node) {
    let current = node;
    while (current && current !== elements.libraryList) {
      if (current.dataset && current.dataset.videoKey && cards.has(current.dataset.videoKey)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  // Controls carry data-focus ("title", "video-star", "star:<sceneId>", ...)
  // so a rebuilt card can hand focus to its replacement.
  function captureFocus() {
    const active = document.activeElement;
    const card = active && active.dataset && active.dataset.focus ? cardOf(active) : null;
    if (!card) {
      return null;
    }

    const videoKey = card.dataset.videoKey;
    const [kind, sceneId] = active.dataset.focus.split(/:(.*)/s);
    const rows = sceneRows(card);
    return {
      element: active,
      videoKey,
      focusId: active.dataset.focus,
      kind,
      rowIndex: sceneId ? rows.findIndex((row) => row.dataset.sceneId === sceneId) : -1,
      cardIndex: Array.from(cards.keys()).indexOf(videoKey)
    };
  }

  function restoreFocus(saved, visible) {
    if (!saved || (saved.element.isConnected && document.activeElement === saved.element)) {
      return;
    }

    const entry = cards.get(saved.videoKey);
    let target = entry && findDescendant(entry.card, (node) => node.dataset && node.dataset.focus === saved.focusId);
    if (!target && entry && saved.rowIndex >= 0) {
      // The row left the list (deleted, or unstarred under Favorite
      // moments): take the same control on the row now in its place.
      const rows = sceneRows(entry.card);
      const row = rows[Math.min(saved.rowIndex, rows.length - 1)];
      target = row && findDescendant(row, (node) => node.dataset && String(node.dataset.focus).startsWith(`${saved.kind}:`));
    }
    if (!target && visible.length) {
      // The card left the list: take the title of the card now in its place.
      const next = cards.get(visible[Math.min(Math.max(saved.cardIndex, 0), visible.length - 1)].videoKey);
      target = next && findDescendant(next.card, (node) => node.dataset && node.dataset.focus === "title");
    }
    if (target) {
      target.focus({ preventScroll: true });
    }
  }

  function showMore() {
    renderLimit += PAGE_SIZE;
    updateList(new Set());
  }

  function emptyMessage() {
    if (Object.keys(state.videos).length) {
      return momentsMode()
        ? "No favorite moments match. Star a timestamp (\u2606 on its row) to see it here."
        : "No saved scenes match the current filters.";
    }

    const { DEFAULT_SETTINGS } = SceneMarks.Constants;
    const hotkeys = (state.settings && state.settings.hotkeys) || DEFAULT_SETTINGS.hotkeys;
    return `Your library is empty. On a video page, press ${hotkeys.quickSave} or use the SceneMarks popup to save a moment, and it will show up here.`;
  }

  let lastRandomPickKey = null;

  async function pickRandomVideo() {
    const videos = getFilteredVideos();

    if (!videos.length) {
      elements.statusLine.textContent = "No videos to pick from under the current filters.";
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
      elements.statusLine.textContent = (response && response.error) || "Random pick is unavailable right now.";
      return;
    }

    const previousPick = lastRandomPickKey;
    lastRandomPickKey = response.video.videoKey;
    setVideoCollapsed(response.video.videoKey, false);
    // A pick beyond the cards shown so far extends the list to reach it.
    const index = getFilteredVideos().findIndex((video) => video.videoKey === lastRandomPickKey);
    if (index >= renderLimit) {
      renderLimit = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE;
    }
    updateList(new Set([previousPick, lastRandomPickKey].filter(Boolean)));

    requestAnimationFrame(() => {
      const entry = cards.get(response.video.videoKey);
      if (!entry) {
        return;
      }
      const card = entry.card;

      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("is-random-pick");
      card.addEventListener("animationend", () => card.classList.remove("is-random-pick"), { once: true });
    });

    elements.statusLine.textContent = `Random pick: ${response.video.title || "Untitled video"}`;
  }

  async function openRandomVideos() {
    const count = Math.floor(Number(elements.randomOpenCount.value));
    if (!Number.isFinite(count) || count < 1) {
      elements.statusLine.textContent = "Enter how many videos to open (1 or more).";
      return;
    }

    const videos = getFilteredVideos();
    if (!videos.length) {
      elements.statusLine.textContent = "No videos to pick from under the current filters.";
      return;
    }

    elements.openRandomVideosButton.disabled = true;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SceneMarks.Constants.MESSAGE_TYPES.OPEN_RANDOM_VIDEOS,
        payload: {
          videoKeys: videos.map((video) => video.videoKey),
          count
        }
      });
    } catch (_error) {
      // Fall through to the shared error handling below.
    } finally {
      elements.openRandomVideosButton.disabled = false;
    }

    if (!response || !response.ok) {
      elements.statusLine.textContent = (response && response.error) || "Opening random videos is unavailable right now.";
      return;
    }

    const titles = response.videos.map((video) => video.title || "Untitled video");
    const shown = titles.slice(0, 5).join(", ");
    const shortfall = response.openedCount < response.requestedCount
      ? ` (only ${response.openedCount} not already open)`
      : "";
    const suffix = titles.length > 5 ? `, and ${titles.length - 5} more` : "";
    elements.statusLine.textContent = `Opened ${response.openedCount} random ${response.openedCount === 1 ? "video" : "videos"}${shortfall}: ${shown}${suffix}`;
  }

  // "Play these": the scenes the current filters show, in the order shown
  // (or shuffled), become the play queue. The worker opens the first in a
  // new tab; the lineup hotkeys step through the rest there.
  function shuffled(items) {
    const pool = items.slice();
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    return pool;
  }

  async function playFilteredScenes() {
    const { MAX_PLAY_QUEUE, MESSAGE_TYPES, DEFAULT_SETTINGS } = SceneMarks.Constants;
    const all = getFilteredVideos().flatMap((video) => video.scenes.map((scene) => ({
      videoKey: video.videoKey,
      sceneId: scene.id,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds
    })));
    if (!all.length) {
      elements.statusLine.textContent = "No scenes to play under the current filters.";
      return;
    }
    const items = (elements.playQueueShuffle.checked ? shuffled(all) : all).slice(0, MAX_PLAY_QUEUE);

    elements.playQueueButton.disabled = true;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.PLAY_QUEUE_START, payload: { items } });
    } catch (_error) {
      // Fall through to the shared error handling below.
    } finally {
      elements.playQueueButton.disabled = false;
    }
    if (!response || !response.ok) {
      elements.statusLine.textContent = (response && response.error) || "Playing these scenes is unavailable right now.";
      return;
    }

    const hotkeys = (state && state.settings && state.settings.hotkeys) || DEFAULT_SETTINGS.hotkeys;
    const capped = all.length > items.length ? ` (the first ${items.length} of ${all.length})` : "";
    elements.statusLine.textContent = `Playing ${response.count} ${response.count === 1 ? "scene" : "scenes"}`
      + ` from ${response.videoCount} ${response.videoCount === 1 ? "video" : "videos"}${capped} in a new tab.`
      + ` In that tab, ${hotkeys.lineupNext} plays the next scene and ${hotkeys.lineupPrevious} the previous one.`;
  }

  function handleLibraryKeydown(event) {
    if (elements.confirmDialog.open || rowMenuTarget) {
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
    getFilteredVideos().forEach((video) => setVideoCollapsed(video.videoKey, false));
    updateList(new Set(cards.keys()));
  }

  function collapseAllVideos() {
    getFilteredVideos().forEach((video) => setVideoCollapsed(video.videoKey, true));
    updateList(new Set(cards.keys()));
  }

  function renderVideo(video) {
    const card = createElement("article", "video-card");
    const isCollapsed = isVideoCollapsed(video.videoKey);
    card.classList.toggle("is-collapsed", isCollapsed);
    card.dataset.videoKey = video.videoKey;

    const header = createElement("div", "video-card__header");
    const details = createElement("div");
    if (video.identityRepairRequired) {
      details.append(createElement("p", "hint", "Legacy video identity is ambiguous. Export a backup, separate its scenes into the correct video records in the JSON, and re-import after removing this legacy entry. Keep the original backup until verified."));
    }
    const platform = createElement("span", "platform-pill", platformLabel(video.platform));
    // The Random pick stays marked until the next pick, across re-renders.
    const isRandomPick = video.videoKey === lastRandomPickKey;
    card.classList.toggle("is-random-current", isRandomPick);
    const title = document.createElement("button");
    title.type = "button";
    title.className = "video-title-button";
    title.setAttribute("aria-expanded", String(!isCollapsed));
    title.dataset.focus = "title";
    title.addEventListener("click", () => toggleVideoCollapse(video.videoKey));

    const caret = createElement("span", "video-title-caret", isCollapsed ? "+" : "-");
    const titleText = createElement("span", "video-title", video.title || "Untitled video");
    const fullVideo = (state && state.videos[video.videoKey]) || video;
    const total = fullVideo.scenes.length;
    // Under a filter the card shows how many of the video's scenes it lists.
    const sceneCount = createElement("span", "video-title-count", video.scenes.length === total
      ? plural(total, "scene")
      : `${video.scenes.length} of ${plural(total, "scene")}`);
    const url = createElement("p", "video-url", video.canonicalUrl || video.rawUrls[0] || video.videoKey);
    const actions = createElement("div", "video-actions");

    title.append(caret, titleText, sceneCount);
    const star = createFavoriteButton(video.favorite, "video", () => toggleVideoFavorite(video.videoKey, !video.favorite));
    const open = createButton("Open", () => openVideo(video));
    const remove = createButton("Delete Video", () => deleteVideo(fullVideo));
    star.dataset.focus = "video-star";
    open.dataset.focus = "open";
    remove.dataset.focus = "delete-video";
    actions.append(star, open, remove);

    details.append(platform);
    if (isRandomPick) {
      details.append(createElement("span", "random-pick-pill", "Random pick \u00b7 Open it, or press R for another"));
    }
    details.append(title, url);
    header.append(details, actions);
    card.append(header);

    const sceneTable = createElement("div", "scene-table");
    sceneTable.dataset.sceneTable = "true";
    sceneTable.hidden = isCollapsed;
    // Rows are built on first expand: building every row of every collapsed
    // card made each re-render slow on large libraries.
    if (!isCollapsed) {
      fillSceneTable(sceneTable, video);
    }
    card.append(sceneTable);

    return card;
  }

  function fillSceneTable(sceneTable, video) {
    sceneTable.dataset.filled = "true";
    video.scenes.forEach((scene) => sceneTable.append(renderScene(video, scene)));
  }

  function momentsMode() {
    return elements.favoritesFilter.value === "moments";
  }

  function isVideoCollapsed(videoKey) {
    return momentsMode() ? collapsedMomentKeys.has(videoKey) : !expandedVideoKeys.has(videoKey);
  }

  function setVideoCollapsed(videoKey, collapsed) {
    if (momentsMode()) {
      collapsedMomentKeys[collapsed ? "add" : "delete"](videoKey);
    } else {
      expandedVideoKeys[collapsed ? "delete" : "add"](videoKey);
    }
  }

  function toggleVideoCollapse(videoKey) {
    setVideoCollapsed(videoKey, !isVideoCollapsed(videoKey));

    // Toggle the existing card in place: a full re-render here would drop the
    // scroll position (and the clicked button's focus) every time.
    const entry = cards.get(videoKey);
    if (!entry) {
      render();
      return;
    }
    const card = entry.card;

    const isCollapsed = isVideoCollapsed(videoKey);
    card.classList.toggle("is-collapsed", isCollapsed);

    const sceneTable = card.querySelector(".scene-table");
    const video = entry.video;
    if (!isCollapsed && sceneTable && !sceneTable.dataset.filled && video) {
      fillSceneTable(sceneTable, video);
    }

    const titleButton = card.querySelector(".video-title-button");
    if (titleButton) {
      titleButton.setAttribute("aria-expanded", String(!isCollapsed));
      const caret = titleButton.querySelector(".video-title-caret");
      if (caret) {
        caret.textContent = isCollapsed ? "+" : "-";
      }
    }
  }

  const savedDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  const savedDateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  function formatSavedDate(iso) {
    const date = new Date(iso);
    return Number.isFinite(date.getTime())
      ? { short: savedDateFormat.format(date), long: savedDateTimeFormat.format(date) }
      : null;
  }

  // A row reads at a glance: time, when it was saved, the note only when
  // there is one, then star, Jump and a "more" menu (Edit, Delete).
  function renderScene(video, scene) {
    const row = createElement("div", scene.favorite ? "scene-row is-favorite" : "scene-row");
    row.dataset.sceneId = scene.id;
    const time = createElement("span", "scene-time", formatRange(scene.startSeconds, scene.endSeconds));
    const saved = formatSavedDate(scene.createdAt);
    const savedText = createElement("span", "scene-saved", saved ? saved.short : "");
    if (saved) {
      savedText.title = `Saved ${saved.long}`;
    }
    const body = createElement("div", "scene-body");
    if (scene.note) {
      body.append(createElement("p", "scene-note", scene.note));
    }
    if (scene.tags && scene.tags.length) {
      body.append(createElement("p", "scene-tags", scene.tags.map((tag) => `#${tag}`).join(" ")));
    }

    const actions = createElement("div", "scene-actions");
    const label = formatRange(scene.startSeconds, scene.endSeconds);
    const jump = createButton("Jump", () => openVideoAtScene(video, scene));
    jump.className = "scene-jump";
    jump.title = `Open the video at ${label}`;
    const more = createButton("\u22ef", () => toggleRowMenu(more, video.videoKey, scene.id));
    more.className = "scene-more";
    more.title = `More actions for ${label}`;
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    const star = createFavoriteButton(scene.favorite, `timestamp ${label}`, () => toggleFavorite(video.videoKey, scene));
    star.dataset.focus = `star:${scene.id}`;
    jump.dataset.focus = `jump:${scene.id}`;
    more.dataset.focus = `more:${scene.id}`;
    actions.append(star, jump, more);

    row.append(time, savedText, body, actions);
    return row;
  }

  // ---- The row "more" menu: one shared element, placed by the button. ----

  let rowMenuTarget = null;

  function rowMenuItems() {
    return [elements.rowMenuEdit, elements.rowMenuDelete];
  }

  function toggleRowMenu(trigger, videoKey, sceneId) {
    if (rowMenuTarget && rowMenuTarget.trigger === trigger) {
      closeRowMenu(true);
      return;
    }

    closeRowMenu(false);
    rowMenuTarget = { trigger, videoKey, sceneId };
    trigger.setAttribute("aria-expanded", "true");
    elements.rowMenu.hidden = false;
    if (typeof trigger.getBoundingClientRect === "function") {
      // position: fixed, so the card's overflow cannot clip it.
      const rect = trigger.getBoundingClientRect();
      const menuHeight = elements.rowMenu.offsetHeight || 0;
      const below = rect.bottom + 4;
      const top = below + menuHeight > window.innerHeight ? Math.max(4, rect.top - 4 - menuHeight) : below;
      elements.rowMenu.style.top = `${top}px`;
      elements.rowMenu.style.right = `${Math.max(4, window.innerWidth - rect.right)}px`;
    }
    elements.rowMenuEdit.focus();
  }

  function closeRowMenu(returnFocus) {
    if (!rowMenuTarget) {
      return;
    }

    const { trigger } = rowMenuTarget;
    rowMenuTarget = null;
    elements.rowMenu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus && trigger.isConnected !== false) {
      trigger.focus();
    }
  }

  function runRowMenuAction(action) {
    const target = rowMenuTarget;
    closeRowMenu(true);
    const video = target && state && state.videos[target.videoKey];
    const scene = video && video.scenes.find((item) => item.id === target.sceneId);
    if (scene) {
      action(video, scene);
    }
  }

  function handleRowMenuKeydown(event) {
    const items = rowMenuItems();
    const index = items.indexOf(event.target);
    if (event.key === "Escape") {
      event.preventDefault();
      closeRowMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1].focus();
    } else if (event.key === "Tab") {
      closeRowMenu(false);
    }
  }

  function handleOutsidePointer(event) {
    if (!rowMenuTarget) {
      return;
    }
    const target = event.target;
    if (elements.rowMenu.contains(target) || rowMenuTarget.trigger.contains(target)) {
      return;
    }
    closeRowMenu(false);
  }

  function openVideo(video) {
    const url = video.canonicalUrl || video.rawUrls[0];
    if (!url) {
      return;
    }

    // Opened by the worker, which only allows http(s) and file URLs.
    chrome.runtime.sendMessage({
      type: SceneMarks.Constants.MESSAGE_TYPES.OPEN_VIDEO_URL,
      payload: { url }
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response || !response.ok) {
        elements.statusLine.textContent = error
          ? error.message
          : response && response.error ? response.error : "Could not open video.";
      }
    });
  }

  async function openVideoAtScene(video, scene) {
    const url = video.canonicalUrl || video.rawUrls[0];
    if (!url) {
      elements.statusLine.textContent = "This saved video does not have an openable URL.";
      return;
    }

    // The worker allocates the destination before publishing its owned jump.
    // A separate storage RPC here would let an already-open tab steal it.
    chrome.runtime.sendMessage({
      type: SceneMarks.Constants.MESSAGE_TYPES.OPEN_VIDEO_AT_SCENE,
      payload: { url, videoKey: video.videoKey, sceneId: scene.id, seconds: scene.startSeconds }
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response || !response.ok) {
        elements.statusLine.textContent = error
          ? error.message
          : response && response.error ? response.error : "Could not open video.";
        return;
      }

      elements.statusLine.textContent = "Opening video and queued timestamp jump.";
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
    const sceneCount = video.scenes.length;
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

    elements.statusLine.textContent = action.value && action.value.ok
      ? `Deleted "${title}" and its ${plural(sceneCount, "timestamp")}.`
      : "That video was already gone.";
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

    elements.statusLine.textContent = action.value && action.value.ok === false
      ? "That timestamp was already gone."
      : `Deleted ${formatRange(scene.startSeconds, scene.endSeconds)} from "${video.title || video.canonicalUrl || video.videoKey}".`;
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
  }

  async function toggleVideoFavorite(videoKey, favorite) {
    const action = await runStorageAction(() => Storage.updateVideo(videoKey, { favorite }));
    if (!action.ok) {
      return;
    }

    const result = action.value;
    if (!result.ok) {
      elements.statusLine.textContent = result.error || "Could not update video favorite.";
      return;
    }

    elements.statusLine.textContent = favorite
      ? "Video added to favorites."
      : "Video removed from favorites.";
  }

  async function toggleFavorite(videoKey, scene) {
    const action = await runStorageAction(() => Storage.updateScene(videoKey, scene.id, { favorite: !scene.favorite }));
    if (!action.ok) {
      return;
    }
  }

  // The export keeps the single-object shape ({ schemaVersion, videos,
  // settings, ... }) whatever the storage layout, so any version imports it.
  async function exportData() {
    const exportState = await Storage.getState();
    const blob = new Blob([JSON.stringify(exportState, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `scenemarks-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    const videos = Object.values(exportState.videos);
    const sceneCount = videos.reduce((total, video) => total + video.scenes.length, 0);
    elements.statusLine.textContent = `Exported ${plural(videos.length, "video")} and ${plural(sceneCount, "timestamp")} to ${anchor.download} in your downloads folder.`;
  }

  async function importData(file) {
    if (!file) {
      return;
    }

    let parsed = null;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (_error) {
      elements.importInput.value = "";
      elements.statusLine.textContent = `Nothing was imported: "${file.name}" is not a SceneMarks export (it could not be read as JSON).`;
      return;
    }

    if (!parsed || typeof parsed !== "object" || !parsed.videos || typeof parsed.videos !== "object") {
      elements.importInput.value = "";
      elements.statusLine.textContent = `Nothing was imported: "${file.name}" has no saved videos in it. Choose a file made by Export JSON or by the automatic backup.`;
      return;
    }

    // The imported videos arrive through storage.onChanged like any write.
    const action = await runStorageAction(() => Storage.importState(parsed, { merge: true }));
    if (!action.ok) {
      return;
    }

    elements.importInput.value = "";
    elements.statusLine.textContent = describeImport(action.value);
  }

  // The merge report counts only the exceptions; timestamps that were new
  // are simply added, so they need no count of their own.
  function describeImport(result) {
    const parts = [`Imported ${plural(result.videoCount, "video")}. New timestamps were added; your existing ones and the library order are unchanged.`];
    if (result.mergedScenes) {
      parts.push(`${plural(result.mergedScenes, "timestamp")} ${result.mergedScenes === 1 ? "was" : "were"} already saved, so ${result.mergedScenes === 1 ? "it was" : "they were"} combined with the saved one (tags joined, stars kept).`);
    }
    if (result.conflictingScenes) {
      parts.push(`${plural(result.conflictingScenes, "timestamp")} differed from a saved one with the same ID and ${result.conflictingScenes === 1 ? "was" : "were"} kept as a separate copy.`);
    }
    if (result.repairedScenes) {
      parts.push(`${plural(result.repairedScenes, "timestamp")} with a duplicate ID or a reversed range ${result.repairedScenes === 1 ? "was" : "were"} fixed.`);
    }
    if (result.rejectedScenes) {
      parts.push(`${plural(result.rejectedScenes, "timestamp")} could not be read and ${result.rejectedScenes === 1 ? "was" : "were"} skipped.`);
    }
    return parts.join(" ");
  }

  let loadingState = false;
  let changedWhileLoading = false;

  async function loadState() {
    loadingState = true;
    changedWhileLoading = false;
    const action = await runStorageAction(() => Storage.getState());
    loadingState = false;
    if (!action.ok) {
      return;
    }

    state = action.value;
    render();
    // A change that landed during the read may or may not be in it.
    if (changedWhileLoading) {
      loadState();
    }
  }

  function installStorageSync() {
    // This is the only update path after a mutation. Storage is split per
    // video, so a change carries just the videos it touched: they are
    // patched in from newValue, with no re-read, and only their cards are
    // rebuilt, once per frame. Writes that leave videos untouched (pending
    // jump, range draft, settings) change nothing here.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      const videoChanges = Object.keys(changes).filter(SceneMarks.Storage.isVideoStorageKey);
      if (!videoChanges.length) {
        return;
      }

      if (loadingState) {
        changedWhileLoading = true;
        return;
      }

      if (!state) {
        loadState();
        return;
      }

      videoChanges.forEach((key) => {
        const video = SceneMarks.Schema.normalizeVideo(changes[key].newValue);
        if (video) {
          state.videos[video.videoKey] = video;
        } else {
          delete state.videos[SceneMarks.Storage.videoKeyFromStorageKey(key)];
        }
      });
      scheduleUpdate(videoChanges.map((key) => SceneMarks.Storage.videoKeyFromStorageKey(key)));
    });
  }

  function bindElements() {
    [
      "openOptionsButton",
      "searchInput",
      "platformFilter",
      "sortSelect",
      "favoritesFilter",
      "statusLine",
      "rowMenu",
      "rowMenuEdit",
      "rowMenuDelete",
      "playQueueButton",
      "playQueueShuffle",
      "randomVideoButton",
      "randomOpenCount",
      "openRandomVideosButton",
      "expandAllButton",
      "collapseAllButton",
      "summaryBox",
      "libraryList",
      "emptyState",
      "showMoreButton",
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
      searchRenderTimer = window.setTimeout(() => render({ reset: true }), SEARCH_RENDER_DEBOUNCE_MS);
    });
    elements.platformFilter.addEventListener("change", () => render({ reset: true }));
    elements.sortSelect.addEventListener("change", changeSort);
    elements.favoritesFilter.addEventListener("change", () => render({ reset: true }));
    elements.showMoreButton.addEventListener("click", showMore);
    elements.playQueueButton.addEventListener("click", playFilteredScenes);
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
    elements.rowMenuEdit.addEventListener("click", () => runRowMenuAction((video, scene) => editScene(video.videoKey, scene)));
    elements.rowMenuDelete.addEventListener("click", () => runRowMenuAction(deleteScene));
    elements.rowMenu.addEventListener("keydown", handleRowMenuKeydown);
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    // The menu is placed against its button, so it closes rather than drift.
    window.addEventListener("scroll", () => closeRowMenu(false), { passive: true });
    window.addEventListener("resize", () => closeRowMenu(false));
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
    sortId = readSavedSort();
    elements.sortSelect.value = sortId;
    bindEvents();
    installStorageSync();
    await loadState();
  });
})(globalThis);
