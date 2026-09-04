(function attachConstants(root) {
  const SceneMarks = root.SceneMarks || {};

  const STORAGE_KEY = "scenemarksState";
  const SCHEMA_VERSION = 1;
  const RANGE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
  const PENDING_JUMP_TTL_MS = 15 * 60 * 1000;
  const MAX_NOTE_LENGTH = 1000;
  const MAX_TAG_LENGTH = 40;
  const MAX_TAGS = 12;
  // An armed delete reverts on its own so a much later second click can never
  // delete a row the user armed and forgot about.
  const ARMED_DELETE_TIMEOUT_MS = 5000;

  const DEFAULT_SETTINGS = Object.freeze({
    enableFloatingButton: true,
    enableGenericSites: true,
    enablePageHotkeys: true,
    defaultJumpBehavior: "preserve-play-state",
    quickSaveRequiresNote: false,
    duplicateThresholdSeconds: 3,
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
    OPEN_RANDOM_VIDEO: "SCENEMARKS_OPEN_RANDOM_VIDEO",
    PICK_RANDOM_VIDEO: "SCENEMARKS_PICK_RANDOM_VIDEO",
    GET_ACTIVE_TAB_CONTEXT: "SCENEMARKS_GET_ACTIVE_TAB_CONTEXT",
    FORWARD_TO_ACTIVE_TAB: "SCENEMARKS_FORWARD_TO_ACTIVE_TAB"
  });

  SceneMarks.Constants = {
    ARMED_DELETE_TIMEOUT_MS,
    DEFAULT_SETTINGS,
    MAX_NOTE_LENGTH,
    MAX_TAG_LENGTH,
    MAX_TAGS,
    MESSAGE_TYPES,
    PENDING_JUMP_TTL_MS,
    RANGE_DRAFT_TTL_MS,
    SCHEMA_VERSION,
    STORAGE_KEY
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
