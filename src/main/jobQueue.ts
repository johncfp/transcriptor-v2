import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultEdits, type CleanupOptions, type EpisodeEdits } from "../shared/cleanup";
import { formatBytes, isAudioFile, SETTLED, type AddFilesResult, type Job, type JobSource } from "../shared/jobs";
import { providerById } from "../shared/providers";
import type { SocialResult } from "../shared/clips";
import type { SubtitleTranslations } from "../shared/subtitleTranslation";
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

export interface SuggestRequest {
  transcript: Transcript;
  edits: EpisodeEdits;
  /** The episode's show notes, if written. */
  writing: WritingResult | null;
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
  /** Social clips, if suggested; the kept ones are exported. */
  social: SocialResult | null;
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
  /**
   * Write the episode's documents to disk; `formats` overrides the Settings
   * default. `clipsOnly` writes just the kept clips (with their videos, when
   * video clips are on) and their document, reporting progress on the videos.
   */
  exportEpisode: (
    data: EpisodeExportData,
    formats?: ExportFormat[],
    opts?: { clipsOnly?: boolean; onProgress?: (p: { done: number; total: number }) => void; signal?: AbortSignal },
  ) => Promise<ExportResult>;
  /** Export as soon as show notes are written. */
  autoExport: () => boolean;
  /** Suggests social clips with the configured provider; throws a readable error if it can't. */
  suggest?: (req: SuggestRequest) => Promise<SocialResult>;
  /** True when social clips are switched on and their provider has a key, so they follow the notes. */
  autoSocial?: () => boolean;
  /** Every change, including progress ticks. */
  onChange?: (jobs: Job[]) => void;
  /** A job reached a state the user should hear about. */
  onEvent?: (event: JobEvent) => void;
  /** Called with true while a job is running, false when the queue goes idle. */
  onBusyChange?: (busy: boolean) => void;
  /** Right before a job is transcribed: a reason to skip it instead, or null to go ahead. */
  beforeTranscribe?: (job: Job) => Promise<string | null>;
}

/** Stops a job before transcription without counting as a failure. */
class SkippedError extends Error {}

export type JobEvent =
  | { type: "awaiting-approval"; job: Job }
  | { type: "transcribed"; job: Job; needsReview: boolean }
  | { type: "written"; job: Job }
  | { type: "failed"; job: Job }
  | { type: "clips-ready"; job: Job }
  | { type: "clips-failed"; job: Job };

/** Statuses that have work waiting for the runner. */
const WAITING = new Set<Job["status"]>(["queued", "writing"]);

type Step = "transcription" | "writing" | "social";

/**
 * Episodes moving through transcription and show-note writing. Runs one
 * piece of work at a time in the main process, so it continues with the
 * window closed. The list is saved to `jobs.json` on every status change,
 * so a crash or restart picks up where it left off.
 */
export class JobQueue {
  private jobs: Job[];
  private readonly path: string;
  private running: { id: string; step: Step; abort: AbortController } | null = null;
  /** Clip exports in progress, by job id, so they can be cancelled. */
  private readonly clipExports = new Map<string, AbortController>();
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
      // Social clips that were being suggested start over.
      if (job.social?.status === "running") job.social = { status: "queued", stage: "Waiting" };
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
    if (!job || this.running?.id === id) return;
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
    // Not while clips are being picked from the current notes.
    if (job.social?.status === "running") return;
    writeJsonAtomic(join(this.episodeDir(id), "details.json"), details);
    Object.assign(job, { status: "writing", stage: "Waiting", error: undefined, failedStep: undefined });
    this.changed();
    this.pump();
  }

  /** The episode's suggested social clips, if any. */
  social(id: string): SocialResult | null {
    const saved = this.readEpisodeFile<SocialResult>(id, "social.json");
    return saved?.version === 1 ? saved : null;
  }

  /** The episode's translated subtitles, kept so each language is translated once (see src/shared/subtitleTranslation.ts). */
  subtitleTranslations(id: string): SubtitleTranslations | null {
    const saved = this.readEpisodeFile<SubtitleTranslations>(id, "subtitles.json");
    return saved?.version === 1 ? saved : null;
  }

  saveSubtitleTranslations(id: string, saved: SubtitleTranslations): void {
    if (this.find(id)) writeJsonAtomic(join(this.episodeDir(id), "subtitles.json"), saved);
  }

  /** Save clips changed in review; ignored while new ones are being suggested. */
  saveSocial(id: string, result: SocialResult): void {
    const job = this.find(id);
    if (!job || job.social?.status === "queued" || job.social?.status === "running") return;
    writeJsonAtomic(join(this.episodeDir(id), "social.json"), result);
  }

  /** Queue social clips for an episode with show notes (again, if it has some). */
  suggestClips(id: string): void {
    const job = this.find(id);
    if (!job || job.status !== "written" || !this.deps.suggest) return;
    if (job.social?.status === "queued" || job.social?.status === "running") return;
    job.social = { status: "queued", stage: "Waiting" };
    this.changed();
    this.pump();
  }

  /** Stop suggesting clips; any clips from before stay. */
  cancelSocial(id: string): void {
    const job = this.find(id);
    if (!job?.social || (job.social.status !== "queued" && job.social.status !== "running")) return;
    if (this.running?.id === id && this.running.step === "social") {
      this.running.abort.abort(); // the runner settles the state
      return;
    }
    job.social = this.socialAfterStop(id);
    this.changed();
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
      const result = await this.deps.exportEpisode(
        { job, transcript, edits, details, writing: this.writing(id), social: this.social(id) },
        formats,
      );
      Object.assign(job, { exported: { at: new Date().toISOString(), ...result }, exportError: undefined });
      return result;
    } catch (err) {
      job.exportError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.changed();
    }
  }

  /**
   * Export just the kept clips: their audio and the Social Clips document.
   * Recorded on the job's social state as well as returned.
   */
  async exportClips(id: string): Promise<ExportResult> {
    const job = this.find(id);
    const transcript = this.transcript(id);
    const edits = this.edits(id);
    const details = this.details(id);
    const social = this.social(id);
    if (!job?.social || !transcript || !edits || !details || !social) throw new Error("This episode has no clips yet.");
    if (!social.clips.some((c) => c.kept)) throw new Error("Keep at least one clip to export.");
    if (this.clipExports.has(id)) throw new Error("These clips are already being exported.");
    const state = job.social;
    const abort = new AbortController();
    this.clipExports.set(id, abort);
    Object.assign(state, { exportError: undefined });
    try {
      const result = await this.deps.exportEpisode({ job, transcript, edits, details, writing: this.writing(id), social }, undefined, {
        clipsOnly: true,
        signal: abort.signal,
        onProgress: (p) => {
          state.exporting = p;
          this.progressed();
        },
      });
      Object.assign(state, { exported: { at: new Date().toISOString(), ...result }, exportError: undefined });
      return result;
    } catch (err) {
      state.exportError = err instanceof AbortedError ? "Export cancelled." : err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.clipExports.delete(id);
      delete state.exporting;
      this.changed();
    }
  }

  /** Stop exporting an episode's clips (the videos can take a while); nothing half-made is kept. */
  cancelClipsExport(id: string): void {
    this.clipExports.get(id)?.abort();
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

  /** The next job with work waiting: transcription and notes first, then social clips. */
  private nextJob(): Job | undefined {
    return this.jobs.find((j) => WAITING.has(j.status)) ?? this.jobs.find((j) => j.social?.status === "queued");
  }

  /** Start the next waiting job if nothing is running. */
  private pump(): void {
    if (this.running) return;
    const next = this.nextJob();
    if (!next) return;
    void this.run(next);
  }

  private async run(job: Job): Promise<void> {
    const abort = new AbortController();
    const step: Step = job.status === "writing" ? "writing" : job.status === "queued" ? "transcription" : "social";
    this.running = { id: job.id, step, abort };
    this.deps.onBusyChange?.(true);

    try {
      if (step === "transcription") await this.transcribe(job, abort.signal);
      else if (step === "writing") await this.writeNotes(job, abort.signal);
      else await this.runSocial(job, abort.signal);
    } catch (err) {
      if (step === "social") {
        // The notes are untouched either way; only the social state changes.
        if (err instanceof AbortedError || abort.signal.aborted) job.social = this.socialAfterStop(job.id);
        else {
          job.social = { status: "failed", error: err instanceof Error ? err.message : String(err) };
          this.deps.onEvent?.({ type: "clips-failed", job });
        }
      } else if (err instanceof SkippedError) {
        Object.assign(job, { status: "cancelled", stage: undefined, progress: undefined, error: err.message });
      } else if (err instanceof AbortedError || abort.signal.aborted) {
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
      if (!this.nextJob()) this.deps.onBusyChange?.(false);
      this.pump();
    }
  }

  private async transcribe(job: Job, signal: AbortSignal): Promise<void> {
    Object.assign(job, { status: "transcribing", stage: "Starting", progress: null, error: undefined });
    this.changed();
    const skip = await this.deps.beforeTranscribe?.(job);
    if (skip) throw new SkippedError(skip);

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
    // Clips follow the first notes; after that they're suggested again only when asked.
    if (this.deps.suggest && this.deps.autoSocial?.() && !job.social && !this.social(job.id)) {
      job.social = { status: "queued", stage: "Waiting" };
    }
    this.deps.onEvent?.({ type: "written", job });
  }

  private async runSocial(job: Job, signal: AbortSignal): Promise<void> {
    job.social = { status: "running", stage: "Starting" };
    this.changed();
    const transcript = this.transcript(job.id);
    const edits = this.edits(job.id);
    if (!transcript || !edits) throw new Error("This episode's transcript is missing.");
    if (!this.deps.suggest) throw new Error("Social clips aren't available.");

    const result = await this.deps.suggest({
      transcript,
      edits,
      writing: this.writing(job.id),
      signal,
      onStage: (stage) => {
        if (job.social) job.social.stage = stage;
        this.changed();
      },
    });
    writeJsonAtomic(join(this.episodeDir(job.id), "social.json"), result);
    job.social = { status: "done", clipCount: result.clips.length };
    this.deps.onEvent?.({ type: "clips-ready", job });
  }

  /** Where social clips go when stopped: back to the saved clips if there are some. */
  private socialAfterStop(id: string): Job["social"] {
    const saved = this.social(id);
    return saved ? { status: "done", clipCount: saved.clips.length } : undefined;
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
