// Messages between the main process and the hidden clip cutter page.

export const CUTTER_IPC = {
  /** Main → page: a job to run. */
  job: "cutter:job",
  /** Page → main: read bytes [start, end) of the job's audio. */
  read: "cutter:read",
  /** Page → main: the job's result. */
  done: "cutter:done",
  /** Page → main: loaded and listening. */
  ready: "cutter:ready",
} as const;

export interface CutJob {
  id: string;
  /** Size of the audio file in bytes. */
  size: number;
  /** Where to cut, in seconds. */
  clips: { start: number; end: number }[];
}

/** One WAV per clip, in order; or why it failed. */
export type CutResult = { clips: Uint8Array[]; error?: undefined } | { error: string; clips?: undefined };
