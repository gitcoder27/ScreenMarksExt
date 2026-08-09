(function attachAdapterIndex(root) {
  const SceneMarks = root.SceneMarks || {};
  const Adapters = SceneMarks.Adapters || {};
  const adapterList = [
    Adapters.NetflixAdapter,
    Adapters.PrimeVideoAdapter,
    Adapters.HotstarAdapter,
    Adapters.GenericAdapter
  ].filter(Boolean);

  function getAdapter(url) {
    return adapterList.find((adapter) => adapter.matches(url)) || Adapters.GenericAdapter;
  }

  function getVideoIdentity(documentRef, locationRef) {
    const url = new URL(locationRef.href);
    const adapter = getAdapter(url);
    const fallbackAdapter = Adapters.GenericAdapter;
    const videoKey = adapter.getVideoKey(url, documentRef) || fallbackAdapter.getVideoKey(url, documentRef);
    const canonicalUrl = adapter.getCanonicalUrl(url, documentRef) || fallbackAdapter.getCanonicalUrl(url, documentRef);
    const title = adapter.getTitle(documentRef) || fallbackAdapter.getTitle(documentRef);

    return {
      platform: adapter.id || "generic",
      videoKey,
      canonicalUrl,
      title,
      origin: url.origin,
      rawUrl: url.href
    };
  }

  Adapters.getAdapter = getAdapter;
  Adapters.getVideoIdentity = getVideoIdentity;
  Adapters.list = adapterList;
  SceneMarks.Adapters = Adapters;
  root.SceneMarks = SceneMarks;
})(globalThis);
