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

const FAVORITES = [
  video("plain", "Plain video", [scene("p1", 10, "2026-03-01T00:00:00.000Z"), scene("p2", 20, "2026-03-02T00:00:00.000Z", { favorite: true }),
    scene("p3", 30, "2026-03-03T00:00:00.000Z"), scene("p4", 40, "2026-03-04T00:00:00.000Z", { favorite: true, note: "kitchen" })]),
  video("starred", "Starred video", [scene("s1", 5, "2026-02-01T00:00:00.000Z"), scene("s2", 6, "2026-02-02T00:00:00.000Z")], { favorite: true }),
  video("both", "Starred with a moment", [scene("b1", 7, "2026-01-01T00:00:00.000Z", { favorite: true }), scene("b2", 8, "2026-01-02T00:00:00.000Z")], { favorite: true }),
  video("none", "Nothing starred", [scene("n1", 9, "2026-01-03T00:00:00.000Z")])
];

test("favorites filter: All, Favorite videos, Favorite moments", () => {
  const View = loadView();
  const shown = (filters) => Array.from(View.filterVideos(FAVORITES, filters))
    .map((item) => `${item.videoKey.slice(8)}:${item.scenes.map((entry) => entry.id).join(",")}`);
  assert.deepEqual(shown({ favorites: "all" }), ["plain:p1,p2,p3,p4", "starred:s1,s2", "both:b1,b2", "none:n1"]);
  // Starred videos with every scene; a starred moment in an unstarred video does not count.
  assert.deepEqual(shown({ favorites: "videos" }), ["starred:s1,s2", "both:b1,b2"]);
  // Exactly the starred scenes, in any video; a starred video without one is gone.
  assert.deepEqual(shown({ favorites: "moments" }), ["plain:p2,p4", "both:b1"]);
  // Combined with search: a note hit narrows, a title hit keeps the favorites rule.
  assert.deepEqual(shown({ favorites: "moments", query: "KITCHEN" }), ["plain:p4"]);
  assert.deepEqual(shown({ favorites: "moments", query: "plain" }), ["plain:p2,p4"]);
  assert.deepEqual(shown({ favorites: "videos", query: "nothing" }), []);
  assert.deepEqual(shown({ favorites: "all", query: "0:40" }), ["plain:p4"]);
  assert.deepEqual(shown({ favorites: "bogus", platform: "netflix" }), []);
});

test("rows show time, saved date, star, Jump and a keyboard menu with Edit and Delete", async () => {
  const page = await openLibrary(seedOf(FAVORITES));
  page.get("favoritesFilter").value = "moments";
  await page.get("favoritesFilter").emit("change");
  const list = page.get("libraryList");
  const rows = descendants(list).filter((node) => /^scene-row/.test(node.className));
  // Favorite moments start expanded: exactly the two starred moments of the unstarred video, then the other.
  assert.equal(rows.length, 3);
  const buttons = descendants(rows[0]).filter((node) => node.tagName === "BUTTON");
  assert.deepEqual(buttons.map((node) => node.textContent), ["★", "Jump", "⋯"]);
  assert.equal(descendants(rows[0]).find((node) => node.className === "scene-time").textContent, "00:20");
  assert.match(descendants(rows[0]).find((node) => node.className === "scene-saved").textContent, /2026/);
  assert.equal(descendants(rows[0]).some((node) => node.className === "scene-note"), false);
  assert.equal(descendants(rows[1]).find((node) => node.className === "scene-note").textContent, "kitchen");
  assert.equal(descendants(list).some((node) => ["Open", "Copy Text", "Edit", "Delete"].includes(node.textContent)
    && node.parentNode && node.parentNode.className === "scene-actions"), false);

  const menu = page.get("rowMenu");
  const more = buttons[2];
  menu.hidden = true;
  await more.emit("click");
  assert.equal(menu.hidden, false);
  assert.equal(more.attributes["aria-expanded"], "true");
  let focused = null;
  page.get("rowMenuEdit").focus = () => { focused = "edit"; };
  page.get("rowMenuDelete").focus = () => { focused = "delete"; };
  more.focus = () => { focused = "more"; };
  await menu.emit("keydown", { key: "ArrowDown", target: page.get("rowMenuEdit") });
  assert.equal(focused, "delete");
  await menu.emit("keydown", { key: "Escape", target: page.get("rowMenuDelete") });
  assert.equal(menu.hidden, true);
  assert.equal(more.attributes["aria-expanded"], "false");
  assert.equal(focused, "more");

  // Delete from the menu keeps the confirmation that names the time and the video.
  await more.emit("click");
  const pending = page.get("rowMenuDelete").emit("click");
  await flush();
  assert.equal(page.get("confirmDialog").open, true);
  assert.match(page.get("confirmDialogDescription").textContent, /^00:20 will be removed from "Plain video"/);
  await page.get("confirmDeleteButton").emit("click");
  await pending;
  await flush();
  assert.equal(page.store.raw("video:generic:plain").scenes.some((item) => item.id === "p2"), false);
  assert.equal(page.get("statusLine").textContent, 'Deleted 00:20 from "Plain video".');
});

test("import messages are plain words, and a broken file names itself", async () => {
  const page = await openLibrary(seedOf(FAVORITES));
  const input = page.get("importInput");
  input.files = [{ name: "notes.txt", text: async () => "not json" }];
  await input.emit("change");
  assert.equal(page.get("statusLine").textContent, 'Nothing was imported: "notes.txt" is not a SceneMarks export (it could not be read as JSON).');
  input.files = [{ name: "other.json", text: async () => "{\"hello\":1}" }];
  await input.emit("change");
  assert.match(page.get("statusLine").textContent, /^Nothing was imported: "other.json" has no saved videos/);
  input.files = [{ name: "backup.json", text: async () => JSON.stringify({ videos: seedOf(FAVORITES.slice(3)) }) }];
  await input.emit("change");
  assert.equal(page.get("statusLine").textContent, "Imported 1 video. New timestamps were added; your existing ones and the library order are unchanged."
    + " 1 timestamp was already saved, so it was combined with the saved one (tags joined, stars kept).");
});
