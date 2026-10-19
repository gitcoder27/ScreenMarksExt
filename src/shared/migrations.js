(function attachMigrations(root) {
  const SceneMarks = root.SceneMarks || {};

  // Adds source's scenes (matched by id) and URLs to target and keeps
  // target's own fields. Source URLs go first so target's stay the newest.
  function absorbVideo(target, source) {
    const seen = new Set(target.scenes.map((scene) => scene.id));
    const scenes = target.scenes.concat(source.scenes.filter((scene) => !seen.has(scene.id)));

    return {
      ...target,
      favorite: target.favorite || source.favorite,
      rawUrls: Array.from(new Set([...source.rawUrls, ...target.rawUrls])),
      scenes: SceneMarks.Schema.sortScenes(scenes),
      updatedAt: new Date().toISOString()
    };
  }

  // Schema 1 kept the whole library in one LEGACY_STORAGE_KEY blob, so
  // every write sent all of it to every tab; schema 2 gives each video its
  // own key (see storage.js). Anything already on the new layout was
  // written after the update, so it wins: a video there absorbs the blob's
  // copy, and settings, draft and pending jump keys that exist are kept.
  // Re-running is safe, and an idle pass reads two small keys and writes
  // nothing.
  async function migrateToSplitStorage() {
    const { LEGACY_STORAGE_KEY, SCHEMA_VERSION, STORAGE_KEYS } = SceneMarks.Constants;
    const { Schema, Storage } = SceneMarks;
    let migratedCount = 0;

    await Storage.updateRawKeys(async (get) => {
      const marker = await get([LEGACY_STORAGE_KEY, STORAGE_KEYS.SCHEMA_VERSION]);
      const legacy = marker[LEGACY_STORAGE_KEY];
      if (legacy === undefined) {
        // A fresh install records its version once; after that, nothing.
        return Number(marker[STORAGE_KEYS.SCHEMA_VERSION]) >= SCHEMA_VERSION
          ? Storage.SKIP_WRITE
          : { set: { [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION } };
      }

      const legacyState = Schema.normalizeState(legacy);
      const legacyVideos = Object.values(legacyState.videos);
      const current = await get([
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.ACTIVE_RANGE_DRAFT,
        STORAGE_KEYS.PENDING_JUMP,
        ...legacyVideos.map((video) => Storage.videoStorageKey(video.videoKey))
      ]);
      const writes = { [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION };

      for (const video of legacyVideos) {
        const key = Storage.videoStorageKey(video.videoKey);
        const existing = Schema.normalizeVideo(current[key]);
        writes[key] = existing ? Schema.normalizeVideo(absorbVideo(existing, video)) : video;
      }

      if (current[STORAGE_KEYS.SETTINGS] === undefined) {
        writes[STORAGE_KEYS.SETTINGS] = legacyState.settings;
      }

      if (current[STORAGE_KEYS.ACTIVE_RANGE_DRAFT] === undefined && legacyState.activeRangeDraft) {
        writes[STORAGE_KEYS.ACTIVE_RANGE_DRAFT] = legacyState.activeRangeDraft;
      }

      if (current[STORAGE_KEYS.PENDING_JUMP] === undefined && legacyState.pendingJump) {
        writes[STORAGE_KEYS.PENDING_JUMP] = legacyState.pendingJump;
      }

      migratedCount = legacyVideos.length;
      // The blob is removed only after the new keys are written, so a
      // failed write leaves it in place for the next pass.
      return { set: writes, remove: [LEGACY_STORAGE_KEY] };
    });

    return { ok: true, migratedCount };
  }

  function findAdapterIdentity(video, adapters) {
    const urls = [video.canonicalUrl, ...(video.rawUrls || [])].filter(Boolean);
    for (const raw of urls) {
      let url;
      try {
        url = new URL(raw);
      } catch (_error) {
        continue;
      }

      const adapter = adapters.find((candidate) => candidate.matches(url));
      if (!adapter) {
        continue;
      }

      const videoKey = adapter.getVideoKey(url);
      if (videoKey && videoKey !== video.videoKey) {
        return {
          platform: adapter.id,
          videoKey,
          canonicalUrl: adapter.getCanonicalUrl(url) || video.canonicalUrl
        };
      }
    }

    return null;
  }

  // Videos saved before a site had a dedicated adapter live under
  // `generic:<origin>:<pathname>` keys, which collapse distinct videos
  // (e.g. every /watch?v=... page) into one entry. Re-key them using the
  // adapter that now matches their stored URLs.
  async function migrateLegacyGenericVideos() {
    const adapters = ((SceneMarks.Adapters && SceneMarks.Adapters.list) || [])
      .filter((adapter) => adapter && adapter.id !== "generic");
    const { Storage } = SceneMarks;

    if (!adapters.length) {
      return { ok: true, migratedCount: 0 };
    }

    // The key names alone show which videos are generic, so an idle pass
    // reads no video data.
    const genericKeys = (await Storage.listVideoKeys()).filter((key) => key.startsWith("generic:"));
    if (!genericKeys.length) {
      return { ok: true, migratedCount: 0 };
    }

    // The write must see both ends of each re-key, so read the generic
    // videos first to learn their new keys, then scope one write to both.
    const genericState = await Storage.getState({ videoKeys: genericKeys });
    const targetKeys = Object.values(genericState.videos)
      .map((video) => findAdapterIdentity(video, adapters))
      .filter(Boolean)
      .map((identity) => identity.videoKey);
    if (!targetKeys.length) {
      return { ok: true, migratedCount: 0 };
    }

    const scope = new Set([...genericKeys, ...targetKeys]);
    let migratedCount = 0;
    await Storage.updateState((state) => {
      let changed = false;
      for (const video of Object.values(state.videos)) {
        if (!String(video.videoKey).startsWith("generic:")) {
          continue;
        }

        // A video edited since the read above could point outside the
        // scope, where this write cannot see an existing entry to merge.
        const identity = findAdapterIdentity(video, adapters);
        if (!identity || !scope.has(identity.videoKey)) {
          continue;
        }

        delete state.videos[video.videoKey];
        const existing = state.videos[identity.videoKey];
        state.videos[identity.videoKey] = existing
          ? absorbVideo(existing, video)
          : {
            ...video,
            videoKey: identity.videoKey,
            platform: identity.platform,
            canonicalUrl: identity.canonicalUrl
          };

        migratedCount += 1;
        changed = true;
      }

      // An idle pass must not write: every write reaches every open tab
      // through storage.onChanged.
      return changed ? state : Storage.SKIP_WRITE;
    }, { videoKeys: Array.from(scope) });

    return { ok: true, migratedCount };
  }

  // Order matters: the re-keying reads the per-video keys the split writes.
  async function runAll() {
    const split = await migrateToSplitStorage();
    const generic = await migrateLegacyGenericVideos();
    return { ok: true, splitCount: split.migratedCount, genericCount: generic.migratedCount };
  }

  SceneMarks.Migrations = { migrateLegacyGenericVideos, migrateToSplitStorage, runAll };
  root.SceneMarks = SceneMarks;
})(globalThis);
