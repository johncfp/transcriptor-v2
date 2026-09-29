import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultEdits, type CleanupOptions, type EpisodeEdits } from "../shared/cleanup";
import { formatBytes, isAudioFile, SETTLED, type AddFilesResult, type Job, type JobSource } from "../shared/jobs";
import { providerById } from "../shared/providers";
import { EMPTY_DETAILS, episodeNumberFromFileName, type EpisodeDetails, type WritingResult } from "../shared/showNotes";
import { suggestSpeakers } from "../shared/speakerNames";
import type { Transcript } from "../shared/transcript";
import type { ExportFormat } from "../shared/exportDocs";
import type { ExportResult } from "./exporter";
import { readJson, writeJsonAtomic } from "./jsonFile";
import { AbortedError } from "./transcribe/multipart";
import type { Transcriber } from "./transcribe/types";

export interface WriteRequest {
  transcript: Transcript;
  edits: EpisodeEdits;
  details: EpisodeDetails;
  signal: AbortSignal;
  onStage: (stage: string) => void;
}

/** Everything an export needs about one episode. */
export interface EpisodeExportData {
  job: Job;
  transcript: Transcript;
  edits: EpisodeEdits;
  details: EpisodeDetails;
  writing: WritingResult | null;
}

export interface JobQueueDeps {
  /** `<userData>`; jobs.json and episodes/<id>/ live here. */
  dataDir: string;
  transcriber: Transcriber;
  getKey: (providerId: string) => string | null;
  /** Whether files from the folder watcher need approval (read on each add). */
  needsApproval: () => boolean;
  /** Settings that shape a new transcript's review, read when it finishes. */
  reviewOptions: () => { reviewStep: boolean; cleanup: CleanupOptions; hosts: string[] };
  /** Writes show notes with the configured provider; throws a readable error if it can't. */
  write: (req: WriteRequest) => Promise<WritingResult>;
  /** True when a writing provider has a key, so notes can be written without asking. */
  canWrite: () => boolean;
  /** Write the episode's documents to disk; `formats` overrides the Settings default. */
  exportEpisode: (data: EpisodeExportData, formats?: ExportFormat[]) => Promise<ExportResult>;
  /** Export as soon as show notes are written. */
  autoExport: () => boolean;
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
  | { type: "written"; job: Job }
  | { type: "failed"; job: Job };

/** Statuses that have work waiting for the runner. */
const WAITING = new Set<Job["status"]>(["queued", "writing"]);

/**
 * Episodes moving through transcription and show-note writing. Runs one
 * piece of work at a time in the main process, so it continues with the
 * window closed. The list is saved to `jobs.json` on every status change,
 * so a crash or restart picks up where it left off.
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
      // Writing that was interrupted just runs again ("writing" means queued or running).
      if (job.status === "writing") job.stage = "Waiting";
      // alpha.1 had a single "transcribed" status.
      if ((job.status as string) === "transcribed") job.status = "needs-review";
    }
    this.save();
    queueMicrotask(() => this.pump());
  }

  list(): Job[] {
    return this.jobs;
  }

  add(paths: string[], source: JobSource = "manual", extra: Pick<Job, "exportRoot" | "watchedPath"> = {}): AddFilesResult {
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
        ...extra,
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
      this.running.abort.abort(); // the runner settles the status
      return;
    }
    // Cancelling writing keeps the transcript; the episode goes back to where it was.
    if (job.status === "writing") Object.assign(job, { status: this.afterWritingStops(job.id), stage: undefined });
    else Object.assign(job, { status: "cancelled", stage: undefined, progress: undefined });
    this.changed();
  }

  retry(id: string): void {
    const job = this.find(id);
    if (job?.status !== "failed" && job?.status !== "cancelled") return;
    const writing = job.status === "failed" && job.failedStep === "writing";
    Object.assign(job, {
      status: writing ? "writing" : "queued",
      stage: writing ? "Waiting" : undefined,
      error: undefined,
      failedStep: undefined,
      progress: undefined,
    });
    this.changed();
    this.pump();
  }

  /** Removes the job and its saved files. The original audio file is never touched. */
  remove(id: string): void {
    const job = this.find(id);
    if (!job) return;
    if (!SETTLED.has(job.status) && job.status !== "awaiting-approval" && job.status !== "queued") return;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    rmSync(this.episodeDir(id), { recursive: true, force: true });
    this.changed();
  }

  transcript(id: string): Transcript | null {
    return this.readEpisodeFile<Transcript>(id, "transcript.json");
  }

  /** Review edits, created with defaults for transcripts from before they existed. */
  edits(id: string): EpisodeEdits | null {
    const transcript = this.transcript(id);
    if (!transcript) return null;
    const saved = this.readEpisodeFile<EpisodeEdits>(id, "edits.json");
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

  /** Episode details for the show notes, with the number guessed from the file name. */
  details(id: string): EpisodeDetails | null {
    const job = this.find(id);
    if (!job) return null;
    const saved = this.readEpisodeFile<EpisodeDetails>(id, "details.json");
    return { ...EMPTY_DETAILS, episodeNumber: episodeNumberFromFileName(job.fileName), ...saved };
  }

  writing(id: string): WritingResult | null {
    const saved = this.readEpisodeFile<WritingResult>(id, "writing.json");
    return saved?.version === 1 ? saved : null;
  }

  /** Save the details and queue show notes (again, if they exist already). */
  write(id: string, details: EpisodeDetails): void {
    const job = this.find(id);
    if (!job || !this.transcript(id)) return;
    if (job.status === "writing" || job.status === "needs-review") return;
    writeJsonAtomic(join(this.episodeDir(id), "details.json"), details);
    Object.assign(job, { status: "writing", stage: "Waiting", error: undefined, failedStep: undefined });
    this.changed();
    this.pump();
  }

  /**
   * Export the episode's documents now. The outcome is recorded on the job
   * (last export, or the error) as well as returned.
   */
  async exportNow(id: string, formats?: ExportFormat[]): Promise<ExportResult> {
    const job = this.find(id);
    const transcript = this.transcript(id);
    const edits = this.edits(id);
    const details = this.details(id);
    if (!job || !transcript || !edits || !details) throw new Error("This episode hasn't been transcribed yet.");
    try {
      const result = await this.deps.exportEpisode({ job, transcript, edits, details, writing: this.writing(id) }, formats);
      Object.assign(job, { exported: { at: new Date().toISOString(), ...result }, exportError: undefined });
      return result;
    } catch (err) {
      job.exportError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.changed();
    }
  }

  /** The audio file behind a job, for playback in review. */
  audioPath(id: string): string | null {
    return this.find(id)?.filePath ?? null;
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  private initialEdits(transcript: Transcript): EpisodeEdits {
    const { cleanup, hosts } = this.deps.reviewOptions();
    const edits = defaultEdits(cleanup, transcript.speakerCount);
    edits.suggestedNames = suggestSpeakers(transcript.words, transcript.speakerCount, hosts);
    return edits;
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

  /** Start the next waiting job if nothing is running. */
  private pump(): void {
    if (this.running) return;
    const next = this.jobs.find((j) => WAITING.has(j.status));
    if (!next) return;
    void this.run(next);
  }

  private async run(job: Job): Promise<void> {
    const abort = new AbortController();
    this.running = { id: job.id, abort };
    this.deps.onBusyChange?.(true);
    const step = job.status === "writing" ? "writing" : "transcription";

    try {
      if (step === "transcription") await this.transcribe(job, abort.signal);
      else await this.writeNotes(job, abort.signal);
    } catch (err) {
      if (err instanceof AbortedError || abort.signal.aborted) {
        if (step === "writing") Object.assign(job, { status: this.afterWritingStops(job.id), stage: undefined });
        else Object.assign(job, { status: "cancelled", stage: undefined, progress: undefined });
      } else {
        Object.assign(job, {
          status: "failed",
          failedStep: step,
          stage: undefined,
          progress: undefined,
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.onEvent?.({ type: "failed", job });
      }
    } finally {
      this.running = null;
      this.changed();
      // Stays busy if more work is waiting, so there's no idle flicker between jobs.
      if (!this.jobs.some((j) => WAITING.has(j.status))) this.deps.onBusyChange?.(false);
      this.pump();
    }
  }

  private async transcribe(job: Job, signal: AbortSignal): Promise<void> {
    Object.assign(job, { status: "transcribing", stage: "Starting", progress: null, error: undefined });
    this.changed();

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
      signal,
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
    // With review off, go straight on to the show notes if a writing key is set.
    const next = needsReview ? "needs-review" : this.deps.canWrite() ? "writing" : "ready";
    Object.assign(job, {
      status: next,
      stage: next === "writing" ? "Waiting" : undefined,
      progress: undefined,
      durationSec: transcript.durationSec,
      wordCount: transcript.words.length,
      speakerCount: transcript.speakerCount,
      finishedAt: new Date().toISOString(),
    });
    this.deps.onEvent?.({ type: "transcribed", job, needsReview });
  }

  private async writeNotes(job: Job, signal: AbortSignal): Promise<void> {
    Object.assign(job, { stage: "Starting", error: undefined });
    this.changed();
    const transcript = this.transcript(job.id);
    const edits = this.edits(job.id);
    const details = this.details(job.id);
    if (!transcript || !edits || !details) throw new Error("This episode's transcript is missing.");

    const result = await this.deps.write({
      transcript,
      edits,
      details,
      signal,
      onStage: (stage) => {
        job.stage = stage;
        this.changed();
      },
    });
    writeJsonAtomic(join(this.episodeDir(job.id), "writing.json"), result);
    Object.assign(job, {
      status: "written",
      stage: undefined,
      episodeNumber: details.episodeNumber.trim() || undefined,
      title: details.title.trim() || result.notes.titleSuggestion || undefined,
      guest: result.guest,
    });
    if (this.deps.autoExport()) {
      try {
        await this.exportNow(job.id);
      } catch {
        // Recorded on the job as exportError; the notes themselves are done.
      }
    }
    this.deps.onEvent?.({ type: "written", job });
  }

  /** Where an episode goes when writing is cancelled: back to its notes if it has some. */
  private afterWritingStops(id: string): Job["status"] {
    return this.writing(id) ? "written" : "ready";
  }

  private readEpisodeFile<T>(id: string, name: string): T | null {
    if (!this.find(id)) return null; // ids come over IPC; only read our own folders
    return (readJson(join(this.episodeDir(id), name)) as T | undefined) ?? null;
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
