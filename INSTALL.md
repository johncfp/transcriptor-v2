# Installing Transcriptor 2 (beta)

Version **2.0.0-beta.1**. Transcriptor 2 turns an episode's audio into a clean
transcript, show notes and a reference file. It's separate from Transcriptor 1,
and both can be installed at the same time.

## 1. Download

| Computer | File |
|---|---|
| Windows 10 or 11 | [Transcriptor2-Setup.exe](https://github.com/johncfp/transcriptor2-releases/releases/download/v2.0.0-beta.1/Transcriptor2-Setup.exe) |
| Mac with Apple Silicon (M1 or later) | [Transcriptor2-mac-arm64.dmg](https://github.com/johncfp/transcriptor2-releases/releases/download/v2.0.0-beta.1/Transcriptor2-mac-arm64.dmg) |
| Mac with an Intel processor | [Transcriptor2-mac-x64.dmg](https://github.com/johncfp/transcriptor2-releases/releases/download/v2.0.0-beta.1/Transcriptor2-mac-x64.dmg) |

The same files may also be in the shared "v2 Beta 1" Drive folder. Not sure
which Mac you have? Open the Apple menu → **About This Mac**: "Chip: Apple M…"
means Apple Silicon; "Processor: Intel…" means Intel.

## 2. Install

This beta isn't code-signed yet, so Windows and macOS will warn you the first
time. That's expected.

### Windows

1. Run **Transcriptor2-Setup.exe**.
2. If Windows shows "Windows protected your PC", click **More info**, then
   **Run anyway**.
3. Follow the installer. You can choose where it goes.
4. Transcriptor 2 opens when it's done, and from then on starts quietly in the
   system tray when you sign in (you can turn that off in Settings).

### Mac

1. Open the **.dmg** and drag **Transcriptor 2** into **Applications**.
2. Open **Applications** and double-click **Transcriptor 2**. macOS will say it
   can't check the app. Click **Done** (or **Cancel**).
3. Open **System Settings → Privacy & Security**, scroll down to the message
   about Transcriptor 2, and click **Open Anyway**. Confirm with your password
   if asked. On older macOS versions you can instead right-click the app and
   choose **Open**.
4. If macOS says the app **"is damaged and can't be opened"**, open
   **Terminal** and run the line below, then open the app again:

   ```
   xattr -cr "/Applications/Transcriptor 2.app"
   ```

## 3. First-time setup

Open **Settings** (left sidebar). Changes are saved when you press **Save**
(top right).

1. **API keys & voice** tab:
   - Add your **ElevenLabs** key (transcription).
   - Add your **Claude** key (show notes and guest lookup).
   - Pick a **Show notes voice**: General, Industry, SEO, or Custom.
2. **Show notes** tab: fill in the **Show profile**. **Host names** matter,
   because they're used to name speakers automatically. Choose a show-notes
   **template**.
3. **Output** tab: check where files are saved (Documents › Transcriptor 2 by
   default), the formats (Word and/or plain text), and the **Speaker format**.
4. **General** tab: theme, episode colors, and whether to review each
   transcript before the show notes are written.
5. Press **Save**.

Each person uses their own API keys. Keys are stored encrypted on your
computer and are only sent to the service they belong to.

## 4. Using it

1. **Episodes → Add audio…** (or drag audio files in). MP3, WAV, M4A, AAC,
   FLAC, OGG, OPUS and WEBM are supported.
2. The episode is transcribed in the background. You'll get a notification
   when it's ready. Episodes are colored by stage: yellow while new, orange once
   reviewed, green when the show notes are ready.
3. **Review**: check the speaker names, listen along, and fix any words shown
   in red or orange. Press **Mark as reviewed**.
4. **Show notes** tab: add the episode number, sponsor reads and next-week
   line, then **Write show notes**. Quotes are checked word for word against the
   transcript, and guest details are confirmed with a web search.
5. The transcript, show notes and reference file are exported automatically,
   or use **Export** on the episode. **Open folder** shows the files.

Closing the window keeps Transcriptor 2 running in the tray so work continues.
To quit, use the tray icon.

## Updates

- **Windows:** updates download in the background and install the next time
  you quit (or click **Restart now** in the sidebar).
- **Mac:** the sidebar shows a **Download** button when a new version is out.
  Install it the same way as above.

## Privacy

Transcriptor 2 doesn't process audio or text on your computer. The audio is
sent to ElevenLabs to transcribe, and the transcript to Claude (or the writing
provider you choose) for show notes, under those companies' terms. Don't
process recordings you don't have the right to share.

## Something wrong?

Note what you were doing and any message shown, and send it to the
Transcriptor 2 team. The version is under **Settings → General → Version**.
