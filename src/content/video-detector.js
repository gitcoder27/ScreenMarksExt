(function attachVideoDetector(root) {
  const SceneMarks = root.SceneMarks || {};

  // Trailing-throttle window for DOM scans: at most one scan per interval no
  // matter how many triggers arrive, so continuously-mutating pages cannot
  // starve detection or churn timers.
  const SCAN_THROTTLE_MS = 400;
  const MIN_MAIN_VIDEO_SECONDS = 60;
  const TINY_AREA_PX = 240 * 135;

  function isFiniteDuration(video) {
    return Number.isFinite(video.duration) && video.duration > 0;
  }

  function isVisible(video) {
    const rect = video.getBoundingClientRect();
    const style = root.getComputedStyle(video);

    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0
      && rect.top < root.innerHeight && rect.left < root.innerWidth;
  }

  function hasPlayerContainer(video) {
    return Boolean(video.closest("[class*='player' i], [id*='player' i], [class*='video' i], [id*='video' i]"));
  }

  function scoreVideo(video) {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    let score = 0;

    if (isFiniteDuration(video) && video.duration > MIN_MAIN_VIDEO_SECONDS) {
      score += 50;
    }

    if (!video.paused && !video.ended) {
      score += 40;
    }

    if (video.currentTime > 0) {
      score += 30;
    }

    if (isVisible(video)) {
      score += 20;
    }

    if (area >= TINY_AREA_PX) {
      score += 20;
    }

    if (video.controls || hasPlayerContainer(video)) {
      score += 10;
    }

    if (isFiniteDuration(video) && video.duration < 10) {
      score -= 50;
    }

    if (!isVisible(video) || area < 2000) {
      score -= 50;
    }

    return score;
  }

  function getVideos() {
    return Array.from(document.querySelectorAll("video"));
  }

  function findActiveVideo() {
    const candidates = getVideos()
      .map((video) => ({ video, score: scoreVideo(video) }))
      .sort((left, right) => right.score - left.score);

    return candidates.length > 0 && candidates[0].score > -20 ? candidates[0].video : null;
  }

  function waitForReady(video, timeoutMs) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timeout = root.setTimeout(cleanup, timeoutMs);

      function cleanup() {
        root.clearTimeout(timeout);
        video.removeEventListener("loadedmetadata", cleanup);
        video.removeEventListener("canplay", cleanup);
        resolve();
      }

      video.addEventListener("loadedmetadata", cleanup, { once: true });
      video.addEventListener("canplay", cleanup, { once: true });
    });
  }

  function createSnapshot(video) {
    const identity = SceneMarks.Adapters.getVideoIdentity(document, root.location);

    if (!video) {
      return {
        detected: false,
        ...identity,
        currentTimeSeconds: null,
        durationSeconds: null,
        paused: null,
        readyState: null
      };
    }

    return {
      detected: true,
      ...identity,
      currentTimeSeconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      durationSeconds: isFiniteDuration(video) ? video.duration : null,
      paused: video.paused,
      readyState: video.readyState
    };
  }

  function createVideoDetector(options) {
    const onContextChange = options && options.onContextChange;
    const onPlaybackTick = options && options.onPlaybackTick;
    let activeVideo = null;
    let observer = null;
    let scanTimer = null;
    let lastNotifiedSignature = null;
    const mediaEvents = ["loadedmetadata", "timeupdate", "play", "pause", "durationchange"];
    // Precise signals that a <video> appeared or was replaced; they do not
    // bubble, so they are observed in the capture phase at the window.
    const scanTriggerEvents = ["loadedmetadata", "emptied"];

    function snapshotSignature(snapshot) {
      return `${snapshot.detected}|${snapshot.videoKey}`;
    }

    // Fires only when the video identity actually changes. Events like
    // timeupdate re-fire constantly while playing; notifying on each of them
    // would flood consumers and make scheduled refreshes starve.
    function notify() {
      if (typeof onContextChange !== "function") {
        return;
      }

      const snapshot = createSnapshot(activeVideo);
      const signature = snapshotSignature(snapshot);
      if (signature === lastNotifiedSignature) {
        return;
      }

      lastNotifiedSignature = signature;
      onContextChange(snapshot);
    }

    // Unlike notify() this fires on every media event so consumers can track
    // the playback position; consumers are expected to dedupe cheaply.
    function notifyTick() {
      if (typeof onPlaybackTick !== "function" || !activeVideo) {
        return;
      }

      onPlaybackTick(activeVideo.currentTime);
    }

    function bindVideo(video) {
      if (activeVideo !== video) {
        if (activeVideo) {
          mediaEvents.forEach((eventName) => {
            activeVideo.removeEventListener(eventName, notify);
            activeVideo.removeEventListener(eventName, notifyTick);
          });
        }

        activeVideo = video;
        if (video) {
          mediaEvents.forEach((eventName) => {
            video.addEventListener(eventName, notify, { passive: true });
            video.addEventListener(eventName, notifyTick, { passive: true });
          });
        }
      }

      // Always notify: single-page apps (e.g. YouTube) reuse the same <video>
      // element across navigations, so the element may not change even when
      // the identity did. The signature filter drops no-op notifications.
      notify();
    }

    // Trailing throttle, not a reset-debounce: MutationObserver batches arrive
    // continuously on mutating pages, and resetting the timer per batch would
    // starve scans indefinitely. At most one run is ever pending; mutations
    // that land while it waits for its slot are picked up by the next trigger.
    function scheduleScan() {
      if (scanTimer !== null) {
        return;
      }

      scanTimer = root.setTimeout(() => {
        scanTimer = null;
        bindVideo(findActiveVideo());
      }, SCAN_THROTTLE_MS);
    }

    function getSnapshot() {
      const video = findActiveVideo();
      if (video !== activeVideo) {
        bindVideo(video);
      }

      return createSnapshot(video);
    }

    async function seekTo(seconds, behavior) {
      const video = findActiveVideo();
      const target = Number(seconds);

      if (!video) {
        return { ok: false, error: "No active video detected." };
      }

      if (!Number.isFinite(target) || target < 0) {
        return { ok: false, error: "Invalid seek target." };
      }

      const wasPaused = video.paused;
      await waitForReady(video, 3000);

      try {
        video.currentTime = target;
      } catch (error) {
        return { ok: false, error: "This site blocked seeking right now." };
      }

      if (behavior === "play-after-jump" || (behavior === "preserve-play-state" && !wasPaused)) {
        await video.play().catch(() => null);
      }

      if (behavior === "pause-after-jump" || (behavior === "preserve-play-state" && wasPaused)) {
        video.pause();
      }

      return { ok: true, currentTimeSeconds: video.currentTime };
    }

    function start() {
      scheduleScan();
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      scanTriggerEvents.forEach((eventName) => {
        root.addEventListener(eventName, scheduleScan, true);
      });
      root.addEventListener("resize", scheduleScan, { passive: true });
    }

    function stop() {
      root.clearTimeout(scanTimer);
      scanTimer = null;
      if (observer) {
        observer.disconnect();
      }
      if (activeVideo) {
        mediaEvents.forEach((eventName) => {
          activeVideo.removeEventListener(eventName, notify);
          activeVideo.removeEventListener(eventName, notifyTick);
        });
      }
      scanTriggerEvents.forEach((eventName) => {
        root.removeEventListener(eventName, scheduleScan, true);
      });
      root.removeEventListener("resize", scheduleScan);
      activeVideo = null;
      lastNotifiedSignature = null;
    }

    return {
      getActiveVideo: findActiveVideo,
      getSnapshot,
      scheduleScan,
      seekTo,
      start,
      stop
    };
  }

  SceneMarks.VideoDetector = {
    createVideoDetector,
    findActiveVideo,
    scoreVideo
  };

  root.SceneMarks = SceneMarks;
})(globalThis);
