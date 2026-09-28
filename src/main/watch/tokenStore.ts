import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { readJson, writeJsonAtomic } from "../jsonFile";
import type { GoogleTokens } from "./googleAuth";

/** Google tokens, encrypted with the OS keychain like the API keys (`<userData>/google.json`). */
export class GoogleTokenStore {
  private readonly path: string;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, "google.json");
  }

  get(): GoogleTokens | null {
    const blob = readJson(this.path);
    if (typeof blob !== "string") return null;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(blob, "base64"))) as GoogleTokens;
    } catch {
      return null;
    }
  }

  set(tokens: GoogleTokens): void {
    writeJsonAtomic(this.path, safeStorage.encryptString(JSON.stringify(tokens)).toString("base64"));
  }

  clear(): void {
    if (existsSync(this.path)) rmSync(this.path);
  }
}
