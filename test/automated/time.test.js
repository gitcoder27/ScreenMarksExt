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
