(function attachConstants(root) {
  const SceneMarks = root.SceneMarks || {};

  // Schema 3 adds query/fragment-aware generic identities. Schema 2 split
  // storage so a write carries one video, not the library:
  // each saved video lives under `video:<videoKey>`, and settings and the
  // transient state each get a small key of their own. Schema 1 kept
  // everything in the single LEGACY_STORAGE_KEY blob.
  const SCHEMA_VERSION = 3;
  const LEGACY_STORAGE_KEY = "scenemarksState";
  const VIDEO_KEY_PREFIX = "video:";
  const STORAGE_KEYS = Object.freeze({
    SCHEMA_VERSION: "schemaVersion",
    SETTINGS: "settings",
    ACTIVE_RANGE_DRAFT: "activeRangeDraft",
    PENDING_JUMP: "pendingJump",
    // The user's recorded voice-command templates. Fixed size (a few
    // samples per command), written only while training; device-specific,
    // so it is left out of export and kept by a replacing import.
    VOICE_PROFILE: "voiceProfile"
  });
  const RANGE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
  const PENDING_JUMP_TTL_MS = 15 * 60 * 1000;
  const MAX_NOTE_LENGTH = 1000;
  const MAX_TAG_LENGTH = 40;
  const MAX_TAGS = 12;
  // An armed delete reverts on its own so a much later second click can never
  // delete a row the user armed and forgot about.
  const ARMED_DELETE_TIMEOUT_MS = 5000;
  // Batch Open Random opens each pick in its own tab, and every tab loads a
  // full streaming site at once, so one batch is capped.
  const MAX_RANDOM_OPEN_COUNT = 10;
  // Saved page URLs per video, newest last. Player URLs carry per-session
  // tokens (Netflix trackId/tctx, YouTube &t=/&pp=), so without a cap every
  // save from a new session grows the state that every write rewrites.
  const MAX_RAW_URLS = 5;
  // Sites switched off live in settings, which every tab reads, so the
  // list is capped.
  const MAX_DISABLED_SITES = 200;

  const DEFAULT_SETTINGS = Object.freeze({
    // false pauses SceneMarks on every site; disabledSites lists the
    // domains (each covering its subdomains) it is switched off on. Off
    // means no page hotkeys, browser shortcuts, overlay or saving there;
    // jumps queued from the library still land.
    extensionEnabled: true,
    disabledSites: Object.freeze([]),
    enableFloatingButton: true,
    enableGenericSites: true,
    enablePageHotkeys: true,
    defaultJumpBehavior: "preserve-play-state",
    quickSaveRequiresNote: false,
    duplicateThresholdSeconds: 3,
    // Voice commands. micDeviceId "" follows the system default input
    // (macOS switches it to plugged-in headphones); otherwise it pins one
    // mic, with micLabel kept to find it again if its ID changes.
    // resumeOnStartup: stay on across a browser restart (off: a restart
    // turns voice off, so the mic is never silently live). autoOffMinutes:
    // turn off after that long with no video playing (0 = never).
    // onlyWithVideo: keep the mic closed unless the active tab has a video.
    voice: Object.freeze({
      enabled: false,
      sensitivity: 0.5,
      micDeviceId: "",
      micLabel: "",
      resumeOnStartup: false,
      autoOffMinutes: 0,
      onlyWithVideo: false
    }),
    hotkeys: Object.freeze({
      quickSave: "Alt+Shift+S",
      toggleRange: "Alt+Shift+M",
      startRange: "Alt+Shift+A",
      endRange: "Alt+Shift+D",
      nextScene: "Alt+Shift+N",
      previousScene: "Alt+Shift+B",
      randomVideo: "Alt+Shift+R",
      toggleOverlay: "Alt+Shift+O",
      openLibrary: "Alt+Shift+L"
    })
  });

  const MESSAGE_TYPES = Object.freeze({
    PING: "SCENEMARKS_PING",
    GET_CONTEXT: "SCENEMARKS_GET_VIDEO_CONTEXT",
    QUICK_SAVE: "SCENEMARKS_QUICK_SAVE",
    SAVE_TIMESTAMP: "SCENEMARKS_SAVE_TIMESTAMP",
    START_RANGE: "SCENEMARKS_START_RANGE",
    END_RANGE: "SCENEMARKS_END_RANGE",
    TOGGLE_RANGE: "SCENEMARKS_TOGGLE_RANGE",
    SEEK_TO: "SCENEMARKS_SEEK_TO",
    DELETE_SCENE: "SCENEMARKS_DELETE_SCENE",
    UPDATE_SCENE: "SCENEMARKS_UPDATE_SCENE",
    OPEN_LIBRARY: "SCENEMARKS_OPEN_LIBRARY",
    OPEN_VIDEO_URL: "SCENEMARKS_OPEN_VIDEO_URL",
    OPEN_VIDEO_AT_SCENE: "SCENEMARKS_OPEN_VIDEO_AT_SCENE",
    GET_TAB_ID: "SCENEMARKS_GET_TAB_ID",
    OPEN_RANDOM_VIDEO: "SCENEMARKS_OPEN_RANDOM_VIDEO",
    OPEN_RANDOM_VIDEOS: "SCENEMARKS_OPEN_RANDOM_VIDEOS",
    PICK_RANDOM_VIDEO: "SCENEMARKS_PICK_RANDOM_VIDEO",
    GET_ACTIVE_TAB_CONTEXT: "SCENEMARKS_GET_ACTIVE_TAB_CONTEXT",
    FORWARD_TO_ACTIVE_TAB: "SCENEMARKS_FORWARD_TO_ACTIVE_TAB",
    STORAGE_RPC: "SCENEMARKS_STORAGE_RPC",
    // Offscreen voice engine -> worker: read the voice settings and
    // templates (the offscreen document has no chrome.storage).
    VOICE_GET_CONFIG: "SCENEMARKS_VOICE_GET_CONFIG",
    // Worker -> offscreen engine: voice settings or templates changed.
    VOICE_CONFIG_CHANGED: "SCENEMARKS_VOICE_CONFIG_CHANGED",
    // Offscreen engine -> worker: a command word was recognized.
    VOICE_COMMAND: "SCENEMARKS_VOICE_COMMAND",
    // Worker -> content script: run a voice action on this tab.
    VOICE_ACTION: "SCENEMARKS_VOICE_ACTION",
    // Worker -> offscreen engine: open or close the mic ("only while a
    // video tab is active").
    VOICE_SET_LISTENING: "SCENEMARKS_VOICE_SET_LISTENING",
    // Content script -> worker: this tab's video appeared or went away.
    VOICE_VIDEO_PRESENCE: "SCENEMARKS_VOICE_VIDEO_PRESENCE",
    // Offscreen engine -> worker, once a minute with auto-off on: has a
    // video played lately?
    VOICE_IDLE_CHECK: "SCENEMARKS_VOICE_IDLE_CHECK"
  });

  // The spoken commands, in training-screen order. The user records their
  // own word for each, so the "say" text is only a suggestion.
  const VOICE_COMMANDS = Object.freeze([
    Object.freeze({ id: "next", say: "next", label: "Next saved timestamp" }),
    Object.freeze({ id: "back", say: "back", label: "Previous saved timestamp" }),
    Object.freeze({ id: "pause", say: "pause", label: "Pause" }),
    Object.freeze({ id: "play", say: "play", label: "Play" }),
    Object.freeze({ id: "mark", say: "mark", label: "Quick-save the current time" }),
    Object.freeze({ id: "skip", say: "skip", label: "Next video in the lineup, at its first mark" }),
    Object.freeze({ id: "return", say: "return", label: "Previous video in the lineup, at its first mark" }),
    Object.freeze({ id: "random", say: "random", label: "Open a random saved video" })
  ]);
  const MAX_VOICE_MIC_FIELD_LENGTH = 300;
  const MAX_VOICE_SAMPLES = 3;
  // 13 MFCCs per 10 ms frame; a template holds at most 1.5 s of speech.
  const VOICE_MFCC_COEFFS = 13;
  const MAX_VOICE_TEMPLATE_FRAMES = 150;
  // Bumped whenever feature extraction changes: templates recorded with
  // another version no longer match and must be recorded again.
  const VOICE_FEATURE_VERSION = 1;
  const VOICE_COOLDOWN_MS = 700;
  const VOICE_AUTO_OFF_CHOICES = Object.freeze([0, 15, 30, 60, 120]);

  // The offscreen voice engine reports status to open extension pages on
  // this BroadcastChannel (same extension origin) instead of
  // runtime.sendMessage, so its periodic status never wakes the worker.
  const VOICE_STATUS_CHANNEL = "scenemarks-voice-status";

  SceneMarks.Constants = {
    ARMED_DELETE_TIMEOUT_MS,
    DEFAULT_SETTINGS,
    LEGACY_STORAGE_KEY,
    MAX_DISABLED_SITES,
    MAX_NOTE_LENGTH,
    MAX_RANDOM_OPEN_COUNT,
    MAX_RAW_URLS,
    MAX_TAG_LENGTH,
    MAX_TAGS,
    MAX_VOICE_MIC_FIELD_LENGTH,
    MAX_VOICE_SAMPLES,
    MAX_VOICE_TEMPLATE_FRAMES,
    MESSAGE_TYPES,
    PENDING_JUMP_TTL_MS,
    RANGE_DRAFT_TTL_MS,
    SCHEMA_VERSION,
    STORAGE_KEYS,
    VIDEO_KEY_PREFIX,
    VOICE_AUTO_OFF_CHOICES,
    VOICE_COMMANDS,
    VOICE_COOLDOWN_MS,
    VOICE_FEATURE_VERSION,
    VOICE_MFCC_COEFFS,
    VOICE_STATUS_CHANNEL
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
