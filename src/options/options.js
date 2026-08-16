(function initializeOptions() {
  const Storage = SceneMarks.Storage;
  const elements = {};
  let recordTarget = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function bindElements() {
    [
      "openLibraryButton",
      "settingsForm",
      "enableFloatingButton",
      "quickSaveRequiresNote",
      "duplicateThresholdSeconds",
      "defaultJumpBehavior",
      "enableGenericSites",
      "enablePageHotkeys",
      "quickSaveHotkey",
      "toggleRangeHotkey",
      "startRangeHotkey",
      "endRangeHotkey",
      "nextSceneHotkey",
      "randomVideoHotkey",
      "openLibraryHotkey",
      "openBrowserShortcutsButton",
      "clearDataButton",
      "statusMessage"
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function setStatus(message, isError) {
    elements.statusMessage.textContent = message;
    elements.statusMessage.style.color = isError ? "#fca5a5" : "#4ade80";
  }

  function formatKeyboardEvent(event) {
    const parts = [];
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;

    if (event.ctrlKey) {
      parts.push("Ctrl");
    }
    if (event.metaKey) {
      parts.push("Command");
    }
    if (event.altKey) {
      parts.push("Alt");
    }
    if (event.shiftKey) {
      parts.push("Shift");
    }

    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
      return "";
    }

    parts.push(key);
    return parts.join("+");
  }

  async function loadSettings() {
    const state = await Storage.getState();
    const settings = state.settings;

    elements.enableFloatingButton.checked = settings.enableFloatingButton;
    elements.quickSaveRequiresNote.checked = settings.quickSaveRequiresNote;
    elements.duplicateThresholdSeconds.value = String(settings.duplicateThresholdSeconds);
    elements.defaultJumpBehavior.value = settings.defaultJumpBehavior;
    elements.enableGenericSites.checked = settings.enableGenericSites;
    elements.enablePageHotkeys.checked = settings.enablePageHotkeys;
    elements.quickSaveHotkey.value = settings.hotkeys.quickSave;
    elements.toggleRangeHotkey.value = settings.hotkeys.toggleRange;
    elements.startRangeHotkey.value = settings.hotkeys.startRange;
    elements.endRangeHotkey.value = settings.hotkeys.endRange;
    elements.nextSceneHotkey.value = settings.hotkeys.nextScene;
    elements.randomVideoHotkey.value = settings.hotkeys.randomVideo;
    elements.openLibraryHotkey.value = settings.hotkeys.openLibrary;
  }

  async function saveSettings(event) {
    event.preventDefault();
    await Storage.updateSettings({
      enableFloatingButton: elements.enableFloatingButton.checked,
      quickSaveRequiresNote: elements.quickSaveRequiresNote.checked,
      duplicateThresholdSeconds: Number(elements.duplicateThresholdSeconds.value),
      defaultJumpBehavior: elements.defaultJumpBehavior.value,
      enableGenericSites: elements.enableGenericSites.checked,
      enablePageHotkeys: elements.enablePageHotkeys.checked,
      hotkeys: {
        quickSave: elements.quickSaveHotkey.value,
        toggleRange: elements.toggleRangeHotkey.value,
        startRange: elements.startRangeHotkey.value,
        endRange: elements.endRangeHotkey.value,
        nextScene: elements.nextSceneHotkey.value,
        randomVideo: elements.randomVideoHotkey.value,
        openLibrary: elements.openLibraryHotkey.value
      }
    });
    setStatus("Settings saved.", false);
  }

  function startRecording(inputId, button) {
    recordTarget = { input: byId(inputId), button };
    button.textContent = "Press keys";
    recordTarget.input.focus();
  }

  function stopRecording() {
    if (recordTarget) {
      recordTarget.button.textContent = "Record";
      recordTarget = null;
    }
  }

  function handleRecording(event) {
    if (!recordTarget) {
      return;
    }

    event.preventDefault();

    if (event.key === "Escape") {
      recordTarget.input.blur();
      stopRecording();
      setStatus("Recording cancelled.", false);
      return;
    }

    const shortcut = formatKeyboardEvent(event);
    if (!shortcut || !shortcut.trim()) {
      return;
    }

    recordTarget.input.value = shortcut;
    recordTarget.input.blur();
    stopRecording();
    setStatus("Hotkey recorded. Save settings to apply it.", false);
  }

  async function openBrowserShortcuts() {
    try {
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch (_error) {
      setStatus("Open chrome://extensions/shortcuts or brave://extensions/shortcuts manually.", true);
    }
  }

  async function clearData() {
    if (!confirm("Clear all SceneMarks data from this browser profile?")) {
      return;
    }

    await Storage.clearAllData();
    await loadSettings();
    setStatus("All SceneMarks data cleared.", false);
  }

  function bindEvents() {
    elements.settingsForm.addEventListener("submit", saveSettings);
    elements.openLibraryButton.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/library/library.html") });
    });
    elements.openBrowserShortcutsButton.addEventListener("click", openBrowserShortcuts);
    elements.clearDataButton.addEventListener("click", clearData);
    document.addEventListener("keydown", handleRecording, true);

    document.querySelectorAll("[data-record-hotkey]").forEach((button) => {
      button.addEventListener("click", () => startRecording(button.dataset.recordHotkey, button));
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindElements();
    bindEvents();
    await loadSettings();
  });
})();
