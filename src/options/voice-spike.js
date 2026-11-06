// Phase 0 spike panel: grant the mic on this page, pick which mic to use,
// start the offscreen listener through the worker, show its live status,
// and copy a fixed snapshot of it as a report.
(function initializeVoiceSpike() {
  const { MESSAGE_TYPES, VOICE_STATUS_CHANNEL } = SceneMarks.Constants;
  const Storage = SceneMarks.Storage.createClient();
  const DEFAULT_VALUE = "";

  let pageMicLine = "not requested yet";
  let workerLine = "-";
  let lastStatus = null;
  let voiceSettings = null;
  let channel = null;

  function byId(id) {
    return document.getElementById(id);
  }

  async function permissionState() {
    try {
      return (await navigator.permissions.query({ name: "microphone" })).state;
    } catch (_error) {
      return "unknown";
    }
  }

  async function grant() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const label = stream.getAudioTracks()[0]?.label || "unnamed mic";
      stream.getTracks().forEach((track) => track.stop());
      pageMicLine = `granted (${label})`;
    } catch (error) {
      pageMicLine = `FAILED ${error.name}: ${error.message}`;
    }
    await renderMicOptions();
    render();
  }

  async function send(type) {
    try {
      workerLine = JSON.stringify(await chrome.runtime.sendMessage({ type }));
    } catch (error) {
      workerLine = `FAILED ${error.message}`;
    }
    if (type === MESSAGE_TYPES.VOICE_SPIKE_STOP) {
      lastStatus = null;
    }
    render();
  }

  // Chrome lists virtual "default" and "communications" entries next to
  // the real inputs; "default" is labelled "Default - <current device>".
  async function listInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const systemDefault = inputs.find((device) => device.deviceId === "default");
    const real = inputs.filter((device) => device.deviceId !== "default" && device.deviceId !== "communications");
    return { systemDefault, real };
  }

  function addOption(select, value, text) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
    return option;
  }

  async function renderMicOptions() {
    const select = byId("voiceMicSelect");
    const hint = byId("voiceMicHint");
    const { systemDefault, real } = await listInputs();
    const hasLabels = real.some((device) => device.label);
    const current = voiceSettings || SceneMarks.Constants.DEFAULT_SETTINGS.voice;

    select.replaceChildren();
    const currentDefault = systemDefault && systemDefault.label
      ? systemDefault.label.replace(/^Default - /, "")
      : null;
    addOption(select, DEFAULT_VALUE,
      `System default${currentDefault ? ` (now: ${currentDefault})` : ""}`);
    for (const device of real) {
      addOption(select, device.deviceId, device.label || "Microphone (grant access to see its name)");
    }
    if (current.micDeviceId && !real.some((device) => device.deviceId === current.micDeviceId)) {
      const byLabel = real.find((device) => current.micLabel && device.label === current.micLabel);
      if (byLabel) {
        select.value = byLabel.deviceId;
      } else {
        addOption(select, current.micDeviceId, `${current.micLabel || "Chosen mic"} (not connected)`);
        select.value = current.micDeviceId;
      }
    } else {
      select.value = current.micDeviceId;
    }

    hint.textContent = hasLabels
      ? "System default follows macOS: your headphone mic while it is plugged in, the MacBook mic otherwise. Pick a mic to always use it, even when headphones are plugged in."
      : "Click Grant Microphone to see your microphones by name.";
  }

  async function saveMic() {
    const select = byId("voiceMicSelect");
    const option = select.selectedOptions[0];
    const micDeviceId = select.value;
    const micLabel = micDeviceId ? (option.textContent || "").replace(/ \(not connected\)$/, "") : "";
    try {
      const saved = await Storage.updateSettings({ voice: { micDeviceId, micLabel } });
      voiceSettings = saved.voice;
      byId("voiceCopyResult").textContent = "Microphone saved.";
    } catch (error) {
      byId("voiceCopyResult").textContent = `Saving the microphone failed: ${error.message}`;
    }
  }

  const REJECTION_NAMES = {
    click: "tap/click",
    "no-voice": "no voice",
    "too-short": "too short",
    "too-long": "too long"
  };

  function describeUtterance(entry) {
    return entry.rejected ? `ignored: ${REJECTION_NAMES[entry.rejected] || entry.rejected}` : `WORD ${entry.ms} ms`;
  }

  function describeRejections(rejectedBy) {
    const parts = Object.entries(rejectedBy || {})
      .map(([reason, count]) => `${REJECTION_NAMES[reason] || reason} ${count}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  function statusLines() {
    const lines = [`Mic on this page: ${pageMicLine}`, `Last worker reply: ${workerLine}`, ""];
    if (!lastStatus) {
      lines.push("Background listener: not running.");
      return lines;
    }
    const s = lastStatus;
    const age = Math.round((Date.now() - s.at) / 1000);
    lines.push(
      `Background listener: ${s.state}${s.error ? ` (${s.error})` : ""}${age > 3 ? ` [no update for ${age}s]` : ""}`,
      `Mic in use: ${s.micLabel || "-"} (${s.micMode})${s.micNote ? `\n  ${s.micNote}` : ""}`,
      `Listening for: ${s.listeningSeconds}s   mic restarts: ${s.micRestarts}`,
      `Audio: ${s.framesPerSecond} frames/s (expect 100), ${s.sampleRate || "-"} Hz, ${s.pullMode}`,
      `Level: loudest ${s.levelDb} dB, quietest ${s.quietDb} dB (last second)   noise floor: ${s.noiseFloorDb} dB`,
      `Sound detected: ${s.speaking ? `yes, checking whether it is a word (${s.gateOpenMs} ms so far)` : "no"}`,
      `Words heard: ${s.utterances}   ignored sounds: ${s.rejected}${describeRejections(s.rejectedBy)}`,
      `Recent (newest first): ${s.history.length ? s.history.map(describeUtterance).join(", ") : "none"}`,
      `Engine CPU (main thread): now ${s.busyPercent}%, average ${s.busyAvgPercent}%, max ${s.busyMaxPercent}%`
    );
    return lines;
  }

  function render() {
    byId("voiceSpikeStatus").textContent = statusLines().join("\n");
    const fill = byId("voiceMeterFill");
    const level = lastStatus ? Math.max(0, Math.min(100, (lastStatus.levelDb + 80) * 1.25)) : 0;
    fill.style.width = `${level}%`;
    fill.classList.toggle("is-speaking", Boolean(lastStatus && lastStatus.speaking));
  }

  async function copyReport() {
    const brave = navigator.brave && await navigator.brave.isBrave().catch(() => false);
    const report = [
      "SceneMarks voice spike report",
      `Time: ${new Date().toISOString()}`,
      `Browser: ${brave ? "Brave" : "not Brave"}; ${navigator.userAgent}`,
      `Page mic permission: ${await permissionState()}`,
      `Saved mic setting: ${voiceSettings && voiceSettings.micDeviceId ? voiceSettings.micLabel : "System default"}`,
      ...statusLines()
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      byId("voiceCopyResult").textContent = "Report copied. Paste it into the chat.";
    } catch (error) {
      byId("voiceCopyResult").textContent = `Copy failed: ${error.message}`;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    pageMicLine = `permission ${await permissionState()}`;
    try {
      voiceSettings = (await Storage.getSettings()).voice;
    } catch (_error) {
      voiceSettings = null;
    }
    await renderMicOptions();

    byId("voiceGrantButton").addEventListener("click", grant);
    byId("voiceStartButton").addEventListener("click", () => send(MESSAGE_TYPES.VOICE_SPIKE_START));
    byId("voiceStopButton").addEventListener("click", () => send(MESSAGE_TYPES.VOICE_SPIKE_STOP));
    byId("voiceMicSelect").addEventListener("change", saveMic);
    byId("voiceCopyButton").addEventListener("click", copyReport);
    byId("voiceResetButton").addEventListener("click", () => {
      channel.postMessage({ command: "reset-counters" });
      byId("voiceCopyResult").textContent = "Counters reset.";
    });
    navigator.mediaDevices.addEventListener("devicechange", () => renderMicOptions());

    channel = new BroadcastChannel(VOICE_STATUS_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data && event.data.state) {
        lastStatus = event.data;
        render();
      }
    };
    setInterval(render, 1000);
    render();
  });
})();
