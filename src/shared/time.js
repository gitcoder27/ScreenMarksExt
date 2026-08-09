(function attachTime(root) {
  const SceneMarks = root.SceneMarks || {};

  function isValidSeconds(value) {
    return Number.isFinite(value) && value >= 0;
  }

  function normalizeSeconds(value) {
    const seconds = Number(value);
    return isValidSeconds(seconds) ? seconds : 0;
  }

  function formatSeconds(value) {
    const total = Math.max(0, Math.round(normalizeSeconds(value)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
    }

    return `${mm}:${ss}`;
  }

  function formatRange(startSeconds, endSeconds) {
    if (!isValidSeconds(endSeconds)) {
      return formatSeconds(startSeconds);
    }

    return `${formatSeconds(startSeconds)} -> ${formatSeconds(endSeconds)}`;
  }

  SceneMarks.Time = {
    formatRange,
    formatSeconds,
    isValidSeconds,
    normalizeSeconds
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
