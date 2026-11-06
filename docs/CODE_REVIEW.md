# SceneMarks Code Review

Read-only review of `main` at `1d4ac60`. Automated tests: `node --test test/automated/*.test.js` → **37/37 pass**.

## 1. Summary

The data layer is in good shape: the single-writer queue, `SKIP_WRITE`, TTL normalization, the RPC whitelist and the duplicated script load lists are all correct and consistent. The weak spots are the **main-thread work done right when a seek happens** and the **per-write fan-out to every open tab**. Nothing in the code seeks twice or loops, but a jump runs several full storage reads and whole-panel DOM rebuilds while the site's player is trying to rebuffer.

Fix these first:
1. **Stop the refresh storm around a jump** (F1, F2). A jump changes no data, so it should only move the highlight and must not read storage or rebuild the overlay.
2. **Seek through the site player instead of writing `currentTime` directly**, and skip no-op seeks (F3). Netflix, Prime and Hotstar handle direct writes badly.
3. **Make the queued `pendingJump` robust** (F4): wait until the player is ready, confirm the seek landed, and only then consume the jump.

## 2. Video flicker/lag diagnosis

**Important scope note.** This codebase has **no auto-jump at scene boundaries and no skip points**. A grep for `skip`, `boundary`, `autojump` and `fastSeek` finds no such logic. Every seek comes from a user action or from `pendingJump`. If glitches show up during an automatic skip, another extension or the site itself (for example Netflix "Skip Intro") is doing that seek.

### Most likely causes, in order

1. **Main-thread jank at the moment of the seek** (Confirmed in code; the visual effect still needs runtime confirmation). Netflix, Prime, Hotstar and YouTube are MSE players: after a seek, their JavaScript has to fetch segments and call `appendBuffer` on the **page's main thread**. That is the same thread the content script uses. SceneMarks does its heaviest work in exactly that window, so the player rebuffers late, which shows up as a frozen frame, a black flash or a stutter.
2. **Direct `video.currentTime = x` fights the site player** (Suspected). Netflix's Cadmium player is widely reported to raise error M7375 or re-sync after an external `currentTime` write. Prime and Hotstar show a spinner or rebuffer. The detector also seeks even when the target is within milliseconds of the current position.
3. **Toast top-layer churn over fullscreen video** (Suspected). Each toast hides and re-shows a popover in the top layer and forces a synchronous reflow. In fullscreen, a layer appearing over the video can make Chrome stop showing the video as a hardware overlay and composite it instead. Switching between the two modes can flash for one frame.

### What happens when you click "Jump" in the overlay (Current tab)

1. `overlay.js:767` `jumpToScene` → `content-script.js:459` `seekTo` → `video-detector.js:219`.
2. `findActiveVideo()` (`video-detector.js:75`) runs `getBoundingClientRect` 3× and `getComputedStyle` 2× per `<video>` (`isVisible` is called twice in `scoreVideo`, lines 48 and 64), which forces a layout.
3. `video.currentTime = target` (`video-detector.js:235`). There is no epsilon check, and `await video.play()` runs even if the video is already playing (line 240).
4. `scheduleOverlayRefresh(250)` (`content-script.js:464`).
5. Back in `jumpToScene`: `showToast` (`overlay.js:254`): `hidePopover` + `showPopover` + `void toast.offsetWidth`, which forces another reflow, then a 180 ms opacity/transform transition.
6. `await refresh()` (`overlay.js:776`): `getContextResponse` → `findActiveVideo()` again → `Storage.getState()` structured-clones the **entire** library out of `chrome.storage` and runs `normalizeState` over every video and scene (with sorting) → `render()` **rebuilds the Current list and the whole Library panel** (`overlay.js:308-320`, `467-486`), even when the Library tab is hidden.
7. 250 ms later the scheduled refresh runs step 6 again.
8. The seek fires `timeupdate`, which triggers `notify()` (re-derives identity, `video-detector.js:146`), then the highlight changes and a smooth `scrollIntoView` starts (`overlay.js:464`).

Hotkey next/previous runs steps 1–4 plus one refresh. Popup and library jumps go through `SEEK_TO` and also run steps 1–4 plus one refresh. A **pending jump** is the worst case. `consumePendingJump` writes to storage, which fires `storage.onChanged` in this tab: `setEnabled` → `refresh()` immediately, plus a scheduled refresh (`content-script.js:711-713`, `overlay.js:274-276`). That happens on top of the seek's own refresh, while the site's player is still initializing and may be running its own "resume where you left off" seek.

### Fix sketch

- **Jumps must not refresh.** After a successful seek, call `overlay.updatePlaybackTime(target)` (highlight only) and drop both `refresh()` in `overlay.js:776` and `scheduleOverlayRefresh(250)` in `content-script.js:464`. Seeks change no stored data.
- **Seek gently.** Return early if `Math.abs(video.currentTime - target) < 0.25`. Only call `play()` when `video.paused`. Show the toast on `seeked` (or after `requestIdleCallback`) rather than in the same task as the seek.
- **Site seek bridge.** Add a small main-world script (`chrome.scripting.executeScript({ world: "MAIN" })`) that uses the player's own API. For Netflix that is `netflix.appContext.state.playerApp.getAPI().videoPlayer` → `getVideoPlayerBySessionId(id).seek(ms)`. For YouTube it is `document.getElementById("movie_player").seekTo(s, true)`. Fall back to `currentTime` everywhere else. Keep this outside `site-adapters/`, since AGENTS.md says adapters never touch media. `fastSeek` is not an option: Chrome does not implement it.
- **Toast.** Only re-raise the popover when `document.fullscreenElement` is set and the toast is not already open. Restart the animation with the Web Animations API instead of `offsetWidth`.

### 5-minute confirmation in Brave/Chrome DevTools

1. Open a video tab, then DevTools → **Console**, and paste:
   ```js
   const v = document.querySelector("video");
   ["seeking","seeked","waiting","playing","stalled"].forEach(e =>
     v.addEventListener(e, () => console.log(e, v.currentTime.toFixed(2), Math.round(performance.now()))));
   ```
   Jump once. A healthy jump logs a single `seeking` → `seeked`. A second `seeking` means the site re-seeked (cause 2). A long `waiting` means a rebuffer.
2. **Performance** tab, with Screenshots enabled → Record → press `Alt+Shift+N` three times → Stop. In the Main track, right after each `keydown`/`click`, look for long tasks containing `refresh`/`render`/`renderLibrary`/`normalizeState` and purple "Forced reflow" warnings from `findActiveVideo`/`showToast`. Compare those with dropped frames in the Frames track (cause 1).
3. A/B test: hide the overlay (`Alt+Shift+O`) and repeat. If the glitch mostly disappears, cause 1 is confirmed.
4. In fullscreen, add `.scenemarks-toast{display:none!important}` through Elements → Styles and repeat. If the flash goes away, cause 3 is confirmed. **Rendering** → *Paint flashing* + *Layer borders* shows what repaints.
5. On Netflix, watch the console and the player for M7375 or other player errors after a jump (cause 2).

## 3. Findings

Severity is impact on real use. "Confirmed" means traced in the code; "Suspected" means it needs runtime verification (the method is given in the row).

| ID | Sev | Area | File:line | Issue | Impact | Conf. | Suggested fix |
|---|---|---|---|---|---|---|---|
| F1 | High | Jump path | `overlay.js:767-777`, `content-script.js:459-468` | Every jump runs 1–2 full refreshes (whole-library `getState` + `normalizeState` + rebuild of Current **and** hidden Library panels) right after the seek | Main-thread jank while the MSE player rebuffers; the most likely cause of the reported glitch | Confirmed (effect: Suspected, see §2 steps 2–3) | Highlight-only update after a seek; no storage read |
| F2 | High | Storage fan-out | `content-script.js:704-714`, `overlay.js:269-277` | Each storage write makes **every tab on every site** run `loadSettings` (full read) + `setEnabled`→`refresh()` + a scheduled `refresh()`: 3 full reads/normalizations and 2 overlay rebuilds per tab. `onChanged` also delivers old+new full blobs | Saving during playback janks the video tab; cost grows with tab count × library size | Confirmed | Use `changes.scenemarksState.newValue` once; drop the `refresh()` inside `setEnabled` when already enabled; skip work when `document.hidden` or overlay hidden/collapsed and refresh on `visibilitychange` |
| F3 | High | Seek | `video-detector.js:219-249` | Direct `currentTime` write, no epsilon guard, `play()` even when already playing, no site-player API | Netflix M7375/re-sync, Prime/Hotstar rebuffer spinner; useless decoder flushes on no-op seeks | Suspected (verify §2 steps 1 and 5) | Epsilon guard, `play()` only if paused, main-world player-API seek bridge |
| F4 | High | Pending jump | `content-script.js:758-782`, `storage.js:400-420` | Jump is **consumed before the seek is confirmed**; it runs once the video reaches `HAVE_METADATA` (or after a 3 s timeout), racing the site's own resume seek; on Prime/Hotstar detail pages an autoplay trailer `<video>` (>60 s) can be the detected video | Lands at the wrong time or on the trailer, then the jump is gone; visible double jump | Confirmed (consume order); Suspected (trailer/resume race: verify with §2 step 1 in a new tab) | Wait for `playing` + settle (no `seeking`, ~500 ms), seek, verify within 2 s after `seeked`, retry once, then consume |
| F5 | Med | Toast | `overlay.js:218-231`, `254-267` | Every toast hides and re-shows the popover in the top layer and forces a reflow (`offsetWidth`) | One-frame flash over fullscreen video; forced layout of the whole page | Suspected (verify §2 step 4) | Raise only in fullscreen and only if not already open; animate with WAAPI |
| F6 | Med | Detection | `video-detector.js:199-208`, `251-259`, `15-69` | Whole-document `childList` observer → scans every 400 ms on mutating pages (Netflix/YouTube caption DOM, the overlay's own re-renders); each scan forces layout per `<video>`, and `isVisible` is computed twice | Steady layout cost during playback; scroll jank on feeds with many videos (Reddit/X) | Confirmed (cost: Suspected; Performance tab shows "Recalculate style/Layout" every ~400 ms) | Skip the rescan while `activeVideo.isConnected` and it is still playing; call `isVisible` once; ignore mutations inside `.scenemarks-overlay` |
| F7 | Med | Page-wide cost | `content-script.js:784-824`, `overlay.js:269-277` | The overlay mounts and fully renders the library on **every page** (`<all_urls>`), including pages without video; each page load reads and normalizes the whole state twice | Wasted CPU and memory on every navigation; a SceneMarks panel on Gmail etc. | Confirmed | Mount and render only after a video is detected; build the Library tab lazily when opened |
| F8 | Med | Lifecycle | `content-script.js:126-136`, `723-756` | After an extension reload or **auto-update**, the orphaned copy's detector (observer, media listeners, timers) keeps running; callbacks check `isContextDead()` but never call `tearDownDeadContext()` (only keydown does) | Two detectors doing forced-layout scans in every old tab until reload | Confirmed | Call `tearDownDeadContext()` from `onContextChange`, `onPlaybackTick` and the timer callbacks when dead |
| F9 | Med | Hotkeys | `content-script.js:680` | Matched hotkeys call `preventDefault` but not `stopImmediatePropagation`; site handlers still get the event | Site shortcuts may fire as well (for example, YouTube Shift+N/P if it ignores Alt) | Suspected (on YouTube, press Alt+Shift+N and see whether it also skips to the next video) | `event.stopImmediatePropagation()` on a match (this listener already runs first, in capture at window) |
| F10 | Med | Library scale | `library.js:166-194`, `326-364`, `649-655` | Every storage change (including another tab's `setPendingJump`/consume) rebuilds every card and every scene row, including collapsed ones. Its own mutations render twice (`loadState()` + `onChanged`) | Library page gets sluggish at a few thousand scenes | Confirmed | Build rows only for expanded cards; diff by `videoKey`/`updatedAt`; drop the explicit `loadState()` after mutations |
| F11 | Low | Errors | `content-script.js:682-689` | Non-context hotkey errors (for example RPC "Receiving end does not exist", quota exceeded) are swallowed silently | Hotkey appears to do nothing | Confirmed | Show `overlay.showToast(error.message, "error")` |
| F12 | Low | Worker | `service-worker.js:381-414` | Non-RPC handlers use `.then(sendResponse)` with no `.catch` (for example `tabs.create` failing) | Unhandled rejection; the caller gets "message port closed" | Confirmed | Add `.catch(e => sendResponse({ ok:false, error:e.message }))` |
| F13 | Low | Overlay | `overlay.js:299-306` | Concurrent `refresh()` calls are not coalesced; an older `getState` can resolve last | A stale list renders briefly | Suspected | Sequence number; drop stale results |
| F14 | Low | Hotkeys | `content-script.js:155-161` | `isTextInputTarget` ignores shadow DOM (target is retargeted to the host) and `contenteditable="plaintext-only"` | Hotkeys fire while typing in web-component inputs | Confirmed | Use `event.composedPath()[0]` and `isContentEditable` |
| F15 | Low | Hotkeys | `options.js:136-143`, `content-script.js:228-242` | Numpad/Intl keys fall back to `event.key`: recording Numpad1 stores "1", which matches only `Digit1` | Recorded numpad shortcuts never fire | Confirmed | Add `Numpad*` to both maps, or store the raw code |
| F16 | Low | Data | `storage.js:245-288` | `endRange` reads the draft outside the write queue and then does 2 separate writes (save + clear) | 2 `onChanged` storms per range; a small race with another tab | Confirmed | One `updateState` that saves and clears atomically |
| F17 | Low | Security | `schema.js:154-184`, `library.js:423-430` | Imported `canonicalUrl`/`rawUrls` are not scheme-checked; library `openVideo` calls `chrome.tabs.create` directly, bypassing the worker's http/https/file check | A crafted import can make "Open" load an arbitrary scheme | Confirmed | Validate the scheme in `normalizeVideo`; route opens through `OPEN_VIDEO_URL` |
| F18 | Low | Security | `service-worker.js:365-374`, `411-414` | `STORAGE_RPC` (`clearAllData`, `importState`) and `FORWARD_TO_ACTIVE_TAB` accept any extension sender, including content scripts in any page | A compromised renderer could wipe or replace data | Confirmed | Reject destructive methods when `sender.tab` is set |
| F19 | Low | Messaging | `content-script.js:287-302` | `GET_CONTEXT` returns the full `videos` map; the popup never uses it | A large message on every popup open | Confirmed | Send `videos` only to the overlay (local call) |
| F20 | Low | Docs | `README.md:18`, `README.md:106` | The migration runs on worker start, not "next page load". Disabling generic sites does not stop detection or pending jumps (`attemptPendingJump` ignores `enableGenericSites`) | Misleading docs/setting | Confirmed | Fix the README or honor the setting in `attemptPendingJump` and the detector |

**Verified OK:**
- `manifest.json` `content_scripts[0].js` and `CONTENT_SCRIPT_FILES` are identical in content and order, and `importScripts` has the correct shared/adapter order plus `migrations.js`.
- `STORAGE_RPC_METHODS` matches `RPC_METHODS` (14 each); neither exposes `setState`/`updateState`/`upsertVideo`.
- `SKIP_WRITE` is honored, and the migration is idempotent and skips idle writes.
- `consumePendingJump` reads before writing.
- Expired `activeRangeDraft`/`pendingJump` are dropped in normalization.
- No `innerHTML` anywhere; selectors use `CSS.escape`.
- The `tokenToCode` ↔ `tokenFromCode` round trip holds for letters, digits, punctuation, F-keys and navigation keys.
- README permission and YouTube claims match the manifest.
- No seek loop: `timeupdate` never triggers a seek.

## 4. Enhancements

- **(S)** No-op seek guard plus `play()` only when paused (part of F3).
- **(S)** Coalesce overlay refreshes into one in-flight render with a version check, and skip the render when the state is unchanged (a hash of `updatedAt`s).
- **(S)** Pause the highlight and auto-scroll work when `document.fullscreenElement` hides the overlay or the tab is hidden.
- **(M)** Main-world seek bridge for Netflix and YouTube, with a `currentTime` fallback (F3).
- **(M)** Lazy, patch-based overlay Library tab and a virtualized `library.js` list (F7, F10).
- **(M)** Pending-jump state machine: wait for ready → seek → verify → retry → consume (F4). Also offer "jump in the existing tab" when the video is already open, instead of always opening a new tab.
- **(M)** Store per-video records or a version counter, so `onChanged` listeners can tell what changed without re-reading the whole blob.
- **(L)** Split storage into per-video keys, so writes and `onChanged` payloads scale with one video rather than the whole library.

## 5. Test gaps

The current tests cover only `schema.js`, `storage.js` and `time.js`. These are untested and worth covering:

- `migrations.js`: re-keying, merging into an existing key, and idempotency (a second run must return `SKIP_WRITE`).
- Site adapters: `videoKey`/`canonicalUrl` for real Netflix/Prime/Hotstar/YouTube URL shapes, including `youtu.be`, `/shorts/`, and Prime `/gp/video/detail/`.
- Hotkey round trip: for every `event.code`, `tokenToCode(parse(tokenFromCode(code)).key) === code`. The two maps currently live in different files, so extract them to `shared/` so they can be tested.
- `video-detector.js` `seekTo` with a fake media element: epsilon guard, play-state behavior, and the not-ready timeout.
- Pending-jump flow: consume only after a successful seek, and TTL expiry while waiting.
- An RPC whitelist parity test: `STORAGE_RPC_METHODS` vs `RPC_METHODS`, so the AGENTS.md rule is enforced automatically.
- A large-state benchmark: `normalizeState` on 1k videos × 20 scenes, to track F2/F7 costs.
