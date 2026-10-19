"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { loadSharedModules } = require("./helpers");

const SceneMarks = loadSharedModules();
const Schema = SceneMarks.Schema;
const { MAX_NOTE_LENGTH, MAX_TAGS } = SceneMarks.Constants;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

test("normalizeScene rejects invalid start seconds", () => {
  assert.equal(Schema.normalizeScene(null), null);
  assert.equal(Schema.normalizeScene({ startSeconds: -5 }), null);
  assert.equal(Schema.normalizeScene({ startSeconds: Number.NaN }), null);
  assert.equal(Schema.normalizeScene({}), null);
});

test("normalizeScene coerces numeric strings and caps notes and tags", () => {
  const scene = Schema.normalizeScene({
    startSeconds: "90",
    endSeconds: null,
    note: "n".repeat(MAX_NOTE_LENGTH + 10),
    tags: ["Keep", "keep ", "  ", ...Array.from({ length: MAX_TAGS + 3 }, (_, i) => `tag${i}`)]
  });

  assert.equal(scene.startSeconds, 90);
  assert.equal(scene.type, "timestamp");
  assert.equal(scene.note.length, MAX_NOTE_LENGTH);
  // Case-insensitive duplicates removed, empty tags dropped, list capped.
  assert.equal(scene.tags[0], "Keep");
  assert.equal(scene.tags.length, MAX_TAGS);
});

test("normalizeScene keeps valid ranges and drops invalid end seconds", () => {
  const range = Schema.normalizeScene({ startSeconds: 10, endSeconds: 20 });
  assert.equal(range.type, "range");
  assert.equal(range.endSeconds, 20);

  const broken = Schema.normalizeScene({ startSeconds: 10, endSeconds: -1 });
  assert.equal(broken.type, "timestamp");
  assert.equal(broken.endSeconds, null);
});

test("normalizeScene only accepts favorite as strict true", () => {
  assert.equal(Schema.normalizeScene({ startSeconds: 1, favorite: true }).favorite, true);
  assert.equal(Schema.normalizeScene({ startSeconds: 1, favorite: "yes" }).favorite, false);
  assert.equal(Schema.normalizeScene({ startSeconds: 1 }).favorite, false);
});

test("normalizeVideo falls back to unknown platform, dedupes urls, and defaults favorite", () => {
  const video = Schema.normalizeVideo({
    videoKey: "netflix:12345",
    platform: "not-a-platform",
    rawUrls: ["https://a.example/u", "https://a.example/u"],
    scenes: [{ startSeconds: 5 }, { startSeconds: "bad" }]
  });

  assert.equal(video.platform, "unknown");
  assert.deepEqual(video.rawUrls, ["https://a.example/u"]);
  assert.equal(video.favorite, false);
  assert.equal(video.scenes.length, 1);
});

test("normalizeVideo keeps only the newest raw URLs", () => {
  const rawUrls = Array.from({ length: 8 }, (_, index) => `https://a.example/watch?session=${index}`);
  const video = Schema.normalizeVideo({ videoKey: "netflix:12345", rawUrls });

  assert.deepEqual(video.rawUrls, rawUrls.slice(-5));
});

test("normalizeVideo drops URLs that are not http(s) or file", () => {
  const video = Schema.normalizeVideo({
    videoKey: "generic:x",
    canonicalUrl: "javascript:alert(1)",
    rawUrls: [
      "data:text/html,hi",
      "chrome://settings",
      "not a url",
      "https://a.example/watch",
      "file:///Users/me/clip.mp4"
    ]
  });

  assert.equal(video.canonicalUrl, "");
  assert.deepEqual(video.rawUrls, ["https://a.example/watch", "file:///Users/me/clip.mp4"]);
});

test("normalizePendingJump rejects a non-web URL", () => {
  const jump = Schema.normalizePendingJump({
    videoKey: "k",
    sceneId: "s",
    seconds: 5,
    url: "javascript:alert(1)",
    createdAt: new Date().toISOString()
  });

  assert.equal(jump, null);
});

test("normalizeVideo preserves a favorite flag", () => {
  const video = Schema.normalizeVideo({ videoKey: "k", platform: "netflix", favorite: true });
  assert.equal(video.favorite, true);
});

test("normalizeState backfills defaults for legacy state without favorite fields", () => {
  const state = Schema.normalizeState({
    videos: { legacy: { videoKey: "legacy", platform: "netflix", scenes: [{ startSeconds: 1 }] } },
    settings: {}
  });

  assert.equal(state.schemaVersion, SceneMarks.Constants.SCHEMA_VERSION);
  assert.equal(state.videos.legacy.favorite, false);
  assert.equal(state.videos.legacy.scenes[0].favorite, false);
  assert.equal(state.activeRangeDraft, null);
  assert.equal(state.pendingJump, null);
  assert.equal(state.settings.duplicateThresholdSeconds, 3);
});

test("normalizeState drops an expired range draft but keeps a fresh one", () => {
  const stale = new Date(Date.now() - DAY_MS - MINUTE_MS).toISOString();
  const fresh = new Date().toISOString();

  const state = Schema.normalizeState({
    activeRangeDraft: { videoKey: "a", startSeconds: 5, createdAt: stale }
  });
  assert.equal(state.activeRangeDraft, null);

  const kept = Schema.normalizeState({
    activeRangeDraft: { videoKey: "a", startSeconds: 5, createdAt: fresh }
  });
  assert.equal(kept.activeRangeDraft.videoKey, "a");
});

test("normalizeState drops an expired pending jump but keeps a fresh one", () => {
  const stale = new Date(Date.now() - 16 * MINUTE_MS).toISOString();
  const fresh = new Date().toISOString();
  const jump = { videoKey: "a", sceneId: "scene_1", seconds: 10, url: "https://a.example/v" };

  const state = Schema.normalizeState({ pendingJump: { ...jump, createdAt: stale } });
  assert.equal(state.pendingJump, null);

  const kept = Schema.normalizeState({ pendingJump: { ...jump, createdAt: fresh } });
  assert.equal(kept.pendingJump.sceneId, "scene_1");
});

test("normalizeSettings clamps the duplicate threshold and validates jump behavior", () => {
  const clamped = Schema.normalizeSettings({ duplicateThresholdSeconds: 99999 });
  assert.equal(clamped.duplicateThresholdSeconds, 600);

  const invalid = Schema.normalizeSettings({ duplicateThresholdSeconds: "nope" });
  assert.equal(invalid.duplicateThresholdSeconds, 3);

  const behavior = Schema.normalizeSettings({ defaultJumpBehavior: "teleport" });
  assert.equal(behavior.defaultJumpBehavior, "preserve-play-state");
});
