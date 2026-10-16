// Messages between the main process and the hidden clip cutter page.

import type { VideoSettings } from "./settings";
import type { CaptionWord, ShapeId } from "./video";

export const CUTTER_IPC = {
  /** Main → page: a job to run. */
  job: "cutter:job",
  /** Page → main: read bytes [start, end) of the job's audio. */
  read: "cutter:read",
  /** Page → main: how far a video job has got. */
  progress: "cutter:progress",
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
  /** Also make each clip into videos (see VideoJob); absent = WAVs only. */
  video?: VideoJob;
}

/** What the videos need beyond the audio: the look, and each clip's captions and shapes. */
export interface VideoJob {
  style: VideoSettings;
  showName: string;
  /** From the show profile, for the outro card. */
  website: string;
  /** From the show profile, so name cards can say Host or Guest. */
  hosts: string[];
  /** Image file bytes (PNG or JPEG), or null for none. */
  logo: Uint8Array | null;
  background: Uint8Array | null;
  /** Per clip, in the same order as CutJob.clips. */
  clips: { words: CaptionWord[]; shapes: ShapeId[] }[];
}

/** Video frames rendered so far, of all the job's videos. */
export interface CutProgress {
  done: number;
  total: number;
}

/**
 * One WAV per clip, in order, and with a video job, one MP4 per clip and
 * shape (videos[clip][shape], shapes in the order asked). Or why it failed.
 */
export type CutResult =
  | { clips: Uint8Array[]; videos?: Uint8Array[][]; error?: undefined }
  | { error: string; clips?: undefined; videos?: undefined };
