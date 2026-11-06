# Voice Control — Implementation Plan

Hands-free control of SceneMarks: jump between saved timestamps and move through a
lineup of open videos with short spoken words. Fully local, no AI model, no network,
no native helper. It's plain browser APIs, so it behaves the same on macOS Brave
as on any Chromium browser.

## Verdict

**Feasible, moderate effort.** The extension already has every action voice needs
(`jumpToNextScene`, `jumpToPreviousScene`, `openRandomVideo`, quick save, tab
messaging through `forwardToActiveTab`). The new work is a small audio
matcher, a training screen, and tab-lineup switching.

## How you use it

Voice mode is **always listening once it's on**. You never press a key per command.

1. One time: Options → Voice commands → record each word 3×.
2. Turn voice on once, with the popup toggle or the `toggle-voice` shortcut. It stays on
   for hours, until you turn it off.
3. While watching, just speak: "next", "back", "skip" and so on. Each command
   shows a toast so you know it was heard. Nothing to re-arm.
4. Turn it off the same way when you're done. Optional settings: turn it back on
   automatically after a browser restart, and turn it off on its own after N
   minutes with no video playing.

Between words, the engine only watches the sound level; matching runs only when you
speak. That's why leaving it on for hours costs almost nothing. If speaker audio
causes false triggers, an optional **wake word** ("marks, next") can be enabled as
a fallback. It's still hands-free, just two words instead of one.

## Choosing the recognizer

| Option | Verdict |
|---|---|
| Web Speech API (`webkitSpeechRecognition`) | **No.** Chrome sends audio to Google's servers, and **Brave doesn't support it at all** (it fails with a `network` error). |
| Whisper / Vosk in WASM | **No.** These are AI models (40 MB+, heavy CPU), which you ruled out. |
| macOS Voice Control custom commands | Works with zero code (say a word, macOS presses a hotkey). But it uses Apple's speech engine, switches on a whole accessibility mode, and can't do "start the next tab at its first mark". It's a stopgap at best. |
| **Template matching (MFCC + DTW), built in** | **Recommended.** This is the classic pre-AI technique: you record each command word 3 times, and live audio is compared against your own recordings. It's pure arithmetic, about 400 lines of JS, uses under 1% CPU, and has no download. You can pick any word in any language. |

How it works: a microphone stream goes through a **voice-activity gate**, which only
reacts when sound rises above the room's noise floor. Each detected utterance
(0.2–1.5 s) becomes **MFCC features** (13 coefficients per 10 ms frame, plus
deltas, mean-normalized). Those features are compared to each stored template
with **DTW** (dynamic time warping), which tolerates saying a word faster or
slower. A command fires only when the best match is under a threshold and clearly
beats the runner-up from a *different* command (margin ≈ 0.85). After that there's
a 700 ms cooldown.

**Limits to accept up front:** it only recognizes the person who trained it (that's a
feature here). It works best with 5–8 words that sound clearly different. Dialogue
playing loudly from the MacBook speakers is the main false-trigger risk. See Risks.

## Commands (defaults; the user records their own words)

| Say | Action | Where it runs |
|---|---|---|
| "next" | Next saved timestamp | content: `jumpToNextScene` |
| "back" | Previous saved timestamp | content: `jumpToPreviousScene` |
| "skip" | Next video in lineup → start at its first mark | worker + content |
| "return" | Previous video in lineup → start at its first mark | worker + content |
| "pause" / "play" | Pause / resume | content |
| "mark" | Quick-save the current time | content: `saveTimestamp({ quick: true })` |
| "random" | Open one random library video | worker: `openRandomVideo` |

Short words of two or more syllables that sound different ("skip" vs "next") are
easier to tell apart than near-rhymes.

## Architecture

```
options page ──(record 3× per word)──▶ worker RPC saveVoiceProfile ──▶ storage.local "voiceProfile"
                                                                              │ read
offscreen doc (src/voice/) ◀──────────────────────────────────────────────────┘
  mic → AudioWorklet → VAD → MFCC → DTW match
        │ SCENEMARKS_VOICE_COMMAND {command}
        ▼
service worker ── mark/play/save ──▶ active tab content script (SCENEMARKS_VOICE_ACTION)
               └─ skip/return ─────▶ pause current tab → activate lineup tab → "startAtFirstMark"
```

- **Mic capture lives in an offscreen document** (`chrome.offscreen`, reason
  `USER_MEDIA`). It can't live in a content script: microphone permission would
  then belong to netflix.com/youtube.com, and the prompt would appear on every
  site. The MV3 worker can't capture audio itself.
- **Permission flow:** the options-page training screen calls `getUserMedia` once.
  That grants the mic to the `chrome-extension://<id>` origin, and the offscreen
  document reuses that permission without a prompt. On macOS, Brave must also be
  allowed under *System Settings → Privacy & Security → Microphone*. The orange
  menu-bar dot shows whenever listening is on, which is expected.
- **Lifecycle:** the worker creates the offscreen document when `settings.voice.enabled`
  turns on (and on `onStartup`/`onInstalled` if it's enabled). It closes the document
  when voice is turned off. Messages from the offscreen document wake the worker as
  needed.
- **Trust:** the worker accepts `VOICE_COMMAND` only when `sender.url` is the offscreen
  document's URL, so a web page can't drive tab switching.

### Lineup ("skip" / "return")

- `openRandomVideos` records the tabs it opens, in order, as
  `{ windowId, tabIds }` in **`chrome.storage.session`**. Session storage stays in
  memory, content scripts never see it, and it adds nothing to `storage.local`.
- "skip" means: take the next tab after the active one in the lineup, skipping closed
  tabs and wrapping around. If the active tab isn't in the lineup, go to the first
  lineup tab. With no lineup, fall back to the next tab to the right in the window.
- Switch sequence: send `pause` to the current tab, run
  `chrome.tabs.update(next, { active: true })`, call `ensureContentScript(next)`, then
  send `startAtFirstMark`.
- `startAtFirstMark` (content side): background tabs often haven't loaded the
  player yet, so it polls `getCurrentSnapshot()` for up to about 10 s. It then reads
  `getScenesForVideo`, calls `seekTo({ seconds: first.startSeconds, behavior: "play-after-jump" })`,
  and shows a toast such as "Video 3/10 · 01:23 (1/5)". If the video has no marks,
  it just plays.
- No single-slot `pendingJump` is needed: these tabs are already open, so the content
  script seeks on demand.

## Changes by file

| File | Change |
|---|---|
| `manifest.json` | Add the `"offscreen"` permission. Add a `toggle-voice` command (a 4th suggested key; Chrome allows at most 4). |
| `src/shared/constants.js` | `MESSAGE_TYPES.VOICE_COMMAND`, `VOICE_ACTION`. `STORAGE_KEYS.VOICE_PROFILE`. `DEFAULT_SETTINGS.voice = { enabled: false, sensitivity: 0.5 }`. A `VOICE_COMMANDS` list. Caps (`MAX_VOICE_SAMPLES = 3`, max frames per template). |
| `src/shared/schema.js` | `normalizeSettings` handles `voice`. New `normalizeVoiceProfile` (known commands only, numeric arrays only, capped size). |
| `src/shared/storage.js` | `saveVoiceProfile` / `clearVoiceProfile` mutators (fixed-size key, written only during training). Add them to `RPC_METHODS`. |
| `src/background/service-worker.js` | Same methods in `STORAGE_RPC_METHODS` and `EXTENSION_PAGE_ONLY_RPC_METHODS`. Offscreen create/close. `VOICE_COMMAND` routing with the sender check. Lineup recording in `openRandomVideos`. Next/previous tab switching. `toggle-voice` command. |
| `src/content/content-script.js` | `VOICE_ACTION` handler: `next`, `back`, `pause`, `play`, `mark`, `startAtFirstMark`. Gate it with `isActiveHere()` like hotkeys, and show results through the existing toast path. |
| `src/voice/offscreen.html` + `voice-engine.js` | Mic, VAD, matching loop, and sending commands. Reload templates on a `voiceProfile` `storage.onChanged` event. |
| `src/voice/capture-worklet.js` | AudioWorklet that posts 16 kHz frames off the main thread. |
| `src/voice/voice-features.js` | **Pure** MFCC + DTW + match decision (an IIFE attaching `SceneMarks.VoiceFeatures`) so it can be tested in Node. |
| `src/options/options.*` | "Voice commands" section: per word, Record ×3, a live test meter showing the matched word and score, a sensitivity slider, and Clear. |
| `src/popup/popup.*` | Voice On/Off toggle and status ("Listening", "Not trained", "Mic blocked"). |
| `README.md`, `AGENTS.md` | Document the offscreen permission, the mic setup on macOS, the `voiceProfile` key, and the lineup rules. |

The voice files load only in the offscreen and options pages. They **don't** go in the
content-script load lists, so the duplicated-load-list rule isn't affected.
Adding a key and default settings isn't a breaking change, so there's **no
`SCHEMA_VERSION` bump**. `voiceProfile` is device-specific, so leave it out of
export, and make sure a replacing import keeps it.

## Phases

0. **Spike on the MacBook (do first, ~1 h).** Load the extension in Brave and confirm three things:
   (a) the offscreen document gets the mic after the options page grants it;
   (b) with `echoCancellation: true`, video audio from the speakers is suppressed enough;
   (c) CPU stays negligible in Activity Monitor.
   The VPS has no microphone, so this can only be checked on the Mac.
1. **Engine + training + mark navigation (MVP):** `voice-features.js` with Node tests,
   the offscreen engine, the training UI, the popup toggle, and next / back /
   pause / play / mark.
2. **Lineup:** session lineup, skip / return, `startAtFirstMark`, and random.
3. **Polish:** a sensitivity slider wired to the threshold, a "voice heard: skip" toast,
   an optional "listen only while a video tab is active" mode, and docs.

## Tests (`node --test test/automated/*.test.js`)

- `voice-features.test.js`: MFCC is deterministic. DTW distance is 0 for identical
  input and stays small for a time-stretched copy. Matching rejects input below the
  margin or threshold. The VAD splits synthetic tone bursts into utterances.
- `schema.test.js`: `normalizeVoiceProfile` drops unknown commands, non-numeric data
  and oversized templates. `voice` settings fall back to their defaults.
- `service-worker.test.js`: `VOICE_COMMAND` from a non-offscreen sender is rejected.
  Lineup next/previous wraps around, skips closed tabs, and falls back to the
  adjacent tab. RPC whitelists still match.
- `content-workflows.test.js`: `VOICE_ACTION` dispatches to the right action and is
  refused when `isActiveHere()` is false. `startAtFirstMark` waits for detection.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Video dialogue matches a command word | Echo cancellation (verify in Phase 0), the strict margin rule, distinct two-syllable words, and the sensitivity slider. **Headphones remove the issue entirely.** |
| `play()` after a voice tab switch is blocked by autoplay policy (there's no user gesture) | Netflix and YouTube are usually allowed because of media-engagement history. Otherwise show the toast "Press Space to play". |
| Background lineup tab hasn't built its player yet | Poll for detection for up to about 10 s before seeking. Activating the tab first lets the site load the player. |
| Mic always on (privacy, battery) | Off by default. Toggle from the popup or the `toggle-voice` shortcut. The VAD gate means matching only runs on speech. |
| Accuracy drifts with a new room or mic | Re-record a word from Options. Each word keeps 3 samples, and the best match wins. |
