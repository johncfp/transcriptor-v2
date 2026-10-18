import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, shell } from "electron";
import { IPC } from "../shared/api";
import { AUDIO_EXTENSIONS, type AddFilesResult } from "../shared/jobs";
import { readFileSync, writeFileSync } from "node:fs";
import type { EpisodeEdits } from "../shared/cleanup";
import { EMPTY_DETAILS, type EpisodeDetails } from "../shared/showNotes";
import { readTemplateFile, sampleTemplateFile, templateFile } from "./templateFile";
import { cleanTranscript } from "../shared/cleanup";
import { clipFileName, clipVideoName, episodeDocuments, safeFileName, type ExportFormat } from "../shared/exportDocs";
import { templateSections } from "../shared/showNotes";
import { writeExport } from "./exporter";
import { printPdf } from "./pdf";
import { importLogo, loadLogo, logoPreview, pruneLogos } from "./logo";
import { backgroundPath, backgroundPreview, importBackground, pruneBackgrounds } from "./background";
import { clampThresholds } from "../shared/confidence";
import type { SettingsPatch, StartWindow } from "../shared/settings";
import { JobQueue } from "./jobQueue";
import { providerById } from "../shared/providers";
import { anthropicWriter } from "./writing/anthropic";
import { writeEpisode, writerById } from "./writing";
import { suggestClips } from "./writing/social";
import { clipLimits, PLATFORMS, socialDefaultModel } from "../shared/social";
import { clipContext, quoteText, reviseClip, type ClipEdit } from "../shared/clips";
import { cutClips, type CutterOptions } from "./clipCutter";
import { audioLevels, clipCaptionWords, SHAPES } from "../shared/video";
import { readWav } from "../shared/wav";
import { listModels } from "./writing/models";
import { KeyStore } from "./keyStore";
import { handleMedia, registerMediaScheme } from "./media";
import { notifyJobEvent } from "./notify";
import { runSmokeTest, SMOKE, smokeTranscriber } from "./smoke";
import { SettingsStore } from "./settingsStore";
import { transcriber } from "./transcribe";
import { createTray } from "./tray";
// Google Drive folder watching (M5), switched off; see the block in start().
// import { DriveClient, parseFolderId } from "./watch/driveClient";
// import { DriveWatcher } from "./watch/driveWatcher";
// import { GOOGLE_OAUTH, refreshTokens, signIn } from "./watch/googleAuth";
// import { GoogleTokenStore } from "./watch/tokenStore";
import { Updater } from "./updater";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { EXPORTS_FOLDER, FolderWatcher } from "./watch/folderWatcher";
import { findDriveForDesktop } from "./watch/driveFolder";
import { buildCues, languageName, subtitleFileName, SUBTITLE_FORMATS, toSrt, toVtt, type Cue } from "../shared/subtitles";
import { segmentsOf, sourceKey, translatedCues, translationLanguage, TRANSLATION_LANGUAGES, type SubtitleTranslations, type TranslationLanguage } from "../shared/subtitleTranslation";
import { clipCues } from "../shared/videoLanguages";
import { translateSubtitles } from "./writing/subtitles";

// The smoke test must not touch the real profile, so it swaps userData
// before anything reads it.
if (SMOKE) app.setPath("userData", SMOKE.userData);

// Windows marks a covered window as hidden and stops painting it, so smoke
// screenshots would show an earlier screen. Chromium reads only the last
// disable-features switch, so add to any existing list rather than replace it.
if (SMOKE) {
  const disabled = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    [disabled, "CalculateNativeWinOcclusion"].filter(Boolean).join(","),
  );
}

// Windows only shows notifications for apps with an AppUserModelID, and it
// has to match the installer's appId.
if (process.platform === "win32") app.setAppUserModelId("io.transcriptor.app2");

registerMediaScheme();

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

/** The hidden page that cuts clips (src/main/clipCutter.ts): the dev server's copy or the built one. */
const CUTTER: CutterOptions = {
  preload: join(__dirname, "..", "preload", "cutter.js"),
  load: (win) =>
    devServerUrl ? win.loadURL(new URL("cutter.html", devServerUrl).href) : win.loadFile(join(__dirname, "..", "renderer", "cutter.html")),
};
const WINDOW_TITLE = "Transcriptor 2 — just transcribe";

let mainWindow: BrowserWindow | null = null;
let queue: JobQueue | null = null;
/** Set once the user really means to quit (tray Quit, Cmd+Q, installer). */
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start);
}

function start(): void {
  const userData = app.getPath("userData");
  const settings = new SettingsStore(userData);
  const keys = new KeyStore(userData);
  // Logo copies left behind by drafts that weren't saved.
  pruneLogos(userData, settings.get().output.branding.logo);
  pruneBackgrounds(userData, settings.get().video.backgroundImage);

  applyLoginItem(settings.get().general.startAtLogin);
  applyTheme(settings.get().general.theme);
  settings.onChange((next, prev) => {
    if (next.general.startAtLogin !== prev.general.startAtLogin) {
      applyLoginItem(next.general.startAtLogin);
    }
    if (next.general.theme !== prev.general.theme) applyTheme(next.general.theme);
  });

  // The writing provider chosen in Settings, with its key and model.
  const writerSetup = () => {
    const w = settings.get().writing;
    const writer = writerById(w.provider) ?? anthropicWriter;
    return {
      writer,
      apiKey: keys.get(writer.id),
      model: w.model.trim() || writer.defaultModel,
      baseUrl: w.baseUrl.trim() || undefined,
      effort: providerById(writer.id)?.effort && w.effort ? w.effort : undefined,
    };
  };

  // The same for social clips, which have their own provider and model.
  const socialSetup = () => {
    const s = settings.get().social;
    const writer = writerById(s.provider) ?? anthropicWriter;
    return {
      writer,
      apiKey: keys.get(writer.id),
      model: s.model.trim() || socialDefaultModel(writer.id) || writer.defaultModel,
      baseUrl: s.baseUrl.trim() || undefined,
      effort: providerById(writer.id)?.effort && s.effort ? s.effort : undefined,
    };
  };

  let sleepBlocker: number | null = null;
  queue = new JobQueue({
    dataDir: userData,
    transcriber: smokeTranscriber(transcriber),
    getKey: (id) => keys.get(id),
    needsApproval: () => settings.get().processing.intake === "approve",
    write: (req) => {
      const { writer, apiKey, model, baseUrl, effort } = writerSetup();
      if (!apiKey) {
        throw new Error(`Add your ${providerById(writer.id)?.label ?? writer.label} API key in Settings, then retry.`);
      }
      const { show } = settings.get();
      return writeEpisode({
        transcript: req.transcript,
        edits: req.edits,
        details: req.details,
        show: { name: show.name, hosts: show.hosts },
        voice: settings.get().writing.voice,
        customVoice: settings.get().writing.customVoice,
        writer,
        call: { apiKey, model, baseUrl, effort, signal: req.signal },
        onStage: req.onStage,
      });
    },
    canWrite: () => writerSetup().apiKey !== null,
    suggest: (req) => {
      const { writer, apiKey, model, baseUrl, effort } = socialSetup();
      if (!apiKey) {
        throw new Error(`Add your ${providerById(writer.id)?.label ?? writer.label} API key in Settings, then try again.`);
      }
      const { show, social } = settings.get();
      return suggestClips({
        transcript: req.transcript,
        edits: req.edits,
        writing: req.writing,
        show: { name: show.name, hosts: show.hosts, website: show.website },
        limits: clipLimits(social),
        platforms: PLATFORMS.map((p) => p.id).filter((id) => social.platforms[id]),
        oneSpeaker: social.oneSpeaker,
        voice: social.voice,
        customVoice: social.customVoice,
        writer,
        call: { apiKey, model, baseUrl, effort, signal: req.signal },
        onStage: req.onStage,
      });
    },
    autoSocial: () => settings.get().social.enabled && socialSetup().apiKey !== null,
    exportEpisode: async (data, formats, opts) => {
      const s = settings.get();
      const kept = data.social?.clips.filter((c) => c.kept) ?? [];
      const turns = cleanTranscript(data.transcript, data.edits);
      const { label, documents: all } = episodeDocuments({
        turns,
        details: data.details,
        writing: data.writing,
        fileName: data.job.fileName,
        show: s.show,
        sections: templateSections(s.template, s.customSections),
        transcript: {
          timestamps: s.output.transcriptTimestamps,
          format: s.output.speakerFormat,
          confidence: s.output.colorConfidence ? clampThresholds(s.confidence) : null,
        },
        clips: kept,
      });
      const documents = opts?.clipsOnly ? all.filter((d) => d.kind === "Social Clips") : all;
      const chosen = formats ?? EXPORT_FORMATS.filter((f) => s.output.formats[f]);
      const { branding } = s.output;
      const base = safeFileName(label);
      const notes: string[] = [];
      const sourceLanguage = languageName(data.transcript.language);
      const setup = socialSetup();
      // Translated subtitles: each language once per version of the subtitles, saved with the episode
      // (and the clips' pull quotes, for translated videos). One that can't be made is a note on the
      // export rather than a failed export.
      const translate = async (wanted: TranslationLanguage[], cues: Cue[], quotes: string[]) => {
        const segments = segmentsOf(cues);
        const key = sourceKey(segments);
        const saved = queue!.subtitleTranslations(data.job.id);
        const store: SubtitleTranslations = saved?.source === key ? saved : { version: 1, source: key, languages: {} };
        const out = new Map<TranslationLanguage, { cues: Cue[]; quotes: Record<string, string> }>();
        const call = { apiKey: setup.apiKey ?? "", model: setup.model, baseUrl: setup.baseUrl, effort: setup.effort, signal: opts?.signal };
        for (const lang of wanted) {
          const { name } = translationLanguage(lang);
          if (name === sourceLanguage) continue;
          let done = store.languages[lang];
          if (!done) {
            if (!setup.apiKey) {
              notes.push(`${name} wasn't made: add a ${setup.writer.label} key in Settings › API keys.`);
              continue;
            }
            try {
              const result = await translateSubtitles({ segments, source: sourceLanguage, target: lang, writer: setup.writer, call });
              done = { provider: setup.writer.id, model: setup.model, at: new Date().toISOString(), ...result };
              store.languages[lang] = done;
              queue!.saveSubtitleTranslations(data.job.id, store);
            } catch (err) {
              notes.push(`${name} couldn't be translated: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
          }
          notes.push(...done.problems.map((p) => `${name} subtitles: ${p}`));
          const have = { ...(store.quotes?.[lang] ?? {}) };
          const missing = [...new Set(quotes)].filter((q) => !have[q]);
          if (missing.length && setup.apiKey) {
            try {
              const r = await translateSubtitles({ segments: missing.map((text, i) => ({ id: i, cue: i, text })), source: sourceLanguage, target: lang, writer: setup.writer, call });
              // A quote that came back untranslated isn't kept, so it's asked for again next time.
              missing.forEach((q, i) => r.texts[i] !== q && (have[q] = r.texts[i]!));
              store.quotes = { ...store.quotes, [lang]: have };
              queue!.saveSubtitleTranslations(data.job.id, store);
            } catch (err) {
              notes.push(`${name} pull quotes couldn't be translated: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          out.set(lang, { cues: translatedCues(cues, segments, done.texts, lang), quotes: have });
        }
        return out;
      };

      // Kept clips' audio, cut from the episode. With clips but none kept, earlier clip files are cleared.
      // Exporting the kept clips (Clips tab) also makes their videos, when video clips are on: each
      // shape with the original captions, and again in each caption language chosen (subtitles S3).
      const shapes = SHAPES.map((sh) => sh.id).filter((id) => s.video.shapes[id]);
      const withVideo = opts?.clipsOnly && s.video.enabled && shapes.length > 0 && kept.length > 0;
      const videoLanguages = withVideo ? TRANSLATION_LANGUAGES.filter((l) => s.video.languages[l.id]).map((l) => l.id) : [];
      const quoteOf = (c: (typeof kept)[number]) => (c.quote ? quoteText(turns, c.quote) : null);
      const videoTranslations = videoLanguages.length
        ? await translate(videoLanguages, buildCues(turns), kept.map(quoteOf).filter((q): q is string => !!q))
        : new Map<TranslationLanguage, { cues: Cue[]; quotes: Record<string, string> }>();
      const renders = shapes.flatMap((shape) => [
        { shape, language: null },
        ...videoLanguages.filter((l) => videoTranslations.has(l)).map((language) => ({ shape, language })),
      ]);
      const background = s.video.backgroundType === "image" && s.video.backgroundImage ? backgroundPath(userData, s.video.backgroundImage) : null;
      const cut = data.social
        ? await cutClips(
            data.job.filePath,
            kept.map((c) => ({ start: c.start, end: c.end })),
            CUTTER,
            {
              signal: opts?.signal,
              onProgress: opts?.onProgress,
              video: withVideo
                ? {
                    style: s.video,
                    showName: s.show.name,
                    website: s.show.website,
                    hosts: s.show.hosts,
                    logo: s.video.showLogo && branding.logo ? (loadLogo(userData, branding.logo)?.png ?? null) : null,
                    background: background ? readFileSync(background) : null,
                    clips: kept.map((c) => ({
                      words: clipCaptionWords(turns, c),
                      renders,
                      quote: c.quote ?? null,
                      keywords: c.keywords ?? [],
                      translations: Object.fromEntries(
                        [...videoTranslations].map(([language, t]) => {
                          const q = quoteOf(c);
                          return [language, { language, cues: clipCues(t.cues, c), quote: (q && t.quotes[q]) || null }];
                        }),
                      ),
                    })),
                  }
                : undefined,
            },
          )
        : null;
      const clips = cut
        ? [
            ...cut.wavs.map((wav, i) => ({ name: clipFileName(base, i + 1, kept[i]!.title), data: wav })),
            ...cut.videos.flatMap((perRender, i) =>
              perRender.map((mp4, j) => {
                const r = renders[j]!;
                return { name: clipVideoName(base, i + 1, kept[i]!.title, r.shape, r.language ? translationLanguage(r.language).name : null), data: mp4 };
              }),
            ),
          ]
        : undefined;
      // Subtitles of the reviewed transcript, with the episode's documents (not with the clips' own export).
      const subtitleFormats = opts?.clipsOnly ? [] : SUBTITLE_FORMATS.filter((f) => s.output.subtitles[f]);
      const cues = subtitleFormats.length ? buildCues(turns) : [];
      const subtitleFiles: { name: string; data: string }[] = [];
      const addSubtitles = (language: string, list: Cue[]) => {
        for (const f of subtitleFormats) subtitleFiles.push({ name: subtitleFileName(base, language, f), data: f === "srt" ? toSrt(list) : toVtt(list) });
      };
      addSubtitles(sourceLanguage, cues);
      const subtitleLanguages = subtitleFormats.length ? TRANSLATION_LANGUAGES.filter((l) => s.output.subtitles.translate[l.id]).map((l) => l.id) : [];
      if (subtitleLanguages.length) {
        for (const [lang, t] of await translate(subtitleLanguages, cues, [])) addSubtitles(translationLanguage(lang).name, t.cues);
      }
      const result = await writeExport(data.job.exportRoot || s.output.folder || defaultOutputFolder(), label, documents, chosen, {
        files: subtitleFiles,
        clips,
        // The episode's own export makes no videos, so it leaves those from the Clips tab in place.
        replaceClips: opts?.clipsOnly ? ["wav", "mp4"] : ["wav"],
        renderPdf: printPdf,
        branding: {
          ...branding,
          show: s.show.name,
          date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
          logo: branding.logo ? loadLogo(userData, branding.logo) : undefined,
        },
      });
      return notes.length ? { ...result, notes } : result;
    },
    autoExport: () => settings.get().output.autoExport,
    reviewOptions: () => {
      const s = settings.get();
      return {
        reviewStep: s.processing.reviewStep,
        cleanup: { repetitions: s.processing.removeFalseStarts },
        hosts: s.show.hosts,
      };
    },
    onChange: (jobs) => mainWindow?.webContents.send(IPC.jobsChanged, jobs),
    // A slow sync may have brought in another computer's earlier claim since the file was taken.
    beforeTranscribe: async (job) => (job.watchedPath && folderWatcher ? folderWatcher.stillMine(job.id) : null),
    onEvent: (event) => {
      // A watched file's original moves to Done once it's transcribed.
      if (event.type === "transcribed") void folderWatcher?.transcribed(event.job.id);
      notifyJobEvent(event, {
        windowFocused: mainWindow?.isFocused() ?? false,
        onClick: showJob,
      });
    },
    // Keep the computer from sleeping mid-upload. The screen can still turn off.
    onBusyChange: (busy) => {
      if (busy && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
      if (!busy && sleepBlocker !== null) {
        powerSaveBlocker.stop(sleepBlocker);
        sleepBlocker = null;
      }
    },
  });

  const updater = new Updater((s) => mainWindow?.webContents.send(IPC.updateStatusChanged, s));
  registerIpc(settings, keys, queue, updater);
  const jobs = queue;

  // --- Watching a folder (Google Drive for Desktop) --------------------------
  const applyFolderWatch = () => {
    folderWatcher?.stop();
    folderWatcher = null;
    const { enabled, folder, settleMinutes } = settings.get().folderWatch;
    if (!enabled || !folder.trim()) return;
    const root = folder.trim();
    folderWatcher = new FolderWatcher({
      root,
      inboxDir: join(userData, "inbox"),
      statePath: join(userData, "folder-watch.json"),
      machineId: machineId(userData),
      machineName: hostname(),
      onFile: (path, relPath) => {
        const { added } = jobs.add([path], "watch", { exportRoot: join(root, EXPORTS_FOLDER), watchedPath: relPath });
        return added[0]?.id ?? "";
      },
      onError: (message) => console.error("[folder watch]", message),
      settleMs: Math.min(60, Math.max(1, Math.round(settleMinutes) || 1)) * 60_000,
      // The smoke test can't wait minutes for files to settle.
      ...(SMOKE ? { scanMs: 500, stableMs: 1000, settleMs: 1000, stuckMs: 2000 } : {}),
    });
    folderWatcher.start();
  };
  settings.onChange((s, prev) => {
    const [a, b] = [s.folderWatch, prev.folderWatch];
    if (a.enabled !== b.enabled || a.folder !== b.folder || a.settleMinutes !== b.settleMinutes) applyFolderWatch();
  });
  applyFolderWatch();
  app.on("before-quit", () => folderWatcher?.stop());

  // --- Google Drive folder watching (M5) ------------------------------------
  // Built and tested, but switched off until the intake workflow is settled.
  // To turn it on:
  //   1. Create a "Desktop app" OAuth client in the team's Google Cloud
  //      project with an Internal consent screen, and fill in GOOGLE_OAUTH in
  //      src/main/watch/googleAuth.ts.
  //   2. Uncomment this block and its imports at the top of the file.
  //   3. Render <DriveWatchSection> in src/renderer/src/components/SettingsScreen.tsx.
  // New files go through queue.add(..., "watch"), so "Ask me before
  // processing" and the approval notification already apply to them.
  //
  // const googleTokens = new GoogleTokenStore(userData);
  // const drive = new DriveClient({
  //   getTokens: () => googleTokens.get(),
  //   saveTokens: (t) => googleTokens.set(t),
  //   refresh: (t) => refreshTokens(t),
  // });
  // let watcher: DriveWatcher | null = null;
  // const applyWatch = () => {
  //   watcher?.stop();
  //   watcher = null;
  //   const { enabled, folderId } = settings.get().watch;
  //   if (!enabled || !folderId || !googleTokens.get()) return;
  //   watcher = new DriveWatcher({
  //     drive,
  //     folderId,
  //     inboxDir: join(userData, "inbox"),
  //     statePath: join(userData, "watch-state.json"),
  //     onFile: (path) => jobs.add([path], "watch"),
  //     onError: (message) => console.error("[drive]", message),
  //   });
  //   watcher.start();
  // };
  // applyWatch();
  // settings.onChange((next, prev) => {
  //   if (JSON.stringify(next.watch) !== JSON.stringify(prev.watch)) applyWatch();
  // });
  // ipcMain.handle(IPC.driveStatus, () => ({ configured: GOOGLE_OAUTH.clientId !== "", signedIn: googleTokens.get() !== null }));
  // ipcMain.handle(IPC.driveSignIn, async () => {
  //   googleTokens.set(await signIn((url) => shell.openExternal(url)));
  //   applyWatch();
  // });
  // ipcMain.handle(IPC.driveSignOut, () => {
  //   googleTokens.clear();
  //   settings.update({ watch: { enabled: false } });
  // });
  // ipcMain.handle(IPC.driveSetFolder, (_e, input: string) => {
  //   const folderId = parseFolderId(input);
  //   if (!folderId) throw new Error("That doesn't look like a Google Drive folder link.");
  //   settings.update({ watch: { folderId } });
  //   return folderId;
  // });
  // ---------------------------------------------------------------------------
  handleMedia((id) => jobs.audioPath(id));
  updater.start();

  createTray({
    iconPath: join(__dirname, "..", "icon.png"),
    onOpen: showWindow,
    onQuit: () => app.quit(),
  });

  // The packaged macOS app gets its Dock icon from the bundle; dev runs don't.
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(join(__dirname, "..", "icon.png"));

  mainWindow = createWindow(settings);
  startWindow = settings.get().general.startWindow;
  if (!launchedHidden()) mainWindow.once("ready-to-show", () => showWindow());
  if (SMOKE) runSmokeTest(mainWindow, { checkForUpdate: () => updater.check() });

  app.on("activate", showWindow); // macOS dock click
}

function createWindow(settings: SettingsStore): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: WINDOW_TITLE,
    // Without this the taskbar shows Electron's default icon. Windows wants
    // the multi-size .ico so the taskbar and Alt+Tab pick a sharp size.
    icon: join(__dirname, "..", process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // F11 toggles full screen; Esc also leaves it (and still reaches the page).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (input.key === "Escape" && win.isFullScreen()) {
      win.setFullScreen(false);
    }
  });

  // The renderer is a local app; nothing inside it should open other pages.
  // This also stops a dropped file that misses the drop zone from replacing the UI.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!devServerUrl || !url.startsWith(devServerUrl)) event.preventDefault();
  });

  // The page asks to stay open (beforeunload) when Settings has unsaved
  // changes; Electron doesn't show a prompt for that itself, so ask here.
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Leave without saving", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "You have unsaved settings.",
      detail: "Leave without saving them, or cancel and press Save in Settings.",
    });
    if (choice === 0) event.preventDefault(); // allow the window to close
    else quitting = false; // a quit was cancelled; closing the window hides it again
  });

  win.on("close", (event) => {
    if (!quitting && settings.get().general.closeToTray && !SMOKE) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    mainWindow = null;
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return win;
}

/** How the window opens the first time it's shown this run (Settings › General); cleared once applied. */
let startWindow: StartWindow | null = null;

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // The smoke test sizes its own window.
  if (startWindow && !SMOKE) {
    if (startWindow === "maximized") mainWindow.maximize();
    if (startWindow === "fullscreen") mainWindow.setFullScreen(true);
  }
  startWindow = null;
  mainWindow.show();
  mainWindow.focus();
}

function showJob(id: string): void {
  showWindow();
  mainWindow?.webContents.send(IPC.showJob, id);
}

app.on("before-quit", (event) => {
  if (quitting) return;
  if (queue?.isBusy() && !SMOKE) {
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Keep running", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      message: "An episode is being transcribed.",
      detail: "If you quit now, it will start over from the beginning next time Transcriptor 2 opens.",
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
  }
  quitting = true;
});

// With close-to-tray on, the window is hidden rather than closed, so this
// only fires when the user has turned close-to-tray off.
app.on("window-all-closed", () => {
  app.quit();
});

/**
 * Light, dark, or follow the OS. Setting Electron's theme source also flips
 * the page's prefers-color-scheme, so the stylesheet's light/dark tokens
 * follow without any renderer code, and the title bar matches.
 */
function applyTheme(theme: "system" | "light" | "dark"): void {
  nativeTheme.themeSource = theme;
  mainWindow?.setBackgroundColor(windowBackground());
}

/** The page background, shown before the UI paints (matches --bg in styles.css). */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#111113" : "#f7f7f8");

/** True when the OS started us at login, in which case stay in the tray. */
function launchedHidden(): boolean {
  if (process.argv.includes("--hidden")) return true; // Windows (see applyLoginItem)
  if (process.platform === "darwin") return app.getLoginItemSettings().wasOpenedAtLogin;
  return false;
}

function applyLoginItem(enabled: boolean): void {
  // In dev this would register the bare electron binary; only do it for real installs.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}

function registerIpc(settings: SettingsStore, keys: KeyStore, jobs: JobQueue, updater: Updater): void {
  ipcMain.handle(IPC.getSettings, () => settings.get());
  ipcMain.handle(IPC.updateSettings, (_e, patch: SettingsPatch) => settings.update(patch));
  ipcMain.handle(IPC.defaultOutputFolder, () => defaultOutputFolder());
  ipcMain.handle(IPC.driveForDesktop, () => findDriveForDesktop());
  ipcMain.handle(IPC.pickWatchFolder, async () => {
    const result = await showOpenDialog({
      properties: ["openDirectory"],
      defaultPath: settings.get().folderWatch.folder || findDriveForDesktop() || undefined,
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.folderWatchStatus, () => folderWatcher?.status() ?? null);
  ipcMain.handle(IPC.stuckFiles, async () => (folderWatcher ? folderWatcher.stuck() : []));
  ipcMain.handle(IPC.takeOverFile, async (_e, key: unknown) => {
    if (!folderWatcher) throw new Error("The folder isn't being watched.");
    if (typeof key !== "string" || !/^[0-9a-f]{24}$/.test(key)) throw new Error("Unknown file.");
    await folderWatcher.takeOver(key);
  });
  ipcMain.handle(IPC.listModels, (_e, provider: unknown) => {
    const info = typeof provider === "string" ? providerById(provider) : undefined;
    if (!info || info.role !== "writing") throw new Error("Unknown provider.");
    const key = keys.get(info.id);
    if (!key) throw new Error(`Add your ${info.label} API key on the API keys tab to see its models.`);
    // The key only ever goes to the saved API address for that provider, never one from the renderer.
    const w = settings.get().writing;
    const baseUrl = w.provider === info.id && w.baseUrl.trim() ? w.baseUrl.trim() : undefined;
    return listModels(info.id, key, baseUrl);
  });
  ipcMain.handle(IPC.pickLogo, async () => {
    const result = await showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    const userData = app.getPath("userData");
    const name = importLogo(userData, path);
    return { name, preview: logoPreview(userData, name) ?? "" };
  });
  ipcMain.handle(IPC.logoPreview, (_e, name: unknown) =>
    typeof name === "string" ? logoPreview(app.getPath("userData"), name) : null,
  );
  ipcMain.handle(IPC.pickBackground, async () => {
    const result = await showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    const userData = app.getPath("userData");
    const name = importBackground(userData, path);
    return { name, preview: backgroundPreview(userData, name) ?? "" };
  });
  ipcMain.handle(IPC.backgroundPreview, (_e, name: unknown) =>
    typeof name === "string" ? backgroundPreview(app.getPath("userData"), name) : null,
  );
  ipcMain.handle(IPC.pickFolder, async () => {
    const result = await showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.listKeys, () => keys.list());
  ipcMain.handle(IPC.setKey, (_e, id: string, key: string) => {
    keys.set(id, key);
    return keys.list();
  });
  ipcMain.handle(IPC.deleteKey, (_e, id: string) => {
    keys.delete(id);
    return keys.list();
  });
  ipcMain.handle(IPC.keychainAvailable, () => keys.available());

  ipcMain.handle(IPC.listJobs, () => jobs.list());
  ipcMain.handle(IPC.pickAudio, async (): Promise<AddFilesResult> => {
    const result = await showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS] }],
    });
    return result.canceled ? { added: [], rejected: [] } : jobs.add(result.filePaths);
  });
  ipcMain.handle(IPC.addFiles, (_e, paths: unknown) =>
    jobs.add(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : []),
  );
  ipcMain.handle(IPC.approveJob, (_e, id: string) => jobs.approve(id));
  ipcMain.handle(IPC.cancelJob, (_e, id: string) => jobs.cancel(id));
  ipcMain.handle(IPC.retryJob, (_e, id: string) => jobs.retry(id));
  ipcMain.handle(IPC.removeJob, (_e, id: string) => jobs.remove(id));
  ipcMain.handle(IPC.getEpisode, (_e, id: string) => {
    const transcript = jobs.transcript(id);
    const edits = jobs.edits(id);
    return transcript && edits ? { transcript, edits } : null;
  });
  ipcMain.handle(IPC.saveEdits, (_e, id: string, edits: EpisodeEdits) => jobs.saveEdits(id, edits));
  ipcMain.handle(IPC.markReviewed, (_e, id: string) => jobs.markReviewed(id));
  ipcMain.handle(IPC.getDetails, (_e, id: string) => jobs.details(id));
  ipcMain.handle(IPC.writeNotes, (_e, id: string, details: EpisodeDetails) => jobs.write(id, sanitizeDetails(details)));
  ipcMain.handle(IPC.getWriting, (_e, id: string) => jobs.writing(id));
  ipcMain.handle(IPC.getSocial, (_e, id: string) => jobs.social(id));
  ipcMain.handle(IPC.getSubtitleTranslations, (_e, id: string) => jobs.subtitleTranslations(id));
  // Each changed clip is checked again here, against the transcript, before it's saved.
  ipcMain.handle(IPC.saveClips, (_e, id: string, edits: unknown) => {
    const social = jobs.social(id);
    const transcript = jobs.transcript(id);
    const reviewEdits = jobs.edits(id);
    if (!social || !transcript || !reviewEdits || !edits || typeof edits !== "object") return social;
    const ctx = clipContext(transcript, reviewEdits, jobs.writing(id), settings.get().show.website);
    const changes = edits as Record<string, ClipEdit>;
    const next = {
      ...social,
      clips: social.clips.map((c) => (Object.hasOwn(changes, c.id) && changes[c.id] ? reviseClip(c, changes[c.id]!, ctx) : c)),
    };
    jobs.saveSocial(id, next);
    return jobs.social(id);
  });
  ipcMain.handle(IPC.suggestClips, (_e, id: string) => jobs.suggestClips(id));
  ipcMain.handle(IPC.cancelClips, (_e, id: string) => jobs.cancelSocial(id));
  ipcMain.handle(IPC.exportClips, (_e, id: string) => jobs.exportClips(id));
  ipcMain.handle(IPC.cancelClipsExport, (_e, id: string) => jobs.cancelClipsExport(id));
  // The waveform for a clip's video preview: cut the clip and measure its loudness per frame.
  const levelsCache = new Map<string, number[]>();
  ipcMain.handle(IPC.clipLevels, async (_e, id: string, start: unknown, end: unknown) => {
    const path = jobs.audioPath(id);
    const from = Number(start);
    const to = Number(end);
    if (!path || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 600) return [];
    const key = `${id}:${from}:${to}`;
    const cached = levelsCache.get(key);
    if (cached) return cached;
    const [wav] = (await cutClips(path, [{ start: from, end: to }], CUTTER)).wavs;
    const parsed = wav ? readWav(wav) : null;
    const levels = parsed ? audioLevels(parsed.pcm, parsed.channels, parsed.sampleRate) : [];
    if (levelsCache.size > 50) levelsCache.delete(levelsCache.keys().next().value!);
    levelsCache.set(key, levels);
    return levels;
  });
  ipcMain.handle(IPC.exportEpisode, (_e, id: string, formats: unknown) =>
    jobs.exportNow(id, Array.isArray(formats) ? EXPORT_FORMATS.filter((f) => formats.includes(f)) : undefined),
  );
  ipcMain.handle(IPC.openFolder, async (_e, path: string) => {
    // Only folders this app exported to; never an arbitrary path from the renderer.
    if (jobs.list().some((j) => j.exported?.folder === path || j.social?.exported?.folder === path)) await shell.openPath(path);
  });
  ipcMain.handle(IPC.exportTemplate, async (_e, sections: unknown) => {
    const result = await (mainWindow
      ? dialog.showSaveDialog(mainWindow, { defaultPath: "show-notes-template.json", filters: [{ name: "Template", extensions: ["json"] }] })
      : dialog.showSaveDialog({ defaultPath: "show-notes-template.json" }));
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, JSON.stringify(templateFile(sections), null, 2));
    return true;
  });
  ipcMain.handle(IPC.saveSampleTemplate, async () => {
    const options = { defaultPath: "sample-show-notes-template.json", filters: [{ name: "Template", extensions: ["json"] }] };
    const result = await (mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options));
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, JSON.stringify(sampleTemplateFile(), null, 2));
    return true;
  });
  ipcMain.handle(IPC.importTemplate, async () => {
    const result = await showOpenDialog({ properties: ["openFile"], filters: [{ name: "Template", extensions: ["json"] }] });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return readTemplateFile(readFileSync(path, "utf8"));
  });

  ipcMain.handle(IPC.getUpdateStatus, () => updater.get());
  ipcMain.handle(IPC.installUpdate, () => updater.installNow());

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    // Only ever hand web links to the OS, never file: or custom schemes.
    if (/^https:\/\//i.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle(IPC.appVersion, () => app.getVersion());
}

/** Details come over IPC; keep only known string fields. */
function sanitizeDetails(value: unknown): EpisodeDetails {
  const v = (value ?? {}) as Record<string, unknown>;
  const out = { ...EMPTY_DETAILS };
  for (const key of Object.keys(out) as (keyof EpisodeDetails)[]) {
    if (typeof v[key] === "string") out[key] = (v[key] as string).slice(0, 5000);
  }
  return out;
}

let folderWatcher: FolderWatcher | null = null;

/** A random id for this computer, kept in userData, so claims on shared folders can tell computers apart. */
function machineId(userData: string): string {
  const path = join(userData, "machine-id");
  try {
    const id = readFileSync(path, "utf8").trim();
    if (id) return id;
  } catch {
    // First run.
  }
  const id = randomUUID();
  writeFileSync(path, id);
  return id;
}

function showOpenDialog(opts: Electron.OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts);
}

const EXPORT_FORMATS: ExportFormat[] = ["docx", "pdf", "txt"];

export function defaultOutputFolder(): string {
  return join(app.getPath("documents"), "Transcriptor 2");
}
