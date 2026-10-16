# Transcriptor 2: notes for Claude Code

Desktop app (Electron + Vite + React + TypeScript) for podcast production:
audio → ElevenLabs transcript → cleanup and review → show notes + reference
file (Claude by default) → optional social clips → DOCX/TXT export. Runs from the tray on Windows and
macOS. Currently **2.0.0-beta.7**. The README has the feature overview and the
Google Drive setup; INSTALL.md is the user install guide.

## Next up

M8, motion graphics for video clips, in four milestones, each checked in with
the owner before the next:
- **M8a (done, unreleased, branch `claude/motion-graphics-transcript-audio-e90fae`):**
  Settings > Video > Motion: opening quote (`hookQuote`: until M8d it's the
  clip's shortest whole sentence of 3–10 words by one speaker, skipping the
  first), word pop, background glow, progress bar, and a Pulse/Rolling
  waveform style. All on by default (the owner's choice); scroll captions now ease.
- **M8b (done, unreleased, same branch):** outro card (`hasOutro`, needs a
  show name or website): the video runs `MOTION.outroSec` past the audio
  with silence padded under it (`cutter.ts`); frame totals and the cutter
  timeout include it; the Clips tab preview plays it when a clip plays to its
  end. The `video-sync-check` CI hasn't been rerun with it (needs a push; ask).
- **M8c:** lower thirds from review speaker names, Host/Guest from
  `show.hosts`, on first words and speaker changes; only named speakers.
- **M8d:** the clip model also gives a pull quote (first/last words, ≤10
  words, one speaker) and up to 3 keywords, checked in code like clips and
  editable on the Clips tab. The opening quote then uses the model's pick
  (the owner wants the hook to be a short quote, not the title).

Earlier: 2.0.0-beta.7 added crosstalk handling for clips, untested on macOS.
Untested: a Windows N edition, and the Drive for Desktop watcher on a real Drive.

## Working with the owner

- **Ask before starting each piece of work** and get an explicit go-ahead.
  Answering questions isn't a go-ahead; flag developer concerns before acting.
- Work in milestones and check in at the end of each with what was done and
  how it was verified.
- Releases are cut only when asked. A release is public (see below).

## Commands

```
npm run dev          # Vite + Electron, hot reload for the UI
npm run typecheck
npm test             # node:test via tsx, tests/*.test.ts
npm run smoke        # build, then drive the real app end to end against fake APIs
npm run cut:beta     # bump beta version, tag, push: CI builds and publishes
```

Always run typecheck, tests and `npm run smoke` before committing, and commit
only if they pass. The smoke test is the main UI check: it runs the built app with a
throwaway profile (`TRANSCRIPTOR_SMOKE_DIR`), exercises the pipeline against
local fake ElevenLabs and Claude servers, saves screenshots and writes
`report.json`. Browser previews can't run this app; use the smoke test and
its screenshots. Set `SMOKE_OUT=<dir>` to keep them.

## Layout

- `src/main`: Electron main process. `index.ts` (window, tray, IPC), `jobQueue.ts`
  (persistent queue: transcribe → review → write → export; social clips run
  after the notes as `job.social`), `transcribe/` (ElevenLabs, streamed
  multipart), `writing/` (Claude via the official SDK; GPT/Kimi/Qwen over
  HTTP; `social.ts` suggests clips), `clipCutter.ts` (cuts kept clips to WAV
  and, with video clips on, renders their MP4s, in a hidden sandboxed page,
  `src/renderer/cutter.html`, running mediabunny; it reads the audio through
  IPC and reports progress), `background.ts` (video background images), `docx.ts`, `exporter.ts`, `media.ts` (t2-media://
  audio for playback), `updater.ts`, `watch/` (`folderWatcher.ts` watches a Drive for Desktop folder: Settings >
  Drive; the Google Drive API watcher is built but
  switched off: see README), `smoke.ts`.
- `src/shared`: pure logic used by both sides: settings schema, cleanup,
  speaker suggestions, show-notes model and templates, verification of AI output
  (`verify.ts`; `clips.ts` for social clips), export documents, voices, confidence,
  `video.ts` (video shapes, fonts, caption layout, waveform levels, motion
  timing: every effect is a function of the time in the clip, so the
  preview and the export draw the same frames).
- `src/renderer`: React UI. `src/renderer/src/video/` draws video frames
  (`drawFrame.ts`) and loads the bundled fonts; the Clips tab preview and the
  export both use it, so the preview is what's exported. `src/preload`: the
  `window.api` bridge.
- User data lives in Electron's userData: settings.json, keys.json (encrypted
  with safeStorage), jobs.json, episodes/<id>/.

## Rules that matter

- **Clean-room.** Upstream code (Transcriptor 1 was forked from a PolyForm
  Noncommercial project) must not be copied in. Only code written for this
  owner may be ported from `../transcriptor`.
- **Low guessing.** AI output is checked in code: quotes must match the
  transcript word for word (text/speaker/time come from the transcript),
  timestamps are snapped to turns, and guest facts and links are kept only if
  their URL was in the web search results. Keep these checks when changing
  the writing step; voices are appended after the rules, never before.
  Social clips follow the same rule: the model gives only a clip's first and
  last words, and `checkClips`/`reviseClip` take the text and times from the
  transcript, including after edits in review. Other speakers in a clip are
  found from the raw words (removed fillers are still in the audio), named
  as in review (`rawSpeakerNames`); `social.oneSpeaker` trims to them.
- **Third-party notices.** mediabunny (MPL-2.0) and the three video fonts
  (Fontsource, SIL OFL) are bundled unmodified; the build writes `out/THIRD_PARTY_NOTICES.txt` (shipped in the app's resources).
  Add an entry there for any new bundled code whose license asks for one.
- Settings are edited as a draft and saved with the Save button; new fields
  need a default in `DEFAULT_SETTINGS` and pass through `mergeSettings`.
- Before writing Claude API code, check current model IDs and parameters
  (default model `claude-opus-5-5`, adaptive thinking, `web_search_20260209`,
  `fallbacks: "default"` for Opus 5.5 and 5). Effort is optional
  (`writing.effort`, blank = the model's default, which is `medium` on Opus
  5.5): Claude gets `output_config.effort`, GPT `reasoning.effort`. Settings
  lists models live from each provider (`src/main/writing/models.ts`).

## Releases and distribution

- Source repo `johncfp/transcriptor-v2` is private. Installers publish to the
  **public** repo `johncfp/transcriptor2-releases` via the `RELEASES_TOKEN`
  secret (a fine-grained token that expires about a year after 2026-09-28).
- `release.yml` creates the draft once, builds Windows and macOS, then
  publishes. After a release, check that all 12 assets are on one release.
- Windows auto-updates; macOS can't (the builds are unsigned) and shows a
  Download button. Beta releases are prereleases, so `/releases/latest/…`
  links don't point at them; use version-specific links.
- Builds are unsigned. A stable 2.0.0 needs Apple and Windows signing.

## Gotchas

- `scrollIntoView()` returns a Promise in current Chromium: never use it as
  an expression-bodied `useEffect` (React treats the return as a cleanup).
- The smoke test must never write outside its scratch dir: it sets
  `output.folder` to scratch before anything exports.
- Word COM automation hangs on the dev machine; validate DOCX output by
  parsing the XML parts instead.
- The Google Drive MCP connector can't upload large files or edit Docs, only
  create, rename, move and trash them.
- Don't cut clips with mediabunny's `Conversion` `trim`: in 1.61.1, trims that
  don't land on a sample can leave an empty decoded block and its PCM encoder
  throws "frameOffset out of range" (65 of 150 random clips on a real M4A).
  The cutter decodes with `AudioSampleSink` and cuts with `ClipAssembler`
  (`src/shared/wav.ts`), which is sample-exact (16-bit sources come back bit
  for bit: it converts with round(v × 32768), the inverse of mediabunny's decode).
  The cutter then fades each clip's edges (`fadeEdges`, 30 ms in, 120 ms out)
  for both the WAV and the video; the Clips tab's Play clip doesn't fade.
- Videos are made only by **Export kept clips** on the Clips tab; the episode's
  own export writes WAVs, not videos. Each export replaces only the clip files it
  makes (`writeExport` `replaceClips`), so the episode export keeps the videos.
- With the outro card on, a clip's MP4 is longer than its WAV by
  `MOTION.outroSec` (silence under the card). The waveform levels still
  cover only the audio, and `audioSeconds(scene)` comes from them.
- AAC encoders take only 44.1 and 48 kHz: the cutter resamples other rates for
  the video's sound (the WAV keeps the source rate).
- macOS's AAC encoder adds 2112 frames of priming (Windows' adds none), which
  made video sound 48 ms late on macOS. The cutter measures the delay once per
  format (`aacDelay`) and starts the sound that much early; mediabunny then
  writes an edit list so players skip it. Check sync with
  `spikes/video-sync` on the `video-sync-check` branch (push it to run CI).
- The cutter's hidden window closes after each export; the app stays open only
  because the main window is hidden, not closed. A script that drives
  `cutClips` on its own needs a `window-all-closed` listener.
