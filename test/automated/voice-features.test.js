"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadVoiceFeatures() {
  const context = vm.createContext({});
  context.globalThis = context;
  const file = path.join(__dirname, "..", "..", "src", "voice", "voice-features.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.SceneMarks.VoiceFeatures;
}

const VoiceFeatures = loadVoiceFeatures();
const FRAME = VoiceFeatures.FRAME_SAMPLES;
const SR = VoiceFeatures.SAMPLE_RATE;

// Deterministic noise in [-0.5, 0.5) so tests never flake (mulberry32;
// 32-bit integer math, so it stays exact in JS).
let seed = 3;
function random() {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function quiet(ms, amplitude = 0.0004) {
  return Float32Array.from({ length: ms * 16 }, () => random() * amplitude);
}

// A vowel: glottal pulses at f0 through one formant resonator, under a
// rise-and-fall envelope. `level` scales it (1 is about -26 dB at the peak).
function voice(ms, { f0 = 120, formant = 700, level = 1, rampMs = null } = {}) {
  const n = ms * 16;
  const out = new Float32Array(n);
  const r = 0.97;
  const theta = (2 * Math.PI * formant) / SR;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < n; i += 1) {
    const pulse = i % Math.round(SR / f0) === 0 ? 1 : 0;
    const y = pulse + 2 * r * Math.cos(theta) * y1 - r * r * y2;
    y2 = y1;
    y1 = y;
    const envelope = rampMs === null
      ? Math.sin(Math.PI * Math.min(1, (i / n) * 1.2))
      : Math.min(1, rampMs > 0 ? i / (rampMs * 16) : 1);
    out[i] = level * (0.05 * y * envelope + random() * 0.002);
  }
  return out;
}

// A spoken word that opens with a plosive ("back", "pause"): a 10 ms
// burst, some aspiration, then a vowel that switches on fast.
function plosiveWord() {
  return concat([
    Float32Array.from({ length: FRAME }, () => random() * 0.03),
    Float32Array.from({ length: 40 * 16 }, () => random() * 0.005),
    voice(300, { rampMs: 10 })
  ]);
}

// A finger tap on the laptop: a sharp strike, then the case rings.
function tap({ ringMs = 120, ringHz = 1500, level = 0.8 } = {}) {
  const tau = (ringMs / 1000) * SR;
  return Float32Array.from({ length: 600 * 16 }, (_, i) => level * (
    random() * Math.exp(-i / (0.005 * SR))
    + 0.3 * Math.sin((2 * Math.PI * ringHz * i) / SR) * Math.exp(-i / tau)
    + 0.2 * random() * Math.exp(-i / tau)
  ));
}

// Unvoiced noise with a soft envelope: a rustle, a breath, hiss.
function rustle(ms, level = 0.1) {
  const n = ms * 16;
  return Float32Array.from({ length: n }, (_, i) => level * random() * Math.sin((Math.PI * i) / n));
}

// Feeds the sounds through a VAD (after 1.5 s of room tone to settle the
// floor) and returns what it reported: a word's length in ms, or the
// rejection reason.
function runVad(...sounds) {
  const vad = VoiceFeatures.createVad();
  const audio = concat([quiet(1500), ...sounds.flatMap((sound) => [sound, quiet(800)])]);
  const results = [];
  for (let start = 0; start + FRAME <= audio.length; start += FRAME) {
    const result = vad.push(audio.slice(start, start + FRAME));
    if (result) {
      results.push(result.frames ? result.frames.length * 10 : result.rejected);
    }
  }
  return results;
}

function assertWord(result, minMs, maxMs) {
  assert.equal(typeof result, "number", `expected a word, got ${result}`);
  assert.ok(result >= minMs && result <= maxMs, `word length ${result} ms`);
}

test("frameDb reports silence at the floor and a full-scale tone near 0 dB", () => {
  assert.equal(VoiceFeatures.frameDb(new Float32Array(FRAME), 0, FRAME), -100);
  const tone = Float32Array.from({ length: FRAME }, (_, i) => Math.sin(i * 0.3));
  assert.ok(Math.abs(VoiceFeatures.frameDb(tone, 0, FRAME) - -3) < 0.5);
});

test("periodicity is high for a voice pitch and low for noise", () => {
  for (const f0 of [80, 120, 220, 350]) {
    const window = voice(30, { f0, rampMs: 0 });
    assert.ok(VoiceFeatures.periodicity(window) > 0.7, `f0 ${f0}`);
  }
  assert.ok(VoiceFeatures.periodicity(Float32Array.from({ length: 480 }, random)) < 0.3);
  assert.equal(VoiceFeatures.periodicity(new Float32Array(480)), 0);
});

test("the VAD splits spoken words into separate utterances", () => {
  const results = runVad(voice(350), voice(300, { f0: 220, level: 0.3 }), voice(250, { f0: 90, formant: 500 }), plosiveWord());
  assert.equal(results.length, 4, String(results));
  assertWord(results[0], 350, 550);
  assertWord(results[1], 300, 500);
  assertWord(results[2], 250, 450);
  assertWord(results[3], 300, 500);
});

test("taps on the laptop are rejected, even when the case rings", () => {
  assert.deepEqual(runVad(tap({ ringMs: 30 }), tap({ ringMs: 50, ringHz: 200 })), ["too-short", "too-short"]);
  // Long rings last as long as a word and are pitched, but are struck.
  assert.deepEqual(runVad(tap({ ringMs: 80 }), tap({ ringMs: 120 }), tap({ ringMs: 120, ringHz: 200 })),
    ["click", "click", "click"]);
});

test("a quick run of taps is rejected", () => {
  const ring = tap({ ringMs: 30, level: 0.6 }).subarray(0, 120 * 16);
  assert.deepEqual(runVad(concat([ring, ring, ring, ring])), ["click"]);
});

test("unvoiced noise of word length is rejected as no-voice", () => {
  assert.deepEqual(runVad(rustle(400), rustle(300, 0.02)), ["no-voice", "no-voice"]);
});

test("a sound longer than a command is cut off", () => {
  assert.deepEqual(runVad(voice(2500, { rampMs: 30 })), ["too-long"]);
});

test("the VAD closes when auto-gain lifts the room noise after a word", () => {
  // Noise suppression drives the quiet room to about -100 dB (the floor
  // bottoms out at its minimum), then the noise after each word sits near
  // -69 dB: above floor + stopDb, but far below the word's peak.
  const raised = () => Float32Array.from({ length: 3000 * 16 }, (_, i) => 0.0005 * Math.sin(i * 0.3));
  const results = runVad(concat([quiet(500, 0.00002), voice(400, { level: 2 }), raised(), voice(400, { level: 2 }), raised()]));
  assert.equal(results.length, 2, String(results));
  results.forEach((result) => assertWord(result, 400, 650));
});

test("a steady noise is cut off once, then words over it are still heard", () => {
  const hum = (ms) => Float32Array.from({ length: ms * 16 }, (_, i) => 0.003 * Math.sin(i * 0.3) + random() * 0.002);
  const results = runVad(concat([hum(6000), concat([voice(400, { level: 3 })]).map((v, i) => v + 0.003 * Math.sin(i * 0.3)), hum(1000)]));
  assert.equal(results[0], "too-long");
  assert.equal(results.length, 2, String(results));
  assertWord(results[1], 400, 650);
});
