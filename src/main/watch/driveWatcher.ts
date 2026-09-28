import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { isAudioFile } from "../../shared/jobs";
import { safeFileName } from "../../shared/exportDocs";
import { readJson, writeJsonAtomic } from "../jsonFile";
import type { DriveFile } from "./driveClient";

export interface DriveWatcherDeps {
  /** The Drive calls used (a DriveClient in the app, a fake in tests). */
  drive: {
    listFolder(folderId: string): Promise<DriveFile[]>;
    download(fileId: string, path: string): Promise<void>;
  };
  folderId: string;
  /** Downloads land here (`<userData>/inbox`). */
  inboxDir: string;
  /** Which files have been seen; survives restarts. */
  statePath: string;
  /** A downloaded file ready to queue. The queue's approval setting takes it from there. */
  onFile: (path: string) => void;
  onError?: (message: string) => void;
  intervalMs?: number;
}

interface WatchState {
  folderId: string;
  /** Drive file ids already handled (or present before watching began). */
  seen: string[];
}

/**
 * Watches one Google Drive folder for new audio files. On the first check it
 * only notes what's already there, so turning the watcher on doesn't import
 * the folder's whole history; after that each new audio file is downloaded
 * to the inbox and handed to the queue as a watched file, which then waits
 * for approval if Settings asks for it.
 *
 * NOT IN USE YET: see the commented-out wiring in src/main/index.ts.
 */
export class DriveWatcher {
  private state: WatchState;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(private readonly deps: DriveWatcherDeps) {
    const saved = readJson(deps.statePath) as WatchState | undefined;
    // A different folder starts over, with its own baseline.
    this.state = saved?.folderId === deps.folderId && Array.isArray(saved.seen) ? saved : { folderId: deps.folderId, seen: [] };
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? 5 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the folder. Returns the paths handed to the queue. */
  async check(): Promise<string[]> {
    if (this.checking) return [];
    this.checking = true;
    const added: string[] = [];
    try {
      const files = await this.deps.drive.listFolder(this.deps.folderId);
      const firstLook = !this.hasBaseline();
      const seen = new Set(this.state.seen);
      for (const file of files) {
        if (seen.has(file.id)) continue;
        if (firstLook || !isAudioFile(file.name) || file.mimeType === "application/vnd.google-apps.folder") {
          seen.add(file.id);
          continue;
        }
        mkdirSync(this.deps.inboxDir, { recursive: true });
        // The id keeps two uploads with the same name apart.
        const ext = extname(file.name);
        const name = `${file.id.slice(0, 8)} ${safeFileName(file.name.slice(0, -ext.length || undefined), 120)}${ext}`;
        const path = join(this.deps.inboxDir, name);
        try {
          await this.deps.drive.download(file.id, path);
        } catch (err) {
          // Not marked seen, so the next check tries again.
          this.deps.onError?.(`Couldn't download ${file.name} from Google Drive: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        seen.add(file.id);
        added.push(path);
        this.deps.onFile(path);
      }
      this.state = { folderId: this.deps.folderId, seen: [...seen] };
      // An empty list still records that the baseline was taken.
      writeJsonAtomic(this.deps.statePath, { ...this.state, baseline: true });
    } catch (err) {
      this.deps.onError?.(`Couldn't check the Google Drive folder: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.checking = false;
    }
    return added;
  }

  private hasBaseline(): boolean {
    const saved = readJson(this.deps.statePath) as { folderId?: string; baseline?: boolean } | undefined;
    return saved?.folderId === this.deps.folderId && saved.baseline === true;
  }
}
