// The transcript as stored on disk (`<userData>/episodes/<id>/transcript.json`).
// This is the raw result from the provider. Cleanup (M2) and review edits are
// layered on top of it rather than rewriting it, so the original is always
// there to compare against.

export interface Word {
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  /** 0-based, numbered in order of first appearance. */
  speaker: number;
  /** 0–1, when the provider reports it (ElevenLabs does, as logprob). */
  confidence?: number;
}

export interface Transcript {
  version: 1;
  provider: string;
  model: string;
  language?: string;
  /** Length of the audio as reported by the provider. */
  durationSec?: number;
  speakerCount: number;
  /** The provider left out false starts before we got the words (ElevenLabs `no_verbatim`). */
  falseStartsRemoved?: boolean;
  words: Word[];
  createdAt: string;
}

export interface Turn {
  speaker: number;
  start: number;
  words: Word[];
}

/** Group consecutive words by the same speaker. */
export function toTurns(words: Word[]): Turn[] {
  const turns: Turn[] = [];
  for (const w of words) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === w.speaker) last.words.push(w);
    else turns.push({ speaker: w.speaker, start: w.start, words: [w] });
  }
  return turns;
}

/** 75 → "01:15", 3725 → "1:02:05". */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
