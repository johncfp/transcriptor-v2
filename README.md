# Transcriptor 2

Desktop app for podcast production: add an episode's audio, get back a clean
transcript, show notes, and a reference file for reusing the episode's content
later. It runs in the background from the system tray on Windows and macOS.

Transcriptor 2 is a clean rebuild, separate from Transcriptor 1. Both can be
installed at the same time.

## How it works

1. **Transcribe**: the audio is sent to ElevenLabs Scribe. (OpenAI's
   transcription API caps uploads at 25 MB, so it isn't used for full episodes.)
2. **Clean up**: filler words are always removed. Repeated and cut-off words
   can also be removed (Settings, or per episode). The raw transcript is kept;
   cleanup only hides words, and every removal can be undone in review.
3. **Review** (optional): confirm the suggested speaker names, fix misheard
   words (low-confidence ones are highlighted), and put back or remove words.
4. **Write**: an AI provider (Claude, GPT, Kimi or Qwen) writes the show notes
   and a per-episode reference file from the reviewed transcript, in the
   template chosen in Settings (Full, Standard, Minimal, or a custom one that
   can be exported and shared). Code then checks the result:
   - quotes must appear word for word in one speaker's turn; the saved text,
     speaker and time come from the transcript, not the AI
   - timestamps must fall inside the episode and are snapped to turn starts
   - guest facts and links are used only if the web search actually returned
     the page cited (Claude and GPT report their sources; Kimi and Qwen don't,
     so their guest findings are never used)
   Anything dropped is listed on the episode's Show notes tab.
5. **Export**: the transcript, show notes and reference file as Word (.docx)
   and/or plain text, in a folder per episode under the output folder
   (Documents/Transcriptor 2 unless you pick another). Runs automatically when
   the notes are written, or from the episode's Export card. The Word files
   use real heading and list styles, so they convert cleanly to Google Docs.

Each person uses their own API keys, stored encrypted with the computer's
keychain. **Audio and transcripts are sent to the providers you choose**;
nothing is hosted by Transcriptor 2 itself.

## Status

Built in milestones:

| | Milestone | State |
|---|---|---|
| M0 | Foundation: tray, start at login, settings, key storage, CI | Done |
| M1 | Transcription pipeline and job queue (ElevenLabs) | Done |
| M2 | Cleanup and review | Done |
| M3 | AI writing: show-notes templates, reference file, guest lookup | Done |
| M4 | Export (DOCX, TXT; Google Doc is set up later) | Done |
| M5 | Drive folder watching (written but switched off) | Done (off) |

## Google Drive folder watching (built, switched off)

`src/main/watch/` can watch a Google Drive folder and queue new audio files
as they arrive (they then wait for approval if Settings asks). It is not
wired in yet. To turn it on:

1. In the team's Google Cloud project, create an OAuth client of type
   "Desktop app" and set the consent screen to **Internal**. The watcher
   needs the restricted `drive.readonly` scope; Internal apps skip Google's
   verification and the 7-day token expiry of unverified external apps.
2. Fill in `GOOGLE_OAUTH` in `src/main/watch/googleAuth.ts`.
3. Uncomment the Drive block (and its imports) in `src/main/index.ts`.
4. Render `<DriveWatchSection>` in `SettingsScreen.tsx`.

## Development

```bash
npm install
npm run dev        # Vite + Electron with hot reload for the UI
npm run typecheck
npm test
npm run smoke      # build, then run the real app end to end against a fake API
npm run dist       # installer for this platform in dist/
```

Layout: `src/main` (Electron main process: settings, keys, tray, and later the
pipeline), `src/preload` (the `window.api` bridge), `src/renderer` (React UI),
`src/shared` (types used by both sides).

## Releasing

`npm run cut:beta` (while in beta) or `npm run cut:patch` bumps the
version and pushes a tag. `.github/workflows/release.yml` creates one draft
release, builds Windows and macOS installers into it, then publishes it.
Builds are unsigned: on macOS, right-click → Open the first time (or run
`xattr -cr "/Applications/Transcriptor 2.app"`); on Windows, choose
"More info → Run anyway".
