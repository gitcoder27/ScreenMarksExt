(function attachOverlay(root) {
  const SceneMarks = root.SceneMarks || {};

  // This DOM belongs to the visited website. Never read or render persisted
  // titles, notes, tags, favorites, IDs, or library results here. Private
  // browsing/editing is available only in extension-origin popup/library pages.
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
    body.append(hint);
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

    function addButton(label, action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scenemarks-overlay__secondary";
      button.textContent = label;
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted || !enabled) return;
        button.disabled = true;
        try {
          const result = await action();
          // Action results can contain saved scenes; only fixed feedback may
          // cross into page DOM, even after a legitimate interaction.
          showToast(result && result.ok ? "Done" : "Open the SceneMarks popup to continue.", result && result.ok ? "success" : "error");
        } catch (_error) {
          showToast("Open the SceneMarks popup to continue.", "error");
        } finally {
          button.disabled = false;
        }
      });
      body.append(button);
    }
    addButton("Quick Save", actions.quickSave);
    addButton("Mark range start/end", actions.toggleRange);
    addButton("Open Library", actions.openLibrary);

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
      showToast,
      destroy() { root.clearTimeout(toastTimer); host.remove(); toast.remove(); }
    };
  }

  SceneMarks.Overlay = { createOverlay };
  root.SceneMarks = SceneMarks;
})(globalThis);
