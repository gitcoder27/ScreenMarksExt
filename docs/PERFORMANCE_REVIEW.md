# SceneMarks Performance Review

This is a review of `fix/code-review-fixes` at `b821f9f`, after the F1–F20 fixes. Tests at review time: `node --test test/automated/*.test.js` → 49/49 pass. The quick wins from §5 have since been applied; §8 has the commits and re-measured results.

**Method.** I read every script and benchmarked the shared data layer in Node at four library sizes. I also ran the real content-script stack in a browser page with a mocked `chrome` API. That run counted storage reads, DOM nodes, long tasks and detector scans. Two things were not measured: real Netflix and YouTube pages, and Chrome's internal storage IPC. Numbers that depend on either are marked *Estimated*.

## 1. Short answer

- **No runaway bugs.** There are no `setInterval`s, alarms, open ports, seek loops or listener leaks, and the service worker goes idle on its own.
- **Two real defects.** Orphaned copies keep scanning after an extension reload or update (P8). Stored data grows without bound (P9, P11).
- **Everything else is scaling cost.** The whole library sits in one storage key, and the content script runs in every tab on every site. So most costs grow with **library size × open tabs**:
  - **About 300 videos / 6k scenes (≈1.6 MB):** each cost is a few ms. You will not notice it.
  - **About 1,000 videos / 20k scenes (≈5.5 MB):** each save costs every open tab tens of ms. Every tab also holds about 10 MB of library in memory.
  - **About 37k short-note scenes (fewer with long notes):** the 10 MB quota is full, and every save fails.
- **Closing or hiding SceneMarks does not turn it off.** Closing the popup or library page stops that page. Hiding the overlay only stops its rendering. The detector and the storage fan-out keep running in every tab.

## 2. What keeps running when you "close" it

| You… | What stops | What keeps running in every http(s)/file tab |
|---|---|---|
| Close the popup or options page | Everything in that page | Nothing depends on them |
| Close the library tab | Its re-render on every write | Nothing |
| Turn the overlay off | Overlay DOM, refreshes, highlight | <ul><li>Detector: about 2.2 scans/s on pages that keep changing their DOM</li><li>Whole-library storage-change delivery on every write</li><li>1 full library read per page load</li><li>The hotkey listener</li><li>Tabs that already showed the overlay keep their library copy (P2)</li></ul> |
| Leave a tab in the background | Overlay refresh (deferred until the tab is shown) | Storage-change delivery, the detector (Chrome throttles its timers to about 1/s), media listeners on a playing video |
| Reload or auto-update the extension | Nothing in old tabs (new tabs start fresh) | Old tabs: the orphaned copy keeps scanning and its overlay stays on screen until you press a key, a video plays or you click the overlay (P8) |
| Leave the service worker idle for about 30 s | The worker exits (good) | Each wake re-runs the legacy migration: a full read and scan (P10) |

Only disabling the extension, or limiting its **Site access** to specific sites in `chrome://extensions`, stops the per-tab work.

## 3. Measurements

Unless a row says otherwise, the library has 1,000 videos × 20 scenes (5.46 MB of JSON).

| What | Result | Where |
|---|---|---|
| Build one in-memory copy of the library (`structuredClone`, a proxy for Chrome giving a tab one storage value) | 41 ms | browser |
| `normalizeState`, which runs on every read | 8.6 ms | browser |
| JS heap kept alive by one normalized copy (what each tab's overlay holds) | ~10 MB for 4.6 MB of JSON | Node `--expose-gc` |
| Full library reads per page load on a page without video, overlay on / off | 3 / 1 | harness |
| First open of the overlay Library tab | <ul><li>88 ms build + 40 ms style/layout</li><li>Long tasks of 132, 74, 62 and 53 ms</li><li>**10,000 scene rows built, 0 visible**</li><li>88k nodes, 32k buttons</li></ul> | harness |
| Detector scans on a page that keeps changing its DOM, with no playing video | 2.2/s. One scan over 30 videos with dirty layout: 3.5 ms on a simple page | harness |
| Orphaned copy after a simulated reload, same page | 2.2 scans/s until a keydown, then 0 | harness |
| One `saveScene` in the worker (read → normalize → normalize → write) | 13 ms at 300 videos, 49 ms at 1k, 169 ms at 3k | Node |
| Legacy migration pass with nothing to migrate | 6 ms at 300 videos, 25 ms at 1k | Node |
| `rawUrls` after 200 saves from distinct URLs | 200 entries, never trimmed | Node |
| Storage size vs. quota | 3,000 × 20 = 19 MB, over quota, so writes fail. 10 MB holds about 37k short-note scenes (≈280 B each), or about 8k with 1,000-character notes | Node |

These numbers come from an Apple-silicon Mac. A content script on a busy streaming page will run slower.

## 4. Findings

Severity is the impact at high load. "Confirmed" means traced in the code and reproduced in the harness. *Estimated* means the mechanism is confirmed but the size of the cost is inferred.

| ID | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| P1 | High | **Every write sends the whole library to every tab.** The content script in each http(s)/file tab listens to `storage.onChanged`, and everything lives in the one `scenemarksState` key. So each save, favorite, delete, range start or queued jump gives every tab a full old copy **and** a full new copy. That includes background tabs, tabs with no video, and tabs with the overlay off. A library **Jump** is 2 writes (set, then consume the pending jump). At 5.5 MB this is about 80 ms of main-thread work per tab per write (2 × 41 ms, *Estimated*), so 30 tabs cost about 2.4 s of CPU per click. The blob is also read twice and rewritten in full on disk every time. The playing video tab pays the same cost, plus its refresh. | `content-script.js:727-742`, `storage.js:82-92` | Split storage. Settings and transient state (`pendingJump`, `activeRangeDraft`) go in small keys of their own, and the library goes in per-video keys, so each change carries only one video. Needs a `SCHEMA_VERSION` bump and a migration. (L) |
| P2 | High | **Every tab keeps a full copy of the library in memory.** The overlay asks for `includeVideos: true` on every refresh and keeps the result in `latestState`. It does this on pages without a video too, and while only the Current tab is shown. That is about 10 MB of heap per tab at 1k × 20, or about 300 MB across 30 tabs. Hiding the overlay does not free it. | `content-script.js:845`, `:318`; `overlay.js:345` | Fetch `videos` only while the Library tab is open, and drop it when the tab closes or the overlay hides. Get the header count from a cheap total. (S) |
| P3 | High | **Every page load on every site reads and normalizes the whole library 3 times** (once with the overlay off; 4 times on video pages because of the pending-jump check). It also mounts the overlay, even on Gmail or Docs. This also runs in tabs that load in the background, all at once and while heavy sites are loading: opening 10 random videos means 30–40 full reads, and a 50-tab session restore means 150 or more. | `content-script.js:160-164`, `:870-880`, `:132-140`, `:812`; `overlay.js:295-306` | Do one read at init and reuse it for both settings and the first render. Mount and render only after a video is detected (the F7 decision is still open). Make hidden tabs wait (see P5). (S) |
| P4 | Med | **The overlay Library tab builds 10 rows for every video, even collapsed ones.** The harness counted 10,000 hidden rows, 88k nodes and 32k click listeners added to the host page's DOM, with long tasks up to 132 ms. The tab is rebuilt on every write while it is open and after each pause in typing a search. The library page already got this fix (F10); the overlay did not. | `overlay.js:637-644` | Build rows only for expanded groups, as `library.js` does. (S) |
| P5 | Med | **Turning the overlay on refreshes every tab at once.** `setEnabled(true)` calls `refresh()` directly, which skips the hidden-tab deferral, and every tab receives the setting change. One toggle makes all N tabs, including background ones, read the full library, render it and keep a copy (P2). | `overlay.js:303-305`, `content-script.js:737-739` | Route the call through `scheduleOverlayRefresh`, which already defers in hidden tabs. (S) |
| P6 | Med | **The detector keeps polling pages that change.** An observer on the whole document schedules a scan at most every 400 ms whenever no bound video is playing. That covers chat apps, feeds, dashboards and paused videos. Each scan walks the whole DOM looking for `<video>`, and if it finds any, it forces style and layout. Measured: 2.2 scans/s. On real, heavy pages one scan costs more than the 3.5 ms measured here (*Estimated*). | `video-detector.js:242-274`, `:351-359` | While no video is bound, rely on events instead: add `play` to the capture-phase `loadedmetadata`/`emptied` scan triggers, which are already wired along with navigation. Keep the observer only to notice when the bound video is removed, or disconnect it while the tab is hidden. Check feed sites after the change. (M) |
| P7 | Med | **Storage quota cliff.** The manifest has no `unlimitedStorage`, so `storage.local` is capped at 10 MB, and everything is in one key. Once the key is full, every save, favorite, range and queued jump fails until you delete data. That is about 37k short scenes, or about 8k with long notes. | `manifest.json:12`, `options.js:12` | Add `unlimitedStorage` (then re-check the README's permission claims). Warn in the popup and overlay at about 80%. (S) |
| P8 | Med | **Orphaned copies keep scanning after an extension reload or auto-update.** The F8 teardown runs only from content-script callbacks. On a page with no video, or with a paused one, the detector never calls them, because the identity signature does not change. So its observer and 400 ms scans keep running, and the dead overlay stays on screen. Measured: 2.2 scans/s until a keydown. | `content-script.js:131-151`, `video-detector.js:242-251` | Pass an `isAlive()` check into the detector, and call `stop()` from `scheduleScan` and `handleMutations` when the check fails. (S) |
| P9 | Med | **`rawUrls` grows without bound.** Every save from a URL that has not been seen before appends `location.href`. Netflix adds a per-session `trackId`/`tctx`, and YouTube adds `&t=`, `&list=` and `&pp=` tokens. Measured: 200 saves gave 200 URLs. Each URL is parsed with `new URL()` on every normalize in every context and is joined into every library search. It also makes every P1 broadcast bigger. | `storage.js:102-106`, `schema.js:185-187` | Keep the last 5 or so, and strip query parameters the adapter does not need. (S) |
| P10 | Low | **The worker re-runs the legacy migration on every wake.** MV3 workers stop after about 30 s idle. After each pause, the first RPC waits behind a full read and scan (25 ms at 1k videos, and growing with the library). | `service-worker.js:18-20` | Run the migration from `chrome.runtime.onInstalled`, or once behind a stored flag, instead of at the top level. (S) |
| P11 | Low | **Mutations that change nothing still rewrite the state and broadcast it.** <ul><li>`startRange` always writes, and it creates an empty video record that is never removed (it shows in the library as "0 scenes").</li><li>`clearPendingJump` writes even when nothing is pending.</li><li>`deleteScene` and `updateScene` write even when the scene is missing.</li><li>Saving unchanged settings writes.</li></ul> Each one is a full P1 broadcast. | `storage.js:225-239`, `:309-337`, `:364-389`, `:441-464` | Return `SKIP_WRITE` when nothing changed. Create the video record only when its first scene is saved. (S) |
| P12 | Low | **The library page does extra full passes on every write, even as a background tab.** It runs `JSON.stringify` on all videos twice to detect a change, then re-reads storage instead of using `newValue`, then rebuilds every card. An import does 3 full reads and sends the whole state back over RPC. | `library.js:671-686`, `:651-657`; `storage.js:527-528` | Compare a revision counter, render from `newValue`, and have `importState` return a count instead of the whole state. (S) |
| P13 | Low | **"Open N random videos" has no upper limit.** The input has `min="1"` and no `max`, and the worker opens as many tabs as requested. Each tab loads a streaming site and adds P3's reads and P2's library copy. A typo of 100 opens 100 heavy tabs. | `library.html:31`, `service-worker.js:324-352` | Clamp the count, for example to 10, in both the UI and the worker. (S) |

## 5. Recommended order

1. **Quick wins.** All are small, and none needs a schema change: P8, P5, P4, P2, P3 (one read at init, hidden tabs wait), P11, P10, P13, and P9 (cap new entries).
2. **Decide F7**, which was left open in `FIX_REPORT.md`: should the overlay mount only when a video is detected? A yes removes most of the P2 and P3 cost on pages without video.
3. **The structural fix:** split storage (P1), plus `unlimitedStorage` (P7). This is the only fix that stops cost from growing with library size; the others make each step cheaper.
4. **Optional product change:** make generic-site support opt-in through optional host permissions. The content script would then run only on streaming sites by default.

## 6. Checked and fine

- The service worker has no timers, alarms or ports, so it goes idle. The popup, options and library pages leave nothing running once closed.
- Per-tick playback work is negligible. On each `timeupdate` (about 4 times a second, background tabs included), it is one URL parse, one title regex and one class toggle. The highlight never rebuilds the list.
- The hotkey listener does up to 9 small string parses per keydown, which is negligible.
- `waitForReady` and `waitForSeekQuiet` remove their listeners, and `destroy()` clears its timers. No leaks found.
- The earlier fixes still hold:
  - F1: same-video jumps do no storage read and no rebuild.
  - F2: hidden tabs defer their refreshes.
  - F5: toasts do not force layout.
  - F13: stale refreshes are dropped.
- Content scripts run in the top frame only; the manifest does not set `all_frames`.

## 7. How to confirm in Chrome or Brave

1. **Memory (P2).** With a large library, open about 10 tabs. Open the Task Manager (Shift+Esc), right-click the column header and add **JavaScript memory**. Compare with the same tabs while the extension is disabled.
2. **Fan-out (P1).** Open DevTools on a background tab and start a Performance recording. Save a scene in another tab, then stop the recording. Look for a task in the extension's content-script context right after the save; it grows with the library.
3. **Orphan (P8).** Pause a YouTube video and reload the extension. Record Performance on that tab for 5 s without touching it: a Timer → Layout pair repeats about every 400 ms. Press any key and it stops.
4. **Library tab (P4).** Open the overlay's Library tab, then run `document.querySelectorAll('.scenemarks-overlay *').length` in the page console.

## 8. Fix status (quick wins)

These were applied on `fix/code-review-fixes`, one commit each, and are not pushed. Tests: 56/56 pass. There are 7 new tests and 1 updated test, and each fails on the old code. The before/after numbers come from the same browser harness and library (1,000 videos × 20 scenes).

| ID | Commit | What changed | Before → after |
|---|---|---|---|
| P8 | `704dddd` | The detector checks an `isAlive` hook on its scan path and hands teardown to the content script | Orphan: 2.2 scans/s with the overlay left on screen → 0 scans/s, overlay and toast removed, no keypress needed |
| P5 | `83840b1` | `setEnabled` reports whether it showed the panel; callers use `scheduleOverlayRefresh` | Hidden tab when the overlay is turned on: 1 full read + render → 0 reads until the tab is shown, then 1 |
| P4 | `483ca9b` | Overlay Library rows are built only for expanded groups | Opening the tab: 10,000 rows, 88k nodes, long tasks up to 132 ms → 0 rows, 8k nodes, no long tasks |
| P2 | `36f9327` | Refreshes fetch `videos` only while the Library tab is open; leaving the tab or hiding the overlay releases the data and rows | Library copy kept per tab: always (≈10 MB) → only while the Library tab is open |
| P3 | `fb8ed7f` | Content-script reads share one copy for up to 3 s; a storage change, a mutation from this tab, or the timer drops it | Full reads per page load (no video, overlay on): 3 → 1 |
| P11 | `9f7aeed` | No-op mutators return `SKIP_WRITE`; `startRange` no longer creates an empty video record (`endRange` creates it) | 10 no-op calls: 10 writes and broadcasts → 0 |
| P10 | `7cda2c6` | The migration runs on `onInstalled`, `onStartup` and after `importState`; README and AGENTS.md updated | Storage reads on a bare worker wake: 1 full read + scan → 0 |
| P13 | `f194230` | `MAX_RANDOM_OPEN_COUNT` (10) is enforced in the worker and the library page; README updated | Asking for 50 opens 50 tabs → 10, with a note in the summary |
| P9 | `0de80df` | `MAX_RAW_URLS` (5): `normalizeVideo` keeps the newest entries, and a re-seen URL moves to the end | 200 saves from distinct URLs: 200 entries → 5. Existing long lists are trimmed on the next write |

**Not changed yet:**
- P1 (storage split), P6 (event-driven detector), P7 (`unlimitedStorage`) and P12 (library page passes).
- The F7 decision: mount the overlay only when a video is detected.
- For P9, query strings are not stripped; the cap alone bounds the growth.
- Empty "0 scenes" video records that already exist are left in place.
- A pre-existing race, unchanged by these fixes: two range toggles pressed faster than one storage round trip both start a range. That round trip takes a few ms in a real tab.

**Hand checks still needed in the real extension:**
- Reload the extension, then use the overlay Library tab: it shows "Loading library...", then the videos, and expanding a video shows its rows.
- Turn the overlay off and on from the popup; it appears with its content.
- Start and end a range with Alt+Shift+M.
- Use Open Random with a count above 10; it opens 10 tabs and the summary says so.
