import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/api";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/johncfp/transcriptor2-releases/releases/latest";

/**
 * Updates come from the public releases-only repo (package.json
 * `build.publish`), so no token ships with the app.
 *
 * Windows downloads in the background and installs on the next quit. macOS
 * refuses to install updates into an unsigned app, so there it only reports
 * that a new version exists and links to the download page.
 */
export class Updater {
  private status: UpdateStatus = { state: "idle" };
  private readonly canInstall = process.platform !== "darwin";

  constructor(private readonly onStatus: (s: UpdateStatus) => void) {}

  start(): void {
    if (!app.isPackaged) return; // dev builds never update themselves
    autoUpdater.autoDownload = this.canInstall;
    autoUpdater.autoInstallOnAppQuit = this.canInstall;

    autoUpdater.on("update-available", (info) => {
      this.set(
        this.canInstall
          ? { state: "downloading", version: info.version }
          : { state: "available", version: info.version, url: RELEASES_URL },
      );
    });
    autoUpdater.on("update-downloaded", (info) => this.set({ state: "ready", version: info.version }));
    autoUpdater.on("error", (err) => console.error("[updater]", err));

    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  get(): UpdateStatus {
    return this.status;
  }

  /** The newer version on the releases page, or null if up to date. */
  async check(): Promise<string | null> {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? result.updateInfo.version : null;
    } catch (err) {
      console.error("[updater] check failed", err);
      return null;
    }
  }

  /** Quit and install now (Windows, once downloaded). */
  installNow(): void {
    if (this.status.state === "ready") autoUpdater.quitAndInstall();
  }

  private set(s: UpdateStatus): void {
    this.status = s;
    this.onStatus(s);
  }
}
