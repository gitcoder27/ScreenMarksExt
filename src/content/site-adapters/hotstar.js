(function attachHotstarAdapter(root) {
  const SceneMarks = root.SceneMarks || {};
  const Adapters = SceneMarks.Adapters || {};
  const { canonicalizeUrl, cleanTitle, normalizePath } = Adapters.Utils;

  function isHotstarHost(hostname) {
    return /(^|\.)hotstar\.com$/i.test(hostname) || /(^|\.)jiohotstar\.com$/i.test(hostname);
  }

  function getHotstarId(url) {
    const segments = url.pathname.split("/").filter(Boolean);
    const numericId = [...segments].reverse().find((segment) => /^\d{5,}$/.test(segment));
    if (numericId) {
      return numericId;
    }

    const contentIndex = segments.findIndex((segment) => /^(movies|shows|sports|clips|watch)$/i.test(segment));
    if (contentIndex >= 0) {
      return segments.slice(contentIndex).join(":") || null;
    }

    return normalizePath(url.pathname);
  }

  const HotstarAdapter = {
    id: "hotstar",
    matches(url) {
      return isHotstarHost(url.hostname);
    },
    getVideoKey(url) {
      return `hotstar:${getHotstarId(url)}`;
    },
    getCanonicalUrl(url) {
      return canonicalizeUrl(url, false);
    },
    getTitle(documentRef) {
      const title = cleanTitle(documentRef);
      return title
        ? title.replace(/\s+-\s+(JioHotstar|Disney\+ Hotstar|Hotstar)$/i, "").trim()
        : null;
    }
  };

  Adapters.HotstarAdapter = HotstarAdapter;
  SceneMarks.Adapters = Adapters;
  root.SceneMarks = SceneMarks;
})(globalThis);
