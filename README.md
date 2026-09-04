# SceneMarks

SceneMarks is a local-first Chromium extension for saving timestamp bookmarks and scene ranges from HTML5 streaming video pages.

It stores saved scenes locally in `chrome.storage.local`. It does not download video, record video or audio, capture screenshots, inspect cookies, bypass DRM, send analytics, or use a backend server.

## What Is Implemented

- Manifest V3 extension.
- Generic HTML5 video detection with active-video scoring.
- Local timestamp and scene-range storage.
- Safe note/tag rendering with `textContent`.
- Popup controls for save, range start/end, jump, edit, and delete.
- Optional always-visible draggable overlay panel with Current and Library views.
- Page-level customizable hotkeys from the extension settings page.
- Browser command shortcuts for quick save, range toggle, and library.
- Netflix, Prime Video, Hotstar/JioHotstar, and YouTube identity adapters. (Saves made on YouTube before the adapter existed are migrated from the old generic key on the next page load.)
- Library page with search, filters, favorites, edit/delete, copy share text, export, import, and a Random pick button.
- Favorites at both levels: star entire videos or individual timestamps from the library, the overlay, or the popup. The library's and overlay's favorites filters include any video that is favorited itself or has a favorited timestamp.
- Random video shortcut that opens a random saved video, skipping videos already open in tabs of the current window.
- Permissions: `storage`, `activeTab`, `scripting`, and `tabs`, plus an `<all_urls>` host permission so content scripts (video detection, overlay, queued jumps) run on every page without popup activation.

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
8. Use the overlay **Library** view to search saved videos without leaving the current page.
9. Open the full **Library** page to search, expand/collapse video groups, export/import JSON, favorite videos and scenes, or open source pages. Use the **Random** button (or press `R` on the library page) to pick and highlight a random video that is not already open in a tab of the current window. When every matching video is already open, SceneMarks says so instead of re-picking one.
10. Star a video or timestamp anywhere (library, overlay, popup) and it shows up under the favorites filters in the library page and the overlay Library view.

## Overlay Panel

The overlay panel appears on video pages when enabled from the popup or Settings. It can be dragged from its header and shows whether the current video has saved timestamps.

From the overlay you can:

- Save the current timestamp.
- Start or end a scene range.
- See saved timestamps/ranges for the current video in **Current** view, and star any of them with the star button. While the video plays, the timestamp you have most recently passed stays highlighted (a saved range is highlighted while playback is inside it), and the list auto-scrolls to keep that row in view. Scrolling or pressing on the list pauses the auto-scroll for a few seconds so you can browse freely.
- Search all saved videos and scenes in **Library** view, and star any video from its group header.
- Toggle **Favorites** in Library view to show only favorited videos and favorited timestamps. A video appears when it is favorited itself or has at least one favorited timestamp.
- Pick a random saved video with the **Random** button. Random picks from whatever the current search and favorites filters match, so toggle **Favorites** first to shuffle within your favorites. Videos already open in a tab of the current window are never picked, so repeated picks keep surfacing videos you have not opened yet.
- Expand a video title to reveal its saved scenes, or use **Expand All** / **Collapse All** to scan faster.
- Click **Jump** for the current video to seek immediately.
- Click **Jump** for another saved video to open that video page and queue the timestamp jump.
- Click the star beside a scene or video to favorite or unfavorite it.
- Click the **x** button beside a scene to delete it.
- Collapse the panel if you only want a small header.

SceneMarks confirms actions (saves, jumps, favorites, errors) with a brief colored notification at the top center of the page. Green means success, red means an error occurred, and clicking a notification dismisses it immediately. Notifications appear even when the overlay itself is hidden.

Queued timestamp jumps are stored briefly while the target page opens. Once SceneMarks detects the matching video page, it seeks to the selected timestamp and clears the queued jump. SceneMarks content scripts load on all pages (`<all_urls>`), so the overlay and queued jumps work on both supported streaming hosts and generic HTML5 video pages without opening the popup first.

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
- `Alt+Shift+N`: jump to the next saved timestamp for the current video. Press repeatedly to rotate through all saved timestamps from the beginning.
- `Alt+Shift+B`: jump back through saved timestamps for the current video. It skips the most recent previous timestamp — the one you just jumped to or are still near — and lands on the one before it, so repeated presses keep cycling backwards instead of re-landing on the same timestamp while playback moves on. At the first saved timestamp it wraps to the last one.
- `Alt+Shift+R`: open a random video from the library. Videos already open in a tab of the current window are never picked, so repeated jumps keep surfacing videos you have not opened yet. Query strings and tracking parameters are ignored when matching open tabs, so player URLs with different tracking noise still count as already open (YouTube video ids are preserved, since they live in the URL query). The library page and overlay Random buttons use the same matching.
- `Alt+Shift+O`: show or hide the overlay panel.
- `Alt+Shift+L`: open library.

To customize page hotkeys, open SceneMarks popup, click **Hotkeys**, then use the recorder fields in Settings. Single-key shortcuts are supported: click **Record** and press one key, for example just `S`, with no modifier. Press `Escape` while recording to cancel. Page hotkeys are ignored while you type in text fields.

Page hotkeys are registered at `document_start`, before the site's own scripts run, so streaming players cannot swallow single-key presses before SceneMarks sees them. After changing hotkeys, reload the video tab so the updated content script picks them up.

To customize browser command shortcuts, open `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`.

## Generic HTML5 Video Support

SceneMarks content scripts run on all pages (`<all_urls>`) at `document_start`, so generic HTML5 video pages are detected automatically without opening the popup first. The popup-injection path (`activeTab` plus `scripting`) still exists as a fallback for pages where the auto-loaded script could not run.

Generic page support can be disabled in Settings. This only stops generic sites from being detected; it does not change extension permissions.

## Platform Adapters

Adapters only normalize video identity and titles. They do not access media streams.

- Netflix: extracts `/watch/{id}`.
- Prime Video: extracts stable detail/video IDs when present, with path fallback.
- Hotstar/JioHotstar: extracts numeric/path content IDs, with path fallback.
- YouTube: extracts the stable 11-character video id from the `v` query parameter, `youtu.be/{id}` short links, or `/shorts/{id}` paths.
- Generic: uses origin plus normalized path.

Streaming services change player and URL behavior often. SceneMarks uses best-effort DOM/video interaction and may need adapter updates later.

## Automated Tests

The shared data layer — schema normalization, storage behavior, and time formatting — has dependency-free tests using Node's built-in test runner:

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
7. Open Library and confirm search plus export/import.
8. Favorite a video from its card header (works while collapsed) and a timestamp from its row, then check **Favorites only**: both videos appear — the favorited video with all its scenes, the other with only the favorited timestamp.
9. In the overlay, toggle **Favorites** in the Library view and confirm the same filtering, then press **Random** to shuffle within the favorites.

Then test on Netflix, Prime Video, and Hotstar/JioHotstar:

1. Start playback first.
2. Save one timestamp.
3. Reload the page.
4. Confirm the saved scene appears.
5. Try Jump. If the site blocks seeking while loading, wait for playback to settle and retry.

## Known Limitations

- SceneMarks saves timestamp references only. It never creates real video clips.
- Some streaming sites may delay or block seeking until metadata/playback is ready.
- Browser command shortcuts can conflict with site/browser shortcuts.
- The `<all_urls>` host permission is broad; all processing stays local, but review `manifest.json` before installing builds you do not trust.
