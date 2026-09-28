import type { Transcript, Word } from "../../shared/transcript";
import { AbortedError, postMultipart } from "./multipart";
import type { TranscribeRequest } from "./types";

/**
 * ElevenLabs Scribe speech-to-text.
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * Files up to 5 GB; returns per-word timing, speaker and logprob.
 */
export const ELEVENLABS = {
  label: "ElevenLabs",
  baseUrl: "https://api.elevenlabs.io",
  path: "/v1/speech-to-text",
  model: "scribe_v2",
  maxBytes: 5 * 1024 ** 3,
};

export async function transcribeElevenLabs(req: TranscribeRequest): Promise<Transcript> {
  const label = ELEVENLABS.label;
  req.onProgress?.(`Uploading to ${label}`, 0);

  let result;
  try {
    result = await postMultipart({
      url: (req.baseUrl ?? ELEVENLABS.baseUrl) + ELEVENLABS.path,
      headers: { "xi-api-key": req.apiKey },
      fields: [
        ["model_id", ELEVENLABS.model],
        ["diarize", "true"],
        ["timestamps_granularity", "word"],
        ["tag_audio_events", "false"],
      ],
      file: { field: "file", path: req.filePath },
      // Hold below 100% until the response arrives so the bar never claims done early.
      onUploadProgress: (f) => req.onProgress?.(`Uploading to ${label}`, Math.min(0.99, f)),
      onUploaded: () => req.onProgress?.(`${label} is transcribing`, null),
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    throw new Error(`Couldn't reach ${label}. Check your internet connection and try again.`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(httpErrorMessage(result.status, result.text, label));
  }

  let data: unknown;
  try {
    data = JSON.parse(result.text);
  } catch {
    throw new Error(`${label} sent back a response that couldn't be read.`);
  }

  const transcript = parseElevenLabs(data);
  if (transcript.words.length === 0) {
    throw new Error(`${label} didn't find any speech in this file.`);
  }
  return transcript;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Natural-log probability (−∞…0) to a 0–1 confidence. */
export function logprobToConfidence(logprob: number): number {
  if (!Number.isFinite(logprob)) return logprob > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, Math.exp(logprob)));
}

/**
 * Map a Scribe response to a Transcript. Keeps only `type: "word"` entries
 * (drops spacing and audio events) and renumbers speakers in order of first
 * appearance, so whoever talks first is speaker 0. Exported for tests.
 */
export function parseElevenLabs(data: unknown): Transcript {
  const record = asRecord(data) ?? {};
  const speakerMap = new Map<string, number>();
  const words: Word[] = [];

  for (const raw of Array.isArray(record.words) ? record.words : []) {
    const w = asRecord(raw);
    if (!w || w.type !== "word") continue;
    const text = String(w.text ?? "").trim();
    const start = Number(w.start);
    const end = Number(w.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;

    const speakerKey = typeof w.speaker_id === "string" ? w.speaker_id : "";
    if (!speakerMap.has(speakerKey)) speakerMap.set(speakerKey, speakerMap.size);

    const s = Math.max(0, start);
    const word: Word = { text, start: s, end: Math.max(s, end), speaker: speakerMap.get(speakerKey)! };
    if (typeof w.logprob === "number") word.confidence = logprobToConfidence(w.logprob);
    words.push(word);
  }

  const duration = Number(record.audio_duration_secs);
  return {
    version: 1,
    provider: "elevenlabs",
    model: ELEVENLABS.model,
    language: typeof record.language_code === "string" ? record.language_code : undefined,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : words.at(-1)?.end,
    speakerCount: speakerMap.size,
    words,
    createdAt: new Date().toISOString(),
  };
}

/** A user-facing message for a non-2xx response. Exported for tests. */
export function httpErrorMessage(status: number, bodyText: string, label: string): string {
  if (status === 401 || status === 403) {
    return `${label} rejected the API key (${status}). Check the key in Settings and that it has Speech-to-Text access.`;
  }
  if (status === 429) {
    return `${label} is rate-limiting requests or your plan's quota is used up (429). Try again later.`;
  }
  let detail = "";
  try {
    const body = asRecord(JSON.parse(bodyText));
    const d = body?.detail;
    const nested = asRecord(d);
    if (typeof d === "string") detail = d;
    else if (nested && typeof nested.message === "string") detail = nested.message;
    else if (typeof body?.message === "string") detail = body.message;
  } catch {
    // Not JSON; the status code will have to do.
  }
  const base = `${label} couldn't transcribe this file (${status})`;
  return detail ? `${base}: ${detail}` : `${base}.`;
}
