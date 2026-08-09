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
- Netflix, Prime Video, and Hotstar/JioHotstar identity adapters.
- Library page with search, filters, favorites, edit/delete, copy share text, export, and import.
- Minimal permissions: no `<all_urls>` host permission.

## Install In Brave

1. Open `brave://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder:

   `outputs/scenemarks`

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
9. Open the full **Library** page to search, expand/collapse video groups, export/import JSON, favorite scenes, or open source pages.

## Overlay Panel

The overlay panel appears on video pages when enabled from the popup or Settings. It can be dragged from its header and shows whether the current video has saved timestamps.

From the overlay you can:

- Save the current timestamp.
- Start or end a scene range.
- See saved timestamps/ranges for the current video in **Current** view.
- Search all saved videos and scenes in **Library** view.
- Expand a video title to reveal its saved scenes, or use **Expand All** / **Collapse All** to scan faster.
- Click **Jump** for the current video to seek immediately.
- Click **Jump** for another saved video to open that video page and queue the timestamp jump.
- Collapse the panel if you only want a small header.

Queued timestamp jumps are stored briefly while the target page opens. Once SceneMarks detects the matching video page, it seeks to the selected timestamp and clears the queued jump. This works best on supported hosts where SceneMarks has content-script access. Generic pages may still require opening the popup on the target page because SceneMarks avoids broad `<all_urls>` permission.

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
- `Alt+Shift+M`: mark range start/end.
- `Alt+Shift+L`: open library.

To customize page hotkeys, open SceneMarks popup, click **Hotkeys**, then use the recorder fields in Settings.

To customize browser command shortcuts, open `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`.

## Generic HTML5 Video Support

SceneMarks does not request `<all_urls>`. For generic pages, open the extension popup while the page is active. The extension uses `activeTab` and `scripting` to inject SceneMarks into that page after your click.

Generic page support can be disabled in Settings without changing extension permissions.

## Platform Adapters

Adapters only normalize video identity and titles. They do not access media streams.

- Netflix: extracts `/watch/{id}`.
- Prime Video: extracts stable detail/video IDs when present, with path fallback.
- Hotstar/JioHotstar: extracts numeric/path content IDs, with path fallback.
- Generic: uses origin plus normalized path.

Streaming services change player and URL behavior often. SceneMarks uses best-effort DOM/video interaction and may need adapter updates later.

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
7. Open Library and confirm search plus export/import.

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
- Generic pages require popup activation because broad host access is intentionally avoided.
- YouTube-specific support is not included.
