(function attachMigrations(root) {
  const SceneMarks = root.SceneMarks || {};

  // Preserves source annotations and URLs in target and keeps
  // target's own fields. Source URLs go first so target's stay the newest.
  function absorbVideo(target, source) {
    const merged = SceneMarks.Storage.mergeVideo(target, source);
    return {
      ...merged,
      title: target.title,
      canonicalUrl: target.canonicalUrl,
      rawUrls: Array.from(new Set([...source.rawUrls, ...target.rawUrls]))
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

  function findAdapterIdentity(video) {
    const { Adapters } = SceneMarks;
    // Old generic canonical URLs discarded the query/hash. Prefer raw URLs,
    // which retain the evidence needed to identify content conservatively.
    const urls = video.rawUrls.length ? video.rawUrls : [video.canonicalUrl];
    const identities = new Map();
    for (const raw of urls.filter(Boolean)) {
      try {
        const url = new URL(raw);
        const adapter = Adapters.getAdapter(url);
        const videoKey = adapter.getVideoKey(url) || Adapters.GenericAdapter.getVideoKey(url);
        const canonicalUrl = adapter.getCanonicalUrl(url) || Adapters.GenericAdapter.getCanonicalUrl(url);
        const identity = SceneMarks.Schema.normalizeIdentity({ platform: adapter.id, videoKey, canonicalUrl });
        if (!identity) return null;
        identities.set(videoKey, {
          videoKey: identity.videoKey,
          platform: identity.platform,
          canonicalUrl: identity.canonicalUrl
        });
      } catch (_error) { /* Invalid stored URLs cannot identify a video. */ }
    }
    return identities.size === 1 ? [...identities.values()][0] : null;
  }

  // Schema 3 changes generic identities, retaining query and fragment data.
  // Never assign already mixed scenes to an arbitrary content ID. Ambiguous
  // records stay on their old key and are marked for manual backup repair.
  async function migrateLegacyGenericVideos() {
    const { Storage, Schema, Constants, Adapters } = SceneMarks;
    if (!Adapters || !Adapters.getAdapter) return { ok: true, migratedCount: 0 };
    const genericKeys = (await Storage.listVideoKeys()).filter((key) => {
      if (!key.startsWith("generic:")) return false;
      if (!key.startsWith("generic:v2:")) return true;
      // Keep supporting generic → platform upgrades when a dedicated adapter
      // is added later, without reading unchanged v2 generic video records.
      try {
        const url = new URL(key.slice("generic:v2:".length));
        const adapter = Adapters.getAdapter(url);
        return adapter.id !== "generic" && Boolean(adapter.getVideoKey(url));
      } catch (_error) {
        return false;
      }
    });
    if (!genericKeys.length) return { ok: true, migratedCount: 0 };
    let migratedCount = 0;
    await Storage.updateRawKeys(async (get) => {
      const { ACTIVE_RANGE_DRAFT, PENDING_JUMP } = Constants.STORAGE_KEYS;
      const raw = await get([...genericKeys.map(Storage.videoStorageKey), ACTIVE_RANGE_DRAFT, PENDING_JUMP]);
      const writes = {};
      const removals = [];
      let draft = Schema.normalizeDraft(raw[ACTIVE_RANGE_DRAFT]);
      let jump = Schema.normalizePendingJump(raw[PENDING_JUMP]);
      for (const key of genericKeys) {
        const storageKey = Storage.videoStorageKey(key);
        const video = Schema.normalizeVideo(raw[storageKey]);
        if (!video) continue;
        const identity = findAdapterIdentity(video);
        if (!identity) {
          if (!video.identityRepairRequired) writes[storageKey] = { ...video, identityRepairRequired: true };
          continue;
        }
        if (identity.videoKey === video.videoKey) continue;
        const targetKey = Storage.videoStorageKey(identity.videoKey);
        const existingRaw = writes[targetKey] || (await get([targetKey]))[targetKey];
        const existing = Schema.normalizeVideo(existingRaw);
        const rekeyed = { ...video, ...identity, identityRepairRequired: false };
        writes[targetKey] = Schema.normalizeVideo(existing ? absorbVideo(existing, rekeyed) : rekeyed);
        removals.push(storageKey);
        if (draft && draft.videoKey === key) {
          draft = { ...draft, videoKey: identity.videoKey };
          writes[ACTIVE_RANGE_DRAFT] = draft;
        }
        if (jump && jump.videoKey === key) {
          jump = { ...jump, videoKey: identity.videoKey, url: identity.canonicalUrl };
          writes[PENDING_JUMP] = jump;
        }
        migratedCount += 1;
      }
      return Object.keys(writes).length ? { set: writes, remove: removals } : Storage.SKIP_WRITE;
    });
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
