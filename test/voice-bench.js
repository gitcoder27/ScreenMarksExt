"use strict";
// Voice recognition bench on real spoken words (macOS only, run by hand):
//
//   node test/voice-bench.js [sensitivity]
//
// The automated tests use synthetic words, which prove the pipeline works
// but cannot say how well it recognizes a voice. This bench speaks every
// command with eight macOS voices (`say`, cached in the temp folder after
// the first run, which takes a few minutes), then for each voice:
//   - trains on three takes, either said alike ("careful") or varied in
//     loudness and speed the way the options page asks ("varied"),
//   - plays each command at six speeds, up to 14 dB softer or 4 dB louder
//     and slightly higher or lower, through the real VAD and matcher in a
//     noisy room, the way the live engine hears it,
//   - plays look-alike words ("text", "black", "pass", ...) and whole
//     sentences that must not run anything.
// Run it before and after changing voice-features.js; it prints how many
// commands were recognized, mistaken and missed (and why), and how often
// other speech would have run a command.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadVoiceFeatures } = require("./automated/voice-synth");

const VoiceFeatures = loadVoiceFeatures();
const SENSITIVITY = Number(process.argv[2] ?? 0.5);
const CACHE = path.join(os.tmpdir(), "scenemarks-voice-bench");
const VOICES = ["Rishi", "Aman", "Tara", "Samantha", "Daniel", "Karen", "Moira", "Tessa"];
const COMMANDS = ["next", "back", "pause", "play", "mark", "skip", "return", "random"];
const LOOK_ALIKES = ["text", "black", "hello", "okay", "stop", "yes", "what", "nice", "neck", "park", "pass", "mask", "packed"];
const SENTENCES = [
  "I think we should go to the market later today",
  "Did you see what happened next in the story",
  "Come back here right now, she said",
  "Let me play that again for you",
  "That was a really random thing to say",
  "Take a break and pause for a moment",
  "We will return after these messages",
  "Mark my words, this will be big"
];
const RATES = [140, 170, 200, 230, 260, 300];

function speak(voice, text, rate) {
  const file = path.join(CACHE, `${voice}_${text.replace(/\W+/g, "-")}_${rate}.wav`);
  if (!fs.existsSync(file)) {
    execFileSync("say", ["-v", voice, "-r", String(rate), "-o", file, "--data-format=LEI16@16000", text]);
  }
  const bytes = fs.readFileSync(file);
  let offset = 12;
  while (offset < bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      const data = bytes.subarray(offset + 8, offset + 8 + size);
      return Float32Array.from({ length: data.length >> 1 }, (_, i) => data.readInt16LE(i * 2) / 32768);
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error(`No audio in ${file}`);
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Loudness, pitch (resampling) and a room's early echoes.
function vary(audio, { gainDb = 0, pitch = 1, reverb = 0 }) {
  const length = Math.floor(audio.length / pitch);
  let out = Float32Array.from({ length }, (_, i) => {
    const at = i * pitch;
    const k = Math.floor(at);
    const a = at - k;
    return ((audio[k] || 0) * (1 - a) + (audio[k + 1] || 0) * a) * 10 ** (gainDb / 20);
  });
  if (reverb) {
    const wet = Float32Array.from(out);
    for (const [ms, level] of [[37, 0.35], [89, 0.25], [151, 0.18], [263, 0.12], [401, 0.07]]) {
      const delay = Math.round(ms * 1.6 * reverb);
      for (let i = delay; i < out.length; i += 1) wet[i] += level * out[i - delay];
    }
    out = wet;
  }
  return out;
}

// Pink-ish room noise at a given level.
function roomNoise(length, db, random) {
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let energy = 0;
  for (let i = 0; i < length; i += 1) {
    const white = random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[i] = b0 + b1 + b2 + white * 0.1848;
    energy += out[i] * out[i];
  }
  const gain = 10 ** (db / 20) / Math.sqrt(energy / length);
  return out.map((value) => value * gain);
}

// One second of room, the sound, then room again, through a running VAD.
function listen(vad, audio, room, random) {
  const total = new Float32Array(16000 + audio.length + 14000);
  total.set(audio, 16000);
  const noise = roomNoise(total.length, room, random);
  const results = [];
  for (let start = 0; start + 160 <= total.length; start += 160) {
    const frame = total.subarray(start, start + 160).map((value, i) => value + noise[start + i]);
    const result = vad.push(frame);
    if (result) results.push(result);
  }
  return results;
}

function run(style) {
  const totals = { commands: 0, recognized: 0, wrong: 0, missed: {}, lookAlikes: 0, lookAlikesRun: 0, sentenceRuns: 0 };
  const perWord = Object.fromEntries(COMMANDS.map((word) => [word, [0, 0]]));
  VOICES.forEach((voice, index) => {
    const random = createRandom(1000 + index);
    const room = -62 + (index % 4) * 4;
    const reverb = index % 2 ? 4 + (index % 3) * 2 : 0;
    const train = style === "careful"
      ? [[170, 0, 1], [200, -2, 1.02], [200, 2, 0.98]]
      : [[170, 0, 1], [200, -6, 1.02], [230, -10, 0.98]];

    const trainVad = VoiceFeatures.createVad();
    listen(trainVad, new Float32Array(0), room, random);
    const commands = {};
    for (const word of COMMANDS) {
      commands[word] = train.map(([rate, gainDb, pitch]) => {
        const words = listen(trainVad, vary(speak(voice, word, rate), { gainDb, pitch, reverb }), room, random)
          .filter((result) => result.frames);
        return words.length ? VoiceFeatures.extractFeatures(VoiceFeatures.concatFrames(words[words.length - 1].frames)) : null;
      }).filter(Boolean);
    }
    const library = VoiceFeatures.prepareLibrary({ commands });
    const calibration = VoiceFeatures.calibrate(library);

    const vad = VoiceFeatures.createVad();
    listen(vad, new Float32Array(0), room, random);
    const hear = (audio) => listen(vad, audio, room + random() * 3, random).map((result) => {
      if (result.rejected) return { rejected: result.rejected };
      const features = VoiceFeatures.extractFeatures(VoiceFeatures.concatFrames(result.frames));
      return features
        ? VoiceFeatures.match(VoiceFeatures.withDeltas(features), library, calibration, SENSITIVITY)
        : { rejected: "no-features" };
    });

    for (const word of COMMANDS) {
      for (const rate of RATES) {
        for (let n = 0; n < 2; n += 1) {
          const heard = hear(vary(speak(voice, word, rate), { gainDb: -14 + random() * 18, pitch: 0.96 + random() * 0.08, reverb }));
          const accepted = heard.find((result) => result.accepted);
          totals.commands += 1;
          perWord[word][1] += 1;
          if (accepted && accepted.command === word) {
            totals.recognized += 1;
            perWord[word][0] += 1;
          } else if (accepted) {
            totals.wrong += 1;
          } else {
            const why = heard.find((result) => result.reason)?.reason || heard.map((result) => result.rejected).join("+") || "not heard";
            totals.missed[why] = (totals.missed[why] || 0) + 1;
          }
        }
      }
    }
    for (const word of LOOK_ALIKES) {
      for (const rate of [170, 230]) {
        totals.lookAlikes += 1;
        if (hear(vary(speak(voice, word, rate), { gainDb: -6 + random() * 8, reverb })).some((result) => result.accepted)) {
          totals.lookAlikesRun += 1;
        }
      }
    }
    for (const sentence of SENTENCES) {
      totals.sentenceRuns += hear(vary(speak(voice, sentence, 190), { gainDb: -4, reverb })).filter((result) => result.accepted).length;
    }
  });

  const percent = (count, total) => `${((100 * count) / total).toFixed(1)}%`;
  console.log(`${style} takes, sensitivity ${SENSITIVITY}:`);
  console.log(`  commands recognized ${percent(totals.recognized, totals.commands)}, wrong command ${percent(totals.wrong, totals.commands)}, missed ${JSON.stringify(totals.missed)}`);
  console.log(`  per word: ${COMMANDS.map((word) => `${word} ${Math.round((100 * perWord[word][0]) / perWord[word][1])}%`).join(", ")}`);
  console.log(`  look-alike words that ran a command: ${percent(totals.lookAlikesRun, totals.lookAlikes)}; commands run by ${VOICES.length * SENTENCES.length} sentences: ${totals.sentenceRuns}`);
}

if (process.platform !== "darwin") {
  console.error("The voice bench needs macOS (it speaks words with `say`).");
  process.exit(1);
}
fs.mkdirSync(CACHE, { recursive: true });
run("careful");
run("varied");
