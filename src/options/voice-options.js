// Options -> Voice Commands: microphone permission and choice, recording
// the user's word templates, a test mode, and engine diagnostics.
//
// Recording and testing use their own capture on this page (the same
// pipeline as the offscreen engine, from voice-capture.js). While either
// runs, the engine is told to suspend, so practising "skip" here does not
// switch tabs. Templates are saved through the worker (single writer).
(function initializeVoiceOptions() {
  const { Constants, VoiceFeatures, VoiceCapture } = SceneMarks;
  const { MAX_VOICE_SAMPLES, VOICE_COMMANDS, VOICE_FEATURE_VERSION, VOICE_STATUS_CHANNEL, STORAGE_KEYS } = Constants;
  const Storage = SceneMarks.Storage.createClient();
  const SUSPEND_MS = 4000;
  const SAMPLE_TIMEOUT_MS = 10000;

  const REJECTION_TEXT = {
    click: "ignored a tap or click",
    "no-voice": "ignored a sound that was not a voice",
    "too-short": "ignored a sound too short for a word",
    "too-long": "ignored a sound too long for a command"
  };
  // What to try when the same kind of sound is ignored again and again.
  const REJECTION_ADVICE = {
    click: "Keep the mic away from taps and the keyboard while you speak.",
    "no-voice": "Speak a little louder or closer to the mic.",
    "too-short": "Say the whole word clearly, not clipped.",
    "too-long": "Leave a short pause before and after the word, and say only the word."
  };
  const MAX_EXTRA_TAKES = 2;
  // A take this much farther from the other two than they are from each
  // other was probably said differently (or clipped): it is re-taken.
  const OUTLIER_RATIO = 1.6;
  const ENGINE_STATE_TEXT = {
    listening: "Listening",
    suspended: "Listening (commands paused while this page records or tests)",
    opening: "Starting the microphone",
    "mic-error": "Microphone unavailable",
    "not-trained": "Waiting: no words recorded yet",
    "waiting-for-video": "Waiting for a tab with a video (microphone closed)",
    retrain: "Waiting: words were recorded with an older version; record them again",
    closed: "Microphone closed"
  };

  let voiceSettings = { ...Constants.DEFAULT_SETTINGS.voice };
  let profile = { featureVersion: VOICE_FEATURE_VERSION, commands: {} };
  let library = [];
  let calibration = null;
  let channel = null;
  let engineStatus = null;
  let suspendTimer = null;
  let session = null; // { kind: "record", command, samples, timer } | { kind: "test" }
  let meterTimer = null;
  let pageMicLine = "";

  function byId(id) {
    return document.getElementById(id);
  }

  // ---- Troubleshooting recording -----------------------------------------
  // The raw audio of this page's recording and test sessions, with what the
  // voice gate decided and when, kept in memory only (at most the last 3
  // minutes) and saved to a file only when the user asks. It lets the
  // recognizer be tuned against a real voice and room.
  const debugRecorder = (() => {
    const MAX_SAMPLES = 3 * 60 * VoiceFeatures.SAMPLE_RATE;
    let chunks = [];
    let total = 0;
    let dropped = 0;
    let events = [];

    function toInt16(samples) {
      const out = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) {
        out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
      }
      return out;
    }

    return {
      add(samples) {
        chunks.push(toInt16(samples));
        total += samples.length;
        while (total - dropped > MAX_SAMPLES && chunks.length > 1) {
          dropped += chunks.shift().length;
        }
        events = events.filter((event) => event.atSample >= dropped);
      },
      // Called while the batch that finished the sound is being handled.
      mark(kind, command, outcome, lengthSamples) {
        events.push({ atSample: total, kind, command: command || null, outcome, lengthSamples: lengthSamples || null });
      },
      get seconds() {
        return (total - dropped) / VoiceFeatures.SAMPLE_RATE;
      },
      build() {
        const pcm = new Int16Array(total - dropped);
        let offset = 0;
        chunks.forEach((chunk) => {
          pcm.set(chunk, offset);
          offset += chunk.length;
        });
        let binary = "";
        const bytes = new Uint8Array(pcm.buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return {
          kind: "scenemarks-voice-recording",
          version: 1,
          createdAt: new Date().toISOString(),
          featureVersion: VOICE_FEATURE_VERSION,
          sampleRate: VoiceFeatures.SAMPLE_RATE,
          micLabel: capture.status.micLabel,
          sensitivity: voiceSettings.sensitivity,
          startSample: dropped,
          events,
          pcm16Base64: btoa(binary)
        };
      }
    };
  })();

  function saveDebugRecording() {
    if (!debugRecorder.seconds) {
      byId("voiceCopyResult").textContent = "Nothing recorded yet: record or test some words on this page first.";
      return;
    }
    const blob = new Blob([JSON.stringify(debugRecorder.build())], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `scenemarks-voice-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    byId("voiceCopyResult").textContent = `Saved ${Math.round(debugRecorder.seconds)} s of recording to your Downloads folder.`;
  }

  // ---- Shared capture for recording and testing ----------------------
  const capture = VoiceCapture.createCapture({
    getConfig: () => voiceSettings,
    onAudio: (samples) => debugRecorder.add(samples),
    onUtterance: (utterance) => {
      debugRecorder.mark(session ? session.kind : "idle", session && session.command, "word", utterance.samples.length);
      if (session && session.kind === "record") handleRecordedUtterance(utterance);
      else if (session && session.kind === "test") handleTestUtterance(utterance);
    },
    onRejected: (result) => {
      debugRecorder.mark(session ? session.kind : "idle", session && session.command, result.rejected);
      if (!session) return;
      const text = REJECTION_TEXT[result.rejected] || "ignored a sound";
      if (session.kind === "record") handleRecordedRejection(result.rejected);
      else setTestResult(`Not a word (${text}).`, false);
    },
    onStateChange: (status) => {
      if (status.state === "mic-error" && session) {
        const message = status.errorName === "NotAllowedError"
          ? "The microphone is blocked. Click Allow Microphone, and check System Settings → Privacy & Security → Microphone."
          : `The microphone could not start (${status.error}).`;
        if (session.kind === "record") setTrainStatus(message, true);
        else setTestResult(message, true);
        endSession();
      }
    }
  });

  function suspendEngine() {
    if (channel) channel.postMessage({ command: "suspend", ms: SUSPEND_MS });
  }

  function startMeter() {
    clearInterval(meterTimer);
    meterTimer = setInterval(() => {
      const stats = capture.takeWindowStats();
      const fill = byId("voiceMeterFill");
      fill.style.width = `${Math.max(0, Math.min(100, (stats.levelDb + 80) * 1.25))}%`;
      fill.classList.toggle("is-speaking", stats.speaking);
    }, 150);
  }

  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
    const fill = byId("voiceMeterFill");
    fill.style.width = "0";
    fill.classList.remove("is-speaking");
  }

  async function beginSession(next) {
    endSession();
    session = next;
    suspendEngine();
    suspendTimer = setInterval(suspendEngine, SUSPEND_MS / 2);
    startMeter();
    await capture.start();
  }

  function endSession() {
    if (session && session.timer) clearTimeout(session.timer);
    session = null;
    clearInterval(suspendTimer);
    suspendTimer = null;
    stopMeter();
    capture.stop();
    byId("voiceTestButton").textContent = "Start Test";
    renderWords();
  }

  // ---- Recording -------------------------------------------------------
  function commandInfo(id) {
    return VOICE_COMMANDS.find((command) => command.id === id);
  }

  function recordPrompt() {
    if (!session || session.kind !== "record") return "";
    const info = commandInfo(session.command);
    const take = Math.min(session.takes.length + 1, MAX_VOICE_SAMPLES);
    return `Say "${info.say}" (or your own word) · take ${take} of ${MAX_VOICE_SAMPLES}`;
  }

  function setTrainStatus(text, isError) {
    const node = byId("voiceTrainStatus");
    node.textContent = text;
    node.classList.toggle("is-error", Boolean(isError));
  }

  // The prompt, plus what just happened in a quieter second sentence.
  function promptWith(note) {
    setTrainStatus(note ? `${recordPrompt()} · ${note}` : recordPrompt(), false);
  }

  function armSampleTimeout() {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (!session || session.kind !== "record") return;
      setTrainStatus("Nothing heard for 10 seconds, so recording stopped. Check that the meter moves when you speak, then click Record again.", true);
      endSession();
    }, SAMPLE_TIMEOUT_MS);
  }

  async function startRecording(command) {
    await beginSession({ kind: "record", command, takes: [], extraTakes: 0, rejections: [], timer: null });
    if (!session) return;
    promptWith("");
    armSampleTimeout();
    renderWords();
  }

  function handleRecordedRejection(reason) {
    session.rejections.push(reason);
    const recent = session.rejections.slice(-3);
    const repeated = recent.length === 3 && recent.every((item) => item === reason);
    promptWith(repeated
      ? `${REJECTION_TEXT[reason]} three times. ${REJECTION_ADVICE[reason] || ""}`.trim()
      : REJECTION_TEXT[reason] || "ignored a sound");
  }

  // Mean DTW distance of each take to the others; the take that sits far
  // from a consistent pair is the odd one out.
  function findOutlier(takes) {
    if (takes.length < 3) return -1;
    const prepared = takes.map((take) => VoiceFeatures.withDeltas(take));
    const distance = (i, j) => VoiceFeatures.dtwDistance(prepared[i], prepared[j]);
    const pairs = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => ({ i, j, d: distance(i, j) }));
    let worst = -1;
    let worstRatio = 0;
    for (let k = 0; k < 3; k += 1) {
      const others = pairs.find((pair) => pair.i !== k && pair.j !== k);
      const own = pairs.filter((pair) => pair.i === k || pair.j === k).map((pair) => pair.d);
      const mean = (own[0] + own[1]) / 2;
      const ratio = Number.isFinite(mean) ? mean / Math.max(others.d, 1e-6) : Infinity;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worst = k;
      }
    }
    return worstRatio >= OUTLIER_RATIO ? worst : -1;
  }

  // The words already saved, plus this one, checked the way the engine
  // will see them: which of the new word's takes would be mistaken.
  function confusionFor(command, takes) {
    const usable = profile.featureVersion === VOICE_FEATURE_VERSION ? profile.commands : {};
    const candidate = VoiceFeatures.prepareLibrary({ commands: { ...usable, [command]: takes } });
    const candidateCalibration = VoiceFeatures.calibrate(candidate);
    if (!candidateCalibration) return null;
    return VoiceFeatures.evaluateProfile(candidate, candidateCalibration, voiceSettings.sensitivity)
      .find((entry) => entry.command === command) || null;
  }

  async function handleRecordedUtterance(utterance) {
    const features = VoiceFeatures.extractFeatures(utterance.samples);
    if (!features) {
      handleRecordedRejection("no-voice");
      return;
    }
    session.takes.push(features);
    session.rejections = [];
    armSampleTimeout();
    renderWords();
    if (session.takes.length < MAX_VOICE_SAMPLES) {
      promptWith(`take ${session.takes.length} done`);
      return;
    }

    const outlier = findOutlier(session.takes);
    if (outlier >= 0 && session.extraTakes < MAX_EXTRA_TAKES) {
      session.takes.splice(outlier, 1);
      session.extraTakes += 1;
      renderWords();
      promptWith(`take ${outlier + 1} sounded different from the other two; say it once more, the same way`);
      return;
    }

    const { command, takes } = session;
    endSession();
    setTrainStatus("Saving…", false);
    try {
      const result = await Storage.saveVoiceSamples(command, takes);
      if (!result.ok) throw new Error(result.error);
      await loadProfile();
      const check = qualityFor(command) || confusionFor(command, takes);
      const label = `"${commandInfo(command).say}"`;
      if (check && check.confusedWith.length) {
        const others = check.confusedWith.map((id) => `"${commandInfo(id).say}"`).join(" and ");
        setTrainStatus(`Saved ${label}, but it sounds a lot like ${others}. Record one of them again, saying each word distinctly, or pick a more different word.`, true);
      } else if (check && check.recognized < check.total) {
        setTrainStatus(`Saved ${label}. ${qualityText(check)}`, true);
      } else {
        setTrainStatus(`Saved ${label}. All ${takes.length} takes are recognized.`, false);
      }
    } catch (error) {
      setTrainStatus(`Saving failed: ${error.message}`, true);
    }
  }

  async function clearWord(command) {
    if (session) endSession();
    try {
      await Storage.clearVoiceProfile(command);
      await loadProfile();
      setTrainStatus(command ? `Cleared "${commandInfo(command).label}".` : "Cleared all words.", false);
    } catch (error) {
      setTrainStatus(`Clearing failed: ${error.message}`, true);
    }
  }

  // ---- Quality check ----------------------------------------------------
  let quality = [];

  function qualityFor(command) {
    return quality.find((entry) => entry.command === command) || null;
  }

  function qualityText(entry) {
    if (!entry) return "";
    if (entry.recognized === entry.total) return `Recognized ${entry.recognized} of ${entry.total} takes.`;
    const confused = entry.confusedWith.map((id) => `"${commandInfo(id).say}"`).join(", ");
    return confused
      ? `Recognized ${entry.recognized} of ${entry.total} takes; sounds like ${confused}. Try a more different word or record again.`
      : `Recognized ${entry.recognized} of ${entry.total} takes. Record it again, saying it the same way each time.`;
  }

  async function loadProfile() {
    profile = await Storage.getVoiceProfile();
    const usable = profile.featureVersion === VOICE_FEATURE_VERSION;
    library = usable ? VoiceFeatures.prepareLibrary(profile) : [];
    calibration = library.length ? VoiceFeatures.calibrate(library) : null;
    quality = calibration ? VoiceFeatures.evaluateProfile(library, calibration, voiceSettings.sensitivity) : [];
    renderWords();
  }

  function renderWords() {
    const list = byId("voiceWordList");
    list.replaceChildren();
    const stale = profile.featureVersion !== VOICE_FEATURE_VERSION;
    for (const info of VOICE_COMMANDS) {
      const samples = (profile.commands[info.id] || []).length;
      const recording = session && session.kind === "record" && session.command === info.id;
      const item = document.createElement("li");
      item.className = `voice-word${recording ? " is-recording" : ""}`;

      const name = document.createElement("span");
      name.className = "voice-word__name";
      name.textContent = `${info.label} (e.g. "${info.say}")`;

      const detail = document.createElement("span");
      detail.className = "voice-word__detail";
      const check = qualityFor(info.id);
      if (recording) {
        const marks = Array.from({ length: MAX_VOICE_SAMPLES }, (_, i) => (i < session.takes.length ? "✓" : "○"));
        detail.textContent = `Recording: takes ${marks.join(" ")}${session.extraTakes ? ` (re-take ${session.extraTakes})` : ""}`;
      } else if (!samples) {
        detail.textContent = "Not recorded";
      } else if (stale) {
        detail.textContent = "Recorded with an older version. Record again.";
        detail.classList.add("is-warning");
      } else if (check) {
        detail.textContent = qualityText(check);
        detail.classList.add(check.recognized === check.total ? "is-good" : "is-warning");
      } else {
        detail.textContent = `${samples} of ${MAX_VOICE_SAMPLES} takes recorded`;
      }

      const actions = document.createElement("span");
      actions.className = "voice-word__actions";
      const record = document.createElement("button");
      record.type = "button";
      record.className = "secondary-button";
      record.textContent = recording ? "Cancel" : samples ? "Record Again" : "Record";
      record.addEventListener("click", () => {
        if (recording) {
          endSession();
          setTrainStatus("Recording cancelled.", false);
        } else {
          startRecording(info.id);
        }
      });
      actions.append(record);
      if (samples && !recording) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "secondary-button";
        clear.textContent = "Clear";
        clear.addEventListener("click", () => clearWord(info.id));
        actions.append(clear);
      }

      item.append(name, actions, detail);
      list.append(item);
    }
    byId("voiceClearAllButton").disabled = !Object.keys(profile.commands).length;
  }

  // ---- Test mode ----------------------------------------------------------
  function setTestResult(text, isError) {
    const node = byId("voiceTestResult");
    node.textContent = text;
    node.classList.toggle("is-error", Boolean(isError));
  }

  async function toggleTest() {
    if (session && session.kind === "test") {
      endSession();
      setTestResult("Test stopped.", false);
      return;
    }
    if (!library.length || !calibration) {
      setTestResult("Record at least one word (3 takes) first.", true);
      return;
    }
    await beginSession({ kind: "test" });
    if (!session) return;
    byId("voiceTestButton").textContent = "Stop Test";
    setTestResult("Listening. Say one of your words.", false);
  }

  function handleTestUtterance(utterance) {
    const features = VoiceFeatures.extractFeatures(utterance.samples);
    if (!features) {
      setTestResult("Too quiet: ignored.", false);
      return;
    }
    const result = VoiceFeatures.match(VoiceFeatures.withDeltas(features), library, calibration, voiceSettings.sensitivity);
    const nearest = result.command ? `"${commandInfo(result.command).say}"` : "nothing";
    const score = `distance ${result.distance.toFixed(2)}, limit ${result.threshold.toFixed(2)}`;
    if (result.accepted) {
      setTestResult(`Heard ${nearest}: ${commandInfo(result.command).label} (${score})`, false);
    } else if (result.reason === "ambiguous") {
      const other = result.runnerUp ? `"${commandInfo(result.runnerUp.command).say}"` : "another word";
      setTestResult(`Not sure: between ${nearest} and ${other}, so nothing would run (${score}).`, true);
    } else {
      setTestResult(`No command: closest is ${nearest}, but not close enough (${score}).`, true);
    }
  }

  // ---- Settings: on/off, mic ------------------------------------------
  async function saveVoice(updates, message) {
    try {
      const saved = await Storage.updateSettings({ voice: updates });
      voiceSettings = saved.voice;
      if (message) byId("voiceCopyResult").textContent = message;
      return true;
    } catch (error) {
      byId("voiceCopyResult").textContent = `Saving failed: ${error.message}`;
      return false;
    }
  }

  async function permissionState() {
    try {
      return (await navigator.permissions.query({ name: "microphone" })).state;
    } catch (_error) {
      return "unknown";
    }
  }

  async function renderPermission() {
    const state = await permissionState();
    byId("voicePermissionLabel").textContent = state === "granted"
      ? "Microphone allowed."
      : state === "denied"
        ? "Microphone blocked. Allow it from the address bar's site settings for this page, then reload."
        : "Not allowed yet. Click Allow Microphone (the browser asks once).";
    byId("voiceGrantButton").hidden = state === "granted";
  }

  async function grant() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pageMicLine = stream.getAudioTracks()[0]?.label || "";
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      byId("voicePermissionLabel").textContent = `Microphone not allowed (${error.name}).`;
      return;
    }
    await renderPermission();
    await renderMicOptions();
    if (channel) channel.postMessage({ command: "retry-mic" });
  }

  // Chrome lists virtual "default" and "communications" entries next to
  // the real inputs; "default" is labelled "Default - <current device>".
  async function renderMicOptions() {
    const select = byId("voiceMicSelect");
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    const systemDefault = devices.find((device) => device.deviceId === "default");
    const real = devices.filter((device) => device.deviceId !== "default" && device.deviceId !== "communications");
    const hasLabels = real.some((device) => device.label);

    select.replaceChildren();
    const addOption = (value, text) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    };
    const currentDefault = systemDefault && systemDefault.label ? systemDefault.label.replace(/^Default - /, "") : null;
    addOption("", `System default${currentDefault ? ` (now: ${currentDefault})` : ""}`);
    real.forEach((device) => addOption(device.deviceId, device.label || "Microphone (allow access to see its name)"));

    const { micDeviceId, micLabel } = voiceSettings;
    if (micDeviceId && !real.some((device) => device.deviceId === micDeviceId)) {
      const byLabel = micLabel && real.find((device) => device.label === micLabel);
      if (byLabel) {
        select.value = byLabel.deviceId;
      } else {
        addOption(micDeviceId, `${micLabel || "Chosen mic"} (not connected)`);
        select.value = micDeviceId;
      }
    } else {
      select.value = micDeviceId;
    }

    byId("voiceMicHint").textContent = hasLabels
      ? "System default follows macOS: your headphone mic while it is plugged in, the built-in mic otherwise. Pick a mic to always use it, even with headphones plugged in."
      : "Click Allow Microphone to see your microphones by name.";
  }

  async function saveMic() {
    const select = byId("voiceMicSelect");
    const option = select.selectedOptions[0];
    const micDeviceId = select.value;
    const micLabel = micDeviceId ? (option.textContent || "").replace(/ \(not connected\)$/, "") : "";
    await saveVoice({ micDeviceId, micLabel }, "Microphone saved.");
    if (session) capture.restart("mic-setting-changed");
  }

  // ---- Engine diagnostics ---------------------------------------------
  const REJECTION_NAMES = {
    click: "tap/click", "no-voice": "no voice", "too-short": "too short", "too-long": "too long", "no-features": "too quiet"
  };

  function describeHistory(entry) {
    if (entry.rejected) return `ignored: ${REJECTION_NAMES[entry.rejected] || entry.rejected}`;
    if (entry.accepted) return `RAN ${entry.command}`;
    return `not a command (${entry.reason}, nearest ${entry.command})`;
  }

  function diagnosticsLines() {
    if (!voiceSettings.enabled) return ["Voice commands are off."];
    const s = engineStatus;
    if (!s || Date.now() - s.at > 4000) return ["Voice commands are on, but the listener has not reported yet."];
    const c = s.capture;
    const w = s.window || {};
    const rejected = Object.entries(s.counters.rejectedBy).map(([k, v]) => `${REJECTION_NAMES[k] || k} ${v}`).join(", ");
    const last = s.lastHeard
      ? `${s.lastHeard.command || "-"} ${s.lastHeard.accepted ? "accepted" : `rejected (${s.lastHeard.reason})`}, distance ${s.lastHeard.distance} / limit ${s.lastHeard.threshold}${s.lastHeard.result ? `, result: ${s.lastHeard.result}` : ""}${s.lastHeard.outcome && s.lastHeard.outcome !== "sent" ? ` [${s.lastHeard.outcome}]` : ""}`
      : "none";
    return [
      `Listener: ${ENGINE_STATE_TEXT[s.state] || s.state}${c.error ? ` (${c.error})` : ""}`,
      `Words trained: ${s.trainedCommands.join(", ") || "none"}`,
      `Mic in use: ${c.micLabel || "-"} (${c.micMode})${c.micNote ? `\n  ${c.micNote}` : ""}`,
      `Listening for: ${s.listeningSeconds}s   mic restarts: ${c.micRestarts}`,
      `Audio: ${w.framesPerSecond ?? "-"} frames/s (expect 100), ${c.sampleRate || "-"} Hz, ${c.pullMode}`,
      `Level: loudest ${w.levelDb} dB, quietest ${w.quietDb} dB   noise floor: ${w.noiseFloorDb} dB`,
      `Sounds: ${s.counters.utterances} word-like, ${s.counters.recognized} ran a command; ignored ${s.counters.rejected}${rejected ? ` (${rejected})` : ""}`,
      `Last heard: ${last}`,
      `Recent (newest first): ${s.history.length ? s.history.map(describeHistory).join("; ") : "none"}`,
      s.rule ? `Match limits: distance ${s.rule.threshold.toFixed(2)}, margin ${s.rule.margin.toFixed(2)}` : "Match limits: -",
      `Engine CPU (main thread): now ${w.busyPercent ?? 0}%, average ${s.busyAvgPercent}%, max ${s.busyMaxPercent}%`
    ];
  }

  function renderDiagnostics() {
    byId("voiceDiagnostics").textContent = diagnosticsLines().join("\n");
  }

  async function copyReport() {
    const brave = navigator.brave && await navigator.brave.isBrave().catch(() => false);
    const report = [
      "SceneMarks voice report",
      `Time: ${new Date().toISOString()}`,
      `Browser: ${brave ? "Brave" : "not Brave"}; ${navigator.userAgent}`,
      `Page mic permission: ${await permissionState()}${pageMicLine ? ` (${pageMicLine})` : ""}`,
      `Voice setting: ${voiceSettings.enabled ? "on" : "off"}, sensitivity ${voiceSettings.sensitivity}, mic ${voiceSettings.micDeviceId ? voiceSettings.micLabel : "system default"}, only with video ${voiceSettings.onlyWithVideo}, resume after restart ${voiceSettings.resumeOnStartup}, auto-off ${voiceSettings.autoOffMinutes || "never"}`,
      `Recorded: ${VOICE_COMMANDS.map(({ id }) => `${id} ${(profile.commands[id] || []).length}`).join(", ")}`,
      `Quality: ${quality.map((q) => `${q.command} ${q.recognized}/${q.total}${q.confusedWith.length ? ` (~${q.confusedWith.join("/")})` : ""}`).join(", ") || "-"}`,
      calibration ? `Calibration: typical distance ${calibration.typicalDistance.toFixed(2)} over ${calibration.pairs} pairs` : "Calibration: -",
      "",
      ...diagnosticsLines()
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      byId("voiceCopyResult").textContent = "Report copied.";
    } catch (error) {
      byId("voiceCopyResult").textContent = `Copy failed: ${error.message}`;
    }
  }

  // ---- Wiring --------------------------------------------------------------
  function applySettings(settings) {
    const previousSensitivity = voiceSettings.sensitivity;
    voiceSettings = settings.voice;
    byId("voiceEnabled").checked = voiceSettings.enabled;
    byId("voiceSensitivity").value = String(voiceSettings.sensitivity);
    byId("voiceOnlyWithVideo").checked = voiceSettings.onlyWithVideo;
    byId("voiceResumeOnStartup").checked = voiceSettings.resumeOnStartup;
    byId("voiceAutoOffMinutes").value = String(voiceSettings.autoOffMinutes);
    if (previousSensitivity !== voiceSettings.sensitivity && calibration) {
      quality = VoiceFeatures.evaluateProfile(library, calibration, voiceSettings.sensitivity);
      renderWords();
    }
    renderDiagnostics();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      applySettings(await Storage.getSettings());
    } catch (_error) {
      // Defaults stay.
    }
    await Promise.all([renderPermission(), loadProfile().catch(() => renderWords())]);
    await renderMicOptions();

    byId("voiceEnabled").addEventListener("change", async (event) => {
      const enabled = event.target.checked;
      if (!(await saveVoice({ enabled }, enabled ? "Voice commands on." : "Voice commands off."))) {
        event.target.checked = !enabled;
      }
      renderDiagnostics();
    });
    byId("voiceSensitivity").addEventListener("change", (event) => {
      saveVoice({ sensitivity: Number(event.target.value) }, "Sensitivity saved.");
    });
    // The test reads voiceSettings, so a drag takes effect before it saves.
    byId("voiceSensitivity").addEventListener("input", (event) => {
      voiceSettings = { ...voiceSettings, sensitivity: Number(event.target.value) };
    });
    byId("voiceOnlyWithVideo").addEventListener("change", (event) => {
      saveVoice({ onlyWithVideo: event.target.checked }, "Saved.");
    });
    byId("voiceResumeOnStartup").addEventListener("change", (event) => {
      saveVoice({ resumeOnStartup: event.target.checked }, "Saved.");
    });
    byId("voiceAutoOffMinutes").addEventListener("change", (event) => {
      saveVoice({ autoOffMinutes: Number(event.target.value) }, "Saved.");
    });
    byId("voiceGrantButton").addEventListener("click", grant);
    byId("voiceMicSelect").addEventListener("change", saveMic);
    byId("voiceClearAllButton").addEventListener("click", () => clearWord(null));
    byId("voiceTestButton").addEventListener("click", toggleTest);
    byId("voiceCopyButton").addEventListener("click", copyReport);
    byId("voiceSaveRecordingButton").addEventListener("click", saveDebugRecording);
    byId("voiceResetButton").addEventListener("click", () => {
      channel.postMessage({ command: "reset-counters" });
      byId("voiceCopyResult").textContent = "Counters reset.";
    });
    navigator.mediaDevices.addEventListener("devicechange", () => renderMicOptions());
    try {
      (await navigator.permissions.query({ name: "microphone" })).onchange = () => {
        renderPermission();
        renderMicOptions();
      };
    } catch (_error) {
      // No live permission updates.
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEYS.SETTINGS]) applySettings(SceneMarks.Schema.normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue));
      if (changes[STORAGE_KEYS.VOICE_PROFILE] && !session) loadProfile();
    });

    channel = new BroadcastChannel(VOICE_STATUS_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data && event.data.kind === "engine-status") {
        engineStatus = event.data;
        renderDiagnostics();
      }
    };
    const requestStatus = () => {
      if (!document.hidden) channel.postMessage({ command: "status-request" });
    };
    requestStatus();
    setInterval(requestStatus, 3000);
    setInterval(renderDiagnostics, 2000);
    document.addEventListener("visibilitychange", () => {
      // A hidden page cannot show prompts, and nobody hears the recording.
      if (document.hidden && session) {
        endSession();
        setTrainStatus("Stopped because the page was hidden.", false);
      }
      requestStatus();
    });
  });
})();
