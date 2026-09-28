import type { Transcript } from "../../shared/transcript";

export interface TranscribeRequest {
  filePath: string;
  apiKey: string;
  /**
   * Ask the provider to leave out false starts (and filler words) itself.
   * For ElevenLabs this is `no_verbatim`. It can't be reviewed or undone,
   * because the words never reach us.
   */
  removeFalseStarts?: boolean;
  /** Overrides the provider's API origin. Used by tests. */
  baseUrl?: string;
  /** A step label and 0–1 progress, or null when there's no way to measure it. */
  onProgress?: (stage: string, progress: number | null) => void;
  signal?: AbortSignal;
}

export interface Transcriber {
  /** Which saved key to use (a provider id from src/shared/providers.ts). */
  providerId: string;
  label: string;
  maxBytes: number;
  transcribe(req: TranscribeRequest): Promise<Transcript>;
}
