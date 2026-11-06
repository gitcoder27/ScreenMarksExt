// Offscreen voice engine: listens on the chosen mic, matches each
// utterance against the user's templates and sends recognized commands to
// the worker. It runs while settings.voice.enabled is on; the worker opens
// and closes this document.
//
// Offscreen documents get only chrome.runtime, so settings and templates
// come from the worker (VOICE_GET_CONFIG), which also says when they
// change. Status goes to open extension pages (popup, options) over a
// BroadcastChannel, and only while one of them is asking, so a quiet
// engine never wakes the worker or does work for nobody.
(function startVoiceEngine() {
  const { VoiceFeatures, VoiceCapture, Constants } = SceneMarks;
  const { MESSAGE_TYPES, VOICE_COOLDOWN_MS, VOICE_FEATURE_VERSION } = Constants;
  const STATUS_INTERVAL_MS = 1000;
  const INTEREST_MS = 6000;
  const HISTORY_LENGTH = 10;

  const channel = new BroadcastChannel(Constants.VOICE_STATUS_CHANNEL);

  let voice = { ...Constants.DEFAULT_SETTINGS.voice };
  let library = [];
  let calibration = null;
  let staleProfile = false;
  let lastCommandAt = 0;
  let suspendedUntil = 0;
  let interestUntil = 0;
  let listeningSince = null;
  let busyTotalMs = 0;
  let busyMaxPercent = 0;

  const counters = { utterances: 0, recognized: 0, rejected: 0, rejectedBy: {} };
  const history = [];
  let lastHeard = null;

  const capture = VoiceCapture.createCapture({
    getConfig: () => voice,
    onUtterance: handleUtterance,
    onRejected: (result) => {
      counters.rejected += 1;
      counters.rejectedBy[result.rejected] = (counters.rejectedBy[result.rejected] || 0) + 1;
      remember({ rejected: result.rejected });
    },
    onStateChange: (status) => {
      if (status.state === "open" && listeningSince === null) {
        listeningSince = performance.now();
      }
      if (status.state !== "open") {
        listeningSince = null;
      }
      publishSoon();
    }
  });

  function remember(entry) {
    history.unshift({ ...entry, at: Date.now() });
    history.length = Math.min(history.length, HISTORY_LENGTH);
  }

  function engineState() {
    if (!library.length) return staleProfile ? "retrain" : "not-trained";
    const state = capture.status.state;
    if (state === "open") return Date.now() < suspendedUntil ? "suspended" : "listening";
    return state; // opening | mic-error | closed
  }

  function snapshot(windowStats) {
    const listened = listeningSince === null ? 0 : performance.now() - listeningSince;
    return {
      kind: "engine-status",
      at: Date.now(),
      state: engineState(),
      trainedCommands: library.map(({ command }) => command),
      capture: { ...capture.status },
      window: windowStats,
      listeningSeconds: Math.round(listened / 1000),
      busyAvgPercent: listened ? Math.round((busyTotalMs / listened) * 10000) / 100 : 0,
      busyMaxPercent,
      counters: { ...counters, rejectedBy: { ...counters.rejectedBy } },
      history: history.slice(),
      lastHeard,
      rule: calibration ? VoiceFeatures.decisionRule(calibration, voice.sensitivity) : null
    };
  }

  function publish() {
    const windowStats = capture.takeWindowStats();
    busyTotalMs += windowStats.busyMs;
    // The first window after the mic opens includes setup.
    if (listeningSince !== null && performance.now() - listeningSince > 2 * STATUS_INTERVAL_MS) {
      busyMaxPercent = Math.max(busyMaxPercent, windowStats.busyPercent);
    }
    if (Date.now() < interestUntil) {
      channel.postMessage(snapshot(windowStats));
    }
  }

  let publishTimer = null;
  function publishSoon() {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publish, 50);
  }

  async function dispatch(command) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.VOICE_COMMAND,
        payload: { command }
      });
      return response || { ok: false, error: "No response." };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  async function handleUtterance(utterance) {
    counters.utterances += 1;
    if (!library.length || !calibration) {
      return;
    }
    const features = VoiceFeatures.extractFeatures(utterance.samples);
    if (!features) {
      counters.rejected += 1;
      counters.rejectedBy["no-features"] = (counters.rejectedBy["no-features"] || 0) + 1;
      return;
    }
    const result = VoiceFeatures.match(VoiceFeatures.withDeltas(features), library, calibration, voice.sensitivity);
    const heard = {
      command: result.command,
      accepted: result.accepted,
      reason: result.reason,
      distance: Math.round(result.distance * 100) / 100,
      threshold: Math.round(result.threshold * 100) / 100,
      ratio: result.ratio === null ? null : Math.round(result.ratio * 100) / 100,
      runnerUp: result.runnerUp ? result.runnerUp.command : null,
      at: Date.now()
    };

    const now = Date.now();
    if (result.accepted && now < suspendedUntil) {
      heard.outcome = "test-only";
    } else if (result.accepted && now - lastCommandAt < VOICE_COOLDOWN_MS) {
      heard.outcome = "cooldown";
    } else if (result.accepted) {
      lastCommandAt = now;
      counters.recognized += 1;
      heard.outcome = "sent";
      lastHeard = heard;
      remember({ command: result.command, accepted: true });
      publishSoon();
      const response = await dispatch(result.command);
      heard.result = response.ok ? (response.message || "Done") : (response.error || "Failed");
      heard.ok = Boolean(response.ok);
    } else {
      remember({ command: result.command, accepted: false, reason: result.reason });
    }
    lastHeard = heard;
    publishSoon();
  }

  function applyProfile(profile) {
    const usable = profile && profile.featureVersion === VOICE_FEATURE_VERSION ? profile : null;
    staleProfile = Boolean(profile && profile.commands && Object.keys(profile.commands).length && !usable);
    library = usable ? VoiceFeatures.prepareLibrary(usable) : [];
    calibration = library.length ? VoiceFeatures.calibrate(library) : null;
    if (!calibration) {
      library = [];
    }
  }

  async function loadConfig() {
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.VOICE_GET_CONFIG });
    } catch (_error) {
      response = null;
    }
    if (!response || !response.ok) {
      return false;
    }
    const previousMic = `${voice.micDeviceId}\n${voice.micLabel}`;
    voice = { ...voice, ...response.voice };
    applyProfile(response.profile);
    return previousMic !== `${voice.micDeviceId}\n${voice.micLabel}`;
  }

  // The mic is open only when there is something to listen for.
  async function syncCapture({ micChanged = false } = {}) {
    const shouldListen = library.length > 0;
    const isOpen = capture.status.state !== "closed";
    if (shouldListen && !isOpen) {
      await capture.start();
    } else if (!shouldListen && isOpen) {
      await capture.stop();
    } else if (shouldListen && micChanged) {
      capture.restart("mic-setting-changed");
    }
    publishSoon();
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== MESSAGE_TYPES.VOICE_CONFIG_CHANGED) {
      return false;
    }
    if (!sender || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
      return false;
    }
    loadConfig().then((micChanged) => syncCapture({
      micChanged: micChanged || capture.status.state === "mic-error"
    }));
    return false;
  });

  // Extension pages talk to the engine on the status channel:
  //   status-request  - "I am showing status": publish for a few seconds.
  //   suspend { ms }  - training or testing on the options page: keep
  //                     listening but run no commands until then.
  //   retry-mic       - the options page was just granted the microphone.
  //   reset-counters  - diagnostics.
  channel.onmessage = (event) => {
    const data = event.data || {};
    if (data.command === "retry-mic") {
      if (capture.status.state === "mic-error") capture.restart("permission-granted");
    } else if (data.command === "status-request") {
      interestUntil = Date.now() + INTEREST_MS;
      publishSoon();
    } else if (data.command === "suspend") {
      const ms = Math.min(Math.max(Number(data.ms) || 0, 0), 10000);
      suspendedUntil = Date.now() + ms;
    } else if (data.command === "reset-counters") {
      counters.utterances = 0;
      counters.recognized = 0;
      counters.rejected = 0;
      counters.rejectedBy = {};
      history.length = 0;
      busyTotalMs = 0;
      busyMaxPercent = 0;
      if (listeningSince !== null) listeningSince = performance.now();
      publishSoon();
    }
  };

  setInterval(publish, STATUS_INTERVAL_MS);
  loadConfig().then(() => syncCapture());
})();
