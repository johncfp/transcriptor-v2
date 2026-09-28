import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { formatBytes, isAudioFile, SETTLED, type AddFilesResult, type Job, type JobSource } from "../shared/jobs";
import { defaultEdits, type CleanupOptions, type EpisodeEdits } from "../shared/cleanup";
import { providerById } from "../shared/providers";
import { suggestSpeakers } from "../shared/speakerNames";
import type { Transcript } from "../shared/transcript";
import { readJson, writeJsonAtomic } from "./jsonFile";
import { AbortedError } from "./transcribe/multipart";
import type { Transcriber } from "./transcribe/types";

export interface JobQueueDeps {
  /** `<userData>`; jobs.json and episodes/<id>/ live here. */
  dataDir: string;
  transcriber: Transcriber;
  getKey: (providerId: string) => string | null;
  /** Whether files from the folder watcher need approval (read on each add). */
  needsApproval: () => boolean;
  /** Settings that shape a new transcript's review, read when it finishes. */
  reviewOptions: () => { reviewStep: boolean; cleanup: CleanupOptions; hosts: string[] };
  /** Every change, including progress ticks. */
  onChange?: (jobs: Job[]) => void;
  /** A job reached a state the user should hear about. */
  onEvent?: (event: JobEvent) => void;
  /** Called with true while a job is running, false when the queue goes idle. */
  onBusyChange?: (busy: boolean) => void;
}

export type JobEvent =
  | { type: "awaiting-approval"; job: Job }
  | { type: "transcribed"; job: Job; needsReview: boolean }
  | { type: "failed"; job: Job };

/**
 * Episodes waiting for, going through, or finished with transcription. Runs
 * one job at a time in the main process, so work continues with the window
 * closed. The list is saved to `jobs.json` on every status change, so a
 * crash or restart picks up where it left off.
 */
export class JobQueue {
  private jobs: Job[];
  private readonly path: string;
  private running: { id: string; abort: AbortController } | null = null;
  private lastProgressEmit = 0;

  constructor(private readonly deps: JobQueueDeps) {
    this.path = join(deps.dataDir, "jobs.json");
    const saved = readJson(this.path);
    this.jobs = Array.isArray(saved) ? saved.filter(isSavedJob) : [];
    for (const job of this.jobs) {
      // A job that was mid-transcription when the app stopped starts over.
      if (job.status === "transcribing") {
        Object.assign(job, { status: "queued", stage: undefined, progress: undefined });
      }
      // alpha.1 had a single "transcribed" status.
      if ((job.status as string) === "transcribed") job.status = "needs-review";
    }
    this.save();
  }

  list(): Job[] {
    return this.jobs;
  }

  add(paths: string[], source: JobSource = "manual"): AddFilesResult {
    const result: AddFilesResult = { added: [], rejected: [] };
    for (const filePath of paths) {
      const fileName = basename(filePath);
      const reason = this.checkFile(filePath);
      if (reason) {
        result.rejected.push({ fileName, reason });
        continue;
      }
      const job: Job = {
        id: randomUUID(),
        fileName,
        filePath,
        fileSize: statSync(filePath).size,
        source,
        // Files added by hand are already the user's choice; only watched files wait.
        status: source === "watch" && this.deps.needsApproval() ? "awaiting-approval" : "queued",
        addedAt: new Date().toISOString(),
      };
      this.jobs.push(job);
      result.added.push(job);
      if (job.status === "awaiting-approval") this.deps.onEvent?.({ type: "awaiting-approval", job });
    }
    if (result.added.length) this.changed();
    this.pump();
    return result;
  }

  approve(id: string): void {
    const job = this.find(id);
    if (job?.status !== "awaiting-approval") return;
    job.status = "queued";
    this.changed();
    this.pump();
  }

  cancel(id: string): void {
    const job = this.find(id);
    if (!job || SETTLED.has(job.status)) return;
    if (this.running?.id === id) {
      this.running.abort.abort(); // run() settles the status
      return;
    }
    Object.assign(job, { status: "cancelled", stage: undefined, progress: undefined });
    this.changed();
  }

  retry(id: string): void {
    const job = this.find(id);
    if (job?.status !== "failed" && job?.status !== "cancelled") return;
    Object.assign(job, { status: "queued", error: undefined, stage: undefined, progress: undefined });
    this.changed();
    this.pump();
  }

  /** Removes the job and its saved transcript. The original audio file is never touched. */
  remove(id: string): void {
    const job = this.find(id);
    if (!job) return;
    if (!SETTLED.has(job.status) && job.status !== "awaiting-approval" && job.status !== "queued") return;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    rmSync(this.episodeDir(id), { recursive: true, force: true });
    this.changed();
  }

  transcript(id: string): Transcript | null {
    if (!this.find(id)) return null; // ids come over IPC; only read our own folders
    return (readJson(join(this.episodeDir(id), "transcript.json")) as Transcript | undefined) ?? null;
  }

  /** Review edits, created with defaults for transcripts from before they existed. */
  edits(id: string): EpisodeEdits | null {
    const transcript = this.transcript(id);
    if (!transcript) return null;
    const saved = readJson(join(this.episodeDir(id), "edits.json")) as EpisodeEdits | undefined;
    return saved?.version === 1 ? saved : this.initialEdits(transcript);
  }

  saveEdits(id: string, edits: EpisodeEdits): void {
    if (!this.transcript(id)) return;
    writeJsonAtomic(join(this.episodeDir(id), "edits.json"), edits);
  }

  markReviewed(id: string): void {
    const job = this.find(id);
    if (job?.status !== "needs-review") return;
    job.status = "ready";
    this.changed();
  }

  private initialEdits(transcript: Transcript): EpisodeEdits {
    const { cleanup, hosts } = this.deps.reviewOptions();
    const edits = defaultEdits(cleanup, transcript.speakerCount);
    edits.suggestedNames = suggestSpeakers(transcript.words, transcript.speakerCount, hosts);
    return edits;
  }

  /** The audio file behind a job, for playback in review. */
  audioPath(id: string): string | null {
    return this.find(id)?.filePath ?? null;
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  private checkFile(filePath: string): string | null {
    if (!isAudioFile(filePath)) return "Not a supported audio file.";
    let size: number;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return "Not a file.";
      size = stat.size;
    } catch {
      return "The file couldn't be opened.";
    }
    if (size === 0) return "The file is empty.";
    if (size > this.deps.transcriber.maxBytes) {
      return `Larger than ${this.deps.transcriber.label}'s ${formatBytes(this.deps.transcriber.maxBytes)} limit.`;
    }
    const active = this.jobs.find((j) => j.filePath === filePath && !SETTLED.has(j.status));
    if (active) return "Already in the queue.";
    return null;
  }

  /** Start the next queued job if nothing is running. */
  private pump(): void {
    if (this.running) return;
    const next = this.jobs.find((j) => j.status === "queued");
    if (!next) return;
    void this.run(next);
  }

  private async run(job: Job): Promise<void> {
    const abort = new AbortController();
    this.running = { id: job.id, abort };
    this.deps.onBusyChange?.(true);
    Object.assign(job, { status: "transcribing", stage: "Starting", progress: null, error: undefined });
    this.changed();

    try {
      const { transcriber } = this.deps;
      const key = this.deps.getKey(transcriber.providerId);
      if (!key) {
        const name = providerById(transcriber.providerId)?.label ?? transcriber.label;
        throw new Error(`Add your ${name} API key in Settings, then retry.`);
      }
      if (!existsSync(job.filePath)) {
        throw new Error("The audio file was moved or deleted since it was added.");
      }

      const transcript = await transcriber.transcribe({
        filePath: job.filePath,
        apiKey: key,
        signal: abort.signal,
        removeFalseStarts: this.deps.reviewOptions().cleanup.repetitions,
        onProgress: (stage, progress) => {
          job.stage = stage;
          job.progress = progress;
          this.progressed();
        },
      });

      writeJsonAtomic(join(this.episodeDir(job.id), "transcript.json"), transcript);
      writeJsonAtomic(join(this.episodeDir(job.id), "edits.json"), this.initialEdits(transcript));
      const needsReview = this.deps.reviewOptions().reviewStep;
      Object.assign(job, {
        status: needsReview ? "needs-review" : "ready",
        stage: undefined,
        progress: undefined,
        durationSec: transcript.durationSec,
        wordCount: transcript.words.length,
        speakerCount: transcript.speakerCount,
        finishedAt: new Date().toISOString(),
      });
      this.deps.onEvent?.({ type: "transcribed", job, needsReview });
    } catch (err) {
      if (err instanceof AbortedError || abort.signal.aborted) {
        Object.assign(job, { status: "cancelled", stage: undefined, progress: undefined });
      } else {
        Object.assign(job, {
          status: "failed",
          stage: undefined,
          progress: undefined,
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.onEvent?.({ type: "failed", job });
      }
    } finally {
      this.running = null;
      this.changed();
      // Stays busy if another job is queued, so there's no idle flicker between jobs.
      if (!this.jobs.some((j) => j.status === "queued")) this.deps.onBusyChange?.(false);
      this.pump();
    }
  }

  private find(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private episodeDir(id: string): string {
    return join(this.deps.dataDir, "episodes", id);
  }

  private save(): void {
    writeJsonAtomic(this.path, this.jobs);
  }

  /** Status changed: save and notify. */
  private changed(): void {
    this.save();
    this.deps.onChange?.(this.jobs);
  }

  /** Progress ticked: notify at most ~4 times a second, and don't hit the disk. */
  private progressed(): void {
    const now = Date.now();
    if (now - this.lastProgressEmit < 250) return;
    this.lastProgressEmit = now;
    this.deps.onChange?.(this.jobs);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Enough of a check that a damaged jobs.json can't break the queue. The id
 * check matters most: it becomes a folder name that remove() deletes.
 */
function isSavedJob(value: unknown): value is Job {
  const j = value as Partial<Job> | null;
  return (
    typeof j === "object" &&
    j !== null &&
    typeof j.id === "string" &&
    UUID.test(j.id) &&
    typeof j.filePath === "string" &&
    typeof j.fileName === "string" &&
    typeof j.status === "string"
  );
}
