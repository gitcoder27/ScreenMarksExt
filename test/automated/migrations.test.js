"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { installChromeStorageMock, loadSharedModules } = require("./helpers");

const SceneMarks = loadSharedModules({ withMigrations: true });
const { Migrations, Storage } = SceneMarks;

const KEY_A = "youtube:videoAAAAAAA";
const KEY_B = "netflix:80000001";
const NOW = new Date().toISOString();

function scene(id, startSeconds, extra) {
  return { id, startSeconds, createdAt: "2025-01-01T00:00:00.000Z", ...extra };
}

// A schema-1 library: everything in the one scenemarksState blob.
function legacyBlob() {
  return {
    schemaVersion: 1,
    videos: {
      [KEY_A]: {
        videoKey: KEY_A,
        platform: "youtube",
        title: "Video A",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        canonicalUrl: "https://www.youtube.com/watch?v=videoAAAAAAA",
        rawUrls: ["https://www.youtube.com/watch?v=videoAAAAAAA"],
        scenes: [scene("scene_a1", 10, { note: "x".repeat(1500) })]
      },
      [KEY_B]: {
        videoKey: KEY_B,
        platform: "netflix",
        title: "Video B",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-03T00:00:00.000Z",
        canonicalUrl: "https://www.netflix.com/watch/80000001",
        favorite: true,
        scenes: [scene("scene_b1", 20), scene("scene_b2", 5)]
      }
    },
    settings: { duplicateThresholdSeconds: 7, hotkeys: { quickSave: "Alt+Shift+Q" } },
    activeRangeDraft: { videoKey: KEY_A, startSeconds: 30, createdAt: NOW },
    pendingJump: {
      videoKey: KEY_B,
      sceneId: "scene_b1",
      seconds: 20,
      url: "https://www.netflix.com/watch/80000001",
      createdAt: NOW
    }
  };
}

test("the split moves the schema-1 blob into per-video and per-setting keys", async () => {
  const store = installChromeStorageMock({ scenemarksState: legacyBlob() });

  const result = await Migrations.migrateToSplitStorage();

  assert.deepEqual(result, { ok: true, migratedCount: 2 });
  assert.deepEqual(store.keys(), [
    "activeRangeDraft",
    "pendingJump",
    "schemaVersion",
    "settings",
    `video:${KEY_B}`,
    `video:${KEY_A}`
  ].sort());
  assert.equal(store.raw("schemaVersion"), SceneMarks.Constants.SCHEMA_VERSION);

  // Values are normalized on the way in, caps included.
  const videoA = store.raw(`video:${KEY_A}`);
  assert.equal(videoA.scenes[0].note.length, SceneMarks.Constants.MAX_NOTE_LENGTH);
  assert.deepEqual(store.raw(`video:${KEY_B}`).scenes.map((item) => item.id), ["scene_b2", "scene_b1"]);
  assert.equal(store.raw("settings").duplicateThresholdSeconds, 7);
  assert.equal(store.raw("settings").hotkeys.quickSave, "Alt+Shift+Q");
  assert.equal(store.raw("activeRangeDraft").videoKey, KEY_A);
  assert.equal(store.raw("pendingJump").sceneId, "scene_b1");

  // Readers see the same library the blob held.
  const expected = SceneMarks.Schema.normalizeState(legacyBlob());
  const state = await Storage.getState();
  assert.deepEqual(state.videos, expected.videos);
  assert.deepEqual(state.settings, expected.settings);
});

test("re-running the split writes nothing and reads two small keys", async () => {
  const store = installChromeStorageMock({ scenemarksState: legacyBlob() });
  await Migrations.migrateToSplitStorage();
  const keysAfterFirstRun = store.keys();
  const writesBefore = store.writes;
  const readsBefore = store.reads;

  const again = await Migrations.migrateToSplitStorage();
  await Migrations.migrateToSplitStorage();

  assert.deepEqual(again, { ok: true, migratedCount: 0 });
  assert.equal(store.writes, writesBefore);
  assert.deepEqual(store.keys(), keysAfterFirstRun);
  assert.deepEqual(store.readLog.slice(readsBefore), [
    ["scenemarksState", "schemaVersion"],
    ["scenemarksState", "schemaVersion"]
  ]);
});

test("a fresh install records the schema version once, then stays idle", async () => {
  const store = installChromeStorageMock();

  await Migrations.migrateToSplitStorage();
  assert.deepEqual(store.writeLog, [{ set: ["schemaVersion"], remove: [] }]);

  await Migrations.runAll();
  await Migrations.runAll();
  assert.equal(store.writes, 1);
});

test("data written on the new layout before the split runs wins", async () => {
  // A save and a settings change landed after the update but before the
  // migration, and the draft was already cleared on the new layout.
  const store = installChromeStorageMock({
    scenemarksState: legacyBlob(),
    [`video:${KEY_A}`]: {
      videoKey: KEY_A,
      platform: "youtube",
      title: "Video A, renamed",
      canonicalUrl: "https://www.youtube.com/watch?v=videoAAAAAAA",
      rawUrls: ["https://www.youtube.com/watch?v=videoAAAAAAA&t=1"],
      scenes: [scene("scene_a2", 50)]
    },
    settings: { duplicateThresholdSeconds: 1 },
    activeRangeDraft: null
  });

  await Migrations.migrateToSplitStorage();

  const videoA = store.raw(`video:${KEY_A}`);
  assert.equal(videoA.title, "Video A, renamed");
  assert.deepEqual(videoA.scenes.map((item) => item.id), ["scene_a1", "scene_a2"]);
  assert.deepEqual(videoA.rawUrls, [
    "https://www.youtube.com/watch?v=videoAAAAAAA",
    "https://www.youtube.com/watch?v=videoAAAAAAA&t=1"
  ]);
  assert.equal(store.raw("settings").duplicateThresholdSeconds, 1);
  assert.equal(store.raw("activeRangeDraft"), null);
  // Nothing on the new layout held a pending jump, so the blob's carries over.
  assert.equal(store.raw("pendingJump").sceneId, "scene_b1");
  assert.equal(store.raw("scenemarksState"), undefined);
});

test("a failed split keeps the blob for the next pass", async () => {
  const store = installChromeStorageMock({ scenemarksState: legacyBlob() });
  const realSet = store.local.set;
  store.local.set = (_values, callback) => {
    globalThis.chrome.runtime.lastError = { message: "QUOTA_BYTES quota exceeded" };
    callback();
    globalThis.chrome.runtime.lastError = null;
  };

  await assert.rejects(Migrations.migrateToSplitStorage(), /QUOTA_BYTES/);
  assert.deepEqual(store.keys(), ["scenemarksState"]);

  store.local.set = realSet;
  const retry = await Migrations.migrateToSplitStorage();
  assert.equal(retry.migratedCount, 2);
  assert.equal(store.raw("scenemarksState"), undefined);
});
