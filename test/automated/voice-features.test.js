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
  // Each utterance holds the word plus up to 150 ms of lead-in and tail.
  assertWord(results[0], 350, 700);
  assertWord(results[1], 300, 650);
  assertWord(results[2], 250, 600);
  assertWord(results[3], 300, 700);
});

test("taps on the laptop are rejected, even when the case rings", () => {
  for (const result of runVad(tap({ ringMs: 30 }), tap({ ringMs: 50, ringHz: 200 }))) {
    assert.ok(["too-short", "click"].includes(result), String(result));
  }
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
  results.forEach((result) => assertWord(result, 400, 800));
});

test("a steady noise is cut off once, then words over it are still heard", () => {
  const hum = (ms) => Float32Array.from({ length: ms * 16 }, (_, i) => 0.003 * Math.sin(i * 0.3) + random() * 0.002);
  const results = runVad(concat([hum(6000), concat([voice(400, { level: 3 })]).map((v, i) => v + 0.003 * Math.sin(i * 0.3)), hum(1000)]));
  assert.equal(results[0], "too-long");
  assert.equal(results.length, 2, String(results));
  assertWord(results[1], 400, 800);
});

// ---- MFCC, DTW and matching -------------------------------------------
const { TAKES, synthWord, vadUtterance } = require("./voice-synth");
const COMMANDS = ["next", "back", "pause", "play", "mark", "skip", "return", "random"];

function features(word, take = 0) {
  return VoiceFeatures.extractFeatures(synthWord(word, TAKES[take]));
}

function trainedLibrary(words = COMMANDS) {
  const commands = {};
  for (const word of words) commands[word] = [0, 1, 2].map((take) => features(word, take));
  const library = VoiceFeatures.prepareLibrary({ commands });
  return { commands, library, calibration: VoiceFeatures.calibrate(library) };
}

test("feature sizes agree with the shared constants", () => {
  const constantsFile = path.join(__dirname, "..", "..", "src", "shared", "constants.js");
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(constantsFile, "utf8"), context);
  const { VOICE_MFCC_COEFFS, MAX_VOICE_TEMPLATE_FRAMES } = context.SceneMarks.Constants;
  assert.equal(VoiceFeatures.COEFFS, VOICE_MFCC_COEFFS);
  assert.equal(VoiceFeatures.FEATURE_DIM, VOICE_MFCC_COEFFS * 2);
  const long = VoiceFeatures.extractFeatures(new Float32Array(SR * 3).map((_, i) => 0.1 * Math.sin(i * 0.2) * (1 + Math.sin(i / 900))));
  assert.ok(long.frames <= MAX_VOICE_TEMPLATE_FRAMES, String(long.frames));
});

test("MFCC extraction is deterministic, mean-normalized and trims edge silence", () => {
  const a = features("next");
  const b = features("next");
  assert.deepEqual(a, b);
  assert.equal(a.data.length, a.frames * VoiceFeatures.COEFFS);
  assert.ok(a.data.every(Number.isFinite));
  // Cepstral mean normalization: every coefficient averages ~0.
  for (let k = 0; k < VoiceFeatures.COEFFS; k += 1) {
    let sum = 0;
    for (let f = 0; f < a.frames; f += 1) sum += a.data[f * VoiceFeatures.COEFFS + k];
    assert.ok(Math.abs(sum / a.frames) < 0.02, `coefficient ${k}`);
  }
  // 360 ms of word inside 200 ms of padding: the padding is trimmed away.
  assert.ok(a.frames >= 30 && a.frames <= 40, String(a.frames));
  // Loudness is normalized away: a loud and a quiet take of a word are
  // much closer than two different words.
  const loud = VoiceFeatures.withDeltas(VoiceFeatures.extractFeatures(synthWord("next", { level: 2 })));
  const quietCopy = VoiceFeatures.withDeltas(VoiceFeatures.extractFeatures(synthWord("next", { level: 0.5 })));
  const otherWord = VoiceFeatures.withDeltas(features("back"));
  assert.ok(VoiceFeatures.dtwDistance(loud, quietCopy) < VoiceFeatures.dtwDistance(loud, otherWord) / 2);
});

test("extractFeatures returns null for input too short to describe", () => {
  assert.equal(VoiceFeatures.extractFeatures(new Float32Array(100)), null);
  assert.equal(VoiceFeatures.extractFeatures(null), null);
});

test("DTW is zero for identical input and small for a time-stretched copy", () => {
  const base = VoiceFeatures.withDeltas(features("random"));
  assert.equal(VoiceFeatures.dtwDistance(base, base), 0);
  const slow = VoiceFeatures.withDeltas(VoiceFeatures.extractFeatures(synthWord("random", { speed: 1.3 })));
  const other = VoiceFeatures.withDeltas(features("skip"));
  const stretched = VoiceFeatures.dtwDistance(base, slow);
  assert.ok(stretched < VoiceFeatures.dtwDistance(base, other) / 2, `${stretched}`);
  // Symmetric.
  assert.ok(Math.abs(VoiceFeatures.dtwDistance(slow, base) - stretched) < 1e-9);
});

test("DTW never matches lengths that differ too much", () => {
  const short = VoiceFeatures.withDeltas(features("play"));
  const long = { frames: short.frames * 3, data: new Float64Array(short.frames * 3 * VoiceFeatures.FEATURE_DIM) };
  assert.equal(VoiceFeatures.dtwDistance(short, long), Infinity);
});

test("new takes of every trained word are recognized", () => {
  const { library, calibration } = trainedLibrary();
  for (const word of COMMANDS) {
    for (const take of [3, 4]) {
      const result = VoiceFeatures.match(VoiceFeatures.withDeltas(features(word, take)), library, calibration, 0.5);
      assert.equal(result.accepted, true, `${word} take ${take}: ${result.reason}`);
      assert.equal(result.command, word);
    }
  }
});

test("words that are not commands are rejected", () => {
  const { library, calibration } = trainedLibrary();
  for (const word of ["hello", "stop"]) {
    const result = VoiceFeatures.match(VoiceFeatures.withDeltas(features(word)), library, calibration, 0.5);
    assert.equal(result.accepted, false, word);
    assert.equal(result.reason, "too-far");
  }
});

test("a match too close to a second command is rejected as ambiguous", () => {
  const { library, calibration } = trainedLibrary(["next", "back"]);
  // Train "back" a second time under another name: the two are the same word.
  const twin = library.find(({ command }) => command === "back");
  const confusable = [...library, { command: "mark", templates: twin.templates }];
  const result = VoiceFeatures.match(VoiceFeatures.withDeltas(features("back", 3)), confusable, calibration, 0.5);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "ambiguous");
});

test("sensitivity loosens the threshold and margin", () => {
  const calibration = { typicalDistance: 2 };
  const strict = VoiceFeatures.decisionRule(calibration, 0);
  const loose = VoiceFeatures.decisionRule(calibration, 1);
  assert.ok(strict.threshold < loose.threshold);
  assert.ok(strict.margin < loose.margin);
  assert.deepEqual(VoiceFeatures.decisionRule(calibration, Number.NaN), VoiceFeatures.decisionRule(calibration, 0.5));
});

test("calibration needs two takes of a word; the profile check flags weak words", () => {
  const single = VoiceFeatures.prepareLibrary({ commands: { next: [features("next")] } });
  assert.equal(VoiceFeatures.calibrate(single), null);

  const { library, calibration } = trainedLibrary(["next", "back", "skip"]);
  assert.ok(calibration.typicalDistance > 0);
  const report = VoiceFeatures.evaluateProfile(library, calibration, 0.5);
  assert.deepEqual(Array.from(report, ({ command }) => command), ["next", "back", "skip"]);
  report.forEach((entry) => assert.equal(entry.recognized, entry.total, entry.command));

  // "mark" trained with takes of "back": both become unreliable.
  const mixed = trainedLibrary(["next", "back"]);
  mixed.library.push({ command: "mark", templates: [1, 3, 4].map((take) => VoiceFeatures.withDeltas(features("back", take))) });
  const weak = VoiceFeatures.evaluateProfile(mixed.library, mixed.calibration, 0.5);
  const mark = weak.find(({ command }) => command === "mark");
  assert.ok(mark.recognized < mark.total);
  assert.ok(mark.confusedWith.includes("back"));
});

test("templates and live words recorded through the VAD match each other", () => {
  const commands = {};
  for (const word of COMMANDS) {
    commands[word] = [0, 1, 2].map((take) => VoiceFeatures.extractFeatures(vadUtterance(VoiceFeatures, word, TAKES[take])));
  }
  const library = VoiceFeatures.prepareLibrary({ commands });
  const calibration = VoiceFeatures.calibrate(library);
  for (const word of COMMANDS) {
    for (const take of [3, 4]) {
      const live = VoiceFeatures.extractFeatures(vadUtterance(VoiceFeatures, word, TAKES[take], 99));
      const result = VoiceFeatures.match(VoiceFeatures.withDeltas(live), library, calibration, 0.5);
      assert.equal(result.accepted, true, `${word} take ${take}: ${result.reason} (${result.command})`);
      assert.equal(result.command, word);
    }
  }
});

test("trimming keeps a soft trailing consonant", () => {
  // "pause" ends in an unvoiced "s" about 30 dB below its vowel.
  const pause = VoiceFeatures.extractFeatures(vadUtterance(VoiceFeatures, "pause"));
  const paw = VoiceFeatures.extractFeatures(vadUtterance(VoiceFeatures, "pause").subarray(0, Math.round((150 + 50 + 220) * 16)));
  assert.ok(pause.frames >= paw.frames + 8, `${pause.frames} vs ${paw.frames}`);
});

test("every take of every command word passes the VAD, including sharp plosive onsets", () => {
  for (const word of COMMANDS) {
    for (const take of TAKES) {
      const results = runVad(synthWord(word, take));
      assert.equal(results.length, 1, `${word} ${JSON.stringify(take)}: ${results}`);
      assert.equal(typeof results[0], "number", `${word} ${JSON.stringify(take)} rejected as ${results[0]}`);
    }
  }
});
