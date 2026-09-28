import { ELEVENLABS, transcribeElevenLabs } from "./elevenlabs";
import type { Transcriber } from "./types";

/**
 * The transcription engine used for new jobs. ElevenLabs is the only one for
 * now: OpenAI's endpoint caps uploads at 25 MB and can't return speakers and
 * word timings together, which rules it out for full episodes without
 * splitting the audio first.
 */
export const transcriber: Transcriber = {
  providerId: "elevenlabs",
  label: ELEVENLABS.label,
  maxBytes: ELEVENLABS.maxBytes,
  transcribe: transcribeElevenLabs,
};

export { AbortedError } from "./multipart";
