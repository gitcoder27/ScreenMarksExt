(function attachYouTubeAdapter(root) {
  const SceneMarks = root.SceneMarks || {};
  const Adapters = SceneMarks.Adapters || {};
  const { cleanTitle } = Adapters.Utils;

  function normalizeVideoId(value) {
    const id = String(value || "");
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  function extractVideoId(url) {
    if (url.hostname === "youtu.be") {
      return normalizeVideoId(url.pathname.split("/").filter(Boolean)[0]);
    }

    const fromQuery = url.searchParams.get("v");
    if (fromQuery) {
      return normalizeVideoId(fromQuery);
    }

    const shortsMatch = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
    return shortsMatch ? shortsMatch[1] : null;
  }

  const YouTubeAdapter = {
    id: "youtube",
    matches(url) {
      return /(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === "youtu.be";
    },
    extractVideoId,
    getVideoKey(url) {
      const id = extractVideoId(url);
      return id ? `youtube:${id}` : null;
    },
    getCanonicalUrl(url) {
      const id = extractVideoId(url);
      return id ? `https://www.youtube.com/watch?v=${id}` : null;
    },
    getTitle(documentRef) {
      const title = cleanTitle(documentRef);
      return title ? title.replace(/\s+-\s+YouTube$/i, "") : null;
    }
  };

  Adapters.YouTubeAdapter = YouTubeAdapter;
  SceneMarks.Adapters = Adapters;
  root.SceneMarks = SceneMarks;
})(globalThis);
