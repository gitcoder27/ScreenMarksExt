# SceneMarks

SceneMarks is a local-first Chromium extension for saving timestamp bookmarks and scene ranges from HTML5 streaming video pages.

It stores saved scenes locally in `chrome.storage.local` (see [Data Storage](#data-storage)). It does not download video, record video or audio, capture screenshots, inspect cookies, bypass DRM, send analytics, or use a backend server.

## What Is Implemented

- Manifest V3 extension.
- Generic HTML5 video detection with active-video scoring.
- Local timestamp and scene-range storage.
- Safe note/tag rendering with `textContent`.
- Popup controls for save, range start/end, jump, edit, and delete, with two-step arm-then-confirm deletion.
- Optional draggable capture controls with an Open Library button.
- Page-level customizable hotkeys from the extension settings page.
- Settings page showing how much local `chrome.storage` space SceneMarks uses.
- Browser command shortcuts for quick save, range toggle, and library.
- Netflix, Prime Video, Hotstar/JioHotstar, and YouTube identity adapters. (Saves made on YouTube before the adapter existed are migrated from the old generic key when the extension is installed, updated, enabled or reloaded, when the browser starts, and after an import.)
- Library page with search, filters, favorites, edit/delete, copy share text, export, import, a Random pick button, and a batch Open Random that opens a chosen number of random videos (up to 10 at a time) in new tabs.
- Favorites at both levels: star entire videos in the Library or individual timestamps in the Library and popup. The Library favorites filter includes any video that is favorited itself or has a favorited timestamp.
- Random video shortcut that opens a random saved video, skipping videos already open in tabs of the current window.
- Permissions: `storage`, `unlimitedStorage`, `activeTab`, `scripting`, and `tabs`, plus an `<all_urls>` host permission so content scripts (video detection, overlay, queued jumps) run on every page without popup activation. `unlimitedStorage` lifts the 10 MB `chrome.storage.local` cap; Chrome shows no permission warning for it.

## Install In Brave

1. Open `brave://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the repository root folder (the one containing `manifest.json`).

5. Pin SceneMarks if you want quick popup access.

The same flow works in Chrome at `chrome://extensions`.

## Usage

1. Open a supported video page.
2. Start playback so the page creates the active `<video>` element.
3. Open SceneMarks.
4. Click **Save Moment** to save the current timestamp with optional notes/tags.
5. Click **Mark Scene Start**, continue playback, then click **Mark End** to save a range.
6. Click **Jump** beside any saved scene to seek back to it.
7. Use **Overlay On/Off** in the popup to show or hide the draggable page overlay.
8. Use the overlay **Open Library** button to open saved videos in a private extension page.
9. Open the full **Library** page to search, expand/collapse video groups, export/import JSON, favorite videos and scenes, or open source pages. Use the **Random** button (or press `R` on the library page) to pick and highlight a random video that is not already open in a tab of the current window. When every matching video is already open, SceneMarks says so instead of re-picking one. To open several at once, set the count next to **Open Random** and click it (or press `Enter` in the count field): that many distinct videos are sampled uniformly at random from the filtered, not-already-open pool and opened in background tabs — asking for more than are available opens all of them. One batch opens at most 10 tabs, since each one loads a full streaming site at once.
10. Star a video in the Library or a timestamp in the Library/popup to include it in the Library favorites filter.

## Overlay Panel

The draggable overlay offers **Quick Save**, **Mark range start/end**, and **Open Library**. Saved notes, titles, tags, scene lists, favorites and deletion controls are available in extension-origin popup/Library pages. They are never rendered into a visited website's DOM, where page scripts could read them. Overlay actions ignore synthetic events.

SceneMarks shows brief feedback notifications, including above fullscreen players where the browser supports popovers. Overlay capture feedback contains no saved annotations. Private search, favorites, random selection and editing are in the Library page.

Queued timestamp jumps are kept for up to 15 minutes. Library opens the destination through the worker, which binds the request to the new tab before navigating it. Only that tab can execute and consume the jump; an existing tab showing the same video stays untouched. Once the matching video is detected there, SceneMarks verifies the seek before consuming that specific request. Temporarily unready players retry with delays of 1–5 seconds until success, expiry, cancellation or navigation; failed retries do not produce repeated notifications. A newer request cannot be cleared by an older seek. The single pending slot means a newer opening replaces an older outstanding request. Ownerless requests from older versions require re-opening the scene; browser startup clears owned requests from the previous session, while ordinary worker wakes keep them.

## Hotkeys

SceneMarks supports two hotkey layers:

- Browser command shortcuts from `manifest.json`.
- Page hotkeys that can be customized inside SceneMarks settings.

Default browser command shortcuts:

- `Ctrl+Shift+S` or `Command+Shift+S`: quick save current timestamp.
- `Ctrl+Shift+M` or `Command+Shift+M`: mark range start/end.
- `Ctrl+Shift+L` or `Command+Shift+L`: open library.

Default page hotkeys:

- `Alt+Shift+S`: quick save current timestamp.
- `Alt+Shift+M`: mark range start/end (toggle).
- `Alt+Shift+A`: mark range start only.
- `Alt+Shift+D`: mark range end only.
- `Alt+Shift+N`: jump to the next saved timestamp for the current video. Press repeatedly to rotate through all saved timestamps from the beginning. The confirmation toast shows where you landed among the video's saved scenes, e.g. `Jumped to 04:12 (4/10)`; the backwards hotkey shows the same counter.
- `Alt+Shift+B`: jump back through saved timestamps for the current video. It skips the most recent previous timestamp — the one you just jumped to or are still near — and lands on the one before it, so repeated presses keep cycling backwards instead of re-landing on the same timestamp while playback moves on. At the first saved timestamp it wraps to the last one.
- `Alt+Shift+R`: open a random video from the library. Videos already open in a tab of the current window are never picked, so repeated jumps keep surfacing videos you have not opened yet. Open-tab matching uses service adapter identities (including YouTube watch/shorts/short-link variants). Generic matching preserves case-sensitive paths, content query parameters and fragments while removing known tracking parameters. Library Random controls use the same matching.
- `Alt+Shift+O`: show or hide the overlay panel.
- `Alt+Shift+L`: open library.

To customize page hotkeys, open SceneMarks popup, click **Hotkeys**, then use the recorder fields in Settings. Single-key shortcuts are supported: click **Record** and press one key, for example just `S`, with no modifier. Press `Escape` while recording to cancel. Page hotkeys are ignored while you type in text fields.

Page hotkeys are registered at `document_start`, synchronously before waiting for settings. Shortcuts pass through while settings load; accepted matches stop propagation before running an action. Saved settings reach open tabs immediately. Reload video tabs after updating extension code. Numpad keys keep their own physical-key identity, separately from main-keyboard digits and Enter.

To customize browser command shortcuts, open `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`.

## Switching SceneMarks Off For A Site

The popup's top panel has two switches:

- **Turn off here** switches SceneMarks off for the hostname displayed in the popup and its subdomains. It keeps hosted tenants such as `alice.github.io` separate from their neighbors. **Turn on here** removes every entry covering the page.
- **Pause everywhere** switches SceneMarks off on every site until you press **Resume**.

On a switched-off site, page hotkeys go to the site untouched, the overlay is hidden, and saving or marking ranges is refused. Saved scenes still show in the popup, and jumps from the library still land. The toolbar icon shows an **OFF** badge on those tabs. The changes reach open tabs right away, with no reload needed.

Settings → **Where SceneMarks Runs** lists the switched-off sites. You can turn a site back on there, or add one by hand (`example.com`, a subdomain, or a pasted URL). An entry covers the domain it names and its subdomains. The popup conservatively keeps the hostname instead of guessing public suffixes. Add a broader domain explicitly in Settings when you want it to cover sibling hosts.

The browser-level shortcuts (`Ctrl/Cmd+Shift+S/M/L`) belong to the browser, so it keeps those keys on every site. On a switched-off site they do nothing. If they clash with a site's own shortcuts, clear them at `chrome://extensions/shortcuts`.

## Generic HTML5 Video Support

SceneMarks content scripts run on all pages (`<all_urls>`) at `document_start`, so generic HTML5 video pages are detected automatically without opening the popup first. The popup-injection path (`activeTab` plus `scripting`) still exists as a fallback for pages where the auto-loaded script could not run.

Generic page support can be disabled in Settings. This blocks saving, range marking, and next/previous scene hotkeys on generic sites; video detection, the overlay, and queued jumps still run there. It does not change extension permissions.

## Platform Adapters

Adapters only normalize video identity and titles. They do not access media streams.

- Netflix: extracts `/watch/{id}`.
- Prime Video: extracts stable detail/video IDs when present, with path fallback.
- Hotstar/JioHotstar: extracts numeric/path content IDs, with path fallback.
- YouTube: extracts the stable 11-character video id from the `v` query parameter, `youtu.be/{id}` short links, or `/shorts/{id}` paths.
- Generic: uses the full URL, preserving path case, non-tracking query parameters (sorted by name) and fragments, including SPA hash routes. Only known tracking names (`utm_*`, `fbclid`, `gclid`, `msclkid`, `dclid`) are discarded. Unknown/session parameters and fragments are retained conservatively; they may create separate records rather than risk merging different content.

Streaming services change player and URL behavior often. SceneMarks uses best-effort DOM/video interaction and may need adapter updates later.

## Data Storage

Everything stays in this browser profile's `chrome.storage.local`, split so that a change rewrites only what it touches:

| Key | Holds |
|---|---|
| `video:<videoKey>` | One saved video: its identity, up to five recent page URLs, its favorite flag and its scenes |
| `settings` | Settings, page hotkeys, the pause switch and the switched-off sites (at most 200) |
| `activeRangeDraft` | A started, unfinished range (dropped after 24 hours) |
| `pendingJump` | A jump owned by its destination tab and request token (dropped after 15 minutes) |
| `schemaVersion` | The storage layout version, currently 3 |

Saving, editing or favoriting a scene writes only that video's key, so every open tab is told about one video instead of the whole library, and the cost of a save does not grow with the library. All writes run in the service worker, one at a time.

Versions before schema 2 kept everything in one `scenemarksState` key. When the extension is installed, updated, re-enabled or reloaded, when the browser starts, and after an import, SceneMarks moves that data into the keys above, then deletes the old key. The move is safe to repeat: if it fails, the old key stays for the next attempt, and once it is done it writes nothing.

Schema 3 migrates old generic identities using stored source URLs. When those URLs identify different videos, the old record stays intact with an identity-repair notice in the Library. Scene ownership cannot be inferred reliably from already mixed records or URLs lost before migration; export and retain a backup before manually separating those annotations. Migrations also move matching range drafts and queued jumps in the same write as their video.

Library exports are a single JSON object (`schemaVersion`, `videos`, `settings`, ...) whatever the storage layout, and import accepts exports from any version. Merge imports combine scenes with identical endpoints and notes by unioning tags and keeping either favorite flag. Conflicting notes/endpoints, nearby distinct times, and tag unions exceeding the tag cap stay as separate scenes; conflicting IDs are reassigned. Duplicate IDs and reversed range endpoints are repaired, invalid scenes are rejected, and the import result reports counts. Merge import keeps current settings unless explicitly requested through the storage API. Replacing imports remain available through the storage API.

Settings saves include only fields changed in that form. External changes update pristine fields and preserve unsaved edits; hotkeys merge per action.

## Automated Tests

The shared data layer, adapters, service worker, popup capture, Settings synchronization, content hotkeys, overlay privacy and queued-jump workflows have dependency-free tests using Node's built-in test runner and browser/DOM doubles:

```
node --test test/automated/*.test.js
```

No npm packages or build step are required; any Node 18+ runtime can run them.

## Manual Testing

Do this first on a normal HTML5 video before trying streaming sites:

1. Load the extension unpacked.
2. Open `test/manual-html5-video.html` in Brave.
3. If testing from `file://`, open the extension details page and enable **Allow access to file URLs**.
4. Choose a local video file in the test page.
5. Start playback.
6. Open SceneMarks and confirm:
   - Video is detected.
   - **Save Moment** stores a timestamp.
   - **Mark Scene Start** then **Mark End** stores a range.
   - Saved rows appear in the popup.
   - **Jump** seeks to the saved timestamp.
   - **Edit** and **Delete** work.
   - The star beside a saved scene in the popup toggles its favorite state.
7. Open Library and confirm search plus export/import, and that a save in another tab shows up without reloading the library page.
8. Favorite a video from its card header (works while collapsed) and a timestamp from its row, then check **Favorites only**: both videos appear — the favorited video with all its scenes, the other with only the favorited timestamp.
9. Use overlay **Quick Save**, **Mark range start/end** and **Open Library**. Confirm saved annotations appear only in the popup/Library. Try popup capture while playback continues, customized single-key/numpad shortcuts, and independent Settings changes from two extension pages.
10. Serve the test page over `http://localhost` (for example `python3 -m http.server`) and press **Turn off here** in the popup. Confirm that the overlay disappears, page hotkeys do nothing, and the toolbar badge reads **OFF**. Then open a scene from the Library and confirm the jump still lands. Press **Turn on here** and confirm everything comes back without a reload. Repeat with **Pause everywhere** / **Resume**, which also covers `file://` pages.

Then test on Netflix, Prime Video, Hotstar/JioHotstar, and YouTube:

1. Start playback first.
2. Save one timestamp.
3. Reload the page.
4. Confirm the saved scene appears.
5. Open a queued Library jump while the player loads and confirm it retries and lands when ready. Keep a same-video tab already playing while a new target loads slowly: only the new tab should seek. Queue a second jump while the first is seeking, and repeat while paused/switched off, after same-element SPA navigation, after a worker wake, and after browser restart/session restoration.

## Known Limitations

- SceneMarks saves timestamp references only. It never creates real video clips.
- Some streaming sites may delay or block seeking until metadata/playback is ready.
- Browser command shortcuts can conflict with site/browser shortcuts.
- The `<all_urls>` host permission is broad; all processing stays local, but review `manifest.json` before installing builds you do not trust.

Legacy generic records may need manual repair, and generic players with unknown session parameters can produce separate records. Automated browser doubles do not validate fullscreen layout or DRM/service integration; complete the manual checklist in Chrome/Brave before release.
