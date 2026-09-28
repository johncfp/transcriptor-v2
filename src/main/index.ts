import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC } from "../shared/api";
import type { SettingsPatch } from "../shared/settings";
import { KeyStore } from "./keyStore";
import { runSmokeTest, SMOKE } from "./smoke";
import { SettingsStore } from "./settingsStore";
import { createTray } from "./tray";

// The smoke test must not touch the real profile, so it swaps userData
// before anything reads it.
if (SMOKE) app.setPath("userData", SMOKE.userData);

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
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

  registerIpc(settings, keys);

  createTray({
    iconPath: join(__dirname, "..", "icon.png"),
    onOpen: showWindow,
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });

  mainWindow = createWindow(settings);
  if (!launchedHidden()) mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (SMOKE) runSmokeTest(mainWindow);

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

app.on("before-quit", () => {
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

function registerIpc(settings: SettingsStore, keys: KeyStore): void {
  ipcMain.handle(IPC.getSettings, () => settings.get());
  ipcMain.handle(IPC.updateSettings, (_e, patch: SettingsPatch) => settings.update(patch));
  ipcMain.handle(IPC.defaultOutputFolder, () => defaultOutputFolder());
  ipcMain.handle(IPC.pickFolder, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
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

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    // Only ever hand web links to the OS, never file: or custom schemes.
    if (/^https:\/\//i.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle(IPC.appVersion, () => app.getVersion());
}

export function defaultOutputFolder(): string {
  return join(app.getPath("documents"), "Transcriptor 2");
}
