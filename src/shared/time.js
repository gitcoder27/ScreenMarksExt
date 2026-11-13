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

  // The page toast after a save. It runs in host-page DOM, so it reads only
  // numbers and flags from the result (the playback time, a range's times,
  // the open range's start), never a saved scene's note, title or tags.
  // action: "save" | "favorite" | "rangeStart" | "rangeEnd".
  // seconds: the playback time the action captured.
  // Returns { ok, tone: "success" | "info" | "error", text }.
  function describeCapture(action, result, seconds) {
    const r = result && typeof result === "object" ? result : {};
    const at = formatSeconds(seconds);
    const span = (start, end) => `${formatSeconds(start)} → ${formatSeconds(end)}`;
    const fail = (text) => ({ ok: false, tone: "error", text });

    if (r.inactive) return fail("SceneMarks is off on this site");
    if (r.noVideo) return fail("No video found — start playback first");
    if (r.genericDisabled) return fail("Saving on this kind of page is off in SceneMarks settings");
    if (r.videoChanged) return fail("The video changed \u2014 try again");

    if (action === "save" || action === "favorite") {
      if (r.ok && r.alreadyFavorite) return { ok: true, tone: "info", text: `Already a favorite: ${at}` };
      if (r.ok) {
        return { ok: true, tone: "success", text: `${action === "favorite" ? "Favorited" : "Saved"} ${at}` };
      }
      if (r.duplicate) return { ok: false, tone: "info", text: `Already saved near ${at}` };
      return fail("Could not save this moment");
    }

    if (action === "rangeStart") {
      if (r.ok) return { ok: true, tone: "success", text: `Range started at ${at}` };
      if (r.conflict) return fail("A range is already open on another video — finish or cancel it in the popup");
      return fail("Could not start a range");
    }

    if (action === "rangeEnd") {
      const scene = r.scene || {};
      if (r.ok && isValidSeconds(scene.startSeconds) && isValidSeconds(scene.endSeconds)) {
        return { ok: true, tone: "success", text: `Range saved ${span(scene.startSeconds, scene.endSeconds)}` };
      }
      if (r.duplicate) {
        const open = r.draft && isValidSeconds(r.draft.startSeconds) ? r.draft.startSeconds : null;
        return {
          ok: false,
          tone: "info",
          text: open === null
            ? "That range is already saved"
            : `Range ${span(Math.min(open, seconds), Math.max(open, seconds))} is already saved · still open from ${formatSeconds(open)}`
        };
      }
      if (r.noRange) return fail("No range is open on this video");
      return fail("Could not save the range");
    }

    return r.ok ? { ok: true, tone: "success", text: "Done" } : fail("Something went wrong");
  }

  SceneMarks.Time = {
    describeCapture,
    formatRange,
    formatSeconds,
    isValidSeconds,
    normalizeSeconds
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
