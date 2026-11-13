# SceneMarks: screens, features and enhancement review

Date: 2026-11-10, revised 2026-11-11 after the owner's answers. Reviewed at commit `5638959` on `main`. No code was changed and nothing was committed. Line numbers below are as of that commit.

## Evidence plan

Five `claude-opus-5-5` children ran in parallel, read-only, each writing its evidence under `/tmp/scenemarks-fable/<letter>/`.

| Child | What it did | Change from the draft, and why |
|---|---|---|
| A | Inventory of every surface, control, hotkey, setting and message, from code | Kept. Added two questions the ranking depends on: what a saved range actually does when you jump to it, and which save paths can attach a note or tag. |
| B | Live walkthrough in a throwaway Chrome for Testing profile, with screenshots | Kept, with safer mechanics: it loaded a copy of the extension from `/tmp` (so the browser could not write into the repo), served the test page over `127.0.0.1`, visited no real streaming site, and saved 56 marks on one video to see how the overlay and popup scale. |
| C | Overlay deep dive with a privacy verdict per idea | Kept, raised to `high` effort because the privacy verdicts are the subtle judgment. Added "what can the host page read today" and three more candidates (undo, loop, extension-origin iframe). |
| D | Library behaviour, scale benchmark and data-model options | Kept. Moved backup, export formats, omnibox, series grouping and collections here, because they are data-model questions. |
| E | Workflow signals from git history, voice cost and value, cut list, feasibility of new playback features | **Replaced the proposed competitive scan.** This is a one-user tool, so parity with other extensions matters less than how the owner uses it. The drafts also had no child for deliverable 7 (what to cut) and none to say whether new playback features are buildable. |

No follow-up round was used. The remaining unknowns needed the owner's answer or a signed-in streaming site, which the children were not allowed to use. The owner has since answered all five questions; the next section says what changed.

What I read myself: the brief, two memory notes (the voice recognizer decision and the commit rule), three screenshots from B, and two short code ranges to verify claims that drive recommendations (`src/content/content-script.js:360-391` and `src/content/overlay.js:34-145`).

Limits of the evidence:

- **No real streaming site was tested.** Everything about Netflix, Prime Video, Hotstar and YouTube players comes from reading the code.
- **D's benchmark excludes Chrome's storage messaging.** It ran the real Library code against a stubbed `chrome.*`.
- **B ran its save script twice by mistake.** It only touched the throwaway profile; some of the 56 marks come from the second run.

## What the owner's answers changed

| Answer (2026-11-11) | Change to the report |
|---|---|
| "I start the video in normal mode, and once I load one of the timestamps I go fullscreen to watch it fully." | The panel is a picker used in normal mode. Keeping it off the player's controls and showing where you are now lead the overlay list; showing it in fullscreen drops to third and becomes a small pill that appears only on mouse movement. |
| Voice: the test was not good, changes were made since and are not yet verified. "Ignore this feature. It is under development." | Voice is out of scope. The cut-or-keep verdict is withdrawn, and no brief touches voice code or the popup's Voice card. |
| Notes and tags: "I rarely use this. Mostly the timestamps and the favorite feature." | Dropped: clickable tags, the tag list, the Library note editor and the side panel. Added: favorites from the keyboard and the popup, a popup Save that does not stop for a note, and Library rows built around time, star and Jump. |
| Ranges: not used today, "good to have… it should be working." | Range playback stays but moves to third among new features, cut down to pause-at-end. The play queue, which is built on favorites, moves to second. |
| Backup: fine, but "overwrite the same file or a maximum of two backup files." | The backup writes two fixed files and alternates between them. It never creates a third. |

## 1. Inventory

### Surfaces

| # | Surface | Where | State today |
|---|---|---|---|
| 1 | Toolbar popup | `src/popup/` | Solid controls, rough list: only about 2 saved scenes are visible at a time |
| 2 | In-page overlay | `src/content/overlay.js`, `overlay.css` | Rough: sits on the player's controls, forgets its position, hidden in fullscreen |
| 3 | Library page | `src/library/` | Solid for finding and opening; rough for organizing |
| 4 | Options page | `src/options/` | Rough: one page about 3,400 px tall with two save models |
| 5 | Voice commands | `src/voice/`, offscreen document | In development; not judged here at the owner's request |
| 6 | Page hotkeys (9) and browser commands (4) | `content-script.js:841-864`, `manifest.json:28-57` | Page hotkeys solid but hidden; two browser commands give no feedback |
| 7 | Queued cross-tab jump | worker `OPEN_VIDEO_AT_SCENE` | Solid: landed exactly at 14:55 in the walkthrough |
| 8 | Toasts | `overlay.js:37-51` | Solid: shown above fullscreen video |
| 9 | Per-tab OFF badge | worker | Solid |

### Features

| Feature | How you reach it | Judgment | Note |
|---|---|---|---|
| Quick save by page hotkey | `Alt+Shift` hotkey | Solid | Instant; the toast names the time |
| Quick save by browser command | Cmd/Ctrl+Shift+S | Rough | No feedback at all (`service-worker.js:584-591`, `content-script.js:717-726`) |
| Quick save from the overlay | Overlay button | Rough | Toast says only "Done"; every failure says "Open the SceneMarks popup to continue." (`overlay.js:65`) |
| Save Moment with note and tags | Popup | Solid | Always opens a note dialog first, so about 3 steps; the only save path that can attach a note or tag |
| Scene ranges | Popup, overlay, Cmd/Ctrl+Shift+M, Alt+Shift+A/D | Half-built | Stored and shown as `a -> b`, but the end time is never used: every jump seeks to the start and plays on. An open range cannot be cancelled from any UI. |
| Jump to a saved time | Popup, overlay chips, Library | Solid | |
| Next / previous saved time | Alt+Shift+N/B, voice | Solid, hidden | Shows "Jumped to 01:05 (1/56)", also in fullscreen. No surface hints that it exists. |
| Random | Alt+Shift+R, Library Random and `R`, Open Random N, voice "random" | Rough | Three behaviours: the Library button only highlights a card; the hotkey and Open Random open at 0:00; voice opens at the first mark |
| Lineup skip / return | Voice only, and only after Library Open Random | Hidden | The Library never says this is how the lineup is built |
| Favorite a saved time | Popup, Library | Solid, but mouse-only | No hotkey; a quick save cannot be marked favorite as you save it |
| Favorite a video | Library only | Rough | Not in the popup. Starring a card makes it jump to the top of the Library. |
| Library search and filters | Library | Solid | A favorited video shows all its scenes under "Favorites only" |
| Library sort | — | Missing | One fixed order: last updated first (`library.js:137`) |
| Library edit | Library | Rough | Two native `prompt()` boxes in a row (`library.js:550-565`) |
| Copy Text | Library | Half-built | The copied text has no URL (`library.js:591-610`) |
| Export / import | Library | Solid mechanics, rough messages | Manual only; import always merges; a bad file shows a raw parse error |
| Site switch and global pause | Popup, Options | Solid | |
| Customizable hotkeys | Options | Rough | No conflict check; a hotkey cannot be unbound (`schema.js:92-100`) |
| "Quick save should ask for a note" | Options | Misleading | It never asks. With it on, hotkey, overlay and browser-command saves are refused (`content-script.js:367-369`, verified). |
| Edit times or titles | — | Missing | `updateScene` takes only note, tags and favorite (`storage.js:527-566`) |

### Hard to discover

1. **Alt+Shift+N/B** (next / previous saved time) — the core rewatch loop, shown on no surface. It works in fullscreen, where the panel does not.
2. **Alt+Shift+A/D** (start-only and end-only range marks) — hotkey-only.
3. **The lineup** — "skip" and "return" work only by voice, and only after Library Open Random.
4. **Library `R`** — mentioned only in a tooltip.
5. **Cmd/Ctrl+Shift+S and +M** — silent, so you cannot tell they worked.

### README and code mismatches

- `README.md:17` lists three browser commands and omits `toggle-voice`.
- `README.md:83` says "click Hotkeys" in the popup. That button is a copy of Settings and opens no anchor (`popup.js:656`).
- `README.md:98` repeats the "asks for a note" wording.
- `README.md:51` says the page can read saved times "while the overlay is on". The list stays in the page and keeps updating while the overlay is hidden (`overlay.js:137`, `content-script.js:913-917`).
- A stale worker comment says the overlay has a Random button (`service-worker.js:356-357`).

The full table is in `/tmp/scenemarks-fable/A/inventory.md`.

## 2. Verdict

**SceneMarks is strong at capturing and weak at coming back.** Saving by page hotkey is instant and tells you the time. Stepping through marks shows your position, also in fullscreen. Opening a scene from the Library into a new tab lands on the second. Site switches, the storage split and the single-writer design are sound, and all 203 automated tests pass.

**The biggest gap is the return trip.** The owner picks a saved time in normal mode, goes fullscreen to watch, and works almost entirely with bare timestamps and favorites. Along that path:

- **Random** opens at 0:00, not at a saved moment, unless you use voice.
- **The overlay panel** sits on the bottom-right of the player, where the test page's fullscreen button is and where most players put theirs. That is the next thing to click after picking a time.
- **Favorites** have no hotkey, the popup cannot favorite a video, and starring a card in the Library makes it jump away.
- **The popup** shows two saved scenes at a time, and its Save button stops for a note the owner rarely writes.

**The biggest risk is data loss.** The library exists only in one browser profile's `chrome.storage.local`, and nothing protects it except a manual export.

## 3. Top 3 enhancements to existing features

### E1. One Random: land on a saved mark everywhere, and put skip / return on hotkeys

- **Evidence:** Random was built in five steps (`6e8e4a2`, `2efff45`, `1d4ac60`, `f194230`, `5638959`), more than any other feature. It behaves three ways (`library.js:203-248`, `service-worker.js:392-421`, `428-472`, `891-921`). Lineup skip / return exists only as voice words.
- **Effort:** S.
- **Risk:** low. Two new hotkeys touch five places. The new message must not let a page drive tab switching.
- **First slice:** make the Alt+Shift+R hotkey open at the first mark, the way voice "random" already does.
- **How we'll know:** from a keyboard alone, with voice off, you can open random videos, land on a saved moment in each, and move between them.

### E2. Tell the truth after every save

- **Evidence:** browser-command saves are silent. Overlay saves say "Done" or a misleading popup message, including for duplicates. The "ask for a note" setting blocks saves. An open range cannot be cancelled, and a range end rejected as a duplicate leaves the range open silently (B, `overlay-10-range-end-duplicate-toast.png`).
- **Effort:** S.
- **Risk:** low. Overlay toasts may carry only fixed text, times and counts.
- **First slice:** browser-command and overlay saves show the same toasts as the page hotkeys ("Saved 04:12").
- **How we'll know:** every save path shows one of: saved with the time, already saved, range open from a time, range saved, no video found, off on this site.

### E3. Build the popup around timestamps and favorites

- **Evidence:** with 56 saves the popup shows 2 rows, inside a scrollbar inside a scrollbar (`/tmp/scenemarks-fable/B/shots/popup-08-55-saves.png`). Each row spends its space on "No note" and an Edit button. Save Moment always opens a note dialog. A video can be favorited only in the Library, and no hotkey favorites anything. `saveScene` already accepts a `favorite` flag (`content-script.js:379`).
- **Effort:** S–M.
- **Risk:** low. One new hotkey touches five places.
- **First slice:** one-line rows (time, star, Jump), and Save Moment saves at once.
- **How we'll know:** at 600 px height at least 8 scenes are visible; a moment can be saved as a favorite with one key press; the video can be starred from the popup.

## 4. Top 3 new features

All three keep the overlay privacy rule and the local-first, no-backend stance. None needs a schema bump.

### N1. Automatic local backup, two files at most

- **Evidence:** removing the extension or losing the profile deletes the library for good; the only protection is a manual Export JSON (D). The extension is loaded unpacked, and a second unpacked copy on this machine has its own separate storage.
- **Effort:** M.
- **Risk:** medium. It adds the `downloads` and `alarms` permissions and writes a plain JSON file of titles and times into Downloads. Chrome may show its download bubble each time.
- **Design, per the owner:** exactly two files, `Downloads/SceneMarks/scenemarks-backup-1.json` and `-2.json`. Each backup overwrites the older of the two. Nothing is written when the library has not changed since the last backup, so the older file stays a real earlier copy.
- **First slice:** a "Back up now" button in Options and the time of the last backup.
- **How we'll know:** after a month of use the folder still holds two files, and importing the newer one into a fresh profile restores every video and scene.

### N2. Play queue: play a filtered set of scenes back to back

- **Evidence:** this is the structured version of what Random and the lineup already do by hand, and it runs on the owner's favorites: filter to Favorites, then play. The queued jump and the worker's lineup code are the building blocks (`service-worker.js:811-921`).
- **Effort:** M. Depends on E1.
- **Risk:** medium. Episode autoplay can break a queue mid-way, and the queued jump holds one request at a time.
- **First slice:** a "Play these" button in the Library that opens the first scene of the current filter in one tab; the lineup hotkeys from E1 step to the next and previous scene.
- **How we'll know:** filter to Favorites, press Play, go fullscreen, and step through ten scenes across three videos without returning to the Library.

### N3. Range playback: stop at the end of a range

- **Evidence:** scenes already store `endSeconds` (`schema.js:285-312`). The per-tick playback hook exists and does nothing (`content-script.js:152-157`, `video-detector.js:209-213`). The owner does not use ranges today but wants them to work when needed.
- **Effort:** S. Pause-at-end only; looping is left for later.
- **Risk:** low. Pausing needs no extra seek, so it avoids the rebuffering that looping would cause on streaming players.
- **First slice:** jumping to a range from the popup, overlay or next / previous pauses at the range end, with a toast.
- **How we'll know:** jump to a saved range on the test page and on one streaming site; playback stops within a second of the end time.

**Considered and not ranked:**

- **Side panel companion** (notes beside the player). The owner rarely writes notes, and it is hidden in fullscreen.
- **Skip ranges.** Repeated seeks on DRM players; YouTube ads.
- **Resume position.** The four big sites already resume.

## 5. Overlay: top 3 improvements

All three stay inside the rule: only the current video's saved times, trusted events only.

### O1. Keep the panel off the player's controls, and remember where it was put

- **Evidence:** the 360 px panel covers the bottom-right corner of the player (volume, fullscreen, menu) and about half the video at 800×500 (B, `overlay-01-default-pageload.png`, `overlay-12-55-marks-small-800x500.png`). A dragged position resets on every page load (`overlay.js:119-132`). There is no minimize control.
- **Effort:** M.
- **Risk:** low–medium. Position is stored once per platform (a fixed list), never per hostname. Each settings write reaches every tab, so write only when a drag ends.
- **First slice:** default to the top right, and remember a dragged position.
- **How we'll know:** pick a time, then click the player's fullscreen button without moving the panel first; reload and the panel is where you left it.
- **Do alongside:** clear the list of times when the panel hides, and update it only while visible. Today the page can read the times even with the overlay off.

### O2. Show where you are: nearest-mark highlight, previous / next buttons, open-range state

- **Evidence:** with 56 marks the list shows about 25 in a scroll box with no sign of the current position (`/tmp/scenemarks-fable/B/shots/overlay-11-55-marks-1400x820.png`). Picking a time from this list is the owner's first step on every video. An open range start is never shown, and the one range button does not say whether it will start or end.
- **Effort:** S–M.
- **Risk:** low. The open-range line may appear only when the draft belongs to the current video; hinting at a range on another video would leak activity.
- **First slice:** highlight the mark nearest the current time and scroll it into view inside the list.
- **How we'll know:** at any moment you can see which mark you are at, and step either way with one click.

### O3. In fullscreen, a pill that appears only when the mouse moves

- **Evidence:** in fullscreen only the toast shows, not the panel (`/tmp/scenemarks-fable/B/shots/overlay-14-fullscreen-next-toast.png`; `overlay.js:39-45`, `133-134`). Confirmed for native video fullscreen only. The owner goes fullscreen to watch, so a full panel there would be in the way.
- **Effort:** S–M, after O1.
- **Risk:** medium. Players that also use the top layer can cause a one-frame flash; this happened before (F5 in `docs/FIX_REPORT.md`, commit `2faad15`).
- **First slice:** make the panel a manual popover, collapsed to a pill in fullscreen, with previous and next.
- **How we'll know:** in fullscreen nothing is drawn while the mouse is still; moving it shows a pill that can step to the next saved time.

**Later:** a timeline strip with ticks (M), undo last save (S), and a closed shadow root as hardening (S–M).

**Not recommended:** deleting marks from the overlay (the page could steer real clicks onto a delete control), and showing favorite stars on the overlay's chips (the rule allows only times).

## 6. Library page: top 3 improvements

### L1. Sort controls, and stop the starred card jumping

- **Evidence:** one fixed order by `updatedAt` (`library.js:137`). Starring bumps `updatedAt` (`storage.js:538`, `572`), so the card you just starred jumps to the top. For someone who stars a lot, that happens on every star. A merge import sets every imported video to now (`storage.js:763`), wiping the order.
- **Effort:** S. No schema change.
- **Risk:** low.
- **First slice:** a sort dropdown with "Recently saved" as the default, taken from the newest scene's `createdAt`.
- **How we'll know:** starring a card leaves it in place, and the order survives an import.

### L2. Rows built around time, star and Jump

- **Evidence:** every scene row carries six buttons: Jump, Open, ☆, Edit, Copy Text, Delete (`library.js:431-438`; B, `library-10-one-expanded.png`). The row's Open repeats the video's Open, and Edit and Copy Text serve notes the owner rarely writes. No row shows when it was saved. Under "Favorites only", a favorited video shows all its scenes, so favorite moments and favorite videos cannot be told apart. The Random result is easy to miss.
- **Effort:** S–M.
- **Risk:** low.
- **First slice:** rows show time, saved date, star and Jump; the rest moves into a "more" menu.
- **How we'll know:** a row reads at a glance, and the Favorites filter can show just the starred moments.

### L3. Update only the card that changed

- **Evidence:** every storage write rebuilds the whole list (`library.js:180-191`), which drops keyboard focus on each star click. Measured: 25 ms at 500 videos, 91 ms at 2,000 collapsed, 621 ms at 2,000 expanded.
- **Effort:** S–M.
- **Risk:** low.
- **First slice:** on `storage.onChanged`, rebuild only the cards whose keys changed.
- **How we'll know:** star five scenes in a row from the keyboard without losing your place; no flicker when another tab saves.

**Later:** bulk select with favorite and delete (M); a `<dialog>` editor in place of the two `prompt()` boxes (S); clickable tags (S).

**Not worth building now:** series grouping (adapters know only episode identity), full virtualization (not needed below 2,000 videos), a separate collections store (favorites cover it).

## 7. What to cut or simplify

| Item | Verdict |
|---|---|
| "Quick save should ask for a note" setting | **Cut.** It blocks saves and never asks. |
| Popup Save Moment's note dialog before saving | **Simplify.** Save at once; a note can still be added with Edit. |
| Library Copy Text | **Cut.** It has no URL, and it serves notes. |
| Row-level "Open" in the Library | **Cut.** It repeats the video's Open. |
| Popup "Hotkeys" button | **Cut or fix.** It duplicates Settings. |
| Open Random, two-level favorites, site switches, queued jump | **Keep.** All are on the owner's main path. |
| Voice | **Not judged.** The owner is reworking it and asked to leave it out. For reference, it is about 3,350 of 11,117 source lines. |

## 8. Risks

1. **Repeated seeks on streaming players (N2).** Every seek rebuffers. Netflix is widely reported to throw an error when `currentTime` is set directly; the repo records no such problem, and this was not tested.
2. **New permissions for backup (N1).** `downloads` and `alarms`, a file of titles and times in Downloads, and a download bubble. A browser set to "ask where to save each file" would prompt every time. A large library as a `data:` URL needs a test at 2,000 videos.
3. **Fullscreen top layer (O3).** A player that also uses popovers or dialogs can flash or reorder. An earlier fix in this area was reverted.
4. **Hotkey sprawl (E1, E3).** Three new hotkeys in total. Each touches five places, and the `tokenToCode` / `tokenFromCode` maps must still round-trip.
5. **Settings fan-out (O1).** Every settings write reaches every open tab. Position must be written on drag end only.
6. **Privacy rule drift (E2, E3, O2).** Overlay toasts and the open-range line are the places where another video's activity could leak. Each brief names the limit.
7. **Evidence limits.** No streaming site was tested.

## 9. Handoff briefs

Each brief is for one Opus implementation thread. Common rules for all of them:

- Read `AGENTS.md` first. Vanilla JS, no build, no npm.
- Render user content with `textContent` only.
- New persisted fields go through the `normalize*` functions in `src/shared/schema.js` and `DEFAULT_SETTINGS` in `constants.js`. No brief here needs a `SCHEMA_VERSION` bump.
- New message types go in `MESSAGE_TYPES`. New RPCs go in both `RPC_METHODS` (`storage.js`) and `STORAGE_RPC_METHODS` (worker).
- No brief adds a JS file. If one becomes necessary, add it to `manifest.json` `content_scripts[0].js` and `CONTENT_SCRIPT_FILES` in the worker, in the same order.
- Leave voice alone: no changes to `src/voice/`, `popup-voice.js`, `voice-options.js` or the popup's Voice card.
- Run `node --test test/automated/*.test.js` (baseline: 203 pass). Commit to `main` locally; do not push.

Suggested order: H2, H1, H10, H4, H7, H3, H8, H11, H12, H5, H6, H9.

### H1. One Random and lineup hotkeys (E1)

- **Goal:** every random open lands on the video's first saved mark, and the lineup can be stepped from the keyboard.
- **Files:** `src/background/service-worker.js` (random hotkey `392-421`, Open Random `428-472`, lineup and voice random `811-921`), `src/content/content-script.js` (hotkey dispatch `841-864`, first-mark seek `609-610`), `src/shared/constants.js`, `src/shared/schema.js` (`normalizeHotkeys`), `src/options/options.js` and `options.html`, `src/library/library.js` (Random result), `README.md`.
- **Do:**
  1. Route the Alt+Shift+R hotkey through the same open-at-first-mark path voice "random" uses.
  2. Make Open Random tabs seek to their first mark when first activated, as lineup skip already does.
  3. Add two page hotkeys, `lineupNext` and `lineupPrevious`. Propose `Alt+Shift+K` and `Alt+Shift+J`; if either is taken in `DEFAULT_SETTINGS.hotkeys`, take the nearest free letter and say which.
  4. Add message types for the two steps. The worker accepts them only from a content script with a `sender.tab`, and does nothing when no lineup exists.
  5. In the Library, highlight the picked card clearly and show the result next to it.
- **Gotchas:** the five hotkey places; the two key maps must round-trip. The hotkey listener must ignore untrusted key events for these two, or a page could drive tab switching. Honour `isActiveHere()`. Reuse the worker's lineup functions; do not change the voice message handlers.
- **Tests:** extend the worker's Open Random tests for landing at the first mark; add tests for lineup step messages (accepted from a tab, ignored without a lineup); a `normalizeHotkeys` test for the new keys.
- **Manual check:** voice off. Open Random 3 from the Library, press the new keys to move between the tabs, and confirm each lands on its first mark. Press Alt+Shift+R and confirm the same.

### H2. Honest save feedback (E2)

- **Goal:** every save path reports what happened.
- **Files:** `src/background/service-worker.js:584-591`, `src/content/content-script.js` (`360-391`, `404-410`, `717-726`), `src/content/overlay.js:53-73`, `src/popup/popup.js` and `popup.html`, `src/options/options.html` and `options.js`, `src/shared/constants.js`, `src/shared/schema.js`, `README.md:98`.
- **Do:**
  1. Browser-command saves and range marks show the same toasts as the page hotkeys.
  2. Overlay buttons show specific fixed messages built from the current playback time: "Saved 04:12", "Already saved near 04:12", "Range started at 12:04", "Range saved 12:04 → 13:10", "No video found".
  3. Blur the overlay action buttons after a mouse click, as the mark chips do (`overlay.js:93-95`), so Space pauses the video.
  4. Remove the `quickSaveRequiresNote` setting from defaults, normalization, Options and the README.
  5. Add "Cancel range" to the popup while a range is open for this video. Reuse the existing draft-clearing mutator, or add an RPC to both whitelists.
  6. When a range end is rejected as a duplicate, say so and say the range is still open.
- **Gotchas:** overlay toasts may contain only fixed text, times and counts. Build the message from the playback snapshot, never from a stored scene. Keep the `fromVoice` branch of the save path working.
- **Tests:** a pure result-to-message function with a Node test. If `content-script.js` cannot load in Node, put the function in `src/shared/time.js` next to `formatRange`, which is already in every load list. A schema test that an old settings object with `quickSaveRequiresNote` normalizes cleanly.
- **Manual check:** save by page hotkey, browser command, overlay and popup; repeat each within the duplicate window; mark and cancel a range.

### H3. Popup for timestamps and favorites (E3)

- **Goal:** at least 8 scenes visible at 600 px, and favorites one step away.
- **Files:** `src/popup/popup.html:16-92`, `popup.js` (`345-359`, `368`, `441`), `popup.css`, `src/content/content-script.js` (hotkey dispatch `841-864`, save path `360-391`), `src/shared/constants.js`, `src/shared/schema.js`, `src/options/options.js` and `options.html`, `README.md`.
- **Do:**
  1. One-line rows: time, star, and a "more" menu holding Edit and Delete; clicking the row jumps. Show a note snippet only when a note exists.
  2. Save Moment saves at once, with no dialog. Notes and tags stay available through Edit.
  3. Add a star for the video itself next to its title, using the existing `updateVideo` favorite path.
  4. Add a page hotkey `saveFavorite`. It saves the current moment as a favorite; if a saved time already exists inside the duplicate window, it favorites that one. Propose `Alt+Shift+F`; if taken, take the nearest free letter and say which. Toast "Favorited 04:12".
  5. Fold the site switches into one compact row. One scroll container; open scrolled to the mark nearest the current time and highlight it.
  6. Rename "R" to "Retry" and "generic detected" to plain wording; remove the duplicate "Hotkeys" button. On a page with no video, show a neutral message, not a red error.
- **Gotchas:** the five hotkey places; the two key maps must round-trip. Keep arm-then-confirm delete. The toast is page DOM: fixed text and a time only.
- **Tests:** a `normalizeHotkeys` test for the new key; a test for the favorite-or-save decision; the existing `voice-pages` tests must still pass.
- **Manual check:** 50 marks on `test/manual-html5-video.html`; count the visible rows; press the favorite hotkey on a new moment and on an existing one.

### H4. Automatic local backup, two files (N1)

- **Goal:** a local copy of the library without the owner remembering to export, in two files at most.
- **Files:** `manifest.json` (`downloads`, `alarms`), `src/background/service-worker.js`, `src/shared/constants.js`, `src/shared/schema.js`, `src/shared/storage.js`, `src/options/options.html` and `options.js` (Data section), `README.md` (permissions and privacy text).
- **Do:**
  1. Add `settings.backup = { enabled, intervalHours }`, default off and 24, normalized and merged per field like `hotkeys`.
  2. On an hourly alarm, if enabled and due, read the whole library with an unscoped `getState()`.
  3. Compute a fingerprint: video count, scene count and the newest `updatedAt`. If it equals the fingerprint of the last backup, stop without writing anything.
  4. Otherwise serialize in the same shape as the Library export, so Import accepts it, and download it as a `data:` URL with `conflictAction: "overwrite"` and `saveAs: false`.
  5. Use exactly two filenames, `SceneMarks/scenemarks-backup-1.json` and `SceneMarks/scenemarks-backup-2.json`. Write to the slot not used last time. Never use a date or any other varying part in the name.
  6. Record `lastBackupAt`, the slot, the fingerprint and any error in a small `backupStatus` key written with `updateRawKeys`, outside the state model.
  7. After the download completes, remove its entry from the browser's download list with `chrome.downloads.erase`; the file stays on disk.
  8. In Options → Data: the toggle, "Back up now", the time and file name of the last backup, and an Export button.
- **Gotchas:** do not use an offscreen document; only one can exist and voice owns it. An idle alarm must make zero storage writes. Do not add a "changed" flag that every save touches. Skip the backup when the library is empty, so an emptied library cannot overwrite a good copy.
- **Tests:** worker tests with fake `chrome.downloads` and `chrome.alarms`: not due means no download; disabled means no download; unchanged library means no download; ten backups in a row use only the two filenames and alternate; the payload round-trips through the import path; an empty library is skipped; an idle pass makes zero storage writes.
- **Manual check:** click "Back up now" three times with a change between each, and confirm the folder holds two files. Import the newer one into a fresh throwaway profile. Repeat with a 2,000-video synthetic library to check the `data:` URL size.

### H5. Play queue (N2)

- **Goal:** play the Library's current filter scene by scene.
- **Depends on:** H1.
- **Files:** `src/library/library.js` and `library.html`, `src/background/service-worker.js`, `src/content/content-script.js`, `src/shared/constants.js`.
- **Do:**
  1. A "Play these" button, with a shuffle option, sends the filtered scenes to the worker as `{ videoKey, sceneId, startSeconds, endSeconds }`, capped at 200.
  2. The worker keeps the queue and its position in `chrome.storage.session` under `playQueue`.
  3. It opens the first scene in one tab. Stepping to a scene of the same video seeks in place; another video navigates that same tab with the queued jump, with `targetTabId` set to it.
  4. While a queue is active, the lineup hotkeys from H1 step the queue.
  5. Toast "Scene 3 of 10". Closing the tab ends the queue.
  6. Follow-up, after H6: a range that ends advances the queue automatically.
- **Gotchas:** never infer the destination tab from video identity. The queued jump holds one request, so issue the next only after the previous one is consumed. Toasts carry only fixed text and counts.
- **Tests:** worker tests for queue start, step, end, tab close, and that the jump is published before navigation.
- **Manual check:** filter to Favorites across three videos, play, go fullscreen, and step through ten scenes.

### H6. Range playback (N3)

- **Goal:** jumping to a range plays it and pauses at its end.
- **Files:** `src/content/video-detector.js` (`seekTo` `305-375`, tick `209-213`), `src/content/content-script.js` (`152-157`, jump paths `468-506`), `src/content/overlay.js:75-99`, `src/popup/popup.js:441`, `src/shared/constants.js`, `src/shared/schema.js`, `src/options/options.html` and `options.js`.
- **Do:**
  1. Add `settings.rangeEndAction`: `"pause"` (default) or `"none"`, in the Seeking section. Do not build looping.
  2. Keep the range being played in content-script memory. On each tick, at or past the end, pause once and toast "Range ended at 13:10".
  3. Cancel when the user seeks outside the range, jumps elsewhere, or the video changes.
  4. Pass the end time along the popup, overlay-chip and next / previous jump paths.
  5. Second slice: add `endSeconds` to the queued jump (`normalizePendingJump`) so Library jumps do the same.
- **Gotchas:** the Seeking section applies only after Save Settings. The overlay passes only times, which the rule allows.
- **Tests:** put the tick decision in `video-detector.js` and extend its fake-media-element tests: pause at end, cancel on outside seek, `"none"` does nothing.
- **Manual check:** on the test page, jump to a range and let it run to the end. Then try one streaming site.

### H7. Overlay position and pill (O1)

- **Goal:** the overlay stays off the player's controls and stays where it was put.
- **Files:** `src/content/overlay.js`, `overlay.css`, `src/content/content-script.js` (`913-917`, visibility sync), `src/shared/constants.js`, `src/shared/schema.js`, `README.md:51`.
- **Do:**
  1. Change the default position to the top right.
  2. Add `settings.overlay = { collapsed, positions }`, where `positions` is keyed by the valid platforms only and holds x and y as fractions of the viewport. Merge per field.
  3. Save position on drag end only, through the storage client. Clamp it on resize.
  4. A collapse button in the header shrinks the panel to a pill showing the mark count.
  5. When the panel hides, clear the list of times; update it only while visible.
- **Gotchas:** never key by hostname; never use the page's own storage. Other tabs receive the settings change and must apply it without writing back. Keep every `isTrusted` check.
- **Tests:** schema tests for `settings.overlay` (unknown platforms dropped, values clamped to 0–1); a test that a hidden overlay holds an empty list.
- **Manual check:** drag, collapse, reload; open a second tab on the same platform; confirm the player's fullscreen button is reachable with the panel in its default spot.

### H8. Overlay position awareness (O2)

- **Goal:** the panel shows where you are and whether a range is open.
- **Files:** `src/content/overlay.js`, `overlay.css`, `src/content/content-script.js`.
- **Do:**
  1. Highlight the mark nearest the current time; change it only when the nearest mark changes, and scroll it into view inside the list only.
  2. Previous and next buttons that call the existing `jumpToPreviousScene` and `jumpToNextScene`.
  3. Show "Range open from 12:04" and label the button "Mark range end" while a draft is open; otherwise "Mark range start".
- **Gotchas:** show the open-range line only when `activeRangeDraft.videoKey` is the current video. Trusted clicks only. Do not mark favorites in the list.
- **Tests:** a pure nearest-mark function with a Node test.
- **Manual check:** 50 marks; play through and watch the highlight; open a range on another video and confirm this panel shows nothing.

### H9. Overlay pill in fullscreen (O3)

- **Goal:** in fullscreen, a pill that appears on mouse movement and can step between saved times.
- **Depends on:** H7 and H8.
- **Read first:** F5 in `docs/FIX_REPORT.md` and `git show 2faad15`.
- **Files:** `src/content/overlay.js`, `overlay.css`, `src/content/content-script.js`.
- **Do:**
  1. Give the host `popover="manual"` and show it when enabled. Override the popover's default `inset`, `margin` and `border` so the fixed position holds.
  2. On `fullscreenchange`, hide and re-show the panel, then the toast if one is open, so both sit above the new fullscreen element.
  3. While in fullscreen, force the collapsed pill with previous and next. Hide it and set `pointer-events: none` after 3 seconds without pointer movement; show it on pointer move.
  4. On leaving fullscreen, restore the state the panel had before.
- **Gotchas:** keep every `isTrusted` check. No new data reaches the page. Do not write settings on entering or leaving fullscreen.
- **Tests:** extend the overlay test from H7 for the fullscreen state changes, with a minimal fake DOM.
- **Manual check:** fullscreen through the native video control and through a container's `requestFullscreen` on the test page, then YouTube and Netflix. Watch for a flash on entering fullscreen.

### H10. Library sort (L1)

- **Goal:** a choice of order, and no card jumping.
- **Files:** `src/library/library.js:130-140`, `library.html`, `library.css`.
- **Do:**
  1. A sort dropdown: Recently saved (default; newest scene `createdAt`, falling back to the video's), Date added, Most scenes, Title, Platform.
  2. Remember the choice in the page's `localStorage`, inside try/catch.
  3. Fix "1 scenes", capitalize platform names, and give the empty library its own message.
- **Gotchas:** no storage or schema change; do not touch how `updatedAt` is written.
- **Tests:** comparator tests. Expose the comparators the way the `voice-pages` tests load page scripts.
- **Manual check:** star a card and confirm it stays put; import a file and confirm the order is unchanged.

### H11. Library rows for timestamps and favorites (L2)

- **Goal:** rows that read at a glance, and a Favorites filter that can show just the starred moments.
- **Files:** `src/library/library.js` (`124-133`, `203-248`, `431-438`, `591-610`), `library.html`, `library.css`.
- **Do:**
  1. Each row shows time, saved date, a note snippet only when one exists, star and Jump. Move Edit and Delete into a "more" menu.
  2. Remove the row-level Open and Copy Text.
  3. Split the favorites filter into three choices: All, Favorite videos, Favorite moments. "Favorite moments" shows only starred scenes, in any video.
  4. Make the Random result obvious: a clear highlight on the picked card and the result shown next to it.
  5. Show a short status line after Delete and Export. Rewrite the import message in plain words and replace the raw parse error.
- **Gotchas:** `textContent` only. Open Random and "Play these" (H5) must use the new filter set unchanged.
- **Tests:** filter tests for the three favorites choices.
- **Manual check:** star two moments in an unstarred video and confirm "Favorite moments" shows exactly those.

### H12. Library card-only updates (L3)

- **Goal:** no full-list rebuild on each write.
- **Files:** `src/library/library.js` (`180-191`, `674-703`).
- **Do:**
  1. On `storage.onChanged`, rebuild only the cards whose `video:` keys changed, batched to one update per frame, keeping focus and scroll.
  2. Render the first 100 cards with a "Show more" button.
- **Gotchas:** use `Storage.isVideoStorageKey` and `newValue`; do not re-read. A card that no longer matches the filter after a change must leave the list.
- **Tests:** a test that a change to one video key touches one card.
- **Manual check:** star five scenes in a row from the keyboard; save a scene from another tab and watch for flicker. Re-run D's benchmark in `/tmp/scenemarks-fable/D/bench/` if it is still there.

## 10. Questions and answers

All five questions are answered; the table near the top says what each answer changed. Nothing open would change the ranking.

One default was chosen without asking and is easy to change: Random lands on a video's **first** saved mark, as voice "random" already does, not on a random mark or a favorite.
