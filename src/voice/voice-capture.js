// Microphone capture shared by the offscreen voice engine and the options
// page's training screen, so a recorded template and a live command go
// through exactly the same pipeline: the chosen mic -> 16 kHz AudioWorklet
// -> voice-activity gate -> utterance callback.
//
// Browser-only (getUserMedia, AudioContext); the pure parts live in
// voice-features.js.
(function attachVoiceCapture(root) {
  const SceneMarks = root.SceneMarks || {};
  const { VoiceFeatures } = SceneMarks;
  const FRAME = VoiceFeatures.FRAME_SAMPLES;
  const WORKLET_URL = new URL("capture-worklet.js", root.document && root.document.currentScript
    ? root.document.currentScript.src
    : root.location.href).href;

  // options.getConfig() -> { micDeviceId, micLabel }
  // options.onUtterance({ samples, frames, ... })  a speech-like sound
  // options.onRejected({ rejected, ... })           a sound that was not
  // options.onStateChange(status)                   mic opened/failed/closed
  // options.onAudio(samples)                         every raw batch (troubleshooting)
  function createCapture(options) {
    const vad = VoiceFeatures.createVad();
    let context = null;
    let node = null;
    let source = null;
    let stream = null;
    let restartTimer = null;
    let opening = Promise.resolve();
    let wanted = false;
    let pullChecked = false;
    let deviceListener = null;

    const status = {
      state: "closed", // closed | opening | open | mic-error
      error: null,
      errorName: null,
      micMode: "default",
      micLabel: null,
      micNote: null,
      sampleRate: null,
      pullMode: "worklet",
      frames: 0,
      micRestarts: 0,
      lastRestartReason: null
    };

    // Per-window stats, read and reset by takeWindowStats().
    let busyMs = 0;
    let framesInWindow = 0;
    let peakDb = -100;
    let quietDb = 0;
    let windowStart = performance.now();

    function setState(state, error) {
      status.state = state;
      status.error = error ? `${error.name}: ${error.message}` : null;
      status.errorName = error ? error.name : null;
      if (options.onStateChange) options.onStateChange(status);
    }

    function handleBatch(samples) {
      const t0 = performance.now();
      if (options.onAudio) options.onAudio(samples);
      for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
        const frame = samples.subarray(start, start + FRAME);
        status.frames += 1;
        framesInWindow += 1;
        const db = VoiceFeatures.frameDb(frame, 0, FRAME);
        if (db > peakDb) peakDb = db;
        if (db < quietDb) quietDb = db;
        const result = vad.push(frame);
        if (result && result.frames) {
          if (options.onUtterance) {
            options.onUtterance({ ...result, samples: VoiceFeatures.concatFrames(result.frames) });
          }
        } else if (result && result.rejected && options.onRejected) {
          options.onRejected(result);
        }
      }
      busyMs += performance.now() - t0;
    }

    // A pinned mic is found by ID, then by label (IDs can change when a
    // device is re-paired). If it is not connected, use the system default.
    async function resolveDevice() {
      const config = options.getConfig() || {};
      status.micNote = null;
      if (!config.micDeviceId) {
        status.micMode = "default";
        return null;
      }
      status.micMode = "pinned";
      const inputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "audioinput");
      const match = inputs.find((device) => device.deviceId === config.micDeviceId)
        || (config.micLabel && inputs.find((device) => device.label === config.micLabel));
      if (match) {
        return match.deviceId;
      }
      status.micMode = "pinned-missing";
      status.micNote = `Chosen mic "${config.micLabel || "unknown"}" is not connected; using the system default.`;
      return null;
    }

    async function ensureGraph() {
      if (context) {
        return;
      }
      context = new AudioContext({ sampleRate: VoiceFeatures.SAMPLE_RATE });
      status.sampleRate = context.sampleRate;
      await context.audioWorklet.addModule(WORKLET_URL);
      node = new AudioWorkletNode(context, "scenemarks-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { batchSamples: FRAME * 10 }
      });
      node.port.onmessage = (event) => handleBatch(event.data);
    }

    function releaseMic() {
      if (source) {
        source.disconnect();
        source = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
    }

    // A sink node with no outputs should still be pulled; if this browser
    // does not, route the mic through a muted gain to the destination.
    function checkPull() {
      if (pullChecked) return;
      pullChecked = true;
      const framesAtStart = status.frames;
      setTimeout(() => {
        if (status.frames > framesAtStart || !source) {
          return;
        }
        status.pullMode = "muted-destination";
        node.disconnect();
        node = new AudioWorkletNode(context, "scenemarks-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          processorOptions: { batchSamples: FRAME * 10 }
        });
        node.port.onmessage = (event) => handleBatch(event.data);
        const mute = context.createGain();
        mute.gain.value = 0;
        source.disconnect();
        source.connect(node).connect(mute).connect(context.destination);
      }, 1500);
    }

    async function openNow() {
      if (!wanted) {
        return;
      }
      setState("opening");
      const deviceId = await resolveDevice();
      // The browser's call processing is off. Noise suppression removes
      // the soft consonants that tell words apart ("s" in pause, "k-s-t" in
      // next), and auto-gain lifts the room noise after every word, which
      // holds the voice gate open. Matching is against the user's own voice
      // through the same mic, so raw audio is what both sides should see.
      // (Echo cancellation is moot with headphones or a muted Mac.)
      const audio = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      };
      if (deviceId) {
        audio.deviceId = { exact: deviceId };
      }

      let next;
      try {
        next = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (error) {
        releaseMic();
        setState("mic-error", error);
        return;
      }
      if (!wanted) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }

      releaseMic();
      stream = next;
      const track = stream.getAudioTracks()[0];
      status.micLabel = track ? track.label : null;
      if (track) {
        track.addEventListener("ended", () => restart("mic-ended"));
      }

      await ensureGraph();
      source = context.createMediaStreamSource(stream);
      source.connect(node);
      if (context.state === "suspended") {
        await context.resume().catch(() => {});
      }
      vad.reset();
      checkPull();
      setState("open");
    }

    // Opens are serialized so a burst of device changes cannot interleave.
    function open() {
      opening = opening.then(openNow, openNow);
      return opening;
    }

    function start() {
      wanted = true;
      if (!deviceListener) {
        // Plugging headphones in or out changes the default input and can
        // take a pinned mic away or bring it back, so pick the mic again.
        deviceListener = () => restart("device-change");
        navigator.mediaDevices.addEventListener("devicechange", deviceListener);
      }
      return open();
    }

    function restart(reason) {
      if (!wanted) return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        status.micRestarts += 1;
        status.lastRestartReason = reason;
        open();
      }, 500);
    }

    // Closes the mic (the browser's recording indicator goes away) and the
    // audio context.
    async function stop() {
      wanted = false;
      clearTimeout(restartTimer);
      if (deviceListener) {
        navigator.mediaDevices.removeEventListener("devicechange", deviceListener);
        deviceListener = null;
      }
      await opening.catch(() => {});
      releaseMic();
      if (context) {
        await context.close().catch(() => {});
        context = null;
        node = null;
        pullChecked = false;
      }
      vad.reset();
      setState("closed");
    }

    function takeWindowStats() {
      const now = performance.now();
      const elapsed = Math.max(1, now - windowStart);
      const stats = {
        busyMs,
        elapsedMs: elapsed,
        busyPercent: Math.round((busyMs / elapsed) * 10000) / 100,
        framesPerSecond: Math.round((framesInWindow / elapsed) * 1000),
        levelDb: Math.round(peakDb),
        quietDb: Math.round(quietDb),
        noiseFloorDb: Math.round(vad.noiseFloorDb),
        speaking: vad.active,
        gateOpenMs: vad.openFrames * 10
      };
      busyMs = 0;
      framesInWindow = 0;
      peakDb = -100;
      quietDb = 0;
      windowStart = now;
      return stats;
    }

    return { start, stop, restart, status, takeWindowStats };
  }

  SceneMarks.VoiceCapture = { createCapture };
  root.SceneMarks = SceneMarks;
})(globalThis);
