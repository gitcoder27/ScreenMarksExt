(function initializeOptions() {
  const Storage = SceneMarks.Storage.createClient();
  const elements = {};
  let recordTarget = null;

  function byId(id) {
    return document.getElementById(id);
  }

  // chrome.storage.local quota for MV3 extensions; the API offers no way to
  // query it, so the meter is measured against this documented limit.
  const LOCAL_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
  }

  async function updateStorageMeter() {
    let usedBytes;
    try {
      usedBytes = await chrome.storage.local.getBytesInUse(null);
    } catch (_error) {
      elements.storageMeterLabel.textContent = "Storage usage is unavailable in this browser.";
      return;
    }

    const percent = Math.min(100, Math.round((usedBytes / LOCAL_STORAGE_QUOTA_BYTES) * 100));
    elements.storageMeterFill.style.width = `${percent}%`;
    elements.storageMeterBar.setAttribute("aria-valuenow", String(percent));
    elements.storageMeterLabel.textContent =
      `${formatBytes(usedBytes)} of about ${formatBytes(LOCAL_STORAGE_QUOTA_BYTES)} used (${percent}%)`;
    elements.storageMeterFill.classList.toggle("is-warning", percent >= 75);
    elements.storageMeterFill.classList.toggle("is-danger", percent >= 90);
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
      "previousSceneHotkey",
      "randomVideoHotkey",
      "toggleOverlayHotkey",
      "openLibraryHotkey",
      "openBrowserShortcutsButton",
      "clearDataButton",
      "storageMeterBar",
      "storageMeterFill",
      "storageMeterLabel",
      "statusMessage"
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function setStatus(message, isError) {
    elements.statusMessage.textContent = message;
    elements.statusMessage.style.color = isError ? "#fca5a5" : "#4ade80";
  }

  function isDeadContextError(error) {
    return /Extension context invalidated/i.test(String((error && error.message) || error));
  }

  function storageStatusMessage(error) {
    if (isDeadContextError(error)) {
      return "SceneMarks was reloaded. Refresh this page to continue.";
    }

    return error.message;
  }

  // Inverse of the content-script code→key matching map: recordings derive
  // the stored token from event.code because event.key yields composed
  // characters on macOS (Alt+Shift+S records "Í") that never match.
  const CODE_TOKEN_MAP = Object.freeze({
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`"
  });

  // Codes matched verbatim by the content script; anything else falls back
  // to event.key so unmatched layouts keep today's behavior.
  const VERBATIM_CODE_PATTERN = /^(F\d{1,2}|Arrow(Up|Down|Left|Right)|PageUp|PageDown|Home|End|Insert|Delete|Space|Enter|Escape|Tab|Backspace)$/;

  function tokenFromCode(code) {
    if (!code) {
      return null;
    }

    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) {
      return letter[1];
    }

    const digit = /^Digit(\d)$/.exec(code);
    if (digit) {
      return digit[1];
    }

    if (Object.prototype.hasOwnProperty.call(CODE_TOKEN_MAP, code)) {
      return CODE_TOKEN_MAP[code];
    }

    if (VERBATIM_CODE_PATTERN.test(code)) {
      return code;
    }

    return null;
  }

  function keyTokenFromEvent(event) {
    const token = tokenFromCode(event.code);
    if (token !== null) {
      return token;
    }

    return event.key.length === 1 ? event.key.toUpperCase() : event.key;
  }

  function formatKeyboardEvent(event) {
    const parts = [];

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

    parts.push(keyTokenFromEvent(event));
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
    elements.previousSceneHotkey.value = settings.hotkeys.previousScene;
    elements.randomVideoHotkey.value = settings.hotkeys.randomVideo;
    elements.toggleOverlayHotkey.value = settings.hotkeys.toggleOverlay;
    elements.openLibraryHotkey.value = settings.hotkeys.openLibrary;
  }

  async function saveSettings(event) {
    event.preventDefault();

    try {
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
          previousScene: elements.previousSceneHotkey.value,
          randomVideo: elements.randomVideoHotkey.value,
          toggleOverlay: elements.toggleOverlayHotkey.value,
          openLibrary: elements.openLibraryHotkey.value
        }
      });
    } catch (error) {
      setStatus(storageStatusMessage(error), true);
      return;
    }

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

    try {
      await Storage.clearAllData();
    } catch (error) {
      setStatus(storageStatusMessage(error), true);
      return;
    }

    await loadSettings();
    await updateStorageMeter();
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
    await updateStorageMeter();
  });
})();
