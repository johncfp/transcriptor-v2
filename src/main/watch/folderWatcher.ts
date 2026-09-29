import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { isAudioFile } from "../../shared/jobs";
import { safeFileName } from "../../shared/exportDocs";
import { readJson, writeJsonAtomic } from "../jsonFile";

/**
 * Watches a folder on this computer, typically one that Google Drive for
 * Desktop keeps in sync, for new episode audio. No Google sign-in or Drive
 * permission is involved: Drive for Desktop does the syncing.
 *
 * - Subfolders are watched too, except the ones this watcher manages at the
 *   top level: Done, Transcriptor Exports and .transcriptor.
 * - Files already there when watching starts are skipped.
 * - A new file is taken once it has stopped changing (so a half-synced file
 *   is never read).
 * - Several computers can watch the same shared folder. Each writes a claim
 *   file into .transcriptor/claims, waits for the claims to sync, and only
 *   the earliest claim goes ahead, so an episode is transcribed (and billed)
 *   once.
 * - The file is copied into the app and queued. Right before it's
 *   transcribed the claims are read again, in case a slow sync has brought
 *   in an earlier claim since. Once it's transcribed, the original moves into
 *   Done, keeping its subfolder path.
 * - A file another computer claimed long ago but never finished (that
 *   computer went away) is listed as stuck, and can be taken over by hand.
 */

export const DONE_FOLDER = "Done";
export const EXPORTS_FOLDER = "Transcriptor Exports";
const META_FOLDER = ".transcriptor";
const MANAGED = new Set([DONE_FOLDER, EXPORTS_FOLDER, META_FOLDER].map((f) => f.toLowerCase()));

export interface FolderWatcherDeps {
  root: string;
  /** Picked-up files are copied here before they're queued. */
  inboxDir: string;
  /** Which files have been handled; survives restarts. */
  statePath: string;
  /** This computer, for claims (a stable id, and a name people can read). */
  machineId: string;
  machineName: string;
  /** Queue a copied file; returns the job id. */
  onFile: (path: string, relPath: string) => string;
  onError?: (message: string) => void;
  now?: () => number;
  /** How often to look (default 30 s). */
  scanMs?: number;
  /** How long a file must stay unchanged before it's taken (default 20 s). */
  stableMs?: number;
  /** How long to let other computers' claims sync before deciding (default 60 s). */
  settleMs?: number;
  /** How long another computer's unfinished claim stands before it's listed as stuck (default 15 min). */
  stuckMs?: number;
}

/** A file another computer claimed but hasn't moved to Done. */
export interface StuckFile {
  key: string;
  /** Relative to the watched folder, with "/" separators. */
  file: string;
  claimedBy: string;
  claimedAt: number;
}

interface WatchState {
  root: string;
  /** False until the first look, which only notes what's already there. */
  started: boolean;
  /** Keys of files handled, skipped, or taken by another computer. */
  seen: string[];
  /** Jobs from this folder whose original hasn't moved to Done yet. */
  picked: Record<string, { key: string; relPath: string }>;
}

export interface WatchStatus {
  root: string;
  lastScan: number | null;
  pickedUp: number;
  /** Files waiting to stop changing or for claims to settle. */
  waiting: number;
  error: string | null;
}

interface Claim {
  machine: string;
  name: string;
  at: number;
  file: string;
}

/** Identifies a file by where it is in the folder and its size. */
export const fileKey = (relPath: string, size: number) =>
  createHash("sha1").update(`${relPath.split(sep).join("/").toLowerCase()}|${size}`).digest("hex").slice(0, 24);

export class FolderWatcher {
  private state: WatchState;
  private readonly candidates = new Map<string, { relPath: string; size: number; mtime: number; since: number; claimedAt?: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private lastScan: number | null = null;
  private pickedUp = 0;
  private error: string | null = null;

  constructor(private readonly deps: FolderWatcherDeps) {
    const saved = readJson(deps.statePath) as Partial<WatchState> | undefined;
    // A different folder starts over, so its existing files are skipped too.
    this.state =
      saved?.root === deps.root && Array.isArray(saved.seen)
        ? { root: deps.root, started: !!saved.started, seen: saved.seen, picked: saved.picked ?? {} }
        : { root: deps.root, started: false, seen: [], picked: {} };
  }

  private get now() {
    return this.deps.now?.() ?? Date.now();
  }

  private get claimsDir() {
    return join(this.deps.root, META_FOLDER, "claims");
  }

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.deps.scanMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): WatchStatus {
    return { root: this.deps.root, lastScan: this.lastScan, pickedUp: this.pickedUp, waiting: this.candidates.size, error: this.error };
  }

  private save(): void {
    writeJsonAtomic(this.deps.statePath, this.state);
  }

  /** Audio files under the root, outside the folders this watcher manages. */
  private async list(): Promise<{ relPath: string; size: number; mtime: number }[]> {
    const entries = await readdir(this.deps.root, { recursive: true, withFileTypes: true });
    const files: { relPath: string; size: number; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith(".") || !isAudioFile(e.name)) continue;
      const full = join(e.parentPath, e.name);
      const relPath = full.slice(this.deps.root.length).replace(/^[\\/]+/, "");
      const top = relPath.split(/[\\/]/)[0]!.toLowerCase();
      if (relPath.split(/[\\/]/).length > 1 && MANAGED.has(top)) continue;
      try {
        const s = await stat(full);
        files.push({ relPath, size: s.size, mtime: s.mtimeMs });
      } catch {
        // Gone between listing and stat: it'll be looked at next time if it's back.
      }
    }
    return files;
  }

  /** One look at the folder. Public so tests can drive it without timers. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const files = await this.list();
      const seen = new Set(this.state.seen);
      if (!this.state.started) {
        this.state = { ...this.state, started: true, seen: files.map((f) => fileKey(f.relPath, f.size)) };
        this.save();
        return;
      }
      const present = new Set<string>();
      for (const f of files) {
        const key = fileKey(f.relPath, f.size);
        present.add(key);
        if (seen.has(key)) continue;
        await this.consider(key, f);
      }
      // Forget candidates that vanished (moved away, or still syncing under another name).
      for (const key of this.candidates.keys()) if (!present.has(key)) this.candidates.delete(key);
      this.error = null;
    } catch (err) {
      this.error = (err as NodeJS.ErrnoException).code === "ENOENT" ? `The folder ${this.deps.root} can't be found.` : String((err as Error).message ?? err);
      this.deps.onError?.(this.error);
    } finally {
      this.lastScan = this.now;
      this.scanning = false;
    }
  }

  private async consider(key: string, f: { relPath: string; size: number; mtime: number }): Promise<void> {
    const now = this.now;
    const c = this.candidates.get(key);
    if (!c || c.mtime !== f.mtime) {
      this.candidates.set(key, { ...f, since: now });
      return;
    }
    if (now - c.since < (this.deps.stableMs ?? 20_000)) return;
    if (c.claimedAt === undefined) {
      c.claimedAt = await this.claim(key, f.relPath);
      return;
    }
    if (now - c.claimedAt < (this.deps.settleMs ?? 60_000)) return;

    this.candidates.delete(key);
    const winner = await this.winner(key);
    if (winner && winner.machine !== this.deps.machineId) {
      // Another computer has it.
      this.state.seen.push(key);
      this.save();
      return;
    }
    await this.take(key, f.relPath);
  }

  /** Write this computer's claim (or keep the time of one written before a restart). */
  private async claim(key: string, relPath: string): Promise<number> {
    const path = join(this.claimsDir, `${key}.${this.deps.machineId}.json`);
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as Claim;
      if (typeof existing.at === "number") return existing.at;
    } catch {
      // No claim yet.
    }
    const at = this.now;
    await mkdir(this.claimsDir, { recursive: true });
    const claim: Claim = { machine: this.deps.machineId, name: this.deps.machineName, at, file: relPath.split(sep).join("/") };
    await writeFile(path, JSON.stringify(claim));
    return at;
  }

  /** Every readable claim, by file key, earliest first (ties go to the lower machine id, so every computer agrees). */
  private async claims(): Promise<Map<string, (Claim & { path: string })[]>> {
    const byKey = new Map<string, (Claim & { path: string })[]>();
    let names: string[] = [];
    try {
      names = await readdir(this.claimsDir);
    } catch {
      return byKey;
    }
    for (const n of names.filter((n) => n.endsWith(".json"))) {
      const key = n.split(".")[0]!;
      try {
        const path = join(this.claimsDir, n);
        const c = JSON.parse(await readFile(path, "utf8")) as Claim;
        if (typeof c.at === "number" && typeof c.machine === "string") byKey.set(key, [...(byKey.get(key) ?? []), { ...c, path }]);
      } catch {
        // Half-synced claim: ignored this time round.
      }
    }
    for (const list of byKey.values()) list.sort((a, b) => a.at - b.at || a.machine.localeCompare(b.machine));
    return byKey;
  }

  private async winner(key: string): Promise<Claim | null> {
    return (await this.claims()).get(key)?.[0] ?? null;
  }

  private async dropClaims(key: string): Promise<void> {
    const names = await readdir(this.claimsDir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(`${key}.`)).map((n) => rm(join(this.claimsDir, n), { force: true })));
  }

  /**
   * Files another computer claimed at least `stuckMs` ago that are still in
   * the folder (so weren't finished). Usually that computer went away.
   */
  async stuck(): Promise<StuckFile[]> {
    const mine = new Set(Object.values(this.state.picked).map((p) => p.key));
    const out: StuckFile[] = [];
    for (const [key, list] of await this.claims()) {
      const first = list[0]!;
      if (mine.has(key) || first.machine === this.deps.machineId) continue;
      if (this.now - first.at < (this.deps.stuckMs ?? 15 * 60_000)) continue;
      if (!(await exists(join(this.deps.root, first.file)))) continue;
      out.push({ key, file: first.file, claimedBy: first.name || "another computer", claimedAt: first.at });
    }
    return out.sort((a, b) => a.claimedAt - b.claimedAt);
  }

  /**
   * Take a stuck file: the old claims are removed and this computer's claim
   * replaces them, so the other computer backs off if it comes back.
   */
  async takeOver(key: string): Promise<void> {
    const list = (await this.claims()).get(key);
    const file = list?.[0]?.file;
    if (!file || !(await exists(join(this.deps.root, file)))) throw new Error("That file is no longer waiting in the folder.");
    const relPath = file.split("/").join(sep);
    await this.dropClaims(key);
    this.candidates.delete(key);
    await this.claim(key, relPath);
    this.state.seen = this.state.seen.filter((k) => k !== key);
    await this.take(key, relPath);
  }

  /**
   * Checked right before a job from this folder is transcribed: null to go
   * ahead, or why not, when a slow sync has since brought in an earlier claim
   * from another computer, or the file has left the folder. Then this
   * computer's claim is withdrawn and the job forgotten.
   */
  async stillMine(jobId: string): Promise<string | null> {
    const picked = this.state.picked[jobId];
    if (!picked) return null;
    const winner = await this.winner(picked.key);
    let reason: string | null = null;
    if (winner && winner.machine !== this.deps.machineId) {
      reason = `${winner.name || "Another computer"} claimed this file first and is transcribing it, so it was skipped here.`;
    } else if (!(await exists(join(this.deps.root, picked.relPath)))) {
      reason = "The file is no longer in the watched folder (another computer may have finished it), so it was skipped here.";
    }
    if (reason) {
      await rm(join(this.claimsDir, `${picked.key}.${this.deps.machineId}.json`), { force: true });
      delete this.state.picked[jobId];
      this.save();
    }
    return reason;
  }

  private async take(key: string, relPath: string): Promise<void> {
    const source = join(this.deps.root, relPath);
    // A folder of its own in the inbox keeps the file's name (it becomes the episode's name).
    const folder = join(this.deps.inboxDir, randomUUID());
    await mkdir(folder, { recursive: true });
    const name = basename(relPath);
    const copy = join(folder, `${safeFileName(name.slice(0, -extname(name).length))}${extname(name)}`);
    // With Drive for Desktop streaming files, reading the file is what downloads it.
    await copyFile(source, copy);
    const jobId = this.deps.onFile(copy, relPath);
    this.state.seen.push(key);
    this.state.picked[jobId] = { key, relPath };
    this.pickedUp++;
    this.save();
  }

  /**
   * A job from this folder has been transcribed: move its original into Done
   * (same subfolder path) and remove the claims. Unknown jobs are ignored.
   */
  async transcribed(jobId: string): Promise<void> {
    const picked = this.state.picked[jobId];
    if (!picked) return;
    const from = join(this.deps.root, picked.relPath);
    let to = join(this.deps.root, DONE_FOLDER, picked.relPath);
    try {
      await mkdir(dirname(to), { recursive: true });
      // Don't overwrite an earlier file of the same name in Done.
      for (let n = 2; await exists(to); n++) {
        const ext = extname(picked.relPath);
        to = join(this.deps.root, DONE_FOLDER, `${picked.relPath.slice(0, -ext.length || undefined)} (${n})${ext}`);
      }
      await rename(from, to);
      await this.dropClaims(picked.key);
      delete this.state.picked[jobId];
      this.save();
    } catch (err) {
      // Left in place (and still claimed); the episode itself is fine.
      this.deps.onError?.(`Couldn't move ${picked.relPath} to ${DONE_FOLDER}: ${(err as Error).message}`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
