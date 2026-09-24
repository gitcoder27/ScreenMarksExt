"use strict";

const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");

const { installChromeStorageMock, loadSharedModules } = require("./helpers");

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

test("startRange creates a draft and the video entry", async () => {
  const result = await Storage.startRange(IDENTITY, 100);

  assert.equal(result.ok, true);
  const state = store.readState();
  assert.equal(state.activeRangeDraft.videoKey, IDENTITY.videoKey);
  assert.equal(state.activeRangeDraft.startSeconds, 100);
  assert.ok(state.videos[IDENTITY.videoKey]);
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

  const merged = await Storage.importState({
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

  const video = merged.videos[IDENTITY.videoKey];
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
