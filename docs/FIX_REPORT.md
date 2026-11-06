# SceneMarks Fix Report

Branch `fix/code-review-fixes` (15 commits on `main` at `1d4ac60`; not pushed). Source: `docs/CODE_REVIEW.md`.
Tests: `node --test test/automated/*.test.js` → **49/49 pass** (was 37; added 7 detector, 3 storage, 2 schema).

## 1. Fixed

| ID | What changed | Files | Commit |
|---|---|---|---|
| F1 | Same-video jumps no longer refresh the overlay (no storage read, no panel rebuild); the seek's `timeupdate` moves the highlight | overlay.js, content-script.js | `23dc92a` |
| F3 (partial) | Skip `currentTime` writes within 0.25 s of the target; `play()` only when paused | video-detector.js | `23dc92a` |
| F5 | Toast popover re-shown only when closed or the fullscreen element changed; WAAPI replaces the `offsetWidth` reflow | overlay.js | `d4e4af3` |
| F2 | Storage changes take settings from `changes.newValue` (no full read); `setEnabled` refreshes only on hidden→shown; background tabs defer refresh until visible | content-script.js, overlay.js | `2ddf46e` |
| F4 | Pending jump: read locally, wait for 500 ms with no seek in progress, seek, verify within 2 s, retry once, **then** consume; in-flight guard | video-detector.js, content-script.js, new `video-detector.test.js` | `c1a9781` |
| F6 | `isVisible` once per candidate; ignore overlay/toast mutations; skip mutation-triggered rescans while the bound video is attached and playing | video-detector.js | `af051b6` |
| F7 (partial) | Overlay Library tab is built only while visible | overlay.js | `dc58b28` |
| F8 | Detector callbacks and timers call `tearDownDeadContext()` in orphaned copies | content-script.js | `aaad2c9` |
| F10 | Library: rows built on first expand; no duplicate `loadState()` after mutations; `onChanged` skips when videos are unchanged | library.js | `3294b33` |
| F11, F14 | Hotkey errors shown as a toast; text-input check uses `composedPath()[0]` + `isContentEditable` | content-script.js | `ccd20fd` |
| F12, F18 | All worker handlers answer on failure; `importState`/`clearAllData`/`FORWARD_TO_ACTIVE_TAB` need an extension-page sender URL (not `sender.tab`, which would block the library/options tabs) | service-worker.js | `c46abfb` |
| F13 | Overlay refresh sequence number drops stale results | overlay.js | `804ad13` |
| F19 | `GET_CONTEXT` no longer sends the `videos` map; only the overlay's local call gets it | content-script.js | `f3a6352` |
| F16 | `endRange` is one queued write (save + clear draft); no write when no draft matches | storage.js, storage.test.js | `e07cffb` |
| F17 | `normalizeVideo`/`normalizePendingJump` keep only http(s)/file URLs; library Open goes through `OPEN_VIDEO_URL` | schema.js, library.js, schema.test.js | `b811980` |
| F20 | README: migration runs on worker start; what "disable generic sites" really blocks | README.md | `b821f9f` |

No new JS files or message types were added. `manifest.json`, `CONTENT_SCRIPT_FILES` and `importScripts` were re-checked and are still identical in order. `STORAGE_RPC_METHODS` still matches `RPC_METHODS` (14 each, no `setState`/`updateState`/`upsertVideo`). No storage format change and no `SCHEMA_VERSION` bump: F17 tightens validation only. Permissions and adapters are untouched.

## 2. Skipped or not reproducible

| ID | Reason |
|---|---|
| F4 (trailer part) | Whether a Prime/Hotstar detail-page trailer is picked as the active video is Suspected and needs a live site. Not changed. |
| F15 | Numpad support needs a new stored token format (e.g. `Num1`), because `1` already maps to `Digit1`. That is a hotkey-format decision, and the finding is Low, so it is deferred. |

## 3. Needs your decision

1. **F3 site seek bridge (main-world player API for Netflix/YouTube).** The bridge needs a new message type, `executeScript({world:"MAIN"})`, and Netflix's undocumented `getVideoPlayerBySessionId().seek()`. The finding is Suspected (M7375). Options: (a) build it behind a per-platform fallback to `currentTime`, or (b) wait. **Recommend (b):** first check whether the flicker remains with these fixes, using review §2 step 5.
2. **F7 mount the overlay only when a video is detected.** This would remove the panel (and its Library tab) from pages without video, such as Gmail. That is a visible change. **Recommend yes**, but only with your OK.
3. **F9 `stopImmediatePropagation()` on matched hotkeys.** This would stop site handlers from also seeing SceneMarks hotkeys. It is Suspected (check on YouTube whether Alt+Shift+N also skips to the next video). **Recommend applying it if that check reproduces.**
4. **F20 alternative.** I fixed the docs. If you want "disable generic sites" to also stop detection and queued jumps, that is a behavior change.

## 4. Not done

- Enhancements from §4 of the review: main-world seek bridge, refresh hash/coalescing beyond F13, pausing highlight work in fullscreen or hidden tabs, patch-based or virtualized lists, pending-jump "jump in existing tab", a per-video version counter, and per-video storage keys.
- Test gaps from §5: migrations, site adapters, hotkey round-trip extraction, RPC parity test, and a large-state benchmark. `seekTo` and `endRange` coverage was added.
- Known side effect of F1: after a same-video jump, the overlay's "Current time mm:ss" status line keeps its old value until the next refresh. The highlight does move. The line was already a snapshot that went stale during playback.

## 5. How to verify

**Automated:** `node --test test/automated/*.test.js` → 49 pass, 0 fail.

**Harness run, done here:** the built-in browser can't load an unpacked extension. Instead, the real content-script stack ran against a mocked `chrome` API on a page with a playing `<video>`, once on this branch and once on `main`:

| Scenario | `main` | this branch |
|---|---|---|
| Overlay Jump: storage reads / overlay DOM mutations / toast reflows | 2 / 196 / 1 | 0 / 0 / 0 |
| Two jumps 100 ms apart: reads / mutations / popover hide+show | 3 / 294 / 2+2 | 0 / 0 / 0+0 |
| Jump to the current position while paused: `currentTime` writes | 1 | 0 |
| Hotkey next: reads / mutations | 2 / 98 | 1 / 0 |
| Pending jump + site "resume" seek to 0:15 | ends at **0:15**, jump consumed | retried, ends at **4:00**, then consumed |

No console errors. Jump toasts, highlights and the `(n/total)` counter were correct. This does **not** prove the visual flicker is gone on real MSE players. Please check that by hand:

1. `brave://extensions` → SceneMarks → **Reload**, then reload every open video tab.
2. Open `test/manual-html5-video.html` (allow file URLs) and pick a local video. Save 3–4 timestamps, then jump using the overlay Jump buttons, Alt+Shift+N/B and the popup. Each jump should land without the overlay list blinking. A repeat jump to the same spot while paused should do nothing visible.
3. Fullscreen the video, then press Alt+Shift+N a few times quickly. The toast should show above the video with no black flash.
4. On the streaming site where you saw the flicker: paste the event logger from review §2 step 1 into the Console and jump once. You should see a single `seeking`→`seeked` and no long `waiting`. Optionally, record a Performance trace (§2 step 2): there should be no `refresh`/`render`/`normalizeState` tasks right after the jump.
5. Library page → Jump on a scene for a video that is not open. The new tab should land on the timestamp even when the site resumes elsewhere first, and the toast should say "Jumped to …".
6. Library: delete, favorite and edit each re-render once. Expanding a collapsed card shows its rows.
