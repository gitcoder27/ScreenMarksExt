"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { loadSharedModules } = require("./helpers");

const { Time } = loadSharedModules();

test("formatSeconds renders padded minutes and hours", () => {
  assert.equal(Time.formatSeconds(0), "00:00");
  assert.equal(Time.formatSeconds(65), "01:05");
  assert.equal(Time.formatSeconds(3671), "01:01:11");
});

test("formatSeconds rounds and clamps invalid input to zero", () => {
  assert.equal(Time.formatSeconds(1.5), "00:02");
  assert.equal(Time.formatSeconds(-30), "00:00");
  assert.equal(Time.formatSeconds(Number.NaN), "00:00");
});

test("formatRange shows a single time for timestamps and an arrow for ranges", () => {
  assert.equal(Time.formatRange(90, null), "01:30");
  assert.equal(Time.formatRange(90, 120), "01:30 -> 02:00");
});

test("isValidSeconds and normalizeSeconds guard inputs", () => {
  assert.equal(Time.isValidSeconds(5), true);
  assert.equal(Time.isValidSeconds(-1), false);
  assert.equal(Time.isValidSeconds(Number.POSITIVE_INFINITY), false);
  assert.equal(Time.isValidSeconds("5"), false);
  assert.equal(Time.normalizeSeconds("bad"), 0);
});

test("describeCapture gives one fixed message per save outcome, with times only", () => {
  const say = (action, result, seconds) => Time.describeCapture(action, result, seconds);
  assert.deepEqual(say("save", { ok: true, scene: { note: "secret" } }, 252), { ok: true, tone: "success", text: "Saved 04:12" });
  assert.deepEqual(say("save", { ok: false, duplicate: true }, 252), { ok: false, tone: "info", text: "Already saved near 04:12" });
  assert.equal(say("favorite", { ok: true }, 252).text, "Favorited 04:12");
  assert.equal(say("rangeStart", { ok: true }, 724).text, "Range started at 12:04");
  assert.equal(say("rangeEnd", { ok: true, scene: { startSeconds: 724, endSeconds: 790, note: "secret" } }, 790).text,
    "Range saved 12:04 → 13:10");
  assert.equal(say("rangeEnd", { ok: false, duplicate: true, draft: { startSeconds: 724 } }, 790).text,
    "Range 12:04 → 13:10 is already saved · still open from 12:04");
  assert.equal(say("rangeEnd", { ok: false, noRange: true }, 790).text, "No range is open on this video");
  assert.equal(say("rangeStart", { ok: false, conflict: true }, 5).tone, "error");
  for (const action of ["save", "favorite", "rangeStart", "rangeEnd"]) {
    assert.equal(say(action, { ok: false, noVideo: true }, 0).text, "No video found — start playback first");
    assert.equal(say(action, { ok: false, inactive: true }, 0).text, "SceneMarks is off on this site");
    // Unknown failures never echo the result's own text into the page.
    assert.doesNotMatch(say(action, { ok: false, error: "secret note" }, 0).text, /secret/);
  }
});

test("nearestMarkIndex finds the mark playback is at, never one ahead", () => {
  const starts = [10, 60, 60.5, 300, 1200];
  assert.equal(Time.nearestMarkIndex(starts, 0), -1, "before the first mark nothing is current");
  assert.equal(Time.nearestMarkIndex(starts, 9.8), 0, "a seek landing just short still counts");
  assert.equal(Time.nearestMarkIndex(starts, 10), 0);
  assert.equal(Time.nearestMarkIndex(starts, 59), 0, "stays on the scene until the next one starts");
  assert.equal(Time.nearestMarkIndex(starts, 60), 1);
  assert.equal(Time.nearestMarkIndex(starts, 61), 2);
  assert.equal(Time.nearestMarkIndex(starts, 299.9), 3);
  assert.equal(Time.nearestMarkIndex(starts, 5000), 4);
  assert.equal(Time.nearestMarkIndex([], 30), -1);
  assert.equal(Time.nearestMarkIndex(null, 30), -1);
  assert.equal(Time.nearestMarkIndex(starts, Number.NaN), -1);
  const many = Array.from({ length: 50 }, (_, i) => i * 15);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(Time.nearestMarkIndex(many, i * 15 + 7), i);
  }
});
