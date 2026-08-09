(function attachGenericAdapter(root) {
  const SceneMarks = root.SceneMarks || {};
  const Adapters = SceneMarks.Adapters || {};

  const TRACKING_PARAMS = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "msclkid",
    "ref",
    "ref_",
    "tag"
  ]);

  function cleanTitle(documentRef) {
    const title = documentRef.title || "";
    return title
      .replace(/\s+\|\s+.*$/, "")
      .replace(/\s+-\s+Watch.*$/i, "")
      .trim() || null;
  }

  function normalizePath(pathname) {
    const cleaned = pathname
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");

    return cleaned || "/";
  }

  function canonicalizeUrl(url, includeSafeQuery) {
    const canonical = new URL(url.href);
    canonical.hash = "";

    if (!includeSafeQuery) {
      canonical.search = "";
      return canonical.toString();
    }

    for (const key of Array.from(canonical.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
        canonical.searchParams.delete(key);
      }
    }

    return canonical.toString();
  }

  const GenericAdapter = {
    id: "generic",
    matches() {
      return true;
    },
    getVideoKey(url) {
      return `generic:${url.origin}:${normalizePath(url.pathname)}`;
    },
    getCanonicalUrl(url) {
      return canonicalizeUrl(url, false);
    },
    getTitle(documentRef) {
      return cleanTitle(documentRef);
    }
  };

  Adapters.GenericAdapter = GenericAdapter;
  Adapters.Utils = {
    canonicalizeUrl,
    cleanTitle,
    normalizePath
  };

  SceneMarks.Adapters = Adapters;
  root.SceneMarks = SceneMarks;
})(globalThis);
