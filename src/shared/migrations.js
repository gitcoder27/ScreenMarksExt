(function attachMigrations(root) {
  const SceneMarks = root.SceneMarks || {};

  // Videos saved before a site had a dedicated adapter live under
  // `generic:<origin>:<pathname>` keys, which collapse distinct videos
  // (e.g. every /watch?v=... page) into one entry. Re-key them using the
  // adapter that now matches their stored URLs.
  async function migrateLegacyGenericVideos() {
    const adapters = ((SceneMarks.Adapters && SceneMarks.Adapters.list) || [])
      .filter((adapter) => adapter && adapter.id !== "generic");

    if (!adapters.length) {
      return { ok: true, migratedCount: 0 };
    }

    let migratedCount = 0;
    await SceneMarks.Storage.updateState((state) => {
      for (const video of Object.values(state.videos)) {
        if (!String(video.videoKey).startsWith("generic:")) {
          continue;
        }

        const urls = [video.canonicalUrl, ...(video.rawUrls || [])].filter(Boolean);
        let identity = null;
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
            identity = {
              platform: adapter.id,
              videoKey,
              canonicalUrl: adapter.getCanonicalUrl(url) || video.canonicalUrl
            };
            break;
          }
        }

        if (!identity) {
          continue;
        }

        delete state.videos[video.videoKey];
        const existing = state.videos[identity.videoKey];
        if (existing) {
          const seen = new Set(existing.scenes.map((scene) => scene.id));
          for (const scene of video.scenes) {
            if (!seen.has(scene.id)) {
              existing.scenes.push(scene);
            }
          }

          existing.scenes = SceneMarks.Schema.sortScenes(existing.scenes);
          existing.rawUrls = Array.from(new Set([...existing.rawUrls, ...video.rawUrls]));
          existing.updatedAt = new Date().toISOString();
        } else {
          state.videos[identity.videoKey] = {
            ...video,
            videoKey: identity.videoKey,
            platform: identity.platform,
            canonicalUrl: identity.canonicalUrl
          };
        }

        migratedCount += 1;
      }

      return state;
    });

    return { ok: true, migratedCount };
  }

  SceneMarks.Migrations = { migrateLegacyGenericVideos };
  root.SceneMarks = SceneMarks;
})(globalThis);
