(function attachStorage(root) {
  const SceneMarks = root.SceneMarks || {};
  const { MAX_NOTE_LENGTH, MESSAGE_TYPES, STORAGE_KEY } = SceneMarks.Constants;
  const { isValidSeconds, normalizeSeconds } = SceneMarks.Time;
  const {
    createDefaultState,
    normalizeIdentity,
    normalizePendingJump,
    normalizeScene,
    normalizeSettings,
    normalizeState,
    normalizeTags,
    sanitizeText,
    sortScenes
  } = SceneMarks.Schema;

  function getChromeStorage() {
    if (!root.chrome || !root.chrome.storage || !root.chrome.storage.local) {
      throw new Error("chrome.storage.local is unavailable");
    }

    return root.chrome.storage.local;
  }

  function chromeGet(keys) {
    return new Promise((resolve, reject) => {
      getChromeStorage().get(keys, (result) => {
        const error = root.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(result);
      });
    });
  }

  function chromeSet(value) {
    return new Promise((resolve, reject) => {
      getChromeStorage().set(value, () => {
        const error = root.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }

  async function getState() {
    const result = await chromeGet(STORAGE_KEY);
    return normalizeState(result[STORAGE_KEY]);
  }

  async function setState(state) {
    const normalized = normalizeState(state);
    await chromeSet({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  // Every mutation is a get → mutate → set cycle over the whole state blob,
  // and these cycles arrive concurrently from multiple callers. The FIFO
  // queue is what keeps one cycle from reading the pre-write state of
  // another and dropping its change on the floor.
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

  async function updateState(mutator) {
    return enqueueWrite(async () => {
      const state = await getState();
      const nextState = await mutator(state);
      if (nextState === SKIP_WRITE) {
        return state;
      }

      return setState(nextState || state);
    });
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
    video.rawUrls = Array.from(rawUrls);
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

  async function saveScene(identity, sceneInput, options) {
    const opts = options || {};
    const input = sceneInput || {};
    const normalizedIdentity = normalizeIdentity(identity);
    const scene = normalizeScene({
      ...input,
      id: input.id || SceneMarks.Ids.createId("scene"),
      createdAt: input.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    if (!normalizedIdentity || !scene) {
      return { ok: false, error: "Invalid scene data." };
    }

    let savedScene = null;
    let duplicateScene = null;
    let savedVideo = null;

    const state = await updateState((draftState) => {
      const video = upsertVideo(draftState, normalizedIdentity);
      const threshold = draftState.settings.duplicateThresholdSeconds;
      duplicateScene = findDuplicateScene(video, scene, threshold);

      if (duplicateScene && !opts.allowDuplicate) {
        savedVideo = video;
        return draftState;
      }

      video.scenes = sortScenes([...video.scenes, scene]);
      video.updatedAt = new Date().toISOString();
      savedScene = scene;
      savedVideo = video;
      return draftState;
    });

    if (duplicateScene && !opts.allowDuplicate) {
      return {
        ok: false,
        duplicate: true,
        scene: duplicateScene,
        video: savedVideo || state.videos[normalizedIdentity.videoKey],
        error: "A nearby scene already exists"
      };
    }

    return {
      ok: true,
      scene: savedScene,
      video: savedVideo || state.videos[normalizedIdentity.videoKey]
    };
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

    await updateState((state) => {
      upsertVideo(state, normalizedIdentity);

      if (
        state.activeRangeDraft &&
        state.activeRangeDraft.videoKey !== normalizedIdentity.videoKey &&
        opts.overwrite !== true
      ) {
        conflict = state.activeRangeDraft;
        return state;
      }

      state.activeRangeDraft = nextDraft;
      return state;
    });

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

    const state = await getState();
    const draft = state.activeRangeDraft;

    if (!draft || draft.videoKey !== normalizedIdentity.videoKey) {
      return { ok: false, error: "No range start is active for this video." };
    }

    const start = Math.min(draft.startSeconds, seconds);
    const end = Math.max(draft.startSeconds, seconds);
    const result = await saveScene(
      normalizedIdentity,
      {
        type: "range",
        startSeconds: start,
        endSeconds: end,
        note: sceneDetails && sceneDetails.note,
        tags: sceneDetails && sceneDetails.tags,
        favorite: sceneDetails && sceneDetails.favorite
      },
      { allowDuplicate: sceneDetails && sceneDetails.allowDuplicate === true }
    );

    if (!result.ok) {
      return result;
    }

    await updateState((draftState) => {
      if (draftState.activeRangeDraft && draftState.activeRangeDraft.videoKey === draft.videoKey) {
        draftState.activeRangeDraft = null;
      }

      return draftState;
    });

    return result;
  }

  async function deleteScene(videoKey, sceneId) {
    let deleted = false;
    await updateState((state) => {
      const video = state.videos[videoKey];
      if (!video) {
        return state;
      }

      const nextScenes = video.scenes.filter((scene) => scene.id !== sceneId);
      deleted = nextScenes.length !== video.scenes.length;

      if (deleted && nextScenes.length === 0) {
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
    });

    return { ok: deleted, error: deleted ? null : "Scene not found." };
  }

  async function updateVideo(videoKey, updates) {
    let updatedVideo = null;
    await updateState((state) => {
      const video = state.videos[videoKey];
      if (!video) {
        return state;
      }

      updatedVideo = {
        ...video,
        favorite: updates && updates.favorite === undefined ? video.favorite : updates.favorite === true,
        updatedAt: new Date().toISOString()
      };
      state.videos[videoKey] = updatedVideo;
      return state;
    });

    return updatedVideo
      ? { ok: true, video: updatedVideo }
      : { ok: false, error: "Video not found." };
  }

  async function updateScene(videoKey, sceneId, updates) {
    let updatedScene = null;
    await updateState((state) => {
      const video = state.videos[videoKey];
      if (!video) {
        return state;
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
    });

    return updatedScene
      ? { ok: true, scene: updatedScene }
      : { ok: false, error: "Scene not found." };
  }

  async function getScenesForVideo(videoKey) {
    const state = await getState();
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
    });

    return { ok: true, pendingJump };
  }

  async function consumePendingJump(videoKey) {
    // Read first: most calls have nothing to consume, and an unconditional
    // write would broadcast a pointless storage.onChanged event that loops
    // back into overlay refreshes (visible as overlay flicker).
    const state = await getState();
    if (!state.pendingJump || state.pendingJump.videoKey !== videoKey) {
      return { ok: false };
    }

    let pendingJump = null;
    await updateState((draftState) => {
      if (draftState.pendingJump && draftState.pendingJump.videoKey === videoKey) {
        pendingJump = draftState.pendingJump;
        draftState.pendingJump = null;
      }

      return draftState;
    });

    return pendingJump ? { ok: true, pendingJump } : { ok: false };
  }

  async function clearPendingJump() {
    await updateState((state) => {
      state.pendingJump = null;
      return state;
    });

    return { ok: true };
  }

  async function updateSettings(updates) {
    const state = await updateState((draftState) => {
      draftState.settings = normalizeSettings({
        ...draftState.settings,
        ...updates,
        hotkeys: {
          ...draftState.settings.hotkeys,
          ...(updates && updates.hotkeys ? updates.hotkeys : {})
        }
      });
      return draftState;
    });

    return state.settings;
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
    });

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

  async function importState(importedValue, options) {
    const opts = options || {};
    const importedState = normalizeState(importedValue);

    return enqueueWrite(async () => {
      const state = opts.merge === false ? createDefaultState() : await getState();

      for (const video of Object.values(importedState.videos)) {
        state.videos[video.videoKey] = mergeVideo(state.videos[video.videoKey], video);
      }

      if (opts.includeSettings === true) {
        state.settings = importedState.settings;
      }

      await setState(state);
      return getState();
    });
  }

  async function deleteVideo(videoKey) {
    let deleted = false;
    await updateState((state) => {
      if (state.videos[videoKey]) {
        delete state.videos[videoKey];
        deleted = true;
      }

      if (state.activeRangeDraft && state.activeRangeDraft.videoKey === videoKey) {
        state.activeRangeDraft = null;
      }

      if (state.pendingJump && state.pendingJump.videoKey === videoKey) {
        state.pendingJump = null;
      }

      return state;
    });

    return { ok: deleted };
  }

  async function clearAllData() {
    return enqueueWrite(() => setState(createDefaultState()));
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
  // setState, updateState, or upsertVideo here.
  function createClient() {
    const client = {
      getState,
      getScenesForVideo
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
    getState,
    importState,
    saveScene,
    setState,
    setPendingJump,
    startRange,
    toggleFloatingButton,
    updateScene,
    updateVideo,
    updateSettings,
    updateState,
    upsertVideo
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
