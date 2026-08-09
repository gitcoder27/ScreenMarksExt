(function attachPrimeVideoAdapter(root) {
  const SceneMarks = root.SceneMarks || {};
  const Adapters = SceneMarks.Adapters || {};
  const { canonicalizeUrl, cleanTitle, normalizePath } = Adapters.Utils;

  const PRIME_HOST_PATTERNS = [
    /(^|\.)primevideo\.com$/i,
    /(^|\.)amazon\.com$/i,
    /(^|\.)amazon\.in$/i
  ];

  function isPrimePath(pathname) {
    return /\/(detail|gp\/video|video|Prime-Video)\b/i.test(pathname);
  }

  function getPrimeId(url) {
    const patterns = [
      /\/detail\/[^/]+\/([A-Z0-9]{8,})/i,
      /\/detail\/([A-Z0-9]{8,})/i,
      /\/gp\/video\/detail\/([A-Z0-9_.-]{8,})/i,
      /\/dp\/([A-Z0-9]{8,})/i
    ];

    for (const pattern of patterns) {
      const match = url.pathname.match(pattern);
      if (match) {
        return match[1];
      }
    }

    const segments = url.pathname.split("/").filter(Boolean);
    return segments.find((segment) => /^[A-Z0-9][A-Z0-9_.-]{7,}$/i.test(segment)) || null;
  }

  const PrimeVideoAdapter = {
    id: "prime",
    matches(url) {
      return PRIME_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname)) && isPrimePath(url.pathname);
    },
    getVideoKey(url) {
      const id = getPrimeId(url);
      return id ? `prime:${id}` : `prime:${url.origin}:${normalizePath(url.pathname)}`;
    },
    getCanonicalUrl(url) {
      const id = getPrimeId(url);
      return id ? `${url.origin}${normalizePath(url.pathname.split(id)[0])}/${id}` : canonicalizeUrl(url, false);
    },
    getTitle(documentRef) {
      const title = cleanTitle(documentRef);
      return title ? title.replace(/\s+-\s+Prime Video$/i, "").trim() : null;
    }
  };

  Adapters.PrimeVideoAdapter = PrimeVideoAdapter;
  SceneMarks.Adapters = Adapters;
  root.SceneMarks = SceneMarks;
})(globalThis);
