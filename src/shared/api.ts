// The bridge the preload script exposes to the renderer as `window.api`.
// Every call crosses IPC into the main process; the renderer never sees
// Node, the file system, or a stored API key.

import type { AddFilesResult, Job } from "./jobs";
import type { Settings, SettingsPatch } from "./settings";
import type { EpisodeDetails, SectionId, WritingResult } from "./showNotes";
import type { ExportFormat } from "./exportDocs";
import type { EpisodeEdits } from "./cleanup";
import type { Transcript } from "./transcript";

export interface KeyStatus {
  providerId: string;
  /** True when a key is saved. The key itself never leaves the main process. */
  saved: boolean;
  /** Last four characters, so people can tell which key is in use. */
  hint: string;
}

export type UpdateStatus =
  | { state: "idle" }
  /** Windows: downloading in the background. */
  | { state: "downloading"; version: string }
  /** Windows: downloaded; installs on quit, or now via installUpdate(). */
  | { state: "ready"; version: string }
  /** macOS: can't self-install while unsigned, so link to the download. */
  | { state: "available"; version: string; url: string };

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
  /** The raw transcript plus its review edits; null if not transcribed. */
  getEpisode(id: string): Promise<{ transcript: Transcript; edits: EpisodeEdits } | null>;
  saveEdits(id: string, edits: EpisodeEdits): Promise<void>;
  markReviewed(id: string): Promise<void>;
  getDetails(id: string): Promise<EpisodeDetails | null>;
  /** Save details and queue the show notes. */
  writeNotes(id: string, details: EpisodeDetails): Promise<void>;
  getWriting(id: string): Promise<WritingResult | null>;
  /** Save a custom template's sections to a file others can import. */
  exportTemplate(sections: SectionId[]): Promise<boolean>;
  /** Pick a template file; resolves to its sections, or null if cancelled. */
  importTemplate(): Promise<SectionId[] | null>;
  /** Export the episode's documents; rejects with a readable message on failure. */
  exportEpisode(id: string, formats: ExportFormat[]): Promise<{ folder: string; files: string[] }>;
  /** Open an export folder in Explorer/Finder (only folders this app exported to). */
  openFolder(path: string): Promise<void>;
  /** Subscribe to queue changes; returns an unsubscribe function. */
  onJobsChanged(fn: (jobs: Job[]) => void): () => void;
  /** A notification was clicked; the UI should show this job. */
  onShowJob(fn: (id: string) => void): () => void;

  // Google Drive folder watching (M5): declared and exposed, but the main
  // process handlers are switched off (see src/main/index.ts).
  driveStatus(): Promise<{ configured: boolean; signedIn: boolean }>;
  driveSignIn(): Promise<void>;
  driveSignOut(): Promise<void>;
  /** Save the folder to watch from a pasted Drive link or id; rejects if it isn't one. */
  driveSetFolder(input: string): Promise<string>;

  getUpdateStatus(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdateStatus(fn: (s: UpdateStatus) => void): () => void;

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
  getEpisode: "jobs:episode",
  saveEdits: "jobs:save-edits",
  markReviewed: "jobs:mark-reviewed",
  getDetails: "jobs:details",
  writeNotes: "jobs:write-notes",
  getWriting: "jobs:writing",
  exportTemplate: "template:export",
  importTemplate: "template:import",
  exportEpisode: "jobs:export",
  openFolder: "shell:open-folder",
  jobsChanged: "jobs:changed",
  showJob: "jobs:show",
  driveStatus: "drive:status",
  driveSignIn: "drive:sign-in",
  driveSignOut: "drive:sign-out",
  driveSetFolder: "drive:set-folder",
  getUpdateStatus: "update:status",
  installUpdate: "update:install",
  updateStatusChanged: "update:changed",
  openExternal: "shell:open-external",
  appVersion: "app:version",
} as const;
