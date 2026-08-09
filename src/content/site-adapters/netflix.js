(function attachNetflixAdapter(root) {
  const SceneMarks = root.SceneMarks || {};
  const Adapters = SceneMarks.Adapters || {};
  const { canonicalizeUrl, cleanTitle } = Adapters.Utils;

  function getWatchId(url) {
    const match = url.pathname.match(/\/watch\/(\d+)/i);
    return match ? match[1] : null;
  }

  const NetflixAdapter = {
    id: "netflix",
    matches(url) {
      return /(^|\.)netflix\.com$/i.test(url.hostname);
    },
    getVideoKey(url) {
      const watchId = getWatchId(url);
      return watchId ? `netflix:watch:${watchId}` : null;
    },
    getCanonicalUrl(url) {
      const watchId = getWatchId(url);
      return watchId ? `${url.origin}/watch/${watchId}` : canonicalizeUrl(url, false);
    },
    getTitle(documentRef) {
      const title = cleanTitle(documentRef);
      return title ? title.replace(/\s+-\s+Netflix$/i, "").trim() : null;
    }
  };

  Adapters.NetflixAdapter = NetflixAdapter;
  SceneMarks.Adapters = Adapters;
  root.SceneMarks = SceneMarks;
})(globalThis);
