// Subtitles: the reviewed transcript as timed cues, written as SRT or WebVTT.
// No AI here: the words, their order and their times all come from the
// cleaned transcript, so a cue shows exactly what's said while it's said.
// Cue shape follows the usual broadcast guidance: two lines of at most 42
// characters, on screen for 5/6 of a second to 7 seconds.

import type { CleanTurn } from "./cleanup";

export interface Cue {
  /** Seconds from the start of the episode. */
  start: number;
  end: number;
  /** One or two lines. */
  lines: string[];
}

export const SUBTITLE_LIMITS = {
  lineChars: 42,
  lines: 2,
  /** Longest a cue stays up, and the shortest. */
  maxSec: 7,
  minSec: 0.833,
  /** A pause this long starts a new cue. */
  pauseSec: 1,
  /** A cue may stay this long after its last word, if the next one hasn't started. */
  tailSec: 0.5,
  /** Always this much between one cue and the next. */
  gapSec: 0.05,
} as const;

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

const endsSentence = (text: string) => /[.?!…]["'”’)]*$/.test(text);
const endsClause = (text: string) => /[,;:—–]["'”’)]*$/.test(text);
const joined = (ws: TimedWord[]) => ws.map((w) => w.text).join(" ");

/**
 * Group the transcript's words into cues. A cue holds one speaker, except a
 * quick reply sharing a cue with the line it answers (see
 * mergeInterjections), and a new one starts after a long pause, when the text would run past two lines,
 * or when it would stay up too long. Cues end at a sentence once they hold a
 * line's worth; when one has to be cut mid-sentence, it's cut after a comma
 * where there is one in its second half, so lines read as phrases.
 */
export function buildCues(turns: CleanTurn[], limits = SUBTITLE_LIMITS): Cue[] {
  // Fits when it splits into the allowed lines, each within the limit (a total under 84 characters can still fail to).
  const fits = (ws: TimedWord[]) => {
    const lines = splitLines(joined(ws), limits.lineChars);
    return lines.length <= limits.lines && lines.every((l) => l.length <= limits.lineChars);
  };
  const groups: { speaker: string; words: TimedWord[] }[] = [];
  for (const turn of turns) {
    let cur: TimedWord[] = [];
    const close = (keep: TimedWord[] = []) => {
      if (cur.length) groups.push({ speaker: turn.speaker, words: cur });
      cur = keep;
    };
    for (const w of turn.words) {
      const prev = cur.at(-1);
      if (prev) {
        const tooLong = !fits([...cur, w]) || w.end - cur[0]!.start > limits.maxSec;
        if (w.start - prev.end >= limits.pauseSec) close();
        else if (tooLong) {
          // Cut after the last comma in the cue's second half, if any; the rest starts the next cue.
          const text = joined(cur);
          let cut = -1;
          for (let i = cur.length - 2; i >= 0; i--) {
            if (endsClause(cur[i]!.text) && joined(cur.slice(0, i + 1)).length >= text.length * 0.4) {
              cut = i;
              break;
            }
          }
          if (cut >= 0) {
            const rest = cur.slice(cut + 1);
            cur = cur.slice(0, cut + 1);
            close(rest);
          } else close();
        }
      }
      cur.push(w);
      if (endsSentence(w.text) && joined(cur).length >= limits.lineChars) close();
    }
    close();
  }

  // Times: from the first word to the last, held a little longer and at least minSec when
  // there's room, ending a moment before the next cue. Where speakers overlap there may be
  // no room; a cue still gets a short time on screen, overlapping the next.
  const cues = mergeInterjections(groups, limits.lineChars);
  cues.forEach((c, i) => {
    const room = (cues[i + 1]?.start ?? Infinity) - limits.gapSec;
    const wanted = Math.min(Math.max(c.end + limits.tailSec, c.start + limits.minSec), c.start + limits.maxSec);
    c.end = round(Math.max(Math.min(wanted, room), c.start + MIN_SHOWN_SEC));
    c.start = round(c.start);
  });
  return cues;
}

/** A quick reply over someone else ("Yeah.", "Right"): a few words, said briefly. */
const isInterjection = (ws: TimedWord[]) => ws.length <= 3 && ws.at(-1)!.end - ws[0]!.start <= 1.5;

/**
 * Cues from the word groups. A quick reply said over or right next to
 * another speaker's line shares that line's cue, one line each with a dash,
 * as subtitles do for exchanges ("- Yeah." / "- And I would tell him,"), so
 * it doesn't flash up on its own. Where the other line is too long to share,
 * the reply keeps its own cue, overlapping, and players show both.
 */
function mergeInterjections(groups: { speaker: string; words: TimedWord[] }[], lineChars: number): Cue[] {
  const cues: Cue[] = [];
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i]!, b = groups[i + 1];
    if (b && a.speaker !== b.speaker && (isInterjection(a.words) || isInterjection(b.words))) {
      const ta = joined(a.words), tb = joined(b.words);
      const close = b.words[0]!.start - a.words.at(-1)!.end < 0.3;
      if (close && ta.length + 2 <= lineChars && tb.length + 2 <= lineChars) {
        cues.push({ start: a.words[0]!.start, end: Math.max(a.words.at(-1)!.end, b.words.at(-1)!.end), lines: [`- ${ta}`, `- ${tb}`] });
        i++;
        continue;
      }
    }
    cues.push({ start: a.words[0]!.start, end: a.words.at(-1)!.end, lines: splitLines(joined(a.words), lineChars) });
  }
  return cues;
}

/**
 * One line if it fits, otherwise two, split at the space that balances them
 * best; a break after punctuation is preferred when it's nearly as balanced.
 */
export function splitLines(text: string, lineChars: number = SUBTITLE_LIMITS.lineChars): string[] {
  if (text.length <= lineChars) return [text];
  let best: { at: number; score: number } | null = null;
  for (let i = text.indexOf(" "); i > 0; i = text.indexOf(" ", i + 1)) {
    const a = i, b = text.length - i - 1;
    const over = Math.max(0, a - lineChars) + Math.max(0, b - lineChars);
    const punct = /[,.;:?!—–]$/.test(text.slice(0, i)) ? 4 : 0;
    const score = over * 100 + Math.abs(a - b) - punct;
    if (!best || score < best.score) best = { at: i, score };
  }
  return best ? [text.slice(0, best.at), text.slice(best.at + 1)] : [text];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The least time a cue is shown, even when the next one starts straight away. */
const MIN_SHOWN_SEC = 0.3;

/** 3723.4 → "01:02:03,400" (SRT) or "01:02:03.400" (WebVTT). */
export function cueTime(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

/** SubRip: numbered cues, blank lines between them, CRLF line endings for the players that insist. */
export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => [String(i + 1), `${cueTime(c.start, ",")} --> ${cueTime(c.end, ",")}`, ...c.lines].join("\r\n")).join("\r\n\r\n") + "\r\n";
}

/** WebVTT, as YouTube and browsers read it. */
export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => [`${cueTime(c.start, ".")} --> ${cueTime(c.end, ".")}`, ...c.lines].join("\n")).join("\n\n")}\n`;
}

export const SUBTITLE_FORMATS = ["srt", "vtt"] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];

/** Language names for transcript language codes (ElevenLabs gives ISO 639-3, e.g. "eng"), for file names. */
const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English",
  en: "English",
  spa: "Spanish",
  es: "Spanish",
  por: "Portuguese",
  pt: "Portuguese",
  fra: "French",
  fre: "French",
  fr: "French",
  deu: "German",
  ger: "German",
  de: "German",
  cmn: "Mandarin",
  zho: "Mandarin",
  chi: "Mandarin",
  zh: "Mandarin",
};

export const languageName = (code: string | undefined) => (code && LANGUAGE_NAMES[code.toLowerCase()]) || (code ? code : "Original");

/** "Episode 386 - Subtitles (English).srt" */
export function subtitleFileName(base: string, language: string, format: SubtitleFormat): string {
  return `${base} - Subtitles (${language}).${format}`;
}
