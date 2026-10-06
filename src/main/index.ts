import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, shell } from "electron";
import { IPC } from "../shared/api";
import { AUDIO_EXTENSIONS, type AddFilesResult } from "../shared/jobs";
import { readFileSync, writeFileSync } from "node:fs";
import type { EpisodeEdits } from "../shared/cleanup";
import { EMPTY_DETAILS, type EpisodeDetails } from "../shared/showNotes";
import { readTemplateFile, sampleTemplateFile, templateFile } from "./templateFile";
import { cleanTranscript } from "../shared/cleanup";
import { clipFileName, episodeDocuments, safeFileName, type ExportFormat } from "../shared/exportDocs";
import { templateSections } from "../shared/showNotes";
import { writeExport } from "./exporter";
import { printPdf } from "./pdf";
import { importLogo, loadLogo, logoPreview, pruneLogos } from "./logo";
import { backgroundPreview, importBackground, pruneBackgrounds } from "./background";
import { clampThresholds } from "../shared/confidence";
import type { SettingsPatch } from "../shared/settings";
import { JobQueue } from "./jobQueue";
import { providerById } from "../shared/providers";
import { anthropicWriter } from "./writing/anthropic";
import { writeEpisode, writerById } from "./writing";
import { suggestClips } from "./writing/social";
import { clipLimits, PLATFORMS, socialDefaultModel } from "../shared/social";
import { clipContext, reviseClip, type ClipEdit } from "../shared/clips";
import { cutClips } from "./clipCutter";
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
      const { label, documents: all } = episodeDocuments({
        turns: cleanTranscript(data.transcript, data.edits),
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
      // Kept clips' audio, cut from the episode. With clips but none kept, earlier clip files are cleared.
      const base = safeFileName(label);
      const clips = data.social
        ? (
            await cutClips(
              data.job.filePath,
              kept.map((c) => ({ start: c.start, end: c.end })),
              {
                preload: join(__dirname, "..", "preload", "cutter.js"),
                load: (win) =>
                  devServerUrl
                    ? win.loadURL(new URL("cutter.html", devServerUrl).href)
                    : win.loadFile(join(__dirname, "..", "renderer", "cutter.html")),
              },
            )
          ).map((data, i) => ({ name: clipFileName(base, i + 1, kept[i]!.title), data }))
        : undefined;
      return writeExport(data.job.exportRoot || s.output.folder || defaultOutputFolder(), label, documents, chosen, {
        clips,
        renderPdf: printPdf,
        branding: {
          ...branding,
          show: s.show.name,
          date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
          logo: branding.logo ? loadLogo(userData, branding.logo) : undefined,
        },
      });
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
  if (!launchedHidden()) mainWindow.once("ready-to-show", () => mainWindow?.show());
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

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
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
