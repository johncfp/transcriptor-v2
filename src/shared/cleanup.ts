// Transcript cleanup. The raw transcript is never changed: cleanup decides
// which words to hide, and review edits (EpisodeEdits) sit on top. Every
// removal can be seen and undone in the review screen, and nothing here ever
// changes a word; it only drops it.

import type { Transcript, Word } from "./transcript";

export type RemovalReason = "filler" | "repetition" | "fragment" | "manual";

export interface CleanupOptions {
  /** Repeated words/phrases ("the the", "I think I think") and cut-off fragments ("th-"). */
  repetitions: boolean;
}

/**
 * Per-episode review state, saved as `episodes/<id>/edits.json`. Automatic
 * removals aren't stored; they're recomputed from the raw words, so changing
 * the cleanup options applies instantly.
 */
export interface EpisodeEdits {
  version: 1;
  cleanup: CleanupOptions;
  /** Words the reviewer removed by hand. */
  removed: number[];
  /** Automatic removals the reviewer put back. */
  restored: number[];
  /** Corrected spellings, by word index. Only the text changes; timing stays. */
  text: Record<number, string>;
  /** Names set in review, by speaker number; null = not set. */
  speakerNames: (string | null)[];
  /** Names guessed from the transcript, used until the reviewer sets one. */
  suggestedNames: (SpeakerSuggestion | null)[];
}

export interface SpeakerSuggestion {
  name: string;
  role: "host" | "guest";
  /** Why, in words, e.g. "introduces themselves as Nigel". */
  because: string;
}

/** Hesitation sounds only. Words like "like" or "you know" carry meaning too often to cut by rule. */
const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm"]);

/**
 * Single words that are often doubled on purpose ("I know that that works",
 * "it had had", "very very", "no no no"), so a doubled one is left alone.
 */
const INTENTIONAL_DOUBLES = new Set([
  "that", "had", "is", "very", "really", "so", "no", "yeah", "yes", "bye", "ha", "haha", "go", "well", "now", "okay", "ok",
]);

/** Lowercase, without surrounding punctuation; keeps inner apostrophes and hyphens. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

const endsSentence = (text: string) => /[.?!]["'”’)]*$/.test(text);

/** Automatic removals for a transcript, by word index. */
export function autoRemovals(words: Word[], opts: CleanupOptions): Map<number, RemovalReason> {
  const out = new Map<number, RemovalReason>();

  words.forEach((w, i) => {
    if (FILLERS.has(normalize(w.text))) out.set(i, "filler");
  });

  if (opts.repetitions) {
    words.forEach((w, i) => {
      // A cut-off word: "th-", "I-", "wh-". Em dashes ("was—") are left alone,
      // since they usually end a whole word.
      const stem = w.text.replace(/-$/, "");
      if (w.text.endsWith("-") && normalize(stem).length > 0 && normalize(stem).length <= 3) {
        out.set(i, "fragment");
      }
    });

    // Compare what's left after fillers and fragments, so "I, um, I think" counts as a repeat.
    const kept = words.map((_, i) => i).filter((i) => !out.has(i));
    const key = (k: number) => normalize(words[kept[k]!]!.text.replace(/-$/, ""));

    // Longest phrase first, so "I think I think" is one repeat rather than two.
    for (const n of [4, 3, 2, 1]) {
      for (let k = 0; k + 2 * n <= kept.length; k++) {
        const first = kept.slice(k, k + n);
        const second = kept.slice(k + n, k + 2 * n);
        if (first.some((i) => out.has(i))) continue;
        const speaker = words[first[0]!]!.speaker;
        if (![...first, ...second].every((i) => words[i]!.speaker === speaker)) continue;
        if (!first.every((_, j) => key(k + j) !== "" && key(k + j) === key(k + n + j))) continue;
        if (n === 1 && INTENTIONAL_DOUBLES.has(key(k))) continue;
        // "No. No, I didn't": a sentence break between them makes it deliberate.
        if (endsSentence(words[first[n - 1]!]!.text)) continue;
        for (const i of first) out.set(i, "repetition");
      }
    }
  }
  return out;
}

/** Automatic plus manual removals, minus anything the reviewer restored. */
export function removals(transcript: Transcript, edits: EpisodeEdits): Map<number, RemovalReason> {
  const out = autoRemovals(transcript.words, edits.cleanup);
  for (const i of edits.removed) out.set(i, "manual");
  for (const i of edits.restored) out.delete(i);
  return out;
}

export function speakerName(edits: EpisodeEdits, speaker: number): string {
  return edits.speakerNames[speaker] ?? edits.suggestedNames[speaker]?.name ?? `Speaker ${speaker + 1}`;
}

export interface CleanWord {
  /** Index into the raw transcript's words. */
  index: number;
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface CleanTurn {
  speaker: string;
  start: number;
  words: CleanWord[];
}

/**
 * The transcript as it should read after cleanup and review: removed words
 * dropped, corrections applied, and punctuation and capitals repaired where
 * a removal left a gap. Consecutive turns by the same *name* merge, so giving
 * two diarized speakers the same name combines them.
 */
export function cleanTranscript(transcript: Transcript, edits: EpisodeEdits): CleanTurn[] {
  const removed = removals(transcript, edits);
  const turns: CleanTurn[] = [];
  let lastKept: CleanWord | null = null;
  let gap: Word[] = []; // removed words since lastKept

  transcript.words.forEach((w, index) => {
    if (removed.has(index)) {
      gap.push(w);
      return;
    }
    const speaker = speakerName(edits, w.speaker);
    let turn = turns.at(-1);
    if (!turn || turn.speaker !== speaker) {
      turn = { speaker, start: w.start, words: [] };
      turns.push(turn);
      lastKept = null; // a new turn starts a new sentence
    }

    const word: CleanWord = { index, text: edits.text[index] ?? w.text, start: w.start, end: w.end };
    if (w.confidence !== undefined) word.confidence = w.confidence;

    if (gap.length) {
      const gapEnd = gap.at(-1)!.text;
      // "and, um." → "and." : keep the sentence end the removal took with it.
      const moved = gapEnd.match(/[.?!]+$/)?.[0];
      const prev: CleanWord | null = lastKept;
      if (moved && prev && !endsSentence(prev.text)) prev.text = prev.text.replace(/[,;:]+$/, "") + moved;
      // "Um, so we" → "So we" : the sentence now starts at this word.
      const sentenceStart = !prev || endsSentence(prev.text);
      const removedWasCapitalized = /^\p{Lu}/u.test(gap[0]!.text);
      if (sentenceStart && removedWasCapitalized) word.text = capitalize(word.text);
    }
    gap = [];
    turn.words.push(word);
    lastKept = word;
  });

  // Trailing removals at the very end ("…great. Um.") need no repair: the last kept word stands.
  return turns;
}

const capitalize = (s: string) => s.replace(/^(\P{L}*)(\p{Ll})/u, (_, pre: string, c: string) => pre + c.toUpperCase());

export function defaultEdits(cleanup: CleanupOptions, speakerCount: number): EpisodeEdits {
  return {
    version: 1,
    cleanup,
    removed: [],
    restored: [],
    text: {},
    speakerNames: Array(speakerCount).fill(null),
    suggestedNames: Array(speakerCount).fill(null),
  };
}

/** Counts by reason, for the review summary. */
export function removalCounts(map: Map<number, RemovalReason>): Record<RemovalReason, number> {
  const counts: Record<RemovalReason, number> = { filler: 0, repetition: 0, fragment: 0, manual: 0 };
  for (const r of map.values()) counts[r]++;
  return counts;
}

/**
 * True when `edited` is `original` with words only taken out: same words,
 * same order, nothing added or changed. The AI false-start pass (M3) must
 * pass this check or its edit is thrown away. Compared on normalized words,
 * so punctuation and capitals may differ.
 */
export function isDeletionOnly(original: string[], edited: string[]): boolean {
  const a = original.map(normalize).filter(Boolean);
  const b = edited.map(normalize).filter(Boolean);
  let i = 0;
  for (const word of b) {
    while (i < a.length && a[i] !== word) i++;
    if (i === a.length) return false;
    i++;
  }
  return true;
}

export interface ReviewWord {
  index: number;
  /** As it reads after cleanup and corrections (for kept words), or the raw text (for removed ones). */
  text: string;
  removed?: RemovalReason;
  edited: boolean;
  confidence?: number;
}

export interface ReviewTurn {
  speaker: string;
  start: number;
  words: ReviewWord[];
}

/**
 * Every word, kept or removed, for the review screen. With `includeRemoved`
 * off it groups exactly like cleanTranscript, so the reviewer sees the
 * text that will be exported.
 */
export function reviewTurns(transcript: Transcript, edits: EpisodeEdits, includeRemoved: boolean): ReviewTurn[] {
  const removed = removals(transcript, edits);
  const cleanText = new Map<number, string>();
  for (const turn of cleanTranscript(transcript, edits)) for (const w of turn.words) cleanText.set(w.index, w.text);

  const turns: ReviewTurn[] = [];
  transcript.words.forEach((w, index) => {
    const reason = removed.get(index);
    if (reason && !includeRemoved) return;
    const speaker = speakerName(edits, w.speaker);
    let turn = turns.at(-1);
    if (!turn || turn.speaker !== speaker) {
      turn = { speaker, start: w.start, words: [] };
      turns.push(turn);
    }
    const word: ReviewWord = {
      index,
      text: reason ? (edits.text[index] ?? w.text) : cleanText.get(index)!,
      edited: index in edits.text,
    };
    if (reason) word.removed = reason;
    if (w.confidence !== undefined) word.confidence = w.confidence;
    turn.words.push(word);
  });
  return turns;
}

/** Remove a kept word, or put back a removed one, whichever applies. */
export function toggleRemoved(transcript: Transcript, edits: EpisodeEdits, index: number): EpisodeEdits {
  const isRemoved = removals(transcript, edits).has(index);
  const isAuto = autoRemovals(transcript.words, edits.cleanup).has(index);
  const without = (list: number[]) => list.filter((i) => i !== index);
  if (isRemoved) {
    return edits.removed.includes(index)
      ? { ...edits, removed: without(edits.removed) }
      : { ...edits, restored: [...edits.restored, index] };
  }
  return isAuto && edits.restored.includes(index)
    ? { ...edits, restored: without(edits.restored) }
    : { ...edits, removed: [...edits.removed, index] };
}
