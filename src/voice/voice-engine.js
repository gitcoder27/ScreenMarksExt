// Offscreen voice engine. Phase 0 spike: open the chosen microphone, run
// the voice-activity gate, and report what it hears to open extension
// pages over a BroadcastChannel. No command matching yet.
//
// Offscreen documents get only chrome.runtime, so settings come from the
// worker (VOICE_GET_CONFIG), and the worker says when they change.
(function startVoiceEngine() {
  const { VoiceFeatures, Constants } = SceneMarks;
  const { MESSAGE_TYPES } = Constants;
  const FRAME = VoiceFeatures.FRAME_SAMPLES;
  const STATUS_INTERVAL_MS = 1000;
  const HISTORY_LENGTH = 10;

  const channel = new BroadcastChannel(Constants.VOICE_STATUS_CHANNEL);
  const vad = VoiceFeatures.createVad();

  let context = null;
  let node = null;
  let source = null;
  let stream = null;
  let config = { micDeviceId: "", micLabel: "" };
  let restartTimer = null;
  let opening = null;

  const status = {
    state: "starting",
    error: null,
    micMode: "default",
    micLabel: null,
    micNote: null,
    sampleRate: null,
    permission: null,
    pullMode: "worklet",
    frames: 0,
    framesPerSecond: 0,
    levelDb: -100,
    noiseFloorDb: vad.noiseFloorDb,
    speaking: false,
    gateOpenMs: 0,
    quietDb: -100,
    utterances: 0,
    rejected: 0,
    rejectedBy: {},
    history: [],
    busyPercent: 0,
    busyAvgPercent: 0,
    busyMaxPercent: 0,
    listeningSeconds: 0,
    micRestarts: 0
  };

  // Main-thread time spent handling audio, as a share of wall time. The
  // audio thread itself only copies buffers.
  let busyMs = 0;
  let busyTotalMs = 0;
  let windowStart = performance.now();
  let listeningSince = null;
  let framesInWindow = 0;
  let peakDbInWindow = -100;
  let quietDbInWindow = 0;

  function roundPercent(value) {
    return Math.round(value * 100) / 100;
  }

  function resetCounters() {
    status.frames = 0;
    status.utterances = 0;
    status.rejected = 0;
    status.rejectedBy = {};
    status.history = [];
    status.busyMaxPercent = 0;
    busyTotalMs = 0;
    listeningSince = listeningSince === null ? null : performance.now();
  }

  function publish() {
    const now = performance.now();
    const elapsed = Math.max(1, now - windowStart);
    status.busyPercent = roundPercent((busyMs / elapsed) * 100);
    // The first window after a (re)start includes setup; skip it for max.
    if (listeningSince !== null && now - listeningSince > 2 * STATUS_INTERVAL_MS) {
      status.busyMaxPercent = Math.max(status.busyMaxPercent, status.busyPercent);
    }
    status.framesPerSecond = Math.round((framesInWindow / elapsed) * 1000);
    status.levelDb = Math.round(peakDbInWindow);
    status.quietDb = Math.round(quietDbInWindow);
    status.gateOpenMs = vad.openFrames * 10;
    status.noiseFloorDb = Math.round(vad.noiseFloorDb);
    if (listeningSince !== null) {
      const listened = now - listeningSince;
      status.listeningSeconds = Math.round(listened / 1000);
      status.busyAvgPercent = roundPercent((busyTotalMs / Math.max(1, listened)) * 100);
    }
    busyMs = 0;
    framesInWindow = 0;
    windowStart = now;
    peakDbInWindow = -100;
    quietDbInWindow = 0;
    channel.postMessage({ ...status, at: Date.now() });
  }

  function remember(entry) {
    status.history.unshift({ ...entry, at: Date.now() });
    status.history.length = Math.min(status.history.length, HISTORY_LENGTH);
  }

  function handleBatch(samples) {
    const t0 = performance.now();
    for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
      const frame = samples.subarray(start, start + FRAME);
      status.frames += 1;
      framesInWindow += 1;
      const db = VoiceFeatures.frameDb(frame, 0, FRAME);
      if (db > peakDbInWindow) {
        peakDbInWindow = db;
      }
      if (db < quietDbInWindow) {
        quietDbInWindow = db;
      }
      const result = vad.push(frame);
      status.speaking = vad.active;
      if (result && result.frames) {
        status.utterances += 1;
        remember({ ms: result.frames.length * 10 });
      } else if (result && result.rejected) {
        status.rejected += 1;
        status.rejectedBy[result.rejected] = (status.rejectedBy[result.rejected] || 0) + 1;
        remember({ rejected: result.rejected });
      }
    }
    const spent = performance.now() - t0;
    busyMs += spent;
    busyTotalMs += spent;
  }

  async function loadConfig() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.VOICE_GET_CONFIG });
      if (response && response.ok) {
        config = { micDeviceId: response.micDeviceId || "", micLabel: response.micLabel || "" };
      }
    } catch (_error) {
      // Keep the last config; the default mic still works.
    }
  }

  // A pinned mic is found by ID, then by label (IDs can change when a
  // device is re-paired). If it is not connected, use the system default.
  async function resolveDevice() {
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
    status.micNote = `Chosen mic "${config.micLabel || config.micDeviceId}" is not connected; using the system default.`;
    return null;
  }

  async function ensureGraph() {
    if (context) {
      return;
    }
    context = new AudioContext({ sampleRate: VoiceFeatures.SAMPLE_RATE });
    status.sampleRate = context.sampleRate;
    await context.audioWorklet.addModule("capture-worklet.js");
    node = new AudioWorkletNode(context, "scenemarks-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { batchSamples: FRAME * 10 }
    });
    node.port.onmessage = (event) => handleBatch(event.data);
  }

  function closeMic() {
    if (source) {
      source.disconnect();
      source = null;
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  }

  async function openMicNow() {
    const deviceId = await resolveDevice();
    const audio = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (deviceId) {
      audio.deviceId = { exact: deviceId };
    }

    let next;
    try {
      next = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (error) {
      closeMic();
      status.state = "mic-error";
      status.error = `${error.name}: ${error.message}`;
      publish();
      return;
    }

    closeMic();
    stream = next;
    const track = stream.getAudioTracks()[0];
    status.micLabel = track ? track.label : null;
    status.error = null;
    if (track) {
      track.addEventListener("ended", () => scheduleRestart("mic-ended"));
    }

    await ensureGraph();
    source = context.createMediaStreamSource(stream);
    source.connect(node);
    if (context.state === "suspended") {
      await context.resume().catch(() => {});
    }
    vad.reset();
    if (listeningSince === null) {
      listeningSince = performance.now();
      checkPull();
    }
    status.state = "listening";
    publish();
  }

  // Serialize opens so a burst of device changes cannot interleave.
  function openMic() {
    opening = (opening || Promise.resolve()).then(openMicNow, openMicNow);
    return opening;
  }

  function scheduleRestart(reason) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      status.micRestarts += 1;
      status.lastRestartReason = reason;
      openMic();
    }, 500);
  }

  // A sink node with no outputs should still be pulled; if this browser
  // does not, route the mic through a muted gain to the destination.
  function checkPull() {
    setTimeout(() => {
      if (status.frames > 0 || !source) {
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

  async function start() {
    try {
      const permission = await navigator.permissions.query({ name: "microphone" });
      status.permission = permission.state;
      permission.onchange = () => {
        status.permission = permission.state;
      };
    } catch (_error) {
      status.permission = "unknown";
    }
    await loadConfig();
    await openMic();
  }

  // Plugging headphones in or out changes the default input and can take
  // a pinned mic away or bring it back, so re-pick the mic.
  navigator.mediaDevices.addEventListener("devicechange", () => scheduleRestart("device-change"));

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== MESSAGE_TYPES.VOICE_CONFIG_CHANGED) {
      return false;
    }
    if (!sender || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
      return false;
    }
    loadConfig().then(() => scheduleRestart("mic-setting-changed"));
    return false;
  });

  channel.onmessage = (event) => {
    if (event.data && event.data.command === "reset-counters") {
      resetCounters();
      publish();
    }
  };

  setInterval(publish, STATUS_INTERVAL_MS);
  start().catch((error) => {
    status.state = "error";
    status.error = (error && error.message) || String(error);
    publish();
  });
})();
