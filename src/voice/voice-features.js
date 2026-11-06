// Pure audio helpers for voice commands: no DOM, no chrome.*, so Node tests
// can load them. Phase 0 holds only the voice-activity gate; MFCC and DTW
// matching join it in Phase 1.
(function attachVoiceFeatures(root) {
  const SceneMarks = root.SceneMarks || {};

  const SAMPLE_RATE = 16000;
  const FRAME_SAMPLES = 160; // 10 ms
  const DB_FLOOR = -100;

  function frameDb(samples, start, length) {
    let sum = 0;
    for (let i = start; i < start + length; i += 1) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / length);
    return rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR;
  }

  // How strongly a window repeats at a voice pitch (70-400 Hz): the peak
  // normalized autocorrelation, 0..1. Vowels score high (~0.6-0.95); taps,
  // rustles and hiss score low. The window is averaged down to 8 kHz first,
  // which cuts the work by four and is plenty for pitch.
  const PITCH_MIN_HZ = 70;
  const PITCH_MAX_HZ = 400;

  function periodicity(samples) {
    const n = Math.floor(samples.length / 2);
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i += 1) {
      x[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
      mean += x[i];
    }
    mean /= n;
    for (let i = 0; i < n; i += 1) {
      x[i] -= mean;
    }

    const rate = SAMPLE_RATE / 2;
    const minLag = Math.floor(rate / PITCH_MAX_HZ);
    const maxLag = Math.min(n - 20, Math.ceil(rate / PITCH_MIN_HZ));
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let cross = 0;
      let headEnergy = 0;
      let tailEnergy = 0;
      for (let i = 0; i + lag < n; i += 1) {
        cross += x[i] * x[i + lag];
        headEnergy += x[i] * x[i];
        tailEnergy += x[i + lag] * x[i + lag];
      }
      const denominator = Math.sqrt(headEnergy * tailEnergy);
      if (denominator > 0 && cross / denominator > best) {
        best = cross / denominator;
      }
    }
    return best;
  }

  // Energy gate that tracks the room's noise floor. It sees one 10 ms frame
  // at a time and returns null, a finished utterance ({ frames }), or a
  // rejected sound ({ rejected: "too-short" | "too-long" }).
  //
  // The floor falls quickly and rises slowly, so it follows a quiet room
  // but is not dragged up by speech. An utterance ends after a run of
  // quiet frames, where quiet means near the floor OR far below the
  // utterance's own peak: browser noise suppression can push the floor
  // very low, and auto-gain then lifts the room noise after a word above
  // floor + stopDb, which alone would keep the gate open forever.
  // An utterance that runs past maxFrames is cut off, and the floor is
  // re-learned from the quietest recent frames, so a steady noise (a fan,
  // music) cannot hold the gate open either.
  //
  // A finished sound must also look like speech: it must stay near its
  // peak loudness for a while (a tap on the laptop peaks and decays in a
  // few tens of ms; a word holds through its vowel), its loudest moment
  // must be built up to rather than struck (a tap, even one the laptop case
  // rings on for half a second, is loudest at its first instant and only
  // decays; a word is loudest in its vowel, after the opening consonant),
  // and it must have enough voiced frames, ones that repeat at a voice
  // pitch. Otherwise it is rejected as "click" or "no-voice".
  function createVad(options = {}) {
    const startDb = options.startDb ?? 12; // above floor to open
    const stopDb = options.stopDb ?? 6; // within this of the floor is quiet
    const dropDb = options.dropDb ?? 30; // this far below the peak is quiet
    const minFloorDb = options.minFloorDb ?? -75;
    const hangoverFrames = options.hangoverFrames ?? 25; // 250 ms of quiet closes
    const minFrames = options.minFrames ?? 20; // 200 ms
    const maxFrames = options.maxFrames ?? 150; // 1.5 s
    const preRollFrames = options.preRollFrames ?? 10; // keep 100 ms before onset
    const relearnFrames = options.relearnFrames ?? 50; // quietest of the last 0.5 s
    const sustainDb = options.sustainDb ?? 12; // "near the peak"
    const minSustainFrames = options.minSustainFrames ?? 8; // 80 ms near the peak
    const voicedThreshold = options.voicedThreshold ?? 0.5;
    const minPitchFrames = options.minPitchFrames ?? 5; // 50 ms of voicing
    const pitchWindowFrames = 3; // 30 ms windows, enough for a 70 Hz period
    const attackFrames = options.attackFrames ?? 3; // look 30 ms before the peak
    const attackDb = options.attackDb ?? 20; // a jump this big in that time is a strike

    let noiseFloorDb = options.initialFloorDb ?? -60;
    let active = false;
    let silentRun = 0;
    let leadFrames = 0;
    let peakDb = DB_FLOOR;
    let frames = [];
    let levels = [];
    let pitchFrames = 0;
    const preRoll = [];

    function close() {
      active = false;
      silentRun = 0;
      leadFrames = 0;
      peakDb = DB_FLOOR;
      frames = [];
      levels = [];
      pitchFrames = 0;
    }

    // Voicing of the newest frame, measured over it and the frames before
    // it. Only loud frames are measured, which keeps the cost to speech.
    function measureVoicing(db) {
      if (db <= noiseFloorDb + startDb || frames.length < pitchWindowFrames) {
        return;
      }
      const window = new Float32Array(FRAME_SAMPLES * pitchWindowFrames);
      for (let k = 0; k < pitchWindowFrames; k += 1) {
        window.set(frames[frames.length - pitchWindowFrames + k], k * FRAME_SAMPLES);
      }
      if (periodicity(window) >= voicedThreshold) {
        pitchFrames += 1;
      }
    }

    function finish() {
      const voiced = frames.length - silentRun - leadFrames;
      const sustained = levels.filter((db) => db >= peakDb - sustainDb).length;
      // levels[0] is the onset frame (the pre-roll has no level entry).
      const peakIndex = levels.indexOf(peakDb);
      const beforePeak = peakIndex >= attackFrames ? levels[peakIndex - attackFrames] : noiseFloorDb;
      const struck = peakDb - beforePeak >= attackDb;
      const pitched = pitchFrames;
      // Keep 50 ms of the quiet tail.
      const kept = frames.slice(0, frames.length - Math.max(0, silentRun - 5));
      close();
      const stats = { voicedFrames: voiced, sustainedFrames: sustained, pitchFrames: pitched, peakFrame: peakIndex };
      if (voiced < minFrames) {
        return { rejected: "too-short", ...stats };
      }
      if (sustained < minSustainFrames || struck) {
        return { rejected: "click", ...stats };
      }
      if (pitched < minPitchFrames) {
        return { rejected: "no-voice", ...stats };
      }
      return { frames: kept, ...stats };
    }

    function cutOff() {
      const recent = levels.slice(-relearnFrames);
      const quietest = Math.min(...recent);
      noiseFloorDb = Math.max(minFloorDb, Math.min(quietest, peakDb - stopDb));
      close();
      return { rejected: "too-long" };
    }

    return {
      get noiseFloorDb() {
        return noiseFloorDb;
      },
      get active() {
        return active;
      },
      get openFrames() {
        return frames.length;
      },
      push(frame) {
        const db = frameDb(frame, 0, frame.length);
        if (!active) {
          if (db > noiseFloorDb + startDb) {
            active = true;
            frames = preRoll.splice(0);
            leadFrames = frames.length;
            frames.push(frame);
            levels = [db];
            peakDb = db;
            silentRun = 0;
            return null;
          }
          const rate = db < noiseFloorDb ? 0.2 : 0.005;
          noiseFloorDb = Math.max(minFloorDb, noiseFloorDb + (db - noiseFloorDb) * rate);
          preRoll.push(frame);
          if (preRoll.length > preRollFrames) {
            preRoll.shift();
          }
          return null;
        }

        frames.push(frame);
        levels.push(db);
        peakDb = Math.max(peakDb, db);
        measureVoicing(db);
        const quiet = db < noiseFloorDb + stopDb || db < peakDb - dropDb;
        silentRun = quiet ? silentRun + 1 : 0;
        if (silentRun >= hangoverFrames) {
          return finish();
        }
        if (frames.length - leadFrames - silentRun > maxFrames) {
          return cutOff();
        }
        return null;
      },
      reset() {
        close();
        preRoll.length = 0;
      }
    };
  }

  SceneMarks.VoiceFeatures = {
    FRAME_SAMPLES,
    SAMPLE_RATE,
    createVad,
    periodicity,
    frameDb
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
