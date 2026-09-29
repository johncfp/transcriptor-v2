import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Google Drive for Desktop shows "My Drive" on this computer, if it's
 * installed and signed in: a drive letter on Windows (G: by default), and
 * ~/Library/CloudStorage/GoogleDrive-<account> on macOS. Shared drives sit
 * next to "My Drive" as "Shared drives".
 */
export function findDriveForDesktop(): string | null {
  if (process.platform === "win32") {
    for (const letter of "GDEFHIJKLMNOPQRSTUVWXYZ") {
      const path = `${letter}:\\My Drive`;
      if (existsSync(path)) return path;
    }
    return null;
  }
  if (process.platform === "darwin") {
    const cloud = join(homedir(), "Library", "CloudStorage");
    try {
      for (const name of readdirSync(cloud)) {
        const path = join(cloud, name, "My Drive");
        if (name.startsWith("GoogleDrive-") && existsSync(path)) return path;
      }
    } catch {
      // No CloudStorage folder: Drive for Desktop isn't installed.
    }
  }
  return null;
}
