# SceneMarks code review

Reviewed **2026-10-28**, at commit `e4b527d83d9bf57d76690c684aa601334ddf860d`.

## Resolution status — 2026-10-28

**All F01–F12 findings and the five P3 fixes below are implemented.** The optional feature ideas remain separate and were not implemented. The original evidence below describes the reviewed commit; file line numbers are historical.

The extension remains dependency-free, uses classic-script IIFEs, and keeps its serialized service-worker writer, scoped per-video reads/writes, matched injection lists, normalization and explicit RPC whitelists. Schema **3** retains the split storage layout and migrates generic video identities. No library-wide index or write counter was added.

| Finding | Resolution | Regression coverage |
|---|---|---|
| **F01 — fixed** | Removed saved-content browsing, favorites and deletion from host DOM. The draggable overlay now offers trusted-event capture controls and **Open Library**, which opens the existing extension-origin page. Private scene lists and annotations remain in the extension popup/Library. The content overlay has no state-read callback or full-library read path. Random-hotkey feedback never renders the selected saved title. | `content-workflows.test.js`: synthetic overlay actions do nothing; a legitimate Library action opens the extension page without reading saved content into the page; saved annotations returned by an action never render in host DOM. |
| **F02 — fixed, historical ambiguity retained safely** | Generic keys use `generic:v2:<canonical URL>` with path case, sorted non-tracking queries and full fragments preserved. Only `utm_*`, `fbclid`, `gclid`, `msclkid`, and `dclid` are removed. Opening and tab matching use the same policy. Schema-3 migration rekeys records with one inferred identity and merges existing destinations; ambiguous/unidentifiable records stay intact with `identityRepairRequired` and a Library repair notice. Oversized identities/URLs are refused rather than truncated into collisions. | `adapters.test.js`, `service-worker.test.js`: separate IDs/hash routes/case, tracking equivalence, reopen identity, long keys, schema migration, ambiguous preservation, idle reruns and failed-write recovery. |
| **F03 — fixed** | Popup actions fetch fresh context before opening a dialog. `{ videoKey, seconds }` travels through moment/range confirmations, range-start conflict confirmation and duplicate retries. Content validates the identity at confirmation and saves the captured time. | `page-workflows.test.js`, `content-workflows.test.js`: continued playback, cached-context refresh, range boundaries, duplicate retries and changed-video rejection. |
| **F04 — fixed** | Import policy explicitly combines exact endpoints/notes by tag union and favorite OR. Incompatible notes/endpoints and distinct nearby times are preserved separately; conflicting IDs receive fresh IDs. Tag unions that exceed the cap also stay separate. Results/UI report merged scenes, preserved same-ID conflicts, repairs and invalid-scene rejections. The same preservation logic is used by migrations. | `storage.test.js`: same-ID edits, coincident metadata, nearby annotations, tag-cap overflow and repeated import without extra copies. |
| **F05 — fixed** | Each new queued jump gets a unique `requestId`. Consumption atomically compares video key, expected token, and destination tab inside the writer queue; missing/stale tokens or non-owner tabs write nothing. A successful seek checks again afterward so a replacement runs next. Old saved requests receive a stable normalized fallback token but remain dormant when no destination was recorded. See the follow-up ownership fix below. | `storage.test.js`, `content-workflows.test.js`: replacement during seeking, stale completion, missing token, two competing consumers and subsequent execution of the replacement. |
| **F06 — fixed** | Failed queued seeks retry with bounded 1–5 second delays until success, expiry, cancellation or navigation. Storage events schedule new requests; one in-flight attempt per context prevents overlap. Repeated failures have no error toasts. The detector checks expected identity around readiness/verification waits to avoid applying a stale seek to a new SPA video. | `content-workflows.test.js`, `video-detector.test.js`: delayed readiness, success, replacement, cancellation, expiry, navigation and same-element identity changes. |
| **F07 — fixed** | Rekeying plans and commits the destination video plus matching draft/jump references together in one queued raw-key write, then removes old video keys only after the write succeeds. Existing destination metadata and source annotations are preserved. | `service-worker.test.js`: existing destination merge, exact touched keys, successful range completion/jump consumption under the new key, failed-write recovery and idle second pass. |
| **F08 — fixed** | Worker open-tab matching reuses service adapters and the generic identity fallback. Case-sensitive content IDs, paths and query values stay case-sensitive; YouTube watch, shorts and short-link URLs share an identity. | `service-worker.test.js`: URL variants, case distinctions, generic content queries/tracking and actual Random exclusion. |
| **F09 — fixed** | Popup switching conservatively retains every label of the normalized hostname, including `www` (which can itself be a hosted tenant). It no longer guesses registrable domains; the exact affected scope is displayed. Broader domains can still be entered deliberately in Settings. | `schema.test.js`: hosted tenants, country-domain hosts and unaffected sibling hosts. |
| **F10 — fixed** | Settings synchronizes pristine fields from storage events, preserves unsaved edits, and submits only changed fields. Hotkeys are patched individually. Edits made during an in-flight save remain in the form. | `page-workflows.test.js`: independent external changes, dirty/pristine fields, exact submitted patch and in-flight edits. |
| **F11 — fixed** | Keydown capture registration is synchronous, before awaiting settings. Actions are guarded until settings load. Trusted accepted matches call both `preventDefault()` and `stopImmediatePropagation()` synchronously. Unmatched, repeated, synthetic, disabled and text-input events pass through. | `content-workflows.test.js`: deferred settings, single-key dispatch timing, propagation suppression, text/shadow-input and inactive-site pass-through. |
| **F12 — fixed** | Recorder and matcher preserve physical numpad tokens, including digits, Enter, Decimal and operators, separately from main-keyboard keys. | `page-workflows.test.js`: recorder → saved setting → real content matcher round trips across all supported recordable code families. Escape remains the recording-cancel key. |

| Lower-priority finding | Resolution and regression |
|---|---|
| **P3 prototype-like import keys — fixed** | Video dictionaries use null prototypes. Imports containing `constructor`, `__proto__`, and `toString` persist and edit correctly without touching object prototypes (`storage.test.js`). |
| **P3 duplicate scene IDs/reversed ranges — fixed** | Normalization assigns deterministic unique IDs and orders endpoints, retaining annotations. Import reports repaired/rejected scene counts; deleting one repaired scene leaves the others intact (`schema.test.js`, `storage.test.js`). |
| **P3 Settings site-access explanation — fixed** | Settings now accurately describes automatic all-site injection and the generic-saving switch. Manifest remains the source of truth (`adapters.test.js` checks the explanation and permission). |
| **P3 favicon paths — fixed** | All six paths use `../../assets/`; filesystem assertions verify each target (`adapters.test.js`). |
| **P3 empty Random filters — fixed** | An explicitly empty `videoKeys` array selects nothing for pick/batch APIs. Omitting it still selects from all eligible videos (`service-worker.test.js`). |

### Follow-up verification — queued-jump destination ownership (resolved)

**Reproduction:** With the original token-only fix, an existing same-video tab received the Library's global `setPendingJump(seconds: 42)` event. Advancing the actual content-workflows harness by 100 ms produced `existingTabSeekTargets: [42]` and `pendingJump: null` before the intended new tab initialized. Tokens protected request replacement but did not identify the destination. This was a remaining bug, not an optional feature.

**Resolution:** Library now sends one `OPEN_VIDEO_AT_SCENE` command to the worker instead of separately publishing a request and opening a URL. Only extension pages may issue this command. The worker validates the target, creates an `about:blank` tab, stores the jump with its browser-assigned `targetTabId`, and then navigates that tab. Open-at-scene operations publish in click order even if tab allocation is slow. A failed opening removes its allocated tab and clears only its expected request token, preserving a replacement.

Each content context obtains its own top-frame tab ID through `GET_TAB_ID`, using the browser-provided message sender rather than page data or the active tab. It checks ownership before seeking, including retries. The worker independently supplies the real sender's tab ID to `consumePendingJump`; caller-supplied IDs are ignored. Consumption requires the expected video, request token and destination ID in the same serialized, scoped write. Content scripts cannot publish pending jumps through storage RPC or cancel other tabs' requests.

**Compatibility and bounds:** `targetTabId` is an additive, normalized transient field; schema 3 and the saved-video layout remain unchanged. Existing migrations preserve it while rekeying the video reference and retaining the request token. Legacy ownerless requests stay readable/migratable but cannot be automatically claimed: their intended tab is unknowable, so re-open the scene from Library. Ordinary worker suspension/wakes retain ownership; browser startup invalidates owned requests from the previous session because tab IDs are session-scoped. The existing single pending slot, TTL, replacement checks, scoped reads/writes and paused-site jump behavior remain in place.

**Regression coverage:** `queued-jump-routing.test.js` runs the actual Library, service worker, shared storage and content scripts in separate VM worlds with shared storage events and browser-assigned senders. Its slow-target test leaves an already-playing same-video tab running while withholding target initialization, then confirms that only the target seeks to 42 and consumes the request. The same test runs with SceneMarks enabled, paused globally and disabled for the site. Additional tests cover target-only readiness retries, a different destination replacing an in-flight jump, spoofed tab IDs/subframes, blocked direct queue publication, invalid/unwritable openings, guarded cleanup, migration, delayed identity lookup, browser startup and slow allocation ordering. Shared storage/schema tests reject invalid owners and preserve legacy normalization.

**Remaining manual checks:** Reload the extension and video tabs in Chrome/Brave. With a saved video already playing, click a Library scene while the new tab loads slowly and confirm that the existing tab's position is unchanged and the target lands correctly. Repeat while paused globally and while the site is switched off; test worker suspension/restart within the browser session, failed navigation/closed targets, rapid replacement clicks, browser restart/session restoration, and metadata-delayed/DRM players on each supported service. No live browser or streaming-account run was performed here.

### Validation after fixes

- `node --test test/automated/*.test.js`: **119 passed, 0 failed** (76 original tests plus 43 additional tests, including 13 ownership regressions).
- JavaScript syntax checks pass for all **32** source/test JavaScript files.
- Manifest and fallback injection file lists match in order; favicon asset targets exist; RPC whitelist parity and scoped-write tests pass.
- Tests execute the actual modules with dependency-free Chrome/DOM/media doubles. No npm dependencies or build tooling were added.

### Remaining limitations and manual verification

- The privacy fix deliberately moves saved browsing, favorites and deletion out of the page overlay. Use the toolbar popup or extension Library; the page panel remains draggable and supports capture and opening the Library. Browser origin isolation protects private UI; trusted-event checks are additional protection, not the privacy boundary.
- Already mixed legacy scenes have no reliable per-scene source URL. Ambiguous records remain intact and display backup/repair guidance. Even one remaining stored URL cannot prove that older, capped-out URLs never referred to other content. Keep an export until any manual repair is verified; no automatic split guesses scene ownership.
- Generic fragments and unknown/session query parameters are retained conservatively. These may create extra records for the same content. URLs beyond the 2,048-character supported URL cap cannot be newly captured as generic identities. The policy favors preserving content identity over aggressive deduplication.
- Existing intentionally broad or previously mis-inferred disabled-site entries are not silently narrowed. Remove/edit those entries in Settings if needed. Previously recorded numpad shortcuts stored as ordinary digits/Enter cannot be distinguished from intentional main-keyboard bindings; re-record them.
- Queued jumps now have a destination tab; other same-video tabs cannot seek or consume them. The existing single pending slot still means a newer opening supersedes an older outstanding request. Closing the destination does not transfer ownership; re-open the scene if needed. Ownerless legacy requests require a deliberate re-open, and browser startup clears owned requests from the prior session.
- No live Chrome/Brave or authenticated streaming-account session was run. Fullscreen/top-layer presentation, browser event behavior, DRM-player timing and current supported-service URLs still require the README manual checklist. Reload the extension and video tabs after updating the code.

## Original assessment at reviewed commit

The original review found two high-priority privacy/identity issues and ten medium-priority workflow bugs. The following historical findings motivated the fixes above.

**Priorities:** P1 = fix before release; P2 = correctness fix to schedule next; P3 = lower-impact cleanup or defensive validation. Findings below are confirmed by source inspection and, where indicated, focused Node/VM probes. Suggested features are listed separately.

## Scope and verification

- Reviewed shared storage/schema/migrations, service-worker routing and injection, content scripts, video detection, adapters, overlay, popup, library, options, manifest, and README. Three independent reviewers covered storage, playback, and UI; findings were consolidated and checked.
- Ran `node --test test/automated/*.test.js`: **76 passed, 0 failed**.
- Parsed all **26 JavaScript files** under `src/` and `test/automated/`; no syntax errors.
- Verified the manifest's content-script list matches the worker's fallback injection list, including order.
- Used focused probes for overlay data exposure, identity collisions, import behavior, pending-jump races, popup capture payloads, options overwrites, keyboard mappings, and local asset paths.
- No live Chrome/Brave or streaming-account testing was performed. Browser-specific layout, fullscreen behavior, DRM-player behavior, and current service URL formats still need manual verification. VM probes validate the tested logic, not complete browser integration.

## High-priority findings

### F01 · Resolved · P1 · Visited pages can read saved library data through the overlay

**Evidence:** [overlay.js](src/content/overlay.js), lines 69, 215–219, 356–369, 652–720; [content-script.js](src/content/content-script.js), lines 331–345 and 913–935.

The overlay is mounted in the host page's ordinary DOM. Its buttons accept synthetic clicks. A page script can click **Library**, wait for the full-library read, click **Expand All**, and read saved video titles, identifiers, and rendered notes from the DOM. This can expose bookmarks from other sites without a deliberate user action. Rendering with `textContent` prevents HTML injection but does not make the rendered information private.

**Verified:** A VM probe using the actual overlay implementation and synthetic events caused one full-library read and made a test title and confidential note readable through the host document. Expanded groups render the first ten matching scenes; that limit does not prevent the disclosure.

**Fix:** Keep library data and actions inside an extension-origin page or carefully configured extension-origin iframe. Protect privileged interactions from synthetic events as defense in depth. Trusted-event checks alone do not protect notes after a real user opens the overlay; a proper origin boundary is needed. Review favorites/deletion controls under the same threat model.

**Regression:** A host-page script must neither request another video's library data nor read it after a legitimate library interaction.

### F02 · Resolved · P1 · Generic query-based players merge unrelated videos

**Evidence:** [generic.js](src/content/site-adapters/generic.js), lines 58–62.

Both `https://example.com/watch?id=A` and `https://example.com/watch?id=B` produce the same video key, `generic:https://example.com:/watch`, and canonical URL, `https://example.com/watch`. The key ignores the query; canonicalization removes it. Bookmarks from different videos mix together, near-duplicate checks can block valid saves, and reopening the canonical URL loses the selected video. Hash-based player identities have the same limitation.

**Verified:** Both URLs returned identical keys and canonical URLs in an adapter probe.

**Fix:** Preserve identity-bearing query parameters and distinguish them from known tracking parameters. Define a conservative policy for hash-based players. Keep opening and open-tab matching consistent with that policy. Changing persisted identities needs a migration; already mixed records may require user-assisted repair rather than an automatic guess.

**Regression:** Different content IDs stay separate; tracking-only changes keep the same identity; reopened URLs select the original video.

## Correctness findings

### F03 · Resolved · P2 · Popup saves a later timestamp than the time shown

**Evidence:** [popup.js](src/popup/popup.js), lines 339–361 and 397–419; [content-script.js](src/content/content-script.js), lines 363–369 and 416.

The note dialog displays a cached timestamp, but confirmation sends no captured time. The content script samples playback again when saving. A dialog showing `01:00` can save `01:20` after twenty seconds of typing. Range ends and duplicate-confirmation retries drift too; the displayed context may already be stale before opening the dialog.

**Verified:** A popup VM probe displayed the cached time and sent a payload without a timestamp.

**Fix/test:** Capture fresh video identity and time when the action starts, carry them through confirmation and retries, and reject a changed video identity. Test while playback continues and during SPA navigation.

### F04 · Resolved · P2 · Import merging silently discards incoming scene metadata

**Evidence:** [storage.js](src/shared/storage.js), lines 719–745.

Matching scene IDs are skipped completely. Different IDs within 0.5 seconds with identical notes are also skipped, even when their tags or favorite flags differ. Importing an updated backup can therefore omit annotations without explaining the conflict.

**Verified:** Importing a coincident scene with a new tag and `favorite: true` retained only the existing scene's metadata.

**Fix/test:** Define an explicit conflict policy: merge compatible metadata, preserve distinct annotations, or let the user choose. Report skipped/conflicting scenes. Cover same-ID edits and coincident scenes with different tags/favorites.

### F05 · Resolved · P2 · An older seek can clear a newer queued jump

**Evidence:** [content-script.js](src/content/content-script.js), lines 881–895; [storage.js](src/shared/storage.js), lines 603–623.

A queued seek reads request A and takes time to verify. If request B is queued for the same video meanwhile, A's completion calls `consumePendingJump(videoKey)`, which clears B. B is lost even though it was never executed. Serialization of storage writes does not protect this asynchronous read/seek/consume sequence.

**Verified:** Queue A, read A, queue B, consume using A's video key: B is returned and removed.

**Fix/test:** Give each request a unique token and atomically consume only the expected token. Schedule any newer remaining request afterward. Test replacement during an in-flight seek and competing tabs for the same video.

### F06 · Resolved · P2 · Failed queued jumps have no automatic retry

**Evidence:** [content-script.js](src/content/content-script.js), lines 139–146, 868–905, and 950; [video-detector.js](src/content/video-detector.js), lines 196–210.

After a verified seek fails, the jump remains stored but no next attempt is scheduled. Later playback/metadata events for the same video do not change the detector's `detected|videoKey` signature, so they do not trigger another context callback. A temporarily unready player can leave the jump stranded until navigation or reload.

**Verified:** A forced failed seek followed by a playback tick left one seek call and no retry timer.

**Fix/test:** Retry with a bounded delay until success, expiry, cancellation, or navigation. Avoid repeated error toasts. Test a player that becomes seekable after the initial attempt.

### F07 · Resolved · P2 · Video migrations leave range/jump references on the old key

**Evidence:** [migrations.js](src/shared/migrations.js), lines 139–171.

Generic-to-platform migration rekeys the video and removes its old entry, but leaves `activeRangeDraft.videoKey` and `pendingJump.videoKey` unchanged. An active range can no longer finish against the migrated video; its queued jump no longer matches.

**Verified:** A legacy generic YouTube video migrated successfully, while finishing its fresh range or consuming its fresh jump under the new key failed.

**Fix/test:** Rekey affected transient references in the same queued migration write. Cover migration into an existing destination record and an idle second run.

### F08 · Resolved · P2 · Random selection misidentifies which videos are already open

**Evidence:** [service-worker.js](src/background/service-worker.js), lines 176–228.

Open-tab matching lowercases URL paths and YouTube IDs, conflating case-distinct identifiers. Conversely, a YouTube `/shorts/ID` or `youtu.be/ID` tab does not match a canonical `/watch?v=ID` record unless that URL variant happens to be saved in `rawUrls`. The Random controls can exclude a different video or reopen one already present.

**Verified:** Case-distinct IDs/paths normalized identically; watch and shorts URLs for the same ID normalized differently.

**Fix/test:** Reuse adapter identities for recognized services and preserve case-sensitive path/query values. Test watch/shorts/short-link variants and generic case-sensitive paths.

### F09 · Resolved · P2 · Turning off one hosted site can disable unrelated sites

**Evidence:** [schema.js](src/shared/schema.js), lines 130–149; [popup.js](src/popup/popup.js), lines 579–580.

The popup guesses a site's main domain from its final two or three labels. `alice.github.io` becomes `github.io`, and `foo.blogspot.com` becomes `blogspot.com`; switching off one tenant disables every tenant under that suffix.

**Verified:** Both domain reductions were reproduced with the schema helper.

**Fix/test:** Prefer exact-host scope when the registrable domain is uncertain, or use a maintained offline public-suffix solution compatible with the extension. Show the domain being disabled. Cover hosted tenants and country suffixes.

### F10 · Resolved · P2 · Saving Settings overwrites changes made elsewhere

**Evidence:** [options.js](src/options/options.js), lines 260–303 and 386–390.

The form submits every setting, but external storage changes refresh only the site switches. Open Settings, turn the overlay off from the popup, then save an unrelated jump preference: the stale checkbox turns the overlay back on. Two Settings pages can overwrite each other's hotkeys similarly.

**Verified:** A VM probe changed stored overlay visibility to `false`; an unrelated form save restored it to `true`.

**Fix/test:** Save only dirty fields or synchronize externally changed pristine fields. Preserve a user's unsaved edits and test two contexts changing independent settings.

### F11 · Resolved · P2 · Page hotkeys can be swallowed or run alongside site shortcuts

**Evidence:** [content-script.js](src/content/content-script.js), lines 695–764 and 941–947.

Initialization awaits storage before installing the key listener, allowing site capture handlers to register first and swallow later events. When SceneMarks does accept a shortcut, it only calls `preventDefault()`, so site JavaScript handlers can still act on the same key. This is especially visible with customizable single-key shortcuts.

**Verified:** A deferred-settings VM probe found no keydown listener until the storage read completed. The accepted-match branch contains no propagation stop.

**Fix/test:** Install the listener synchronously, guard actions until settings are loaded, and stop propagation synchronously for accepted matches. Confirm unmatched, disabled-site, repeated, and text-input events still pass through.

### F12 · Resolved · P2 · Numpad shortcuts record successfully but do not work

**Evidence:** [options.js](src/options/options.js), lines 130–160; [content-script.js](src/content/content-script.js), lines 268–299.

Recording `Numpad1` stores `1`, which the matcher converts to `Digit1`. `NumpadEnter` and `NumpadDecimal` have equivalent mismatches. The UI reports success but expects another physical key.

**Verified:** Recorder-to-matcher probes failed for these numpad keys and passed for their main-keyboard equivalents.

**Fix/test:** Preserve supported numpad codes in both directions, or reject unsupported recording with clear feedback. Add round-trip tests for every supported keyboard code.

## Lower-priority fixes and hardening

- **P3 · Import keys can collide with object prototypes.** Plain `{}` video dictionaries accept imported keys such as `constructor` and `__proto__`. Probes produced an import exception for `constructor` and silent omission for `__proto__`. Use null-prototype dictionaries/own-property checks or consistently reject reserved identities. See [schema.js](src/shared/schema.js), lines 27–33 and 342–345, and [storage.js](src/shared/storage.js), line 769. This establishes import robustness problems, not arbitrary code execution.
- **P3 · Import accepts duplicate scene IDs and reversed ranges.** Normalization preserves these values. Duplicate IDs make edit/delete affect multiple scenes; reversed ranges cannot highlight correctly. Validate uniqueness and ordered endpoints, reporting repairs/rejections. See [schema.js](src/shared/schema.js), lines 234–289, and [storage.js](src/shared/storage.js), lines 498 and 556–569.
- **P3 · Settings incorrectly describes site access.** [options.html](src/options/options.html), lines 72–74, says the extension does not request all-site access and needs popup activation. The manifest requests `<all_urls>` with automatic injection. Update this user-facing explanation; README already states the permission correctly.
- **P3 · All three extension pages have broken favicon paths.** Lines 7–8 of [popup.html](src/popup/popup.html), [options.html](src/options/options.html), and [library.html](src/library/library.html) use `../assets/`, resolving to nonexistent `src/assets/`. All six references failed a filesystem check. Use `../../assets/`.
- **P3 · Empty random filters widen to the whole library.** Worker pick/batch methods apply `videoKeys` only when the array is nonempty. A probe with `videoKeys: []` opened an unrelated saved video. Current UI callers guard empty results, so this is an API contract edge case. Distinguish an omitted filter from an explicitly empty set. See [service-worker.js](src/background/service-worker.js), lines 271–274 and 346–349.

## Useful enhancements and feature ideas

These are optional product improvements, separate from the confirmed defects.

1. **Safer backup restoration.** Preview video/scene counts, invalid entries, and conflicts before import. Offer explicit merge/replace and restore-settings choices. Exports include settings, but the library currently imports with `{ merge: true }` and does not restore them ([library.js](src/library/library.js), lines 629–663).
2. **Undo deletion.** A short undo window or bounded Recently Deleted area would recover accidental scene/video deletion. Keep its storage bounded and preserve per-video write isolation.
3. **Edit timestamp and range boundaries.** Current editing changes notes/tags, so correcting a mistimed bookmark requires recreation. Add validated time inputs with a preview jump.
4. **Hotkey conflict feedback.** Warn about duplicate assignments and unsupported keys; allow disabling individual actions rather than only the whole hotkey layer.
5. **Broader player support.** Consider iframe and open-shadow-root detection with explicit frame selection and routing. Current detection queries only the current document, and the manifest does not inject into all frames. Treat this as deliberate new scope.
6. **Complete scene access in the overlay Library.** Expanded groups show only ten matching scenes and a “more saved scenes” count. Add pagination or an Open in Library action after fixing F01. Include the source URL in copied share text for easier reuse.

## Recommended implementation order

1. Fix **F01–F02** first: isolate private UI and correct generic identity, including migration/repair behavior.
2. Fix **F03–F07** next: capture accuracy, import preservation, and reliable queued jumps/migrations.
3. Address **F08–F12** alongside targeted regression tests; then handle P3 cleanup.
4. Recheck in Chrome/Brave on the manual HTML5 page and each supported service, including YouTube. Exercise delayed readiness, same-element SPA navigation, multiple tabs, pause/site switches, fullscreen, and single-key shortcuts.

Keep the existing dependency-free test setup and storage invariants. Add behavioral regression coverage where these workflows cross UI, content scripts, and the worker; passing shared-layer tests alone cannot establish those behaviors.
