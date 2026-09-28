# Transcriptor 2

Desktop app for podcast production: add an episode's audio, get back a clean
transcript, show notes, and a reference file for reusing the episode's content
later. It runs in the background from the system tray on Windows and macOS.

Transcriptor 2 is a clean rebuild, separate from Transcriptor 1. Both can be
installed at the same time.

## How it works

1. **Transcribe**: the audio is sent to a cloud transcription service
   (ElevenLabs Scribe or OpenAI).
2. **Clean up**: filler words are always removed. False starts and repetitions
   can also be removed (Settings). Cleanup only ever removes words; it never
   changes them.
3. **Review** (optional): fix speaker names and misheard words.
4. **Write**: an AI provider (Claude, GPT, Kimi or Qwen) writes the show notes
   and the reference file from the transcript. Guest details are checked with
   web lookups, and quotes are checked word for word against the transcript.
5. **Export**: Word (.docx) and/or plain text, saved to a folder you choose.

Each person uses their own API keys, stored encrypted with the computer's
keychain. **Audio and transcripts are sent to the providers you choose**;
nothing is hosted by Transcriptor 2 itself.

## Status

Built in milestones:

| | Milestone | State |
|---|---|---|
| M0 | Foundation: tray, start at login, settings, key storage, CI | Done |
| M1 | Transcription pipeline and job queue | Next |
| M2 | Cleanup and review | |
| M3 | AI writing: show-notes templates, reference file | |
| M4 | Export (DOCX, TXT; Google Doc is set up later) | |
| M5 | Drive folder watching (written but switched off) | |

## Development

```bash
npm install
npm run dev        # Vite + Electron with hot reload for the UI
npm run typecheck
npm test
npm run smoke      # build, launch against a throwaway profile, screenshot
npm run dist       # installer for this platform in dist/
```

Layout: `src/main` (Electron main process: settings, keys, tray, and later the
pipeline), `src/preload` (the `window.api` bridge), `src/renderer` (React UI),
`src/shared` (types used by both sides).

## Releasing

`npm run cut:prerelease` (while in alpha) or `npm run cut:patch` bumps the
version and pushes a tag. `.github/workflows/release.yml` creates one draft
release, builds Windows and macOS installers into it, then publishes it.
Builds are unsigned: on macOS, right-click → Open the first time (or run
`xattr -cr "/Applications/Transcriptor 2.app"`); on Windows, choose
"More info → Run anyway".
