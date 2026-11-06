(function attachSchema(root) {
  const SceneMarks = root.SceneMarks || {};
  const {
    DEFAULT_SETTINGS,
    MAX_DISABLED_SITES,
    MAX_NOTE_LENGTH,
    MAX_RAW_URLS,
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
      videos: Object.create(null),
      settings: clone(DEFAULT_SETTINGS),
      activeRangeDraft: null,
      pendingJump: null
    };
  }

  function sanitizeText(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
  }

  const OPENABLE_URL_PROTOCOLS = new Set(["http:", "https:", "file:"]);

  // Saved video URLs are opened from the library, popup and overlay, so
  // anything but a web or file URL (javascript:, data:, chrome:, ... from a
  // crafted import) is dropped.
  function sanitizeUrl(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 2048) {
      return "";
    }

    try {
      return OPENABLE_URL_PROTOCOLS.has(new URL(text).protocol) ? text : "";
    } catch (_error) {
      return "";
    }
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

  // A site entry is a bare lowercase hostname. Pasted URLs, ports and a
  // leading "*." are dropped. Keep every hostname label, including "www":
  // on a hosted suffix even that label may identify an independent tenant.
  function normalizeSiteDomain(value) {
    const text = sanitizeText(value, 300).toLowerCase();
    if (!text) {
      return "";
    }

    let hostname;
    try {
      hostname = new URL(text.includes("://") ? text : `https://${text.replace(/^\*\./, "")}`).hostname;
    } catch (_error) {
      return "";
    }

    hostname = hostname.replace(/\.$/, "");
    // The URL parser reads numbers as IPv4 ("7" becomes "0.0.0.7"), so an
    // address only counts when it was typed out.
    if (/^\d+(\.\d+){3}$/.test(hostname) && !text.includes(hostname)) {
      return "";
    }

    return hostname.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(hostname) ? hostname : "";
  }

  // Without a public-suffix database, retain the exact host. Reducing an
  // arbitrary hostname can switch off unrelated tenants (e.g. github.io).
  function mainDomainForHost(hostname) {
    return normalizeSiteDomain(hostname);
  }

  function hostMatchesSite(hostname, site) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return Boolean(host && site) && (host === site || host.endsWith(`.${site}`));
  }

  function findDisabledSite(disabledSites, hostname) {
    return (Array.isArray(disabledSites) ? disabledSites : []).find((site) => hostMatchesSite(hostname, site)) || null;
  }

  // Whether SceneMarks should act on a page with this hostname. Pages
  // without one (file://) can only be paused everywhere.
  function isEnabledForHost(settings, hostname) {
    return Boolean(settings)
      && settings.extensionEnabled !== false
      && !findDisabledSite(settings.disabledSites, hostname);
  }

  function normalizeDisabledSites(value) {
    const sites = [];
    const seen = new Set();

    for (const entry of Array.isArray(value) ? value : []) {
      const site = normalizeSiteDomain(entry);
      if (!site || seen.has(site)) {
        continue;
      }

      sites.push(site);
      seen.add(site);
      if (sites.length >= MAX_DISABLED_SITES) {
        break;
      }
    }

    return sites;
  }

  function normalizeVoiceSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const defaults = DEFAULT_SETTINGS.voice;
    const sensitivity = Number(source.sensitivity);
    const cap = SceneMarks.Constants.MAX_VOICE_MIC_FIELD_LENGTH;
    return {
      enabled: source.enabled === true,
      sensitivity: Number.isFinite(sensitivity)
        ? Math.min(1, Math.max(0, sensitivity))
        : defaults.sensitivity,
      micDeviceId: sanitizeText(source.micDeviceId, cap),
      micLabel: sanitizeText(source.micLabel, cap)
    };
  }

  // { featureVersion, commands: { <id>: [{ frames, data }] } } where data is
  // frames x VOICE_MFCC_COEFFS numbers, row by row. Unknown commands, extra
  // samples, oversized or malformed templates and non-numeric data are
  // dropped. Values are rounded to 2 decimals to keep the key small.
  function normalizeVoiceTemplate(value) {
    const { MAX_VOICE_TEMPLATE_FRAMES, VOICE_MFCC_COEFFS } = SceneMarks.Constants;
    if (!value || typeof value !== "object" || !Array.isArray(value.data)) {
      return null;
    }
    const frames = Number(value.frames);
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > MAX_VOICE_TEMPLATE_FRAMES
      || value.data.length !== frames * VOICE_MFCC_COEFFS) {
      return null;
    }
    const data = new Array(value.data.length);
    for (let i = 0; i < value.data.length; i += 1) {
      const number = value.data[i];
      if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 10000) {
        return null;
      }
      data[i] = Math.round(number * 100) / 100;
    }
    return { frames, data };
  }

  function normalizeVoiceProfile(value) {
    const { MAX_VOICE_SAMPLES, VOICE_COMMANDS, VOICE_FEATURE_VERSION } = SceneMarks.Constants;
    const source = value && typeof value === "object" ? value : {};
    const featureVersion = Number.isSafeInteger(source.featureVersion) ? source.featureVersion : VOICE_FEATURE_VERSION;
    const sourceCommands = source.commands && typeof source.commands === "object" ? source.commands : {};
    const commands = {};
    for (const { id } of VOICE_COMMANDS) {
      if (!Object.prototype.hasOwnProperty.call(sourceCommands, id) || !Array.isArray(sourceCommands[id])) {
        continue;
      }
      const samples = sourceCommands[id].map(normalizeVoiceTemplate).filter(Boolean).slice(0, MAX_VOICE_SAMPLES);
      if (samples.length) {
        commands[id] = samples;
      }
    }
    return { featureVersion, commands };
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const duplicateThresholdSeconds = Number(source.duplicateThresholdSeconds);
    const jumpBehavior = VALID_JUMP_BEHAVIORS.has(source.defaultJumpBehavior)
      ? source.defaultJumpBehavior
      : DEFAULT_SETTINGS.defaultJumpBehavior;

    return {
      extensionEnabled: source.extensionEnabled !== false,
      disabledSites: normalizeDisabledSites(source.disabledSites),
      enableFloatingButton: source.enableFloatingButton !== false,
      enableGenericSites: source.enableGenericSites !== false,
      enablePageHotkeys: source.enablePageHotkeys !== false,
      defaultJumpBehavior: jumpBehavior,
      quickSaveRequiresNote: source.quickSaveRequiresNote === true,
      duplicateThresholdSeconds:
        Number.isFinite(duplicateThresholdSeconds) && duplicateThresholdSeconds >= 0
          ? Math.min(duplicateThresholdSeconds, 600)
          : DEFAULT_SETTINGS.duplicateThresholdSeconds,
      voice: normalizeVoiceSettings(source.voice),
      hotkeys: normalizeHotkeys(source.hotkeys)
    };
  }

  function normalizeIdentity(identity) {
    if (!identity || typeof identity !== "object") {
      return null;
    }

    const videoKey = sanitizeText(identity.videoKey, 2200);
    if (!videoKey || String(identity.videoKey).trim().length > 2200) {
      return null;
    }

    const platform = VALID_PLATFORMS.has(identity.platform) ? identity.platform : "unknown";
    if (videoKey.startsWith("generic:v2:") && !sanitizeUrl(identity.canonicalUrl || identity.rawUrl)) {
      return null;
    }

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

    let startSeconds = normalizeSeconds(value.startSeconds);
    const rawEnd = value.endSeconds === null || value.endSeconds === undefined
      ? null
      : Number(value.endSeconds);
    let endSeconds = isValidSeconds(rawEnd) ? normalizeSeconds(rawEnd) : null;
    if (endSeconds !== null && endSeconds < startSeconds) {
      [startSeconds, endSeconds] = [endSeconds, startSeconds];
    }
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

    const videoKey = sanitizeText(value.videoKey, 2200);
    if (!videoKey || String(value.videoKey).trim().length > 2200) {
      return null;
    }

    const scenes = Array.isArray(value.scenes)
      ? value.scenes.map(normalizeScene).filter(Boolean)
      : [];
    const seenIds = new Set();
    for (const scene of scenes) {
      if (seenIds.has(scene.id)) {
        const base = scene.id.slice(0, 100);
        let suffix = 2;
        while (seenIds.has(`${base}~${suffix}`)) suffix += 1;
        scene.id = `${base}~${suffix}`;
      }
      seenIds.add(scene.id);
    }
    const rawUrls = Array.isArray(value.rawUrls)
      ? value.rawUrls.map(sanitizeUrl).filter(Boolean)
      : [];
    const createdAt = sanitizeText(value.createdAt, 60) || new Date().toISOString();
    const updatedAt = sanitizeText(value.updatedAt, 60) || createdAt;

    return {
      videoKey,
      platform: VALID_PLATFORMS.has(value.platform) ? value.platform : "unknown",
      title: sanitizeText(value.title, 300) || null,
      canonicalUrl: sanitizeUrl(value.canonicalUrl),
      rawUrls: Array.from(new Set(rawUrls)).slice(-MAX_RAW_URLS),
      favorite: value.favorite === true,
      identityRepairRequired: value.identityRepairRequired === true,
      createdAt,
      updatedAt,
      scenes: sortScenes(scenes)
    };
  }

  function normalizeDraft(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const videoKey = sanitizeText(value.videoKey, 2200);
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

    const videoKey = sanitizeText(value.videoKey, 2200);
    const sceneId = sanitizeText(value.sceneId, 120);
    const seconds = Number(value.seconds);
    const url = sanitizeUrl(value.url);
    const createdAt = sanitizeText(value.createdAt, 60);
    const createdAtMs = Date.parse(createdAt);

    if (!videoKey || !sceneId || !isValidSeconds(seconds) || !url || !Number.isFinite(createdAtMs)) {
      return null;
    }

    if (Date.now() - createdAtMs > PENDING_JUMP_TTL_MS) {
      return null;
    }

    // Ownership is additive: old requests remain readable/migratable, but a
    // missing owner must never let an arbitrary matching tab claim them.
    const targetTabId = Number.isSafeInteger(value.targetTabId) && value.targetTabId >= 0
      ? value.targetTabId : null;
    // Stable fallback preserves pre-token requests through normalization.
    const requestId = sanitizeText(value.requestId, 120) || sanitizeText(`legacy:${createdAt}:${sceneId}`, 120);
    return { videoKey, sceneId, seconds, url, createdAt, requestId, targetTabId };
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
    findDisabledSite,
    hostMatchesSite,
    isEnabledForHost,
    mainDomainForHost,
    normalizeDraft,
    normalizeIdentity,
    normalizePendingJump,
    normalizeScene,
    normalizeSettings,
    normalizeVoiceProfile,
    normalizeVoiceSettings,
    normalizeVoiceTemplate,
    normalizeSiteDomain,
    normalizeState,
    normalizeTags,
    normalizeVideo,
    sanitizeText,
    sanitizeUrl,
    sortScenes
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
