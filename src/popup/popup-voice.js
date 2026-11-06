// Popup -> Voice row: turn voice commands on or off and show what the
// offscreen engine is doing (it reports over a BroadcastChannel while the
// popup asks). Recording words and choosing the mic live in Options.
(function initializePopupVoice() {
  const { STORAGE_KEYS, VOICE_COMMANDS, VOICE_FEATURE_VERSION, VOICE_STATUS_CHANNEL } = SceneMarks.Constants;
  const Storage = SceneMarks.Storage.createClient();
  let enabled = false;
  let trainedCount = 0;
  let staleProfile = false;
  let engineStatus = null;
  let enabledAt = 0;
  const openedAt = Date.now();

  function byId(id) {
    return document.getElementById(id);
  }

  function openVoiceSettings() {
    chrome.tabs.create({ url: `${chrome.runtime.getURL("src/options/options.html")}#voice` });
    window.close();
  }

  function sayFor(command) {
    const info = VOICE_COMMANDS.find(({ id }) => id === command);
    return info ? info.say : command;
  }

  function ago(at) {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
  }

  // [status text, detail text or null, whether the detail links to Options]
  function describe() {
    if (!enabled) {
      return trainedCount ? ["Off", null, false] : ["Off", "Record your words in Settings to use voice commands.", true];
    }
    if (staleProfile) return ["Not trained", "Your words need to be recorded again in Settings.", true];
    if (!trainedCount) return ["Not trained", "Record your words in Settings first.", true];
    const s = engineStatus && Date.now() - engineStatus.at < 4000 ? engineStatus : null;
    if (!s) {
      // A running engine answers a status request within a moment.
      return Date.now() - Math.max(enabledAt, openedAt) < 3000
        ? ["Starting…", null, false]
        : ["No response", "The listener is not running. Reload SceneMarks from the extensions page.", false];
    }
    if (s.state === "mic-error") {
      const blocked = s.capture.errorName === "NotAllowedError";
      return [blocked ? "Mic blocked" : "Mic unavailable",
        blocked ? "Allow the microphone in Settings → Voice Commands." : `The microphone could not start: ${s.capture.error}`, true];
    }
    if (s.state === "opening") return ["Starting…", null, false];
    if (s.state === "suspended") return ["Paused", "Settings is recording or testing words.", false];
    const heard = s.lastHeard && s.lastHeard.outcome === "sent"
      ? `Last: "${sayFor(s.lastHeard.command)}" ${ago(s.lastHeard.at)}${s.lastHeard.result ? ` · ${s.lastHeard.result}` : ""}`
      : `${trainedCount} word${trainedCount === 1 ? "" : "s"} ready.`;
    return ["Listening", heard, false];
  }

  function render() {
    const [status, detail, linksToOptions] = describe();
    byId("voiceStatusLabel").textContent = status;
    const button = byId("voiceToggleButton");
    button.textContent = enabled ? "Turn off" : "Turn on";
    const detailNode = byId("voiceDetailLabel");
    detailNode.replaceChildren();
    detailNode.hidden = !detail;
    if (detail) {
      const span = document.createElement("span");
      span.textContent = `${detail} `;
      detailNode.append(span);
      if (linksToOptions) {
        const link = document.createElement("button");
        link.type = "button";
        link.textContent = "Open voice settings";
        link.addEventListener("click", openVoiceSettings);
        detailNode.append(link);
      }
    }
  }

  async function loadProfile() {
    const profile = await Storage.getVoiceProfile();
    const count = Object.keys(profile.commands).length;
    staleProfile = count > 0 && profile.featureVersion !== VOICE_FEATURE_VERSION;
    trainedCount = staleProfile ? 0 : count;
  }

  async function toggle() {
    const button = byId("voiceToggleButton");
    button.disabled = true;
    try {
      const saved = await Storage.updateSettings({ voice: { enabled: !enabled } });
      enabled = saved.voice.enabled;
      enabledAt = Date.now();
      engineStatus = null;
    } catch (error) {
      byId("voiceDetailLabel").hidden = false;
      byId("voiceDetailLabel").textContent = `Could not change voice: ${error.message}`;
    } finally {
      button.disabled = false;
    }
    render();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      enabled = (await Storage.getSettings()).voice.enabled;
      await loadProfile();
    } catch (_error) {
      // Defaults stay.
    }
    byId("voiceToggleButton").addEventListener("click", toggle);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEYS.SETTINGS]) {
        enabled = SceneMarks.Schema.normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue).voice.enabled;
      }
      if (changes[STORAGE_KEYS.VOICE_PROFILE]) loadProfile().then(render);
      render();
    });

    const channel = new BroadcastChannel(VOICE_STATUS_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data && event.data.kind === "engine-status") {
        engineStatus = event.data;
        render();
      }
    };
    const requestStatus = () => channel.postMessage({ command: "status-request" });
    requestStatus();
    setInterval(requestStatus, 3000);
    setInterval(render, 1000);
    render();
  });
})();
