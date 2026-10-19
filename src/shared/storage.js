(function attachStorage(root) {
  const SceneMarks = root.SceneMarks || {};
  const {
    MAX_NOTE_LENGTH,
    MAX_RAW_URLS,
    MESSAGE_TYPES,
    SCHEMA_VERSION,
    STORAGE_KEYS,
    VIDEO_KEY_PREFIX
  } = SceneMarks.Constants;
  const { isValidSeconds, normalizeSeconds } = SceneMarks.Time;
  const {
    createDefaultState,
    normalizeDraft,
    normalizeIdentity,
    normalizePendingJump,
    normalizeScene,
    normalizeSettings,
    normalizeState,
    normalizeTags,
    normalizeVideo,
    sanitizeText,
    sortScenes
  } = SceneMarks.Schema;

  // Storage layout (schema 2): every video under its own `video:<videoKey>`
  // key, plus one small key each for settings, the range draft and the
  // pending jump. A write sets only the keys whose value changed, so a
  // storage.onChanged event (which every open tab receives) carries one
  // video instead of the whole library. These small keys are read with
  // every state read.
  const SHARED_KEYS = Object.freeze([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.ACTIVE_RANGE_DRAFT,
    STORAGE_KEYS.PENDING_JUMP
  ]);

  function videoStorageKey(videoKey) {
    return `${VIDEO_KEY_PREFIX}${videoKey}`;
  }

  function isVideoStorageKey(key) {
    return typeof key === "string" && key.startsWith(VIDEO_KEY_PREFIX);
  }

  function getChromeStorage() {
    if (!root.chrome || !root.chrome.storage || !root.chrome.storage.local) {
      throw new Error("chrome.storage.local is unavailable");
    }

    return root.chrome.storage.local;
  }

  function callStorage(method, ...args) {
    return new Promise((resolve, reject) => {
      getChromeStorage()[method](...args, (result) => {
        const error = root.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(result);
      });
    });
  }

  const chromeGet = (keys) => callStorage("get", keys);
  const chromeSet = (values) => callStorage("set", values);
  const chromeRemove = (keys) => callStorage("remove", keys);

  // Builds the state shape every caller uses ({ settings, activeRangeDraft,
  // pendingJump, videos }) from raw entries. Only the videos present in raw
  // are included, so a scoped read yields a state holding just those.
  function assembleState(raw) {
    const state = createDefaultState();
    state.settings = normalizeSettings(raw[STORAGE_KEYS.SETTINGS]);
    state.activeRangeDraft = normalizeDraft(raw[STORAGE_KEYS.ACTIVE_RANGE_DRAFT]);
    state.pendingJump = normalizePendingJump(raw[STORAGE_KEYS.PENDING_JUMP]);

    Object.keys(raw).forEach((key) => {
      if (!isVideoStorageKey(key)) {
        return;
      }

      const video = normalizeVideo(raw[key]);
      if (video) {
        state.videos[video.videoKey] = video;
      }
    });

    return state;
  }

  // null reads every video; an array reads only those videos.
  function readState(videoKeys) {
    const keys = videoKeys
      ? [...SHARED_KEYS, ...videoKeys.filter((key) => typeof key === "string" && key).map(videoStorageKey)]
      : null;
    return chromeGet(keys).then(assembleState);
  }

  function scopeOf(options) {
    return options && Array.isArray(options.videoKeys) ? options.videoKeys : null;
  }

  // Reads the whole library unless options.videoKeys names the videos to
  // include. Settings, the range draft and the pending jump always come
  // along, so getState({ videoKeys: [] }) is a cheap read of just those.
  async function getState(options) {
    return readState(scopeOf(options));
  }

  async function getSettings() {
    const state = await readState([]);
    return state.settings;
  }

  // The normalized storage entries a state maps to. Settings, the draft and
  // the pending jump always have an entry (an empty draft or jump is null),
  // so clearing one is a set in the same write as the rest of the change.
  function toEntries(state) {
    const entries = new Map([
      [STORAGE_KEYS.SETTINGS, normalizeSettings(state.settings)],
      [STORAGE_KEYS.ACTIVE_RANGE_DRAFT, normalizeDraft(state.activeRangeDraft)],
      [STORAGE_KEYS.PENDING_JUMP, normalizePendingJump(state.pendingJump)]
    ]);

    Object.values(state.videos || {}).forEach((value) => {
      const video = normalizeVideo(value);
      if (video) {
        entries.set(videoStorageKey(video.videoKey), video);
      }
    });

    return entries;
  }

  function serializeEntries(entries) {
    const serialized = new Map();
    entries.forEach((value, key) => serialized.set(key, JSON.stringify(value)));
    return serialized;
  }

  function entriesToState(entries) {
    const state = createDefaultState();
    state.settings = entries.get(STORAGE_KEYS.SETTINGS);
    state.activeRangeDraft = entries.get(STORAGE_KEYS.ACTIVE_RANGE_DRAFT);
    state.pendingJump = entries.get(STORAGE_KEYS.PENDING_JUMP);
    entries.forEach((value, key) => {
      if (isVideoStorageKey(key)) {
        state.videos[value.videoKey] = value;
      }
    });

    return state;
  }

  // Writes only the entries that differ from what was read, then removes
  // the videos the mutator deleted. Setting before removing means a
  // re-keyed video is never missing from storage, only briefly doubled.
  async function commitState(nextState, before) {
    const after = toEntries(nextState);
    const writes = {};
    let hasWrites = false;

    after.forEach((value, key) => {
      if (before.get(key) !== JSON.stringify(value)) {
        writes[key] = value;
        hasWrites = true;
      }
    });
    const removals = Array.from(before.keys()).filter((key) => !after.has(key));

    if (hasWrites) {
      await chromeSet(writes);
    }

    if (removals.length) {
      await chromeRemove(removals);
    }

    return entriesToState(after);
  }

  // Every mutation is a read → mutate → write cycle, and these cycles
  // arrive concurrently from multiple callers. The FIFO queue is what keeps
  // one cycle from reading the pre-write state of another and dropping its
  // change on the floor.
  let writeQueue = Promise.resolve();

  function enqueueWrite(task) {
    const run = writeQueue.then(task, task);
    // Chain off a settled copy so a rejected write never poisons the tasks
    // queued behind it; the failing caller still sees the rejection via run.
    writeQueue = run.then(() => {}, () => {});
    return run;
  }

  // Mutators return this to mean "nothing changed — do not write".
  // updateState still resolves, with the current state.
  const SKIP_WRITE = Symbol("SceneMarks.SKIP_WRITE");

  // options.videoKeys scopes the draft state to those videos (plus
  // settings, draft and pending jump), so a one-video change reads and
  // writes one video. Without it the draft holds the whole library. A
  // mutator may add or delete videos in its scope; it must not touch
  // videos outside it, which it cannot see.
  async function updateState(mutator, options) {
    const videoKeys = scopeOf(options);
    return enqueueWrite(async () => {
      const state = await readState(videoKeys);
      const before = serializeEntries(toEntries(state));
      const nextState = await mutator(state);
      if (nextState === SKIP_WRITE) {
        return state;
      }

      return commitState(nextState || state, before);
    });
  }

  const SHARED_ONLY = Object.freeze({ videoKeys: [] });

  function videoScope(videoKey) {
    return { videoKeys: [videoKey] };
  }

  // For migrations, which work on raw keys (the schema-1 blob is not part
  // of the state model). planner(get) reads what it needs and returns
  // { set, remove } — values it has already normalized — or SKIP_WRITE.
  // It runs in the same write queue as every other write and resolves to
  // whether anything was written. Not exposed over RPC.
  function updateRawKeys(planner) {
    return enqueueWrite(async () => {
      const plan = await planner(chromeGet);
      if (!plan || plan === SKIP_WRITE) {
        return false;
      }

      const writes = plan.set || {};
      const removals = plan.remove || [];
      if (Object.keys(writes).length) {
        await chromeSet(writes);
      }

      if (removals.length) {
        await chromeRemove(removals);
      }

      return true;
    });
  }

  // Newer Chrome lists keys without copying every value; older engines
  // fall back to a full read.
  async function listVideoKeys() {
    const keys = typeof getChromeStorage().getKeys === "function"
      ? await callStorage("getKeys")
      : Object.keys(await chromeGet(null));
    return keys.filter(isVideoStorageKey).map((key) => key.slice(VIDEO_KEY_PREFIX.length));
  }

  function upsertVideo(state, identity) {
    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity) {
      throw new Error("Cannot save scene without a valid video identity");
    }

    const now = new Date().toISOString();
    const existing = state.videos[normalizedIdentity.videoKey];
    const rawUrls = new Set(existing ? existing.rawUrls : []);

    if (normalizedIdentity.rawUrl) {
      // Re-adding moves a known URL to the end, so the cap keeps the newest.
      rawUrls.delete(normalizedIdentity.rawUrl);
      rawUrls.add(normalizedIdentity.rawUrl);
    }

    const video = existing || {
      videoKey: normalizedIdentity.videoKey,
      platform: normalizedIdentity.platform,
      title: normalizedIdentity.title,
      canonicalUrl: normalizedIdentity.canonicalUrl,
      rawUrls: [],
      createdAt: now,
      updatedAt: now,
      scenes: []
    };

    video.platform = normalizedIdentity.platform || video.platform;
    video.title = normalizedIdentity.title || video.title;
    video.canonicalUrl = normalizedIdentity.canonicalUrl || video.canonicalUrl;
    video.rawUrls = Array.from(rawUrls).slice(-MAX_RAW_URLS);
    video.updatedAt = now;
    state.videos[normalizedIdentity.videoKey] = video;

    return video;
  }

  function findDuplicateScene(video, scene, thresholdSeconds) {
    return video.scenes.find((existing) => {
      if (existing.type !== scene.type) {
        return false;
      }

      const startClose = Math.abs(existing.startSeconds - scene.startSeconds) <= thresholdSeconds;
      if (!startClose) {
        return false;
      }

      if (scene.type === "timestamp") {
        return true;
      }

      return Math.abs((existing.endSeconds || 0) - (scene.endSeconds || 0)) <= thresholdSeconds;
    }) || null;
  }

  function createScene(input) {
    return normalizeScene({
      ...input,
      id: input.id || SceneMarks.Ids.createId("scene"),
      createdAt: input.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  // Runs inside an updateState mutator. savedScene is null when a nearby
  // duplicate blocked the insert.
  function insertScene(draftState, normalizedIdentity, scene, allowDuplicate) {
    const video = upsertVideo(draftState, normalizedIdentity);
    const threshold = draftState.settings.duplicateThresholdSeconds;
    const duplicateScene = findDuplicateScene(video, scene, threshold);

    if (duplicateScene && !allowDuplicate) {
      return { savedScene: null, duplicateScene, video };
    }

    video.scenes = sortScenes([...video.scenes, scene]);
    video.updatedAt = new Date().toISOString();
    return { savedScene: scene, duplicateScene, video };
  }

  function insertSceneResult(outcome, state, videoKey) {
    if (!outcome.savedScene) {
      return {
        ok: false,
        duplicate: true,
        scene: outcome.duplicateScene,
        video: outcome.video || state.videos[videoKey],
        error: "A nearby scene already exists"
      };
    }

    return {
      ok: true,
      scene: outcome.savedScene,
      video: outcome.video || state.videos[videoKey]
    };
  }

  async function saveScene(identity, sceneInput, options) {
    const opts = options || {};
    const normalizedIdentity = normalizeIdentity(identity);
    const scene = createScene(sceneInput || {});

    if (!normalizedIdentity || !scene) {
      return { ok: false, error: "Invalid scene data." };
    }

    let outcome = null;
    const state = await updateState((draftState) => {
      outcome = insertScene(draftState, normalizedIdentity, scene, opts.allowDuplicate);
      return outcome.savedScene ? draftState : SKIP_WRITE;
    }, videoScope(normalizedIdentity.videoKey));

    return insertSceneResult(outcome, state, normalizedIdentity.videoKey);
  }

  async function startRange(identity, startSeconds, options) {
    const opts = options || {};
    const normalizedIdentity = normalizeIdentity(identity);
    const seconds = Number(startSeconds);

    if (!normalizedIdentity || !isValidSeconds(seconds)) {
      return { ok: false, error: "Cannot start a range without a detected video time." };
    }

    let conflict = null;
    const nextDraft = {
      videoKey: normalizedIdentity.videoKey,
      startSeconds: normalizeSeconds(seconds),
      createdAt: new Date().toISOString()
    };

    // The video record is created when the range is saved (endRange), so an
    // abandoned range leaves no empty video behind.
    await updateState((state) => {
      if (
        state.activeRangeDraft &&
        state.activeRangeDraft.videoKey !== normalizedIdentity.videoKey &&
        opts.overwrite !== true
      ) {
        conflict = state.activeRangeDraft;
        return SKIP_WRITE;
      }

      state.activeRangeDraft = nextDraft;
      return state;
    }, SHARED_ONLY);

    if (conflict) {
      return {
        ok: false,
        conflict: true,
        draft: conflict,
        error: "A range is already started on another video."
      };
    }

    return { ok: true, draft: nextDraft };
  }

  async function endRange(identity, endSeconds, sceneDetails) {
    const normalizedIdentity = normalizeIdentity(identity);
    const seconds = Number(endSeconds);

    if (!normalizedIdentity || !isValidSeconds(seconds)) {
      return { ok: false, error: "Cannot end a range without a detected video time." };
    }

    // The draft is read, the range saved and the draft cleared in one
    // queued write, so no other write can land in between and every tab
    // gets one storage.onChanged instead of two.
    let outcome = null;
    let invalidScene = false;
    const state = await updateState((draftState) => {
      const draft = draftState.activeRangeDraft;
      if (!draft || draft.videoKey !== normalizedIdentity.videoKey) {
        return SKIP_WRITE;
      }

      const scene = createScene({
        type: "range",
        startSeconds: Math.min(draft.startSeconds, seconds),
        endSeconds: Math.max(draft.startSeconds, seconds),
        note: sceneDetails && sceneDetails.note,
        tags: sceneDetails && sceneDetails.tags,
        favorite: sceneDetails && sceneDetails.favorite
      });
      if (!scene) {
        invalidScene = true;
        return SKIP_WRITE;
      }

      outcome = insertScene(
        draftState,
        normalizedIdentity,
        scene,
        sceneDetails && sceneDetails.allowDuplicate === true
      );
      if (!outcome.savedScene) {
        return SKIP_WRITE;
      }

      draftState.activeRangeDraft = null;
      return draftState;
    }, videoScope(normalizedIdentity.videoKey));

    if (invalidScene) {
      return { ok: false, error: "Invalid scene data." };
    }

    if (!outcome) {
      return { ok: false, error: "No range start is active for this video." };
    }

    return insertSceneResult(outcome, state, normalizedIdentity.videoKey);
  }

  async function deleteScene(videoKey, sceneId) {
    let deleted = false;
    await updateState((state) => {
      const video = state.videos[videoKey];
      if (!video) {
        return SKIP_WRITE;
      }

      const nextScenes = video.scenes.filter((scene) => scene.id !== sceneId);
      deleted = nextScenes.length !== video.scenes.length;
      if (!deleted) {
        return SKIP_WRITE;
      }

      if (nextScenes.length === 0) {
        delete state.videos[videoKey];

        if (state.activeRangeDraft && state.activeRangeDraft.videoKey === videoKey) {
          state.activeRangeDraft = null;
        }

        if (state.pendingJump && state.pendingJump.videoKey === videoKey) {
          state.pendingJump = null;
        }

        return state;
      }

      video.scenes = nextScenes;
      video.updatedAt = new Date().toISOString();
      return state;
    }, videoScope(videoKey));

    return { ok: deleted, error: deleted ? null : "Scene not found." };
  }

  async function updateVideo(videoKey, updates) {
    let updatedVideo = null;
    await updateState((state) => {
      const video = state.videos[videoKey];
      if (!video) {
        return SKIP_WRITE;
      }

      updatedVideo = {
        ...video,
        favorite: updates && updates.favorite === undefined ? video.favorite : updates.favorite === true,
        updatedAt: new Date().toISOString()
      };
      state.videos[videoKey] = updatedVideo;
      return state;
    }, videoScope(videoKey));

    return updatedVideo
      ? { ok: true, video: updatedVideo }
      : { ok: false, error: "Video not found." };
  }

  async function updateScene(videoKey, sceneId, updates) {
    let updatedScene = null;
    await updateState((state) => {
      const video = state.videos[videoKey];
      if (!video || !video.scenes.some((scene) => scene.id === sceneId)) {
        return SKIP_WRITE;
      }

      video.scenes = sortScenes(video.scenes.map((scene) => {
        if (scene.id !== sceneId) {
          return scene;
        }

        updatedScene = {
          ...scene,
          note: updates.note === undefined ? scene.note : sanitizeText(updates.note, MAX_NOTE_LENGTH),
          tags: updates.tags === undefined ? scene.tags : normalizeTags(updates.tags),
          favorite: updates.favorite === undefined ? scene.favorite : updates.favorite === true,
          updatedAt: new Date().toISOString()
        };

        return updatedScene;
      }));
      video.updatedAt = new Date().toISOString();
      return state;
    }, videoScope(videoKey));

    return updatedScene
      ? { ok: true, scene: updatedScene }
      : { ok: false, error: "Scene not found." };
  }

  async function getScenesForVideo(videoKey) {
    const state = await readState([videoKey]);
    return state.videos[videoKey] ? state.videos[videoKey].scenes : [];
  }

  async function setPendingJump(value) {
    const pendingJump = normalizePendingJump({
      ...value,
      createdAt: new Date().toISOString()
    });

    if (!pendingJump) {
      return { ok: false, error: "Invalid jump target." };
    }

    await updateState((state) => {
      state.pendingJump = pendingJump;
      return state;
    }, SHARED_ONLY);

    return { ok: true, pendingJump };
  }

  async function consumePendingJump(videoKey) {
    // Read first: most calls have nothing to consume, and an unconditional
    // write would broadcast a pointless storage.onChanged event that loops
    // back into overlay refreshes (visible as overlay flicker).
    const state = await readState([]);
    if (!state.pendingJump || state.pendingJump.videoKey !== videoKey) {
      return { ok: false };
    }

    let pendingJump = null;
    await updateState((draftState) => {
      if (!draftState.pendingJump || draftState.pendingJump.videoKey !== videoKey) {
        return SKIP_WRITE;
      }

      pendingJump = draftState.pendingJump;
      draftState.pendingJump = null;
      return draftState;
    }, SHARED_ONLY);

    return pendingJump ? { ok: true, pendingJump } : { ok: false };
  }

  async function clearPendingJump() {
    await updateState((state) => {
      if (!state.pendingJump) {
        return SKIP_WRITE;
      }

      state.pendingJump = null;
      return state;
    }, SHARED_ONLY);

    return { ok: true };
  }

  async function updateSettings(updates) {
    let nextSettings = null;
    await updateState((draftState) => {
      nextSettings = normalizeSettings({
        ...draftState.settings,
        ...updates,
        hotkeys: {
          ...draftState.settings.hotkeys,
          ...(updates && updates.hotkeys ? updates.hotkeys : {})
        }
      });
      // Both sides are normalized, so key order matches.
      if (JSON.stringify(nextSettings) === JSON.stringify(draftState.settings)) {
        return SKIP_WRITE;
      }

      draftState.settings = nextSettings;
      return draftState;
    }, SHARED_ONLY);

    return nextSettings;
  }

  // The new value must come from the draft inside the locked updateState:
  // deciding it from a cached settings copy first lets a quick double-toggle
  // read the same stale value twice and no-op.
  async function toggleFloatingButton() {
    const state = await updateState((draftState) => {
      draftState.settings = normalizeSettings({
        ...draftState.settings,
        enableFloatingButton: !draftState.settings.enableFloatingButton,
        hotkeys: { ...draftState.settings.hotkeys }
      });
      return draftState;
    }, SHARED_ONLY);

    return { ok: true, settings: state.settings };
  }

  function mergeVideo(existing, incoming) {
    if (!existing) {
      return incoming;
    }

    const seen = new Set(existing.scenes.map((scene) => scene.id));
    const mergedScenes = [...existing.scenes];

    for (const scene of incoming.scenes) {
      if (seen.has(scene.id)) {
        continue;
      }

      const duplicate = findDuplicateScene({ scenes: mergedScenes }, scene, 0.5);
      if (!duplicate || duplicate.note !== scene.note) {
        mergedScenes.push(scene);
      }
    }

    return {
      ...existing,
      title: incoming.title || existing.title,
      canonicalUrl: incoming.canonicalUrl || existing.canonicalUrl,
      rawUrls: Array.from(new Set([...existing.rawUrls, ...incoming.rawUrls])),
      favorite: existing.favorite || incoming.favorite,
      updatedAt: new Date().toISOString(),
      scenes: sortScenes(mergedScenes)
    };
  }

  // Returns a count, not the state: the result travels back over RPC, and
  // the library page re-renders from storage.onChanged anyway.
  async function importState(importedValue, options) {
    const opts = options || {};
    const importedState = normalizeState(importedValue);
    const importedVideos = Object.values(importedState.videos);
    const replace = opts.merge === false;

    // A merge reads and writes only the imported videos. A replace has to
    // see every stored video to remove the ones the import lacks.
    await updateState((state) => {
      if (replace) {
        const fresh = createDefaultState();
        state.videos = fresh.videos;
        state.settings = fresh.settings;
        state.activeRangeDraft = null;
        state.pendingJump = null;
      }

      for (const video of importedVideos) {
        state.videos[video.videoKey] = mergeVideo(state.videos[video.videoKey], video);
      }

      if (opts.includeSettings === true) {
        state.settings = importedState.settings;
      }

      return state;
    }, replace ? undefined : { videoKeys: importedVideos.map((video) => video.videoKey) });

    return { ok: true, videoCount: importedVideos.length };
  }

  async function deleteVideo(videoKey) {
    let deleted = false;
    await updateState((state) => {
      let changed = false;
      if (state.videos[videoKey]) {
        delete state.videos[videoKey];
        deleted = true;
        changed = true;
      }

      if (state.activeRangeDraft && state.activeRangeDraft.videoKey === videoKey) {
        state.activeRangeDraft = null;
        changed = true;
      }

      if (state.pendingJump && state.pendingJump.videoKey === videoKey) {
        state.pendingJump = null;
        changed = true;
      }

      return changed ? state : SKIP_WRITE;
    }, videoScope(videoKey));

    return { ok: deleted };
  }

  // Every key in this extension's storage.local is SceneMarks data.
  async function clearAllData() {
    return enqueueWrite(async () => {
      await callStorage("clear");
      await chromeSet({ [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION });
      return createDefaultState();
    });
  }

  // The service worker's STORAGE_RPC handler whitelist must match this list
  // exactly: these are the mutation methods remote contexts are allowed to
  // run there, because the worker is the single writer.
  const RPC_METHODS = Object.freeze([
    "saveScene",
    "startRange",
    "endRange",
    "deleteScene",
    "updateScene",
    "updateVideo",
    "updateSettings",
    "setPendingJump",
    "consumePendingJump",
    "clearPendingJump",
    "deleteVideo",
    "importState",
    "clearAllData",
    "toggleFloatingButton"
  ]);

  function sendStorageRpc(method, args) {
    return new Promise((resolve, reject) => {
      root.chrome.runtime.sendMessage(
        { type: MESSAGE_TYPES.STORAGE_RPC, payload: { method, args } },
        (response) => {
          const error = root.chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }

          if (response && response.ok) {
            resolve(response.result);
            return;
          }

          reject(new Error((response && response.error) || `Storage RPC "${method}" failed`));
        }
      );
    });
  }

  // UI and content contexts mutate storage through this client so their
  // writes execute — serialized by the worker's write queue — in the service
  // worker. Reads stay local: they cannot lose updates. Deliberately no
  // updateState, updateRawKeys, or upsertVideo here.
  function createClient() {
    const client = {
      getState,
      getScenesForVideo,
      getSettings
    };

    RPC_METHODS.forEach((method) => {
      client[method] = (...args) => sendStorageRpc(method, args);
    });

    return client;
  }

  SceneMarks.Storage = {
    SKIP_WRITE,
    clearAllData,
    clearPendingJump,
    consumePendingJump,
    createClient,
    deleteScene,
    deleteVideo,
    endRange,
    getScenesForVideo,
    getSettings,
    getState,
    importState,
    isVideoStorageKey,
    listVideoKeys,
    saveScene,
    setPendingJump,
    startRange,
    toggleFloatingButton,
    updateScene,
    updateVideo,
    updateRawKeys,
    updateSettings,
    updateState,
    upsertVideo,
    videoStorageKey
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
