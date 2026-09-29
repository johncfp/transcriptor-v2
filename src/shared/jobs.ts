// An episode moving through the pipeline: intake, transcription, review,
// then show notes. Export (M4) adds its own steps.

export type JobStatus =
  /** Found by the folder watcher and waiting for the user to say go (M5). */
  | "awaiting-approval"
  | "queued"
  | "transcribing"
  /** Transcribed; waiting for someone to check speakers and words. */
  | "needs-review"
  /** Reviewed (or review is off); ready for show notes. */
  | "ready"
  /** Show notes queued or being written. */
  | "writing"
  /** Show notes and reference file done. */
  | "written"
  | "failed"
  | "cancelled";

export type JobSource = "manual" | "watch";

export interface Job {
  id: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  source: JobSource;
  status: JobStatus;
  addedAt: string;
  /** Human-readable step while active, e.g. "Uploading to ElevenLabs". */
  stage?: string;
  /** 0–1 while uploading; null while waiting on the provider. */
  progress?: number | null;
  error?: string;
  /** Which step a failed job failed at; retry picks up from there. */
  failedStep?: "transcription" | "writing";
  /** Filled in once transcribed. */
  durationSec?: number;
  wordCount?: number;
  speakerCount?: number;
  finishedAt?: string;
  /** From the show notes, for the episode list and search. */
  episodeNumber?: string;
  title?: string;
  guest?: string | null;
  /** The last export of this episode's documents. */
  exported?: { at: string; folder: string; files: string[] };
  /** Exports go here instead of the Output folder (watched-folder episodes). */
  exportRoot?: string;
  /** Where a watched file was found, relative to the watched folder. */
  watchedPath?: string;
  /** Why the last export failed (the notes themselves are fine). */
  exportError?: string;
}

/** Statuses where the job is done moving and can be removed or retried. */
export const SETTLED: ReadonlySet<JobStatus> = new Set(["needs-review", "ready", "written", "failed", "cancelled"]);

/** Has a transcript on disk. */
export const hasTranscript = (job: Pick<Job, "status" | "failedStep">) =>
  job.status === "needs-review" ||
  job.status === "ready" ||
  job.status === "writing" ||
  job.status === "written" ||
  (job.status === "failed" && job.failedStep === "writing");

/** Audio formats accepted for v2 (audio only, by user decision). */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "webm"] as const;

export function isAudioFile(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

export interface AddFilesResult {
  added: Job[];
  /** Files that weren't queued, with the reason, for a message in the UI. */
  rejected: { fileName: string; reason: string }[];
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${+(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Private URL scheme the main process serves episode audio on (see src/main/media.ts). */
export const MEDIA_SCHEME = "t2-media";
export const audioUrl = (jobId: string) => `${MEDIA_SCHEME}://audio/${encodeURIComponent(jobId)}`;

export type EpisodeStage = "fresh" | "reviewed" | "notesReady";

/**
 * The stage an episode's color shows: fresh until the transcript is
 * reviewed, reviewed until the notes are written, then notes ready. A failed
 * transcription or a cancelled job has no stage color.
 */
export function episodeStage(job: Pick<Job, "status" | "failedStep">): EpisodeStage | null {
  switch (job.status) {
    case "awaiting-approval":
    case "queued":
    case "transcribing":
    case "needs-review":
      return "fresh";
    case "ready":
    case "writing":
      return "reviewed";
    case "written":
      return "notesReady";
    case "failed":
      return job.failedStep === "writing" ? "reviewed" : null;
    case "cancelled":
      return null;
  }
}
