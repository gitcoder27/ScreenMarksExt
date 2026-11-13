"use strict";
// The Library page: sort order, favorites filter and card-only updates,
// with library.js loaded into the fake DOM against the real storage layer.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkflow, flush } = require("./workflow-helpers");

function scene(id, startSeconds, createdAt, extra = {}) {
  return { id, startSeconds, createdAt, updatedAt: createdAt, ...extra };
}

function video(key, title, scenes, extra = {}) {
  return {
    videoKey: `generic:${key}`, platform: "generic", title, canonicalUrl: `https://example.com/${key}`,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", scenes, ...extra
  };
}

function seedOf(videos) {
  return Object.fromEntries(videos.map((item) => [`video:${item.videoKey}`, item]));
}

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

async function openLibrary(seed, options = {}) {
  const work = createWorkflow(seed);
  const storageMap = new Map(Object.entries(options.localStorage || {}));
  Object.assign(work.context, {
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame: (fn) => work.context.setTimeout(fn, 16),
    localStorage: options.localStorage === null ? undefined : {
      getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
      setItem: (key, value) => storageMap.set(key, String(value))
    }
  });
  work.context.window = work.context;
  work.load("src/library/library.js");
  await work.document.emit("DOMContentLoaded");
  await flush();
  const titles = () => work.get("libraryList").children
    .filter((node) => node.dataset.videoKey)
    .map((card) => descendants(card).find((node) => node.className === "video-title").textContent);
  return { ...work, storageMap, titles };
}

function loadView() {
  const work = createWorkflow();
  work.load("src/library/library.js");
  return work.context.SceneMarks.LibraryView;
}

const LIBRARY = [
  video("a", "Alpha", [scene("a1", 5, "2026-03-01T00:00:00.000Z")], { createdAt: "2026-03-01T00:00:00.000Z", platform: "youtube" }),
  video("b", "bravo 10", [scene("b1", 5, "2026-01-05T00:00:00.000Z"), scene("b2", 9, "2026-05-01T00:00:00.000Z")],
    { createdAt: "2026-01-05T00:00:00.000Z", platform: "netflix" }),
  video("c", "Bravo 9", [scene("c1", 1, "2026-02-01T00:00:00.000Z"), scene("c2", 2, "2026-02-02T00:00:00.000Z"), scene("c3", 3, "2026-02-03T00:00:00.000Z")],
    { createdAt: "2026-02-01T00:00:00.000Z", platform: "generic" }),
  video("d", "", [], { createdAt: "2026-04-01T00:00:00.000Z", platform: "prime" })
];

test("sort comparators: recently saved, date added, most scenes, title, platform", () => {
  const View = loadView();
  const order = (sortId) => View.sortVideos(LIBRARY, sortId).map((item) => item.videoKey.slice(8));
  // Newest scene createdAt; the empty video falls back to its own createdAt.
  assert.deepEqual(order("recent"), ["b", "d", "a", "c"]);
  assert.deepEqual(order("added"), ["d", "a", "c", "b"]);
  assert.deepEqual(order("scenes"), ["c", "b", "a", "d"]);
  // Natural, case-insensitive titles; untitled last.
  assert.deepEqual(order("title"), ["a", "c", "b", "d"]);
  // By platform name as shown (Netflix, Other sites, Prime Video, YouTube).
  assert.deepEqual(order("platform"), ["b", "c", "d", "a"]);
  assert.deepEqual(order("nonsense"), order("recent"));
  assert.equal(View.lastSavedAt(LIBRARY[1]), "2026-05-01T00:00:00.000Z");
  assert.equal(View.platformLabel("prime"), "Prime Video");
  assert.equal(View.platformLabel("youtube"), "YouTube");
  assert.equal(View.platformLabel("generic"), "Other sites");
  // updatedAt plays no part: bumping it (a star, a merge import) changes nothing.
  const bumped = LIBRARY.map((item) => ({ ...item, updatedAt: "2030-01-01T00:00:00.000Z" }));
  bumped[2] = { ...bumped[2], scenes: bumped[2].scenes.map((item) => ({ ...item, favorite: true, updatedAt: "2030-01-01T00:00:00.000Z" })) };
  assert.deepEqual(View.sortVideos(bumped, "recent").map((item) => item.videoKey), View.sortVideos(LIBRARY, "recent").map((item) => item.videoKey));
});

test("the sort choice is remembered in localStorage, and the page works without it", async () => {
  const page = await openLibrary(seedOf(LIBRARY));
  assert.deepEqual(page.titles(), ["bravo 10", "Untitled video", "Alpha", "Bravo 9"]);
  page.get("sortSelect").value = "title";
  await page.get("sortSelect").emit("change");
  assert.deepEqual(page.titles(), ["Alpha", "Bravo 9", "bravo 10", "Untitled video"]);
  assert.equal(page.storageMap.get("scenemarks.library.sort"), "title");

  const again = await openLibrary(seedOf(LIBRARY), { localStorage: { "scenemarks.library.sort": "scenes" } });
  assert.equal(again.get("sortSelect").value, "scenes");
  assert.deepEqual(again.titles(), ["Bravo 9", "bravo 10", "Alpha", "Untitled video"]);

  const broken = await openLibrary(seedOf(LIBRARY), { localStorage: { "scenemarks.library.sort": "bogus" } });
  assert.equal(broken.get("sortSelect").value, "recent");
  const none = await openLibrary(seedOf(LIBRARY), { localStorage: null });
  assert.deepEqual(none.titles(), ["bravo 10", "Untitled video", "Alpha", "Bravo 9"]);
});

test("starring a video or a scene, and a merge import, leave the order unchanged", async () => {
  const page = await openLibrary(seedOf(LIBRARY));
  const before = page.titles();
  const { Storage } = page.context.SceneMarks;
  await Storage.updateVideo("generic:c", { favorite: true });
  await Storage.updateScene("generic:a", "a1", { favorite: true });
  await page.advance(20);
  assert.deepEqual(page.titles(), before);
  await Storage.importState({ videos: seedOf(LIBRARY.slice(2, 3).map((item) => ({ ...item, title: "Bravo 9" }))) }, { merge: true });
  await page.advance(20);
  assert.deepEqual(page.titles(), before);
});

test("wording: singular counts, platform names and an empty-library message", async () => {
  const page = await openLibrary(seedOf([LIBRARY[0]]));
  const texts = descendants(page.get("libraryList")).map((node) => node.textContent);
  assert.ok(texts.includes("1 scene"));
  assert.ok(texts.includes("YouTube"));
  assert.match(page.get("summaryBox").textContent, /^1 video, 1 scene$/);
  const empty = await openLibrary({});
  assert.match(descendants(empty.get("libraryList")).map((node) => node.textContent).join(" "), /Your library is empty\. On a video page, press Alt\+Shift\+S/);
});
