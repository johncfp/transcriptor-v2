# Installing Transcriptor 2 (beta)

Version **2.0.0-beta.6**. Transcriptor 2 turns an episode's audio into a clean
transcript, show notes, a reference file and, if you like, short social media
clips with captions, as audio or as captioned videos. It's separate from Transcriptor 1, and both can be
installed at the same time.

## 1. Download

| Computer | File |
|---|---|
| Windows 10 or 11 | [Transcriptor2-Setup.exe](https://github.com/johncfp/transcriptor2-releases/releases/download/v2.0.0-beta.6/Transcriptor2-Setup.exe) |
| Mac with Apple Silicon (M1 or later) | [Transcriptor2-mac-arm64.dmg](https://github.com/johncfp/transcriptor2-releases/releases/download/v2.0.0-beta.6/Transcriptor2-mac-arm64.dmg) |
| Mac with an Intel processor | [Transcriptor2-mac-x64.dmg](https://github.com/johncfp/transcriptor2-releases/releases/download/v2.0.0-beta.6/Transcriptor2-mac-x64.dmg) |

All versions are on the [releases page](https://github.com/johncfp/transcriptor2-releases/releases).
Not sure which Mac you have? Open the Apple menu → **About This Mac**: "Chip:
Apple M…" means Apple Silicon; "Processor: Intel…" means Intel.

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
   - Add your **Claude** key (show notes, guest lookup and social clips).
   - Pick a **Show notes voice**: General, Industry, SEO, or Custom.
2. **Show notes** tab: fill in the **Show profile**. **Host names** matter,
   because they're used to name speakers automatically. Choose a show-notes
   **template**, and the model and effort that write the notes.
3. **Social** tab (optional): turn on **Suggest social clips** to have short
   clips and captions suggested after the show notes. Set how many clips, how
   long, which platforms get captions, the model (Claude Sonnet 5.5 at medium
   effort by default) and the captions' voice. Turn on **One speaker per
   clip** to keep out clips where someone else cuts in, even with a quick
   "yeah" (you get fewer back-and-forth clips). Turn on **Make video clips**
   to also get each kept clip as an MP4 video: choose the shapes (9:16 for
   Reels, TikTok and Shorts, 1:1, 16:9), captions highlighted word by word or
   scrolling, the font and size, your colours, a colour or image background,
   and whether to show the logo (from the Output tab), show name, speaker names
   and a waveform.
4. **Output** tab: check where files are saved (Documents › Transcriptor 2 by
   default), the formats (Word, PDF and/or plain text), the **Speaker
   format**, and an optional cover page, logo, header and footer.
5. **Drive** tab (optional): watch a Google Drive for Desktop folder, so audio
   added there is picked up automatically.
6. **General** tab: theme, episode colors, whether to review each transcript
   before the show notes are written, and whether the window opens normal,
   maximized or full screen (F11 switches full screen, Esc leaves it).
7. Press **Save**.

Each person uses their own API keys. Keys are stored encrypted on your
computer and are only sent to the service they belong to.

## 4. Using it

1. **Episodes → Add audio…** (or drag audio files in). MP3, WAV, M4A, AAC,
   FLAC, OGG, OPUS and WEBM are supported.
2. The episode is transcribed in the background. You'll get a notification
   when it's ready. Episodes are colored by stage: yellow while new, orange once
   reviewed, green when the show notes are ready.
3. **Transcript** tab: check the speaker names, listen along, and fix any
   words shown in red or orange. Press **Mark as reviewed**.
4. **Show notes** tab: add the episode number, sponsor reads and next-week
   line, then **Write show notes**. Quotes are checked word for word against the
   transcript, and guest details are confirmed with a web search.
5. The transcript, show notes and reference file are exported automatically,
   or use **Export** on the episode. **Open folder** shows the files.
6. **Clips** tab: choose **Suggest clips** (or they're suggested automatically
   if social clips are on). Each clip's words and times come from the
   transcript. Play a clip, trim its start or end a word at a time, edit the
   title and captions (with each platform's character count and a **Copy**
   button), and **Keep** the ones you want. **Show more** on a clip opens its
   full details, including a note when someone else is heard in it. With video clips on, the panel beside the clips previews the
   one you play or select exactly as its video will look. **Export kept
   clips** saves each as a WAV file in a **Clips** folder, with a Social Clips
   document of their captions, and with video clips on, an MP4 for each shape.
   Videos take about a third of the clip's length per shape to make; a bar
   shows progress, and **Cancel** stops it.

Closing the window keeps Transcriptor 2 running in the tray so work continues.
To quit, use the tray icon.

## Updates

- **Windows:** updates download in the background and install the next time
  you quit (or click **Restart now** in the sidebar).
- **Mac:** the sidebar shows a **Download** button when a new version is out.
  Install it the same way as above.

## Privacy

Transcriptor 2 doesn't process audio or text on your computer, apart from
cutting clips and making their videos. The audio is sent to ElevenLabs to transcribe, and the
transcript to Claude (or the writing provider you choose) for show notes and
social clips, under those companies' terms. Don't process recordings you don't
have the right to share.

## Something wrong?

Note what you were doing and any message shown, and send it to the
Transcriptor 2 team. The version is under **Settings → General → Version**.
