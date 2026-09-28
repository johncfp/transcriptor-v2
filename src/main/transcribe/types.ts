import type { Transcript } from "../../shared/transcript";

export interface TranscribeRequest {
  filePath: string;
  apiKey: string;
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
