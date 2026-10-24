"use strict";

const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");

const { installChromeStorageMock, loadSharedModules, videoEntries } = require("./helpers");

const SceneMarks = loadSharedModules();
const Storage = SceneMarks.Storage;

const IDENTITY = {
  videoKey: "youtube:abcdEFGH123",
  platform: "youtube",
  title: "Test video",
  canonicalUrl: "https://www.youtube.com/watch?v=abcdEFGH123",
  rawUrl: "https://www.youtube.com/watch?v=abcdEFGH123&t=5s",
  origin: "https://www.youtube.com"
};

const OTHER_IDENTITY = {
  ...IDENTITY,
  videoKey: "youtube:otherVideo01",
  canonicalUrl: "https://www.youtube.com/watch?v=otherVideo01"
};

let store;

beforeEach(() => {
  store = installChromeStorageMock();
});

test("saveScene creates the video and persists scene fields", async () => {
  const result = await Storage.saveScene(IDENTITY, {
    type: "timestamp",
    startSeconds: 42,
    note: "great bit",
    tags: ["funny"],
    favorite: true
  });

  assert.equal(result.ok, true);
  const state = store.readState();
  const video = state.videos[IDENTITY.videoKey];
  assert.equal(video.platform, "youtube");
  assert.equal(video.title, "Test video");
  assert.equal(video.scenes.length, 1);
  assert.equal(video.scenes[0].startSeconds, 42);
  assert.deepEqual(video.scenes[0].tags, ["funny"]);
  assert.equal(video.scenes[0].favorite, true);
});

test("saveScene flags near-duplicates and keeps the original", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const result = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 12 });

  assert.equal(result.ok, false);
  assert.equal(result.duplicate, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey].scenes.length, 1);
});

test("saveScene allows near-duplicates when explicitly requested", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const result = await Storage.saveScene(
    IDENTITY,
    { type: "timestamp", startSeconds: 12 },
    { allowDuplicate: true }
  );

  assert.equal(result.ok, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey].scenes.length, 2);
});

test("saveScene keeps scenes sorted by start time", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 30 });
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 }, { allowDuplicate: true });

  const scenes = store.readState().videos[IDENTITY.videoKey].scenes;
  assert.deepEqual(scenes.map((scene) => scene.startSeconds), [10, 30]);
});

test("updateScene toggles favorite and rewrites note and tags", async () => {
  const saved = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const result = await Storage.updateScene(IDENTITY.videoKey, saved.scene.id, {
    favorite: true,
    note: "rewritten",
    tags: "one, two"
  });

  assert.equal(result.ok, true);
  const scene = store.readState().videos[IDENTITY.videoKey].scenes[0];
  assert.equal(scene.favorite, true);
  assert.equal(scene.note, "rewritten");
  assert.deepEqual(scene.tags, ["one", "two"]);
});

test("updateScene fails for unknown scenes", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const result = await Storage.updateScene(IDENTITY.videoKey, "scene_missing", { favorite: true });
  assert.equal(result.ok, false);
});

test("updateVideo toggles the video-level favorite flag", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });

  const on = await Storage.updateVideo(IDENTITY.videoKey, { favorite: true });
  assert.equal(on.ok, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey].favorite, true);

  const off = await Storage.updateVideo(IDENTITY.videoKey, { favorite: false });
  assert.equal(off.ok, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey].favorite, false);
});

test("updateVideo fails for unknown videos", async () => {
  const result = await Storage.updateVideo("netflix:missing", { favorite: true });
  assert.equal(result.ok, false);
});

test("deleteScene removes the scene and the video when the last scene goes", async () => {
  const saved = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });

  const result = await Storage.deleteScene(IDENTITY.videoKey, saved.scene.id);
  assert.equal(result.ok, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey], undefined);

  const missing = await Storage.deleteScene(IDENTITY.videoKey, saved.scene.id);
  assert.equal(missing.ok, false);
});

test("deleteVideo removes the video", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const result = await Storage.deleteVideo(IDENTITY.videoKey);
  assert.equal(result.ok, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey], undefined);
});

test("startRange creates a draft without an empty video entry", async () => {
  const result = await Storage.startRange(IDENTITY, 100);

  assert.equal(result.ok, true);
  const state = store.readState();
  assert.equal(state.activeRangeDraft.videoKey, IDENTITY.videoKey);
  assert.equal(state.activeRangeDraft.startSeconds, 100);
  // The video is created when the range is saved, so an abandoned range
  // leaves nothing behind.
  assert.equal(state.videos[IDENTITY.videoKey], undefined);

  await Storage.endRange(IDENTITY, 140);
  assert.equal(store.readState().videos[IDENTITY.videoKey].scenes.length, 1);
});

test("mutations that change nothing do not write", async () => {
  const saved = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  await Storage.startRange(OTHER_IDENTITY, 50);
  const writesBefore = store.writes;

  // Every write reaches every open tab, so a no-op must not rewrite state.
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 11 });
  await Storage.startRange(IDENTITY, 20);
  await Storage.deleteScene(IDENTITY.videoKey, "scene_missing");
  await Storage.deleteScene("netflix:missing", saved.scene.id);
  await Storage.updateScene(IDENTITY.videoKey, "scene_missing", { favorite: true });
  await Storage.updateVideo("netflix:missing", { favorite: true });
  await Storage.deleteVideo("netflix:missing");
  await Storage.clearPendingJump();
  await Storage.consumePendingJump(IDENTITY.videoKey);
  const settings = await Storage.updateSettings({ duplicateThresholdSeconds: 3 });

  assert.equal(store.writes, writesBefore);
  assert.equal(settings.duplicateThresholdSeconds, 3);
  const state = store.readState();
  assert.equal(state.videos[IDENTITY.videoKey].scenes.length, 1);
  assert.equal(state.activeRangeDraft.videoKey, OTHER_IDENTITY.videoKey);
});

test("startRange conflicts across videos unless overwrite is set", async () => {
  await Storage.startRange(IDENTITY, 100);

  const conflict = await Storage.startRange(OTHER_IDENTITY, 50);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(store.readState().activeRangeDraft.videoKey, IDENTITY.videoKey);

  const overwrite = await Storage.startRange(OTHER_IDENTITY, 50, { overwrite: true });
  assert.equal(overwrite.ok, true);
  assert.equal(store.readState().activeRangeDraft.videoKey, OTHER_IDENTITY.videoKey);
});

test("endRange orders the endpoints, saves the range scene, and clears the draft", async () => {
  await Storage.startRange(IDENTITY, 100);
  const result = await Storage.endRange(IDENTITY, 40, { note: "intro", favorite: true });

  assert.equal(result.ok, true);
  const state = store.readState();
  assert.equal(state.activeRangeDraft, null);
  const scene = state.videos[IDENTITY.videoKey].scenes[0];
  assert.equal(scene.type, "range");
  assert.equal(scene.startSeconds, 40);
  assert.equal(scene.endSeconds, 100);
  assert.equal(scene.note, "intro");
  assert.equal(scene.favorite, true);
});

test("endRange fails without an active draft for the video", async () => {
  const result = await Storage.endRange(IDENTITY, 40);
  assert.equal(result.ok, false);
});

test("endRange saves the range and clears the draft in a single write", async () => {
  await Storage.startRange(IDENTITY, 100);
  const writesBefore = store.writes;

  const result = await Storage.endRange(IDENTITY, 140);

  assert.equal(result.ok, true);
  assert.equal(store.writes - writesBefore, 1);
  const state = store.readState();
  assert.equal(state.activeRangeDraft, null);
  assert.equal(state.videos[IDENTITY.videoKey].scenes.length, 1);
});

test("endRange does not write when no draft matches the video", async () => {
  await Storage.startRange(OTHER_IDENTITY, 100);
  const writesBefore = store.writes;

  const result = await Storage.endRange(IDENTITY, 140);

  assert.equal(result.ok, false);
  assert.equal(store.writes, writesBefore);
  assert.equal(store.readState().activeRangeDraft.videoKey, OTHER_IDENTITY.videoKey);
});

test("endRange keeps the draft when a near-duplicate range blocks the save", async () => {
  await Storage.startRange(IDENTITY, 100);
  await Storage.endRange(IDENTITY, 140);
  await Storage.startRange(IDENTITY, 101);

  const result = await Storage.endRange(IDENTITY, 141);

  assert.equal(result.ok, false);
  assert.equal(result.duplicate, true);
  const state = store.readState();
  assert.equal(state.videos[IDENTITY.videoKey].scenes.length, 1);
  assert.equal(state.activeRangeDraft.startSeconds, 101);
});

test("pending jumps are consumed once and only by the matching video", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const stateBefore = store.readState();
  const sceneId = stateBefore.videos[IDENTITY.videoKey].scenes[0].id;

  const set = await Storage.setPendingJump({
    videoKey: IDENTITY.videoKey,
    sceneId,
    seconds: 10,
    url: IDENTITY.canonicalUrl
  });
  assert.equal(set.ok, true);

  const wrongVideo = await Storage.consumePendingJump(OTHER_IDENTITY.videoKey);
  assert.equal(wrongVideo.ok, false);
  assert.equal(store.readState().pendingJump.sceneId, sceneId);

  const consumed = await Storage.consumePendingJump(IDENTITY.videoKey);
  assert.equal(consumed.ok, true);
  assert.equal(consumed.pendingJump.seconds, 10);
  assert.equal(store.readState().pendingJump, null);
});

test("importState merges favorites, skips known scenes, and keeps new ones", async () => {
  const saved = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10, note: "original" });

  const result = await Storage.importState({
    videos: {
      [IDENTITY.videoKey]: {
        videoKey: IDENTITY.videoKey,
        platform: "youtube",
        title: "Imported title",
        favorite: true,
        scenes: [
          { id: saved.scene.id, startSeconds: 10.2, note: "same scene, same id" },
          { id: "scene_brand_new", startSeconds: 500, note: "brand new" }
        ]
      }
    }
  });

  // The result travels back over RPC, so it is a count, not the library.
  assert.deepEqual(result, { ok: true, videoCount: 1 });
  const video = store.readState().videos[IDENTITY.videoKey];
  assert.equal(video.favorite, true);
  assert.equal(video.title, "Imported title");
  assert.deepEqual(video.scenes.map((scene) => scene.id), [saved.scene.id, "scene_brand_new"]);
});

test("importState with merge disabled replaces the library", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  await Storage.saveScene(OTHER_IDENTITY, { type: "timestamp", startSeconds: 20 });

  await Storage.importState({
    videos: {
      [OTHER_IDENTITY.videoKey]: {
        videoKey: OTHER_IDENTITY.videoKey,
        platform: "youtube",
        scenes: [{ startSeconds: 30 }]
      }
    }
  }, { merge: false });

  const videos = store.readState().videos;
  assert.equal(videos[IDENTITY.videoKey], undefined);
  assert.deepEqual(videos[OTHER_IDENTITY.videoKey].scenes.map((scene) => scene.startSeconds), [30]);
});

test("updateSettings persists merged settings", async () => {
  const settings = await Storage.updateSettings({ duplicateThresholdSeconds: 0 });

  assert.equal(settings.duplicateThresholdSeconds, 0);
  assert.equal(store.readState().settings.duplicateThresholdSeconds, 0);
  assert.equal(settings.hotkeys.quickSave, SceneMarks.Constants.DEFAULT_SETTINGS.hotkeys.quickSave);
});

test("overlapping updateState calls serialize so both writes survive", async () => {
  await Promise.all([
    Storage.updateState(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.settings.duplicateThresholdSeconds = 5;
      return state;
    }),
    Storage.updateState((state) => {
      state.settings.quickSaveRequiresNote = true;
      return state;
    })
  ]);

  const settings = store.readState().settings;
  assert.equal(settings.duplicateThresholdSeconds, 5);
  assert.equal(settings.quickSaveRequiresNote, true);
});

test("a mutator returning SKIP_WRITE resolves without writing", async () => {
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const writesBefore = store.writes;

  const state = await Storage.updateState(() => Storage.SKIP_WRITE);

  assert.equal(store.writes, writesBefore);
  assert.equal(state.videos[IDENTITY.videoKey].scenes.length, 1);
});

test("toggleFloatingButton flips the persisted flag and returns the new settings", async () => {
  assert.equal(SceneMarks.Constants.DEFAULT_SETTINGS.enableFloatingButton, true);

  const first = await Storage.toggleFloatingButton();
  assert.equal(first.ok, true);
  assert.equal(first.settings.enableFloatingButton, false);
  assert.equal(store.readState().settings.enableFloatingButton, false);

  const second = await Storage.toggleFloatingButton();
  assert.equal(second.settings.enableFloatingButton, true);
  assert.equal(store.readState().settings.enableFloatingButton, true);
});

test("quick concurrent double-toggles each flip the flag exactly once", async () => {
  await Promise.all([Storage.toggleFloatingButton(), Storage.toggleFloatingButton()]);

  assert.equal(store.readState().settings.enableFloatingButton, true);
});

test("a mutator that throws rejects its own call without blocking the next write", async () => {
  await assert.rejects(
    Storage.updateState(() => {
      throw new Error("mutator exploded");
    }),
    /mutator exploded/
  );

  const result = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  assert.equal(result.ok, true);
  assert.equal(store.readState().videos[IDENTITY.videoKey].scenes.length, 1);
});

test("saves keep the five newest raw URLs, newest last", async () => {
  const urlFor = (session) => `https://www.youtube.com/watch?v=abcdEFGH123&pp=session${session}`;
  for (let session = 0; session < 7; session += 1) {
    await Storage.saveScene(
      { ...IDENTITY, rawUrl: urlFor(session) },
      { type: "timestamp", startSeconds: session * 100 }
    );
  }

  // A save from an older URL moves it back to the newest position.
  await Storage.saveScene({ ...IDENTITY, rawUrl: urlFor(3) }, { type: "timestamp", startSeconds: 900 });

  assert.deepEqual(
    store.readState().videos[IDENTITY.videoKey].rawUrls,
    [urlFor(2), urlFor(4), urlFor(5), urlFor(6), urlFor(3)]
  );
});

// A library of other videos that a one-video change must not read or write.
function seedLibrary(count) {
  const videos = {};
  for (let index = 0; index < count; index += 1) {
    const videoKey = `netflix:${8000000 + index}`;
    videos[videoKey] = {
      videoKey,
      platform: "netflix",
      canonicalUrl: `https://www.netflix.com/watch/${8000000 + index}`,
      scenes: [{ id: `scene_${index}`, startSeconds: index, createdAt: "2025-01-01T00:00:00.000Z" }]
    };
  }

  return installChromeStorageMock(videoEntries(videos));
}

const VIDEO_STORAGE_KEY = `video:${IDENTITY.videoKey}`;
const SHARED_STORAGE_KEYS = ["activeRangeDraft", "pendingJump", "settings"];

test("a scene save reads and writes only that video's key", async () => {
  store = seedLibrary(50);
  const before = { reads: store.reads, writes: store.writes };

  const first = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const second = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 99, favorite: true });

  assert.equal(first.ok && second.ok, true);
  assert.deepEqual(store.readLog.slice(before.reads), [
    [...SHARED_STORAGE_KEYS, VIDEO_STORAGE_KEY].sort(),
    [...SHARED_STORAGE_KEYS, VIDEO_STORAGE_KEY].sort()
  ]);
  assert.deepEqual(store.writeLog.slice(before.writes), [
    { set: [VIDEO_STORAGE_KEY], remove: [] },
    { set: [VIDEO_STORAGE_KEY], remove: [] }
  ]);
  assert.equal(Object.keys(store.readState().videos).length, 51);
});

test("a range writes its draft, then the video and the cleared draft together", async () => {
  store = seedLibrary(5);
  const writesBefore = store.writes;

  await Storage.startRange(IDENTITY, 100);
  await Storage.endRange(IDENTITY, 140);

  assert.deepEqual(store.writeLog.slice(writesBefore), [
    { set: ["activeRangeDraft"], remove: [] },
    { set: ["activeRangeDraft", VIDEO_STORAGE_KEY], remove: [] }
  ]);
  assert.equal(store.raw("activeRangeDraft"), null);
});

test("settings, favorites and jumps write only the key they change", async () => {
  store = seedLibrary(5);
  const saved = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const writesBefore = store.writes;

  await Storage.updateSettings({ duplicateThresholdSeconds: 9 });
  await Storage.toggleFloatingButton();
  await Storage.updateScene(IDENTITY.videoKey, saved.scene.id, { favorite: true });
  await Storage.updateVideo(IDENTITY.videoKey, { favorite: true });
  await Storage.setPendingJump({
    videoKey: IDENTITY.videoKey,
    sceneId: saved.scene.id,
    seconds: 10,
    url: IDENTITY.canonicalUrl
  });
  await Storage.consumePendingJump(IDENTITY.videoKey);

  assert.deepEqual(store.writeLog.slice(writesBefore), [
    { set: ["settings"], remove: [] },
    { set: ["settings"], remove: [] },
    { set: [VIDEO_STORAGE_KEY], remove: [] },
    { set: [VIDEO_STORAGE_KEY], remove: [] },
    { set: ["pendingJump"], remove: [] },
    { set: ["pendingJump"], remove: [] }
  ]);
});

test("deleting a video's last scene removes only its key", async () => {
  store = seedLibrary(5);
  const saved = await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });
  const writesBefore = store.writes;

  await Storage.deleteScene(IDENTITY.videoKey, saved.scene.id);

  assert.deepEqual(store.writeLog.slice(writesBefore), [{ set: [], remove: [VIDEO_STORAGE_KEY] }]);
  assert.equal(Object.keys(store.readState().videos).length, 5);
});

test("scoped reads load only the named videos", async () => {
  store = seedLibrary(5);
  await Storage.saveScene(IDENTITY, { type: "timestamp", startSeconds: 10 });

  const scoped = await Storage.getState({ videoKeys: [IDENTITY.videoKey, "youtube:notSaved"] });
  const sharedOnly = await Storage.getState({ videoKeys: [] });
  const everything = await Storage.getState();

  assert.deepEqual(Object.keys(scoped.videos), [IDENTITY.videoKey]);
  assert.deepEqual(sharedOnly.videos, {});
  assert.equal(sharedOnly.settings.duplicateThresholdSeconds, 3);
  assert.equal(Object.keys(everything.videos).length, 6);
  assert.deepEqual(await Storage.getScenesForVideo("youtube:notSaved"), []);
});

test("clearAllData removes every key and records the schema version", async () => {
  store = seedLibrary(5);
  await Storage.updateSettings({ duplicateThresholdSeconds: 9 });

  await Storage.clearAllData();

  assert.deepEqual(store.keys(), ["schemaVersion"]);
  const state = await Storage.getState();
  assert.deepEqual(state.videos, {});
  assert.equal(state.settings.duplicateThresholdSeconds, 3);
});

test("setSiteEnabled switches a site off once and back on, writing only settings", async () => {
  const off = await Storage.setSiteEnabled("youtube.com", false);
  assert.equal(off.ok, true);
  assert.deepEqual(off.settings.disabledSites, ["youtube.com"]);
  const writesAfterOff = store.writes;
  assert.deepEqual(store.writeLog[writesAfterOff - 1], { set: ["settings"], remove: [] });

  // Already covered (a subdomain of an entry): nothing to write.
  const again = await Storage.setSiteEnabled("music.youtube.com", false);
  assert.equal(again.ok, true);
  assert.equal(store.writes, writesAfterOff);

  // Turning a subdomain back on lifts the entry that covers it.
  const on = await Storage.setSiteEnabled("m.youtube.com", true);
  assert.deepEqual(on.settings.disabledSites, []);
  assert.deepEqual(store.raw("settings").disabledSites, []);

  const writesAfterOn = store.writes;
  await Storage.setSiteEnabled("netflix.com", true);
  assert.equal(store.writes, writesAfterOn);
});

test("setSiteEnabled rejects pages without a site name and a full list", async () => {
  assert.equal((await Storage.setSiteEnabled("", false)).ok, false);

  const { MAX_DISABLED_SITES } = SceneMarks.Constants;
  const sites = Array.from({ length: MAX_DISABLED_SITES }, (_, index) => `site${index}.com`);
  await Storage.updateSettings({ disabledSites: sites });
  const writesBefore = store.writes;

  const result = await Storage.setSiteEnabled("netflix.com", false);
  assert.equal(result.ok, false);
  assert.match(result.error, /at most/);
  assert.equal(store.writes, writesBefore);
});

test("concurrent site switches from two tabs both persist", async () => {
  await Promise.all([
    Storage.setSiteEnabled("youtube.com", false),
    Storage.setSiteEnabled("netflix.com", false)
  ]);

  assert.deepEqual(store.raw("settings").disabledSites.sort(), ["netflix.com", "youtube.com"]);
});
