// Pure audio helpers for voice commands: no DOM, no chrome.*, so Node tests
// can load them. The classic pre-ML recipe: a voice-activity gate finds
// utterances, each becomes MFCC features, and DTW (dynamic time warping)
// compares it with the user's own recorded templates.
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

  // Least-squares slope of a level run, in dB per frame. Fewer than four
  // points means the sound died at once: as steep as it gets.
  function decaySlope(levels) {
    const n = levels.length;
    if (n < 4) {
      return -Infinity;
    }
    const meanX = (n - 1) / 2;
    const meanY = levels.reduce((sum, value) => sum + value, 0) / n;
    let numerator = 0;
    let denominator = 0;
    levels.forEach((value, x) => {
      numerator += (x - meanX) * (value - meanY);
      denominator += (x - meanX) * (x - meanX);
    });
    return numerator / denominator;
  }

  // A ring loses a little level in almost every frame. A voice that steps
  // down once (a loud "m" into a quieter vowel) has the same average slope
  // but falls in only a few frames.
  function isSteadyDecay(levels, maxSlope) {
    if (levels.length < 4) {
      return true;
    }
    let falling = 0;
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] < levels[i - 1] - 0.2) falling += 1;
    }
    return decaySlope(levels) < maxSlope && falling / (levels.length - 1) >= 0.6;
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
  // must not be struck (a tap, even one the laptop case rings on for half a
  // second, jumps to its peak and then keeps decaying in a straight line;
  // a word can also start sharply, and its opening consonant can be its
  // loudest moment, but within a few tens of ms it settles into a vowel
  // that holds its level, and it has at most two sharp jumps in level (its
  // onset and a burst after a closure, "back"; a run of taps has one each),
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
    // Judge the decay from 30 to 130 ms after the peak: past the onset
    // transient, where a voice has settled and a ring is still falling.
    const decaySkipFrames = options.decaySkipFrames ?? 3;
    const decayFrames = options.decayFrames ?? 10;
    const decayDbPerFrame = options.decayDbPerFrame ?? -0.4; // a ring falls faster than this
    const jumpDb = options.jumpDb ?? 15; // a rise this big within 20 ms is a strike
    const maxStrikes = options.maxStrikes ?? 2;

    let noiseFloorDb = options.initialFloorDb ?? -60;
    let active = false;
    let silentRun = 0;
    let leadFrames = 0;
    let peakDb = DB_FLOOR;
    let frames = [];
    let levels = [];
    let pitchFrames = 0;
    const preRoll = [];

    // Sharp rises: frames at least jumpDb above both of the two before
    // them. The onset counts as one (it rises from the floor).
    function countStrikes(run) {
      let count = 1;
      for (let i = 2; i < run.length; i += 1) {
        if (run[i] - Math.max(run[i - 1], run[i - 2]) >= jumpDb && run[i] > noiseFloorDb + startDb) {
          count += 1;
        }
      }
      return count;
    }

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
      const strikes = countStrikes(levels);
      const tail = levels.slice(peakIndex + decaySkipFrames, peakIndex + decaySkipFrames + decayFrames + 1);
      const struck = strikes > maxStrikes
        || (peakDb - beforePeak >= attackDb && isSteadyDecay(tail, decayDbPerFrame));
      const pitched = pitchFrames;
      // Keep 50 ms of the quiet tail.
      const kept = frames.slice(0, frames.length - Math.max(0, silentRun - 5));
      close();
      const stats = { voicedFrames: voiced, sustainedFrames: sustained, pitchFrames: pitched, peakFrame: peakIndex, strikes };
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

  // ---------------------------------------------------------------------
  // MFCC features. 25 ms Hamming windows every 10 ms (one VAD frame), a
  // 512-point FFT, 26 mel filters from 64 Hz to 7.6 kHz, log, DCT to 13
  // coefficients. Each utterance is trimmed to its speech, and every
  // coefficient has its utterance mean removed (cepstral mean
  // normalization), which cancels the mic's and the room's colouring.
  const WINDOW_SAMPLES = 400;
  const FFT_SIZE = 512;
  const MEL_FILTERS = 26;
  const MEL_LOW_HZ = 64;
  const MEL_HIGH_HZ = 7600;
  const COEFFS = 13;
  const PRE_EMPHASIS = 0.97;
  const TRIM_DB = 25; // frames this far below the loudest are edge silence
  const C0_WEIGHT = 0.5; // c0 is loudness; keep its contour but damp it
  const MAX_TEMPLATE_FRAMES = 150;

  let tables = null;

  function melFromHz(hz) {
    return 2595 * Math.log10(1 + hz / 700);
  }

  function hzFromMel(mel) {
    return 700 * (10 ** (mel / 2595) - 1);
  }

  function getTables() {
    if (tables) {
      return tables;
    }
    const hamming = new Float64Array(WINDOW_SAMPLES);
    for (let i = 0; i < WINDOW_SAMPLES; i += 1) {
      hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WINDOW_SAMPLES - 1));
    }

    const bits = Math.log2(FFT_SIZE);
    const reversed = new Uint16Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      let r = 0;
      for (let b = 0; b < bits; b += 1) {
        r = (r << 1) | ((i >> b) & 1);
      }
      reversed[i] = r;
    }
    const cos = new Float64Array(FFT_SIZE / 2);
    const sin = new Float64Array(FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE / 2; i += 1) {
      cos[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
      sin[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
    }

    // Triangular filters over the power-spectrum bins 0..FFT_SIZE/2.
    const bins = FFT_SIZE / 2 + 1;
    const lowMel = melFromHz(MEL_LOW_HZ);
    const highMel = melFromHz(MEL_HIGH_HZ);
    const edges = [];
    for (let m = 0; m < MEL_FILTERS + 2; m += 1) {
      const hz = hzFromMel(lowMel + ((highMel - lowMel) * m) / (MEL_FILTERS + 1));
      edges.push((hz * FFT_SIZE) / SAMPLE_RATE);
    }
    const filters = [];
    for (let m = 1; m <= MEL_FILTERS; m += 1) {
      const weights = new Float64Array(bins);
      for (let k = 0; k < bins; k += 1) {
        if (k > edges[m - 1] && k < edges[m]) {
          weights[k] = (k - edges[m - 1]) / (edges[m] - edges[m - 1]);
        } else if (k >= edges[m] && k < edges[m + 1]) {
          weights[k] = (edges[m + 1] - k) / (edges[m + 1] - edges[m]);
        }
      }
      let first = 0;
      while (first < bins && weights[first] === 0) first += 1;
      let last = bins - 1;
      while (last > first && weights[last] === 0) last -= 1;
      filters.push({ first, last, weights });
    }

    // Orthonormal DCT-II rows for the first COEFFS outputs.
    const dct = [];
    for (let k = 0; k < COEFFS; k += 1) {
      const row = new Float64Array(MEL_FILTERS);
      const scale = Math.sqrt((k === 0 ? 1 : 2) / MEL_FILTERS);
      for (let m = 0; m < MEL_FILTERS; m += 1) {
        row[m] = scale * Math.cos((Math.PI * k * (m + 0.5)) / MEL_FILTERS);
      }
      dct.push(row);
    }

    tables = { hamming, reversed, cos, sin, filters, dct };
    return tables;
  }

  // In-place iterative radix-2 FFT of FFT_SIZE points.
  function fft(re, im) {
    const { reversed, cos, sin } = getTables();
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const j = reversed[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= FFT_SIZE; size *= 2) {
      const half = size / 2;
      const step = FFT_SIZE / size;
      for (let start = 0; start < FFT_SIZE; start += size) {
        for (let k = 0; k < half; k += 1) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  // samples: Float32Array at SAMPLE_RATE (a VAD utterance). Returns
  // { frames, data } with data holding frames x COEFFS numbers row by
  // row, or null when there is too little sound to describe.
  function extractFeatures(samples) {
    if (!samples || samples.length < WINDOW_SAMPLES) {
      return null;
    }
    const { hamming, filters, dct } = getTables();
    const count = Math.floor((samples.length - WINDOW_SAMPLES) / FRAME_SAMPLES) + 1;
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    const logMel = new Float64Array(MEL_FILTERS);
    const coefficients = [];
    const energiesDb = [];

    for (let f = 0; f < count; f += 1) {
      const offset = f * FRAME_SAMPLES;
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < WINDOW_SAMPLES; i += 1) {
        const previous = offset + i > 0 ? samples[offset + i - 1] : 0;
        re[i] = (samples[offset + i] - PRE_EMPHASIS * previous) * hamming[i];
      }
      fft(re, im);

      for (let m = 0; m < MEL_FILTERS; m += 1) {
        const { first, last, weights } = filters[m];
        let energy = 0;
        for (let k = first; k <= last; k += 1) {
          energy += weights[k] * (re[k] * re[k] + im[k] * im[k]);
        }
        logMel[m] = Math.log(Math.max(energy, 1e-10));
      }
      // Trimming uses the raw level, like the VAD: pre-emphasis cuts a
      // voice's low frequencies by 15-25 dB but hardly touches hiss, which
      // would shrink the speech-to-silence gap.
      energiesDb.push(frameDb(samples, offset, WINDOW_SAMPLES));

      const row = new Float64Array(COEFFS);
      for (let k = 0; k < COEFFS; k += 1) {
        let sum = 0;
        const basis = dct[k];
        for (let m = 0; m < MEL_FILTERS; m += 1) {
          sum += basis[m] * logMel[m];
        }
        row[k] = sum;
      }
      coefficients.push(row);
    }

    // Trim edge silence (the VAD's pre-roll and tail), keeping one frame.
    const peak = Math.max(...energiesDb);
    let first = energiesDb.findIndex((db) => db >= peak - TRIM_DB);
    let last = energiesDb.length - 1;
    while (last > first && energiesDb[last] < peak - TRIM_DB) last -= 1;
    first = Math.max(0, first - 1);
    last = Math.min(energiesDb.length - 1, last + 1, first + MAX_TEMPLATE_FRAMES - 1);
    const kept = coefficients.slice(first, last + 1);
    if (kept.length < 3) {
      return null;
    }

    const mean = new Float64Array(COEFFS);
    kept.forEach((row) => row.forEach((value, k) => { mean[k] += value / kept.length; }));
    const data = new Array(kept.length * COEFFS);
    kept.forEach((row, f) => {
      for (let k = 0; k < COEFFS; k += 1) {
        const value = (row[k] - mean[k]) * (k === 0 ? C0_WEIGHT : 1);
        data[f * COEFFS + k] = Math.round(value * 100) / 100;
      }
    });
    return { frames: kept.length, data };
  }

  // A stored template (13 per frame) with its deltas appended: 26 per
  // frame, ready for DTW. Deltas use the standard +/-2 frame regression.
  const FEATURE_DIM = COEFFS * 2;

  function withDeltas(template) {
    const { frames, data } = template;
    const out = new Float64Array(frames * FEATURE_DIM);
    for (let f = 0; f < frames; f += 1) {
      for (let k = 0; k < COEFFS; k += 1) {
        out[f * FEATURE_DIM + k] = data[f * COEFFS + k];
        let delta = 0;
        for (let d = 1; d <= 2; d += 1) {
          const ahead = data[Math.min(frames - 1, f + d) * COEFFS + k];
          const behind = data[Math.max(0, f - d) * COEFFS + k];
          delta += d * (ahead - behind);
        }
        out[f * FEATURE_DIM + COEFFS + k] = delta / 10;
      }
    }
    return { frames, data: out };
  }

  // ---------------------------------------------------------------------
  // DTW. Symmetric steps (diagonal counts twice) normalized by n + m, so
  // the distance is an average per-frame cost that does not grow with
  // length. A Sakoe-Chiba band keeps the path near the diagonal, and pairs
  // whose lengths differ by more than MAX_LENGTH_RATIO never match: a
  // short word must not match a slice of a long one.
  const BAND_RATIO = 0.25;
  const MAX_LENGTH_RATIO = 2.2;

  function frameDistance(a, aOffset, b, bOffset) {
    let sum = 0;
    for (let k = 0; k < FEATURE_DIM; k += 1) {
      const d = a[aOffset + k] - b[bOffset + k];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  function dtwDistance(a, b) {
    const n = a.frames;
    const m = b.frames;
    if (!n || !m || Math.max(n, m) / Math.min(n, m) > MAX_LENGTH_RATIO) {
      return Infinity;
    }
    const band = Math.max(Math.ceil(BAND_RATIO * Math.max(n, m)), 2);
    let previous = new Float64Array(m + 1).fill(Infinity);
    let current = new Float64Array(m + 1);
    previous[0] = 0;
    for (let i = 1; i <= n; i += 1) {
      current.fill(Infinity);
      const center = (i * m) / n;
      const low = Math.max(1, Math.floor(center - band));
      const high = Math.min(m, Math.ceil(center + band));
      for (let j = low; j <= high; j += 1) {
        const cost = frameDistance(a.data, (i - 1) * FEATURE_DIM, b.data, (j - 1) * FEATURE_DIM);
        current[j] = Math.min(previous[j] + cost, current[j - 1] + cost, previous[j - 1] + 2 * cost);
      }
      [previous, current] = [current, previous];
    }
    return previous[m] / (n + m);
  }

  // ---------------------------------------------------------------------
  // Matching. A library is [{ command, templates: [withDeltas(...)] }].
  // The best command is the one with the closest template. It is accepted
  // only when it is close enough in absolute terms (threshold, which
  // rejects coughs, other words and dialogue) AND clearly closer than the
  // best template of any OTHER command (margin, which rejects a word that
  // sits between two commands).
  function prepareLibrary(profile) {
    const commands = (profile && profile.commands) || {};
    return Object.keys(commands).map((command) => ({
      command,
      templates: commands[command].map(withDeltas)
    }));
  }

  function rankCommands(input, library, skip) {
    return library.map(({ command, templates }) => {
      let distance = Infinity;
      templates.forEach((template) => {
        if (template !== skip) {
          distance = Math.min(distance, dtwDistance(input, template));
        }
      });
      return { command, distance };
    }).filter((entry) => Number.isFinite(entry.distance))
      .sort((a, b) => a.distance - b.distance);
  }

  // Sensitivity 0..1: higher accepts more (looser threshold and margin).
  function decisionRule(calibration, sensitivity) {
    const s = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : 0.5));
    return {
      threshold: calibration.typicalDistance * (1.2 + 0.8 * s),
      margin: 0.78 + 0.14 * s
    };
  }

  function decide(ranked, rule) {
    const best = ranked[0] || null;
    const runnerUp = ranked[1] || null;
    if (!best) {
      return { accepted: false, reason: "no-match", command: null, distance: Infinity, runnerUp: null, ratio: null };
    }
    const ratio = runnerUp ? best.distance / runnerUp.distance : 0;
    const reason = best.distance > rule.threshold ? "too-far" : ratio > rule.margin ? "ambiguous" : null;
    return {
      accepted: reason === null,
      reason,
      command: best.command,
      distance: best.distance,
      runnerUp,
      ratio,
      threshold: rule.threshold,
      margin: rule.margin
    };
  }

  function match(input, library, calibration, sensitivity) {
    return decide(rankCommands(input, library, null), decisionRule(calibration, sensitivity));
  }

  // How far apart the user's own repetitions of a word are, which sets the
  // scale for "close enough". The median over all same-word pairs.
  function calibrate(library) {
    const distances = [];
    library.forEach(({ templates }) => {
      for (let i = 0; i < templates.length; i += 1) {
        for (let j = i + 1; j < templates.length; j += 1) {
          const distance = dtwDistance(templates[i], templates[j]);
          if (Number.isFinite(distance)) distances.push(distance);
        }
      }
    });
    if (!distances.length) {
      return null;
    }
    distances.sort((a, b) => a - b);
    return { typicalDistance: distances[Math.floor(distances.length / 2)], pairs: distances.length };
  }

  // Leave-one-out check of a profile: each sample is matched against all
  // the others. Shows which words are reliable and which get confused.
  function evaluateProfile(library, calibration, sensitivity) {
    const rule = decisionRule(calibration, sensitivity);
    return library.map(({ command, templates }) => {
      let recognized = 0;
      const confusedWith = new Set();
      templates.forEach((template) => {
        const result = decide(rankCommands(template, library, template), rule);
        if (result.accepted && result.command === command) {
          recognized += 1;
        } else if (result.command && result.command !== command) {
          confusedWith.add(result.command);
        } else if (result.runnerUp && result.runnerUp.command !== command && result.reason === "ambiguous") {
          confusedWith.add(result.runnerUp.command);
        }
      });
      return { command, recognized, total: templates.length, confusedWith: Array.from(confusedWith) };
    });
  }

  function concatFrames(frames) {
    const out = new Float32Array(frames.reduce((total, frame) => total + frame.length, 0));
    let offset = 0;
    frames.forEach((frame) => {
      out.set(frame, offset);
      offset += frame.length;
    });
    return out;
  }

  SceneMarks.VoiceFeatures = {
    COEFFS,
    FEATURE_DIM,
    FRAME_SAMPLES,
    SAMPLE_RATE,
    calibrate,
    concatFrames,
    createVad,
    decisionRule,
    dtwDistance,
    evaluateProfile,
    extractFeatures,
    frameDb,
    match,
    periodicity,
    prepareLibrary,
    withDeltas
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
