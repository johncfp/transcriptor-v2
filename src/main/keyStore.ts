import { join } from "node:path";
import { safeStorage } from "electron";
import type { KeyStatus } from "../shared/api";
import { PROVIDERS, providerById } from "../shared/providers";
import { readJson, writeJsonAtomic } from "./jsonFile";

/**
 * API keys, encrypted with Electron's safeStorage (Windows DPAPI, macOS
 * Keychain) and kept in `<userData>/keys.json` as base64 ciphertext. Plain
 * keys exist only in memory in the main process and are never sent to the
 * renderer.
 */
export class KeyStore {
  private readonly path: string;
  private encrypted: Record<string, string>;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, "keys.json");
    const raw = readJson(this.path);
    this.encrypted = {};
    if (raw && typeof raw === "object") {
      for (const [id, value] of Object.entries(raw)) {
        if (providerById(id) && typeof value === "string") this.encrypted[id] = value;
      }
    }
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /** The decrypted key, or null. Used by the pipeline in M1+. */
  get(providerId: string): string | null {
    const blob = this.encrypted[providerId];
    if (!blob) return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      // Encrypted on another machine or OS account; treat as missing.
      return null;
    }
  }

  set(providerId: string, key: string): void {
    if (!providerById(providerId)) throw new Error(`Unknown provider: ${providerId}`);
    const trimmed = key.trim();
    if (!trimmed) throw new Error("The key is empty.");
    if (!this.available()) {
      throw new Error("This computer's keychain isn't available, so keys can't be stored safely.");
    }
    this.encrypted[providerId] = safeStorage.encryptString(trimmed).toString("base64");
    writeJsonAtomic(this.path, this.encrypted);
  }

  delete(providerId: string): void {
    delete this.encrypted[providerId];
    writeJsonAtomic(this.path, this.encrypted);
  }

  list(): KeyStatus[] {
    return PROVIDERS.map((p) => {
      const key = this.get(p.id);
      return { providerId: p.id, saved: key !== null, hint: key ? key.slice(-4) : "" };
    });
  }
}
