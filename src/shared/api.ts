// The bridge the preload script exposes to the renderer as `window.api`.
// Every call crosses IPC into the main process; the renderer never sees
// Node, the file system, or a stored API key.

import type { Settings, SettingsPatch } from "./settings";

export interface KeyStatus {
  providerId: string;
  /** True when a key is saved. The key itself never leaves the main process. */
  saved: boolean;
  /** Last four characters, so people can tell which key is in use. */
  hint: string;
}

export interface Api {
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** Where exports go when `output.folder` is empty. */
  defaultOutputFolder(): Promise<string>;
  /** Opens a folder picker; resolves to null if cancelled. */
  pickFolder(): Promise<string | null>;

  listKeys(): Promise<KeyStatus[]>;
  setKey(providerId: string, key: string): Promise<KeyStatus[]>;
  deleteKey(providerId: string): Promise<KeyStatus[]>;
  /** False when the OS keychain is unavailable; keys can't be saved then. */
  keychainAvailable(): Promise<boolean>;

  openExternal(url: string): Promise<void>;
  appVersion(): Promise<string>;
}

export const IPC = {
  getSettings: "settings:get",
  updateSettings: "settings:update",
  defaultOutputFolder: "settings:default-output-folder",
  pickFolder: "dialog:pick-folder",
  listKeys: "keys:list",
  setKey: "keys:set",
  deleteKey: "keys:delete",
  keychainAvailable: "keys:available",
  openExternal: "shell:open-external",
  appVersion: "app:version",
} as const;
