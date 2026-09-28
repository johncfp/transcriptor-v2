import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from "electron";
import { IPC } from "../shared/api";
import { AUDIO_EXTENSIONS, type AddFilesResult } from "../shared/jobs";
import { readFileSync, writeFileSync } from "node:fs";
import type { EpisodeEdits } from "../shared/cleanup";
import { EMPTY_DETAILS, type EpisodeDetails } from "../shared/showNotes";
import { readTemplateFile, templateFile } from "./templateFile";
import type { SettingsPatch } from "../shared/settings";
import { JobQueue } from "./jobQueue";
import { providerById } from "../shared/providers";
import { anthropicWriter } from "./writing/anthropic";
import { writeEpisode, writerById } from "./writing";
import { KeyStore } from "./keyStore";
import { handleMedia, registerMediaScheme } from "./media";
import { notifyJobEvent } from "./notify";
import { runSmokeTest, SMOKE, smokeTranscriber } from "./smoke";
import { SettingsStore } from "./settingsStore";
import { transcriber } from "./transcribe";
import { createTray } from "./tray";
import { Updater } from "./updater";

// The smoke test must not touch the real profile, so it swaps userData
// before anything reads it.
if (SMOKE) app.setPath("userData", SMOKE.userData);

// Windows only shows notifications for apps with an AppUserModelID, and it
// has to match the installer's appId.
if (process.platform === "win32") app.setAppUserModelId("io.transcriptor.app2");

registerMediaScheme();

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

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

  applyLoginItem(settings.get().general.startAtLogin);
  settings.onChange((next, prev) => {
    if (next.general.startAtLogin !== prev.general.startAtLogin) {
      applyLoginItem(next.general.startAtLogin);
    }
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
    };
  };

  let sleepBlocker: number | null = null;
  queue = new JobQueue({
    dataDir: userData,
    transcriber: smokeTranscriber(transcriber),
    getKey: (id) => keys.get(id),
    needsApproval: () => settings.get().processing.intake === "approve",
    write: (req) => {
      const { writer, apiKey, model, baseUrl } = writerSetup();
      if (!apiKey) {
        throw new Error(`Add your ${providerById(writer.id)?.label ?? writer.label} API key in Settings, then retry.`);
      }
      const { show } = settings.get();
      return writeEpisode({
        transcript: req.transcript,
        edits: req.edits,
        details: req.details,
        show: { name: show.name, hosts: show.hosts },
        writer,
        call: { apiKey, model, baseUrl, signal: req.signal },
        onStage: req.onStage,
      });
    },
    canWrite: () => writerSetup().apiKey !== null,
    reviewOptions: () => {
      const s = settings.get();
      return {
        reviewStep: s.processing.reviewStep,
        cleanup: { repetitions: s.processing.removeFalseStarts },
        hosts: s.show.hosts,
      };
    },
    onChange: (jobs) => mainWindow?.webContents.send(IPC.jobsChanged, jobs),
    onEvent: (event) =>
      notifyJobEvent(event, {
        windowFocused: mainWindow?.isFocused() ?? false,
        onClick: showJob,
      }),
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
  handleMedia((id) => jobs.audioPath(id));
  updater.start();

  createTray({
    iconPath: join(__dirname, "..", "icon.png"),
    onOpen: showWindow,
    onQuit: () => app.quit(),
  });

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
    title: "Transcriptor 2",
    backgroundColor: "#111113",
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
  ipcMain.handle(IPC.exportTemplate, async (_e, sections: unknown) => {
    const result = await (mainWindow
      ? dialog.showSaveDialog(mainWindow, { defaultPath: "show-notes-template.json", filters: [{ name: "Template", extensions: ["json"] }] })
      : dialog.showSaveDialog({ defaultPath: "show-notes-template.json" }));
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, JSON.stringify(templateFile(sections), null, 2));
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

function showOpenDialog(opts: Electron.OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts);
}

export function defaultOutputFolder(): string {
  return join(app.getPath("documents"), "Transcriptor 2");
}
