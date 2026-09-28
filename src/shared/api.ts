// The bridge the preload script exposes to the renderer as `window.api`.
// Every call crosses IPC into the main process; the renderer never sees
// Node, the file system, or a stored API key.

import type { AddFilesResult, Job } from "./jobs";
import type { Settings, SettingsPatch } from "./settings";
import type { Transcript } from "./transcript";

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

  listJobs(): Promise<Job[]>;
  /** Opens a file picker for audio and queues what's chosen. */
  pickAudio(): Promise<AddFilesResult>;
  addFiles(paths: string[]): Promise<AddFilesResult>;
  /** The disk path of a dropped File (sandboxed renderers can't read it themselves). */
  pathForFile(file: File): string;
  approveJob(id: string): Promise<void>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  removeJob(id: string): Promise<void>;
  getTranscript(id: string): Promise<Transcript | null>;
  /** Subscribe to queue changes; returns an unsubscribe function. */
  onJobsChanged(fn: (jobs: Job[]) => void): () => void;
  /** A notification was clicked; the UI should show this job. */
  onShowJob(fn: (id: string) => void): () => void;

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
  listJobs: "jobs:list",
  pickAudio: "jobs:pick-audio",
  addFiles: "jobs:add-files",
  approveJob: "jobs:approve",
  cancelJob: "jobs:cancel",
  retryJob: "jobs:retry",
  removeJob: "jobs:remove",
  getTranscript: "jobs:transcript",
  jobsChanged: "jobs:changed",
  showJob: "jobs:show",
  openExternal: "shell:open-external",
  appVersion: "app:version",
} as const;
