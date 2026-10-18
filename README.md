# Transcriptor 2

Desktop app for podcast production: add an episode's audio, get back a clean
transcript, show notes, and a reference file for reusing the episode's content
later. It runs in the background from the system tray on Windows and macOS.

Transcriptor 2 is a clean rebuild, separate from Transcriptor 1. Both can be
installed at the same time. Current release: **2.0.0-beta.8**. To install it,
see [INSTALL.md](INSTALL.md).

## How it works

1. **Transcribe**: the audio is sent to ElevenLabs Scribe. (OpenAI's
   transcription API caps uploads at 25 MB, so it isn't used for full episodes.)
2. **Clean up**: filler words are always removed. Repeated and cut-off words
   can also be removed (Settings, or per episode). The raw transcript is kept;
   cleanup only hides words, and every removal can be undone in review.
3. **Review** (optional): confirm the suggested speaker names, fix misheard
   words (low- and medium-confidence ones are colored, with adjustable
   bands), and put back or remove words, with the audio playing alongside:
   the word being spoken is highlighted and clicking a word jumps there.
4. **Write**: an AI provider (Claude, GPT, Kimi or Qwen) writes the show notes
   and a per-episode reference file from the reviewed transcript, in the
   template chosen in Settings (Full, Standard, Minimal, or a custom one that
   can be exported and shared) and in a voice (General, Industry, SEO, or
   your own instruction). Code then checks the result:
   - quotes must appear word for word in one speaker's turn; the saved text,
     speaker and time come from the transcript, not the AI
   - timestamps must fall inside the episode and are snapped to turn starts
   - guest facts and links are used only if the web search actually returned
     the page cited (Claude and GPT report their sources; Kimi and Qwen don't,
     so their guest findings are never used)
   Anything dropped is listed on the episode's Show notes tab.
5. **Export**: the transcript, show notes and reference file as Word (.docx)
   and/or plain text, in a folder per episode under the output folder
   (Documents/Transcriptor 2 unless you pick another), with a choice of five
   speaker formats. Optionally, subtitles of the reviewed transcript too, as
   SRT and/or WebVTT, timed to the episode's audio (two lines of at most 42
   characters, a dash per speaker when a quick reply shares a cue), and
   translated into any of Spanish, Portuguese, French, German and
   Mandarin by the Social clips model, keeping the original's timing; each
   language is translated once per episode and checked cue by cue. Runs automatically when the notes are written, or from the
   episode's Export card. The Word files use real heading and list styles, so
   they convert cleanly to Google Docs. PDF is also available, and Word and
   PDF can have a cover page, a logo, and header and footer text.
6. **Social clips** (optional, Settings › Social): after the show notes, a
   model of its own (Claude Sonnet 5.5 at medium effort by default) picks
   short moments for social media and writes a caption for each platform
   (Instagram/TikTok, X/Threads, LinkedIn, YouTube Shorts) in a voice of its
   own. The model only names each clip's first and last words; the clip's
   text, speakers and times come from the transcript, and clips that can't be
   found or don't fit the length settings are dropped. Captions over a
   platform's limit, or with numbers or links that aren't in the transcript,
   confirmed guest facts or show website, are flagged, and so is anyone else
   heard in a clip (a host's "yeah" in the guest's answer, even one the
   cleanup removed). With **One speaker per clip** on, the model is asked for
   one-person stretches and clips with someone else in them are trimmed to
   the longest one-speaker part, or dropped. Clips fade in and out briefly
   at their edges, and next to another speaker the cut stops halfway to their
   word. Overlapping speech the transcript missed can't be removed from a
   mixed recording. On the episode's Clips
   tab you play, trim (a word at a time), edit and keep clips; kept clips are
   exported as WAV files in a Clips folder, with a Social Clips document of
   their captions.
7. **Video clips** (optional, Settings › Social › Video clips): exporting the
   kept clips also makes each one an MP4 in the shapes you choose (9:16 for
   Reels, TikTok and Shorts, 1:1, 16:9): the clip's audio with its captions,
   either highlighted word by word or as scrolling lines, plus the logo, show
   name, speaker names and a waveform that moves with the audio, in your
   colours over a colour or an image of your own. Motion, each part with its
   own switch: an opening quote (the clip's pull quote, word for word) where
   the logo goes for the first few seconds, the
   word being said popping, a background glow that drifts and swells with the
   voice, the clip's pull quote going big as it's said and its keywords
   highlighted in the captions (both picked with the clip, checked against
   the transcript and changeable on the Clips tab), name cards (the
   speaker's name from review, and Host or Guest)
   when someone starts talking, a pulsing or rolling waveform, a progress bar, and an outro card
   after the audio (the logo, "Full episode on" the show, and its website,
   2.5 seconds with silence under it). Three bundled fonts (Inter,
   Atkinson Hyperlegible Next, Lexend) keep videos the same on every
   computer. The Clips tab previews each clip exactly as it will be exported.
   Videos are made on the computer (H.264 and AAC at 30 fps, about three times
   faster than real time, 6–8 MB a minute), with progress and a Cancel button,
   and aren't uploaded anywhere.

Also: watching a Google Drive folder through Drive for Desktop (below), a
live model list with an effort level for Claude and GPT, light and dark
themes, episode search, color-coded episode stages, and Settings in tabs with
a Save button.

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
| M5 | Drive folder watching (Drive for Desktop; the Google sign-in version is switched off) | Done |
| M6 | Social clips: suggested clips and captions, review, WAV export | Done |
| M7 | Video clips: MP4s of kept clips with captions, in three shapes | Done |
| M8 | Motion graphics for video clips: a) motion from what the app already has, b) outro card, c) lower thirds, d) AI-picked pull quote and keywords | Done (unreleased) |

Now in beta. Before a stable 2.0.0: code signing (Windows and macOS builds are
currently unsigned) and real-episode testing across the team.

**Video clips** are checked on a real episode on Windows and with generated
audio on macOS and Windows: the sound is in sync with the captions to the
millisecond, and the pictures match the preview frame for frame. They use the
browser's own H.264 encoder (hardware where there is one), so they should
work on Windows "N" editions too, but that hasn't been tried. Released in
2.0.0-beta.6.

## Watching a Google Drive folder (Drive for Desktop)

Settings → **Drive**. With Google Drive for Desktop installed and signed in,
Drive keeps your folders in sync on the computer, so Transcriptor 2 watches
that local folder: no Google Cloud setup, sign-in or Drive permission.

1. Install Google Drive for Desktop and sign in (it shows up as `G:\My Drive`
   on Windows, or under Google Drive in Finder on macOS).
2. Settings → Drive → **Choose…** the folder episodes are dropped into (a
   shared folder works), turn on **Watch this folder**, then **Save**.

What happens:

- Files already in the folder when watching starts are left alone.
  Subfolders are watched too.
- A new audio file is picked up once it has finished syncing (it has to stop
  changing for about 20 seconds). It's copied into the app and queued; with
  "Ask me before processing" on, it waits for approval.
- Once it's transcribed, the original moves into `Done/` inside the watched
  folder, keeping its subfolder path.
- The episode's exports go to `Transcriptor Exports/` inside the watched
  folder rather than the Output folder, so Drive syncs them for everyone.
- Several computers can watch the same shared folder. Each writes a claim
  into a hidden `.transcriptor/claims` folder, waits for the claims to sync
  (1 minute by default; 5 or 15 on the Drive tab for slow syncs), and only
  the earliest claim goes ahead. Each checks the claims again right before
  transcribing, and skips the episode if an earlier claim has synced in
  since. This makes a double transcription (and bill) unlikely, but Drive
  gives no sync guarantee, so one computer per folder is safest; the Drive
  tab says so.
- Files are only picked up while the app is running (it keeps running in the
  tray); it looks every 30 seconds.
- If the computer that claimed a file goes away before finishing it, the file
  is listed on the Drive tab after 15 minutes with a **Take over** button
  (use it only when that computer is off or not running the app).
- Moving a file into another subfolder before it's picked up makes it a new
  file.

It works the same with any folder kept in sync (OneDrive, Dropbox).

## Google Drive sign-in version (built, switched off)

The watcher below talks to the Drive API directly instead, for computers
without Drive for Desktop. It isn't needed while the Drive for Desktop
version above suits the workflow.

Transcriptor 2 can watch a Google Drive folder and pick up new episode audio
on its own: each new audio file is downloaded and queued, then waits for
approval if "Ask me before processing" is on. The code is in
`src/main/watch/` and is tested, but it isn't switched on yet: the steps
below are needed first.

### Before setting it up: points to agree on

- **Who watches the folder.** Each person who turns watching on downloads
  and processes every new file, so if three people watch the same folder, the
  episode is transcribed (and billed) three times. Decide whether one person
  or one computer watches each folder.
- **Access it needs.** Watching a folder that other people upload into needs
  Google's `drive.readonly` permission, which lets the app *read* everything
  the signed-in person can see in Drive (it only ever lists the chosen
  folder, and never changes or deletes anything). The narrower "only files
  this app created" permission can't see uploads from other people or tools.
- **Workspace only.** Because that permission is "restricted", the Google
  sign-in must be set up as **Internal** to your Google Workspace: only
  accounts in that Workspace can use it, and Google doesn't require its
  security review.
- **Simpler alternative.** With Google Drive for Desktop installed, the folder
  already appears on the computer, and the app could watch that local folder
  instead: no Google Cloud setup and no Drive permission at all. That would
  be a small change if it suits the workflow better.
- **Limits of the current design.** It checks every 5 minutes while the app
  is running; files already in the folder when watching starts are skipped;
  subfolders aren't watched; only audio files (MP3, WAV, M4A, AAC, FLAC, OGG,
  OPUS, WEBM) are picked up. Shared drives work.

### 1. Google Cloud (once, by someone in the Workspace)

Signed in to <https://console.cloud.google.com> with a Workspace account that
can create projects:

1. **Create a project**, e.g. "Transcriptor 2", under your organization.
2. **Enable the Drive API**: APIs & Services → Library → *Google Drive API* →
   Enable.
3. **Set up the consent screen**: Google Auth Platform (formerly "OAuth
   consent screen") → Get started.
   - App name: *Transcriptor 2*; user support email: a team address.
   - Audience: **Internal**.
   - Contact email, then Create.
4. **Add the permission**: Google Auth Platform → Data Access → Add or remove
   scopes → add `https://www.googleapis.com/auth/drive.readonly` → Update →
   Save.
5. **Create the app's client**: Google Auth Platform → Clients → Create
   client → Application type **Desktop app** → name it *Transcriptor 2
   desktop* → Create. Copy the **Client ID** and **Client secret** (or
   download the JSON). For desktop apps Google doesn't treat the secret as
   confidential, but keep it out of public places anyway; it goes into the
   private source repo.

### 2. Workspace admin (only if app access is restricted)

If your Workspace limits which apps can use Google data, a Workspace admin
allows this one: Google Admin console → Security → Access and data control →
API controls → Manage third-party app access → add the app by its Client ID →
**Trusted**. If sign-in works without this, skip it.

### 3. Switch it on in the code (a developer)

1. Put the Client ID and secret in `GOOGLE_OAUTH` in
   `src/main/watch/googleAuth.ts`.
2. Uncomment the Drive block in `start()` in `src/main/index.ts`, and the
   Drive imports near the top of that file.
3. Show the settings: add
   `<DriveWatchSection settings={settings} update={update} />` to a tab in
   `src/renderer/src/components/SettingsScreen.tsx` (the Output tab fits).
4. `npm run typecheck`, `npm test`, `npm run smoke`, then sign in with a real
   account and drop a test file into a test folder.
5. Release it (`npm run cut:beta`); installed copies update themselves on
   Windows, and Mac users download the new version.

### 4. Each person who watches a folder

1. Settings → **Watch a Google Drive folder** → **Sign in with Google**. The
   browser opens Google's page; allow the read-only access.
2. Paste the folder's link from Google Drive.
3. Turn on **Watch this folder**, then **Save**.
4. From then on, new audio added to the folder shows up in Episodes (with a
   notification to approve it, if that setting is on). To stop, turn watching
   off or **Sign out**.

## Development

```bash
npm install
npm run dev        # Vite + Electron with hot reload for the UI
npm run typecheck
npm test
npm run smoke      # build, then run the real app end to end against a fake API
npm run dist       # installer for this platform in dist/
```

Layout: `src/main` (Electron main process: settings, keys, tray, job queue,
transcription, writing, export), `src/preload` (the `window.api` bridge),
`src/renderer` (React UI), `src/shared` (types used by both sides).

## Releasing

`npm run cut:beta` (while in beta) or `npm run cut:patch` bumps the
version and pushes a tag. `.github/workflows/release.yml` creates one draft
release, builds Windows and macOS installers into it, then publishes it.
Builds are unsigned: on macOS, use System Settings → Privacy & Security →
Open Anyway the first time (or run `xattr -cr "/Applications/Transcriptor 2.app"`);
on Windows, choose "More info → Run anyway".
