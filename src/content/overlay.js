(function attachOverlay(root) {
  const SceneMarks = root.SceneMarks || {};
  const { formatRange, formatSeconds } = SceneMarks.Time;

  // This DOM belongs to the visited website. The only saved data allowed here
  // is the times of the video on this page (setMarks), like the jump toasts.
  // Never read or render persisted titles, notes, tags, favorites, IDs, or
  // other videos here. Private browsing/editing is available only in
  // extension-origin popup/library pages.
  function createOverlay(actions) {
    const host = document.createElement("section");
    host.className = "scenemarks-overlay";
    const header = document.createElement("div");
    header.className = "scenemarks-overlay__header";
    const title = document.createElement("span");
    title.className = "scenemarks-overlay__title";
    title.textContent = "SceneMarks";
    header.append(title);
    const body = document.createElement("div");
    body.className = "scenemarks-overlay__body";
    const hint = document.createElement("p");
    hint.className = "scenemarks-overlay__status";
    hint.textContent = "View and edit saved scenes in the toolbar popup or Library.";
    const marks = document.createElement("div");
    marks.className = "scenemarks-overlay__marks";
    marks.hidden = true;
    const marksStatus = document.createElement("p");
    marksStatus.className = "scenemarks-overlay__status";
    const marksList = document.createElement("div");
    marksList.className = "scenemarks-overlay__mark-list";
    marks.append(marksStatus, marksList);
    body.append(hint, marks);
    host.append(header, body);
    let enabled = false;
    let toastTimer = null;
    let drag = null;
    const toast = document.createElement("div");
    toast.className = "scenemarks-toast";
    toast.setAttribute("popover", "manual");
    toast.setAttribute("role", "status");

    function showToast(message, kind) {
      toast.textContent = String(message || "");
      toast.className = `scenemarks-toast is-visible is-${kind || "info"}`;
      try { toast.showPopover(); } catch (_error) { /* Older Chromium. */ }
      root.clearTimeout(toastTimer);
      toastTimer = root.setTimeout(() => {
        toast.className = "scenemarks-toast";
        try { toast.hidePopover(); } catch (_error) { /* Not open. */ }
      }, 3000);
    }

    const TONES = new Set(["success", "info", "error"]);

    // successText: the fixed toast for an action without capture feedback.
    function addButton(label, action, successText) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scenemarks-overlay__secondary";
      button.textContent = label;
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted || !enabled) return;
        button.disabled = true;
        try {
          const result = await action();
          // Action results can contain saved scenes; only the capture
          // feedback (fixed text and this video's times, built by
          // Time.describeCapture) or fixed text may cross into page DOM.
          const feedback = result && result.feedback;
          if (feedback && typeof feedback.text === "string" && TONES.has(feedback.tone)) {
            showToast(feedback.text, feedback.tone);
          } else if (result && result.inactive) {
            showToast("SceneMarks is off on this site", "error");
          } else {
            showToast(result && result.ok ? successText || "Done" : "Something went wrong. Try the SceneMarks popup.", result && result.ok ? "success" : "error");
          }
        } catch (_error) {
          showToast("Something went wrong. Try the SceneMarks popup.", "error");
        } finally {
          button.disabled = false;
          // A mouse click must not leave focus here, or the next Space to
          // pause the video would press this button again.
          if (event.detail > 0) button.blur();
        }
      });
      body.append(button);
    }

    function createMarkButton(scene, index, total) {
      const seconds = Number(scene.startSeconds);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scenemarks-overlay__mark";
      button.textContent = formatRange(seconds, scene.endSeconds);
      button.setAttribute("aria-label", `Jump to ${formatSeconds(seconds)}`);
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted || !enabled) return;
        button.disabled = true;
        try {
          const result = await actions.jumpToMark(seconds);
          if (result && result.ok) showToast(`Jumped to ${formatSeconds(seconds)} (${index + 1}/${total})`, "success");
          else showToast("Could not jump to that timestamp.", "error");
        } catch (_error) {
          showToast("Could not jump to that timestamp.", "error");
        } finally {
          button.disabled = false;
          // A mouse click must not leave focus here, or the next Space to
          // pause the video would press this button and jump again.
          if (event.detail > 0) button.blur();
        }
      });
      return button;
    }

    // scenes: the current video's saved scenes in time order, or null when
    // no video is detected. Only their times are used.
    function setMarks(scenes) {
      marks.hidden = !Array.isArray(scenes);
      if (marks.hidden) {
        marksList.replaceChildren();
        return;
      }
      marksStatus.textContent = scenes.length
        ? `Saved timestamps (${scenes.length})`
        : "No saved timestamps for this video.";
      marksList.replaceChildren(...scenes.map((scene, index) => createMarkButton(scene, index, scenes.length)));
    }

    addButton("Quick Save", actions.quickSave);
    addButton("Mark range start/end", actions.toggleRange);
    addButton("Open Library", actions.openLibrary, "Opening the Library");

    header.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted) return;
      drag = { x: event.clientX - host.offsetLeft, y: event.clientY - host.offsetTop };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
      if (!event.isTrusted || !drag) return;
      host.style.left = `${Math.max(8, Math.min(root.innerWidth - host.offsetWidth - 8, event.clientX - drag.x))}px`;
      host.style.top = `${Math.max(8, Math.min(root.innerHeight - host.offsetHeight - 8, event.clientY - drag.y))}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    });
    header.addEventListener("pointerup", () => { drag = null; });
    header.addEventListener("lostpointercapture", () => { drag = null; });
    const mount = document.body || document.documentElement;
    mount.append(host, toast);
    host.hidden = true;
    return {
      setEnabled(value) { enabled = Boolean(value); host.hidden = !enabled; return enabled; },
      setMarks,
      showToast,
      destroy() { root.clearTimeout(toastTimer); host.remove(); toast.remove(); }
    };
  }

  SceneMarks.Overlay = { createOverlay };
  root.SceneMarks = SceneMarks;
})(globalThis);
