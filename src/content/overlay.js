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
    // The pill shows only this count of the current video's saved times.
    const count = document.createElement("span");
    count.className = "scenemarks-overlay__count";
    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "scenemarks-overlay__icon-button";
    header.append(title, count, collapseButton);
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
    // Layout from settings: the pill state and this platform's saved
    // position ({ x, y } fractions of the free space, or null for the
    // default top right spot).
    let collapsed = false;
    let position = null;
    // Pill toggles still on their way to storage; until they land, a
    // settings echo of an older toggle must not flip the pill back.
    let pendingCollapseWrites = 0;
    // The current video's saved scenes (times only are used), or null.
    // Held here, outside page-readable DOM; the list of buttons exists
    // only while the panel is shown and expanded.
    let currentScenes = null;
    const EDGE = 8;
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

    function renderMarks() {
      const scenes = enabled ? currentScenes : null;
      count.textContent = Array.isArray(scenes) ? String(scenes.length) : "";
      marks.hidden = !Array.isArray(scenes);
      if (marks.hidden || collapsed) {
        // Hidden or collapsed: no time is left in the page's DOM.
        marksStatus.textContent = "";
        marksList.replaceChildren();
        return;
      }
      marksStatus.textContent = scenes.length
        ? `Saved timestamps (${scenes.length})`
        : "No saved timestamps for this video.";
      marksList.replaceChildren(...scenes.map((scene, index) => createMarkButton(scene, index, scenes.length)));
    }

    // scenes: the current video's saved scenes in time order, or null when
    // no video is detected. Only their times are used.
    function setMarks(scenes) {
      currentScenes = Array.isArray(scenes) ? scenes : null;
      renderMarks();
    }

    function setEnabled(value) {
      const next = Boolean(value);
      if (next === enabled) return enabled;
      enabled = next;
      host.hidden = !enabled;
      if (!enabled) {
        currentScenes = null;
        drag = null;
      }
      renderMarks();
      if (enabled) applyPosition();
      return enabled;
    }

    function applyCollapsed() {
      host.className = collapsed ? "scenemarks-overlay is-collapsed" : "scenemarks-overlay";
      collapseButton.textContent = collapsed ? "+" : "\u2013";
      collapseButton.setAttribute("aria-label", collapsed ? "Expand SceneMarks" : "Collapse SceneMarks");
      collapseButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
      collapseButton.title = collapsed ? "Expand" : "Collapse to a pill";
      renderMarks();
      applyPosition();
    }

    // Stored fractions: x of the free width beside the panel, so a panel
    // pushed to the right edge stays there when it collapses; y of the free
    // height under the header, so the header stays where it was dropped
    // when the list grows or shrinks.
    function freeSpace() {
      return {
        x: root.innerWidth - host.offsetWidth - EDGE * 2,
        y: root.innerHeight - (header.offsetHeight || 0) - EDGE * 2
      };
    }

    // Places the panel from the stored fractions, kept inside the window
    // (a tall panel near the bottom moves up). Without a stored position
    // the stylesheet's top right spot applies.
    function applyPosition() {
      if (!enabled || drag) return;
      if (!position) {
        host.style.left = "";
        host.style.top = "";
        host.style.right = "";
        host.style.bottom = "";
        return;
      }
      const free = freeSpace();
      const top = EDGE + position.y * Math.max(0, free.y);
      const maxTop = root.innerHeight - host.offsetHeight - EDGE;
      host.style.left = `${Math.round(EDGE + position.x * Math.max(0, free.x))}px`;
      host.style.top = `${Math.round(Math.max(EDGE, Math.min(top, maxTop)))}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    }

    function currentFractions() {
      const free = freeSpace();
      const fraction = (offset, space) => (space > 0 ? Math.min(1, Math.max(0, (offset - EDGE) / space)) : 0);
      return { x: fraction(host.offsetLeft, free.x), y: fraction(host.offsetTop, free.y) };
    }

    // layout: { collapsed, position } from settings. Applying it never
    // writes; only a drag end or a pill click does.
    function setLayout(layout) {
      const next = layout && typeof layout === "object" ? layout : {};
      const nextPosition = next.position && Number.isFinite(next.position.x) && Number.isFinite(next.position.y)
        ? { x: next.position.x, y: next.position.y }
        : null;
      if (!drag) position = nextPosition;
      if (pendingCollapseWrites === 0 && Boolean(next.collapsed) !== collapsed) {
        collapsed = Boolean(next.collapsed);
        applyCollapsed();
      } else {
        applyPosition();
      }
    }

    addButton("Quick Save", actions.quickSave);
    addButton("Mark range start/end", actions.toggleRange);
    addButton("Open Library", actions.openLibrary, "Opening the Library");

    collapseButton.addEventListener("click", (event) => {
      if (!event.isTrusted || !enabled) return;
      collapsed = !collapsed;
      applyCollapsed();
      if (event.detail > 0) collapseButton.blur();
      if (typeof actions.setCollapsed !== "function") return;
      pendingCollapseWrites += 1;
      Promise.resolve()
        .then(() => actions.setCollapsed(collapsed))
        .catch(() => {})
        .finally(() => { pendingCollapseWrites -= 1; });
    });

    header.addEventListener("pointerdown", (event) => {
      // Buttons in the header keep their own clicks: capturing the pointer
      // here would retarget the click to the header.
      if (!event.isTrusted || !enabled || event.button !== 0) return;
      if (event.target && event.target !== header && typeof event.target.closest === "function" && event.target.closest("button")) return;
      drag = {
        x: event.clientX - host.offsetLeft,
        y: event.clientY - host.offsetTop,
        startX: event.clientX,
        startY: event.clientY,
        moved: false
      };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
      if (!event.isTrusted || !drag) return;
      if (!drag.moved && Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) < 4) return;
      drag.moved = true;
      host.style.left = `${Math.max(EDGE, Math.min(root.innerWidth - host.offsetWidth - EDGE, event.clientX - drag.x))}px`;
      host.style.top = `${Math.max(EDGE, Math.min(root.innerHeight - host.offsetHeight - EDGE, event.clientY - drag.y))}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    });
    // The position is written once, when a real drag ends.
    function endDrag(event) {
      const finished = drag;
      drag = null;
      if (!finished || !finished.moved || !event.isTrusted || !enabled) return;
      position = currentFractions();
      if (typeof actions.savePosition === "function") {
        Promise.resolve().then(() => actions.savePosition(position)).catch(() => {});
      }
    }
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("lostpointercapture", (event) => {
      if (drag) endDrag(event);
    });
    // Clamp again when the window or the panel changes size (the list
    // loads, the pill toggles). Placing the panel writes nothing.
    const handleResize = () => applyPosition();
    root.addEventListener("resize", handleResize);
    const sizeObserver = typeof root.ResizeObserver === "function" ? new root.ResizeObserver(handleResize) : null;
    if (sizeObserver) sizeObserver.observe(host);
    const mount = document.body || document.documentElement;
    mount.append(host, toast);
    host.hidden = true;
    applyCollapsed();
    return {
      setEnabled,
      setLayout,
      setMarks,
      showToast,
      destroy() {
        root.clearTimeout(toastTimer);
        root.removeEventListener("resize", handleResize);
        if (sizeObserver) sizeObserver.disconnect();
        host.remove();
        toast.remove();
      }
    };
  }

  SceneMarks.Overlay = { createOverlay };
  root.SceneMarks = SceneMarks;
})(globalThis);
