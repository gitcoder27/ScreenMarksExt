(function attachSchema(root) {
  const SceneMarks = root.SceneMarks || {};
  const {
    DEFAULT_SETTINGS,
    MAX_NOTE_LENGTH,
    MAX_TAG_LENGTH,
    MAX_TAGS,
    PENDING_JUMP_TTL_MS,
    RANGE_DRAFT_TTL_MS,
    SCHEMA_VERSION
  } = SceneMarks.Constants;
  const { isValidSeconds, normalizeSeconds } = SceneMarks.Time;

  const VALID_PLATFORMS = new Set(["netflix", "prime", "hotstar", "youtube", "generic", "unknown"]);
  const VALID_JUMP_BEHAVIORS = new Set([
    "preserve-play-state",
    "play-after-jump",
    "pause-after-jump"
  ]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createDefaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      videos: {},
      settings: clone(DEFAULT_SETTINGS),
      activeRangeDraft: null,
      pendingJump: null
    };
  }

  function sanitizeText(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
  }

  function normalizeTags(tags) {
    const rawTags = Array.isArray(tags)
      ? tags
      : String(tags || "")
        .split(",")
        .map((tag) => tag.trim());
    const seen = new Set();
    const normalized = [];

    for (const rawTag of rawTags) {
      const tag = sanitizeText(rawTag, MAX_TAG_LENGTH);
      const key = tag.toLowerCase();

      if (!tag || seen.has(key)) {
        continue;
      }

      normalized.push(tag);
      seen.add(key);

      if (normalized.length >= MAX_TAGS) {
        break;
      }
    }

    return normalized;
  }

  function normalizeHotkeys(value) {
    const defaults = DEFAULT_SETTINGS.hotkeys;
    const hotkeys = value && typeof value === "object" ? value : {};

    return {
      quickSave: sanitizeText(hotkeys.quickSave || defaults.quickSave, 60),
      toggleRange: sanitizeText(hotkeys.toggleRange || defaults.toggleRange, 60),
      startRange: sanitizeText(hotkeys.startRange || defaults.startRange, 60),
      endRange: sanitizeText(hotkeys.endRange || defaults.endRange, 60),
      nextScene: sanitizeText(hotkeys.nextScene || defaults.nextScene, 60),
      previousScene: sanitizeText(hotkeys.previousScene || defaults.previousScene, 60),
      randomVideo: sanitizeText(hotkeys.randomVideo || defaults.randomVideo, 60),
      toggleOverlay: sanitizeText(hotkeys.toggleOverlay || defaults.toggleOverlay, 60),
      openLibrary: sanitizeText(hotkeys.openLibrary || defaults.openLibrary, 60)
    };
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const duplicateThresholdSeconds = Number(source.duplicateThresholdSeconds);
    const jumpBehavior = VALID_JUMP_BEHAVIORS.has(source.defaultJumpBehavior)
      ? source.defaultJumpBehavior
      : DEFAULT_SETTINGS.defaultJumpBehavior;

    return {
      enableFloatingButton: source.enableFloatingButton !== false,
      enableGenericSites: source.enableGenericSites !== false,
      enablePageHotkeys: source.enablePageHotkeys !== false,
      defaultJumpBehavior: jumpBehavior,
      quickSaveRequiresNote: source.quickSaveRequiresNote === true,
      duplicateThresholdSeconds:
        Number.isFinite(duplicateThresholdSeconds) && duplicateThresholdSeconds >= 0
          ? Math.min(duplicateThresholdSeconds, 600)
          : DEFAULT_SETTINGS.duplicateThresholdSeconds,
      hotkeys: normalizeHotkeys(source.hotkeys)
    };
  }

  function normalizeIdentity(identity) {
    if (!identity || typeof identity !== "object") {
      return null;
    }

    const videoKey = sanitizeText(identity.videoKey, 500);
    if (!videoKey) {
      return null;
    }

    const platform = VALID_PLATFORMS.has(identity.platform) ? identity.platform : "unknown";

    return {
      videoKey,
      platform,
      title: sanitizeText(identity.title, 300) || null,
      canonicalUrl: sanitizeText(identity.canonicalUrl || identity.rawUrl, 2048),
      rawUrl: sanitizeText(identity.rawUrl || identity.canonicalUrl, 2048),
      origin: sanitizeText(identity.origin, 300)
    };
  }

  function normalizeScene(value) {
    if (!value || typeof value !== "object" || !isValidSeconds(Number(value.startSeconds))) {
      return null;
    }

    const startSeconds = normalizeSeconds(value.startSeconds);
    const rawEnd = value.endSeconds === null || value.endSeconds === undefined
      ? null
      : Number(value.endSeconds);
    const endSeconds = isValidSeconds(rawEnd) ? rawEnd : null;
    const type = endSeconds === null ? "timestamp" : "range";
    const createdAt = sanitizeText(value.createdAt, 60) || new Date().toISOString();
    const updatedAt = sanitizeText(value.updatedAt, 60) || createdAt;

    return {
      id: sanitizeText(value.id, 120) || SceneMarks.Ids.createId("scene"),
      type,
      startSeconds,
      endSeconds,
      note: sanitizeText(value.note, MAX_NOTE_LENGTH),
      tags: normalizeTags(value.tags),
      favorite: value.favorite === true,
      createdAt,
      updatedAt
    };
  }

  function normalizeVideo(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const videoKey = sanitizeText(value.videoKey, 500);
    if (!videoKey) {
      return null;
    }

    const scenes = Array.isArray(value.scenes)
      ? value.scenes.map(normalizeScene).filter(Boolean)
      : [];
    const rawUrls = Array.isArray(value.rawUrls)
      ? value.rawUrls.map((url) => sanitizeText(url, 2048)).filter(Boolean)
      : [];
    const createdAt = sanitizeText(value.createdAt, 60) || new Date().toISOString();
    const updatedAt = sanitizeText(value.updatedAt, 60) || createdAt;

    return {
      videoKey,
      platform: VALID_PLATFORMS.has(value.platform) ? value.platform : "unknown",
      title: sanitizeText(value.title, 300) || null,
      canonicalUrl: sanitizeText(value.canonicalUrl, 2048),
      rawUrls: Array.from(new Set(rawUrls)),
      favorite: value.favorite === true,
      createdAt,
      updatedAt,
      scenes: sortScenes(scenes)
    };
  }

  function normalizeDraft(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const videoKey = sanitizeText(value.videoKey, 500);
    const startSeconds = Number(value.startSeconds);
    const createdAt = sanitizeText(value.createdAt, 60);
    const createdAtMs = Date.parse(createdAt);

    if (!videoKey || !isValidSeconds(startSeconds) || !Number.isFinite(createdAtMs)) {
      return null;
    }

    if (Date.now() - createdAtMs > RANGE_DRAFT_TTL_MS) {
      return null;
    }

    return { videoKey, startSeconds, createdAt };
  }

  function normalizePendingJump(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const videoKey = sanitizeText(value.videoKey, 500);
    const sceneId = sanitizeText(value.sceneId, 120);
    const seconds = Number(value.seconds);
    const url = sanitizeText(value.url, 2048);
    const createdAt = sanitizeText(value.createdAt, 60);
    const createdAtMs = Date.parse(createdAt);

    if (!videoKey || !sceneId || !isValidSeconds(seconds) || !url || !Number.isFinite(createdAtMs)) {
      return null;
    }

    if (Date.now() - createdAtMs > PENDING_JUMP_TTL_MS) {
      return null;
    }

    return { videoKey, sceneId, seconds, url, createdAt };
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    const state = createDefaultState();
    const videos = source.videos && typeof source.videos === "object" ? source.videos : {};

    for (const video of Object.values(videos)) {
      const normalized = normalizeVideo(video);
      if (normalized) {
        state.videos[normalized.videoKey] = normalized;
      }
    }

    state.settings = normalizeSettings(source.settings);
    state.activeRangeDraft = normalizeDraft(source.activeRangeDraft);
    state.pendingJump = normalizePendingJump(source.pendingJump);
    return state;
  }

  function sortScenes(scenes) {
    return [...scenes].sort((left, right) => {
      if (left.startSeconds !== right.startSeconds) {
        return left.startSeconds - right.startSeconds;
      }

      return left.createdAt.localeCompare(right.createdAt);
    });
  }

  SceneMarks.Schema = {
    createDefaultState,
    normalizeDraft,
    normalizeIdentity,
    normalizePendingJump,
    normalizeScene,
    normalizeSettings,
    normalizeState,
    normalizeTags,
    sanitizeText,
    sortScenes
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
