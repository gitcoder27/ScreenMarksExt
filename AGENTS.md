# SceneMarks — Agent Instructions

SceneMarks is a local-first Chromium (Manifest V3) browser extension for saving timestamp bookmarks and scene ranges on HTML5 streaming video pages. Vanilla JS with no build step, no bundler, and no npm dependencies — automated tests use only Node's built-in test runner. The repo root itself is the loadable extension.

## Repository Layout

- `manifest.json` — MV3 manifest. Permissions: `storage`, `activeTab`, `scripting`, `tabs`, plus `<all_urls>` host permission; content scripts run on all pages at `document_start`.
- `src/shared/` — classic-script IIFE modules that attach to the global `SceneMarks` namespace: `constants.js`, `time.js`, `ids.js`, `schema.js`, `storage.js`, `migrations.js`. Load order matters (constants → time → ids → schema → storage). `migrations.js` is loaded only by the service worker (it needs `SiteAdapters`, so the worker's `importScripts` also loads `site-adapters/` before it) — it is NOT in the content-script load lists.
- `src/content/` — `video-detector.js`, `overlay.js` + `overlay.css`, `content-script.js`, and `site-adapters/` (generic, netflix, prime-video, hotstar, youtube, index).
- `src/background/service-worker.js` — MV3 service worker: message routing, content-script injection fallback, tab management, and the single storage writer (STORAGE_RPC handler + startup legacy migration).
- `src/popup/`, `src/options/`, `src/library/` — extension pages (plain HTML/CSS/JS, no framework).
- `test/automated/` — dependency-free Node tests for the shared layer (schema, storage, time). Run: `node --test test/automated/*.test.js`.
- `test/manual-html5-video.html` — manual test page for local video playback.
- `assets/icons/` — extension icons.

## Commands

There is no package.json, build, or lint setup. Automated tests cover the shared data layer:

```
node --test test/automated/*.test.js
```

To verify changes by hand:

1. Load the repo root unpacked in Brave (`brave://extensions` → Developer mode → Load unpacked) or Chrome.
2. After edits, click Reload on the extension and reload any open video tabs.
3. Test on `test/manual-html5-video.html` first (enable "Allow access to file URLs" when loading from `file://`), then on Netflix / Prime Video / Hotstar / YouTube. `README.md` has the full manual test checklist.

## Architecture Rules

- **Script load lists are duplicated**: any new JS file must be added to `manifest.json` `content_scripts[0].js` AND `CONTENT_SCRIPT_FILES` in `src/background/service-worker.js` (shared files also go in the worker's `importScripts`), in the same order. Otherwise the popup-injected path diverges from the auto-loaded path.
- No ES imports in content/shared context. Each file is an IIFE `(function attachX(root) { ... })(globalThis)` extending `root.SceneMarks` (`SceneMarks.Constants`, `SceneMarks.Schema`, `SceneMarks.Storage`, `SceneMarks.Adapters`, …).
- All persisted data lives under the single `chrome.storage.local` key `scenemarksState`. Every write passes through `normalizeState` / `normalize*` in `src/shared/schema.js`; new persisted fields must be added there (with `sanitizeText` length caps) or they are silently stripped.
- **The service worker is the single storage writer.** All writes are serialized by the FIFO queue inside `updateState`/`importState`/`clearAllData` in `storage.js`. Content scripts, popup, library, and options must mutate through `SceneMarks.Storage.createClient()` (reads stay local via `getState`/`getScenesForVideo`); mutating directly from another context reintroduces the lost-update race. The worker's `STORAGE_RPC_METHODS` whitelist must match `RPC_METHODS` in `storage.js`, and neither may ever include `setState`/`updateState`/`upsertVideo`. Mutators may return `Storage.SKIP_WRITE` to skip the write (no-op migrations depend on this — an idle pass must not rewrite the state blob or every tab gets a pointless `storage.onChanged` storm).
- Cross-context messaging uses `MESSAGE_TYPES` (`SCENEMARKS_*` prefix) from `src/shared/constants.js` — add new message types there, never as string literals.
- Site adapters only normalize video identity (`videoKey`, `canonicalUrl`, `title`) per platform; they never touch media streams. `site-adapters/index.js` picks the adapter and falls back to the generic adapter field by field. Valid platforms: `netflix`, `prime`, `hotstar`, `youtube`, `generic`, `unknown`.
- Breaking storage changes require bumping `SCHEMA_VERSION` in `constants.js` and adding a migration in `src/shared/migrations.js`.

## Conventions & Gotchas

- Security: render user content (notes, tags, titles) with `textContent` only — never `innerHTML` — since content scripts run on all pages.
- `README.md` previously claimed no `<all_urls>` host permission and no YouTube support and pointed at a nonexistent install folder; those errors were fixed, but re-verify README claims against `manifest.json` when touching permissions or adapters — `manifest.json` is the source of truth.
- Page hotkeys are registered at `document_start` so sites can't swallow single-key presses; hotkey defaults and all settings live in `DEFAULT_SETTINGS` in `constants.js`. After changing hotkey code or config, video tabs must be reloaded. Adding a hotkey touches five places: `DEFAULT_SETTINGS.hotkeys`, `normalizeHotkeys` in `schema.js`, the dispatch chain in `content-script.js`, and the input + save logic in `options.js`/`options.html`. Matching is done against `event.code` (via `tokenToCode` in `content-script.js`), not `event.key` — `event.key` is layout- and Alt-composed (macOS Alt+Shift+S yields "Í"); the options recorder (`tokenFromCode` in `options.js`) stores the inverse mapping, so the two maps must round-trip when either changes.
- Range drafts (`activeRangeDraft`) and queued cross-page jumps (`pendingJump`) have TTLs (`RANGE_DRAFT_TTL_MS`, `PENDING_JUMP_TTL_MS`) and are dropped during normalization once expired.
