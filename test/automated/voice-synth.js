"use strict";

// Synthetic speech for the voice tests: deterministic noise, voiced
// "vowels" (glottal pulses through two formant resonators) and unvoiced
// noise segments, so words can differ in their formant tracks the way real
// words do. Not speech, but enough structure for MFCC + DTW to work on.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SR = 16000;

function loadVoiceFeatures() {
  const context = vm.createContext({});
  context.globalThis = context;
  const file = path.join(__dirname, "..", "..", "src", "voice", "voice-features.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.SceneMarks.VoiceFeatures;
}

// mulberry32: 32-bit integer math, so it stays exact in JS.
function createRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

// A word is a list of segments: [ms, F1 from, F1 to, F2 from, F2 to, voiced].
const WORDS = Object.freeze({
  next: [[60, 300, 300, 1500, 1500, true], [180, 550, 550, 1800, 1800, true], [120, 3000, 3000, 5000, 5000, false]],
  back: [[40, 300, 300, 1000, 1000, true], [200, 750, 750, 1650, 1650, true], [60, 2000, 2000, 3000, 3000, false]],
  pause: [[50, 2000, 2000, 3000, 3000, false], [220, 750, 400, 1200, 900, true], [120, 4000, 4000, 6000, 6000, false]],
  play: [[40, 400, 400, 1000, 1000, true], [240, 600, 350, 1900, 2300, true]],
  mark: [[70, 300, 300, 1100, 1100, true], [220, 750, 700, 1200, 1300, true], [50, 2500, 2500, 3500, 3500, false]],
  skip: [[120, 4000, 4000, 6000, 6000, false], [150, 400, 400, 2100, 2100, true], [60, 2000, 2000, 3000, 3000, false]],
  return: [[60, 450, 450, 1300, 1300, true], [120, 350, 350, 2100, 2100, true], [200, 500, 450, 1300, 1400, true], [60, 300, 300, 1500, 1500, true]],
  random: [[60, 450, 450, 1300, 1300, true], [150, 750, 750, 1650, 1650, true], [80, 300, 300, 1500, 1500, true], [150, 600, 450, 1000, 900, true]],
  // Not commands: used to check that other speech is rejected.
  hello: [[80, 3000, 3000, 5000, 5000, false], [150, 550, 500, 1800, 1700, true], [200, 450, 400, 900, 800, true]],
  stop: [[100, 4000, 4000, 6000, 6000, false], [40, 2000, 2000, 3000, 3000, false], [200, 600, 600, 1000, 1000, true]]
});

// Five different "takes" of a word: speed, pitch and loudness vary.
const TAKES = Object.freeze([
  { speed: 1, f0: 120, level: 1 },
  { speed: 0.85, f0: 135, level: 0.6 },
  { speed: 1.15, f0: 110, level: 1.4 },
  { speed: 0.92, f0: 150, level: 0.8 },
  { speed: 1.25, f0: 100, level: 1.1 }
]);

// 100 ms of room tone on each side, like a VAD utterance's pre-roll and tail.
// Voicing builds up over ~25 ms after silence or a consonant and the word
// fades over ~30 ms, as real voices do (an instant full-level onset is what
// a tap looks like).
const ONSET_SAMPLES = 25 * 16;
const RELEASE_SAMPLES = 30 * 16;

function synthWord(name, { speed = 1, f0 = 120, level = 1, noise = 0.002, seed = 11 } = {}) {
  const random = createRandom(seed);
  const out = [];
  const y = [0, 0, 0, 0];
  let phase = 0;
  let previousVoiced = false;
  const segments = WORDS[name];
  segments.forEach(([ms, a1, b1, a2, b2, voiced], index) => {
    const n = Math.round(ms * 16 * speed);
    const rampIn = voiced && !previousVoiced;
    const rampOut = index === segments.length - 1;
    previousVoiced = voiced;
    for (let i = 0; i < n; i += 1) {
      const t = i / n;
      const f1 = a1 + (b1 - a1) * t;
      const f2 = a2 + (b2 - a2) * t;
      phase += f0 / SR;
      let source;
      if (voiced) {
        source = phase >= 1 ? 1 : 0;
        if (phase >= 1) phase -= 1;
      } else {
        source = random() * 0.3;
      }
      const r = 0.96;
      const theta1 = (2 * Math.PI * f1) / SR;
      const theta2 = (2 * Math.PI * f2) / SR;
      const o1 = source + 2 * r * Math.cos(theta1) * y[0] - r * r * y[1];
      y[1] = y[0];
      y[0] = o1;
      const o2 = source + 2 * r * Math.cos(theta2) * y[2] - r * r * y[3];
      y[3] = y[2];
      y[2] = o2;
      let envelope = 1;
      if (rampIn && i < ONSET_SAMPLES) envelope = i / ONSET_SAMPLES;
      if (rampOut && n - i < RELEASE_SAMPLES) envelope = Math.min(envelope, (n - i) / RELEASE_SAMPLES);
      out.push(level * 0.02 * (o1 + 0.5 * o2) * envelope + random() * noise);
    }
  });
  const pad = () => Array.from({ length: 1600 }, () => random() * noise);
  return Float32Array.from([...pad(), ...out, ...pad()]);
}

module.exports = { SR, TAKES, WORDS, createRandom, loadVoiceFeatures, synthWord };
