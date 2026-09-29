# Transcriptor 2: notes for Claude Code

Desktop app (Electron + Vite + React + TypeScript) for podcast production:
audio → ElevenLabs transcript → cleanup and review → show notes + reference
file (Claude by default) → DOCX/TXT export. Runs from the tray on Windows and
macOS. Currently **2.0.0-beta.4**. The README has the feature overview and the
Google Drive setup; INSTALL.md is the user install guide.

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
  (persistent queue: transcribe → review → write → export), `transcribe/`
  (ElevenLabs, streamed multipart), `writing/` (Claude via the official SDK;
  GPT/Kimi/Qwen over HTTP), `docx.ts`, `exporter.ts`, `media.ts` (t2-media://
  audio for playback), `updater.ts`, `watch/` (`folderWatcher.ts` watches a Drive for Desktop folder: Settings >
  Drive; the Google Drive API watcher is built but
  switched off: see README), `smoke.ts`.
- `src/shared`: pure logic used by both sides: settings schema, cleanup,
  speaker suggestions, show-notes model and templates, verification of AI output
  (`verify.ts`), export documents, voices, confidence.
- `src/renderer`: React UI. `src/preload`: the `window.api` bridge.
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
