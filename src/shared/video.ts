// Video clips: a kept clip as an MP4 with its audio and captions. This file
// holds the choices in Settings and the caption layout, which is pure so it's
// tested here and drawn by src/renderer/src/video/drawFrame.ts (the Settings
// preview, the Clips tab and the export all use that one drawing code).

/** Frames per second; fixed. */
export const VIDEO_FPS = 30;

export const SHAPES = [
  { id: "vertical", label: "Vertical 9:16", hint: "Reels, TikTok, Shorts", width: 1080, height: 1920 },
  { id: "square", label: "Square 1:1", hint: "Feed posts", width: 1080, height: 1080 },
  { id: "wide", label: "Wide 16:9", hint: "YouTube, LinkedIn", width: 1920, height: 1080 },
] as const;
export type ShapeId = (typeof SHAPES)[number]["id"];

export const CAPTION_STYLES = [
  { id: "highlight", label: "Word by word", hint: "A few lines at a time, the word being said highlighted." },
  { id: "scroll", label: "Scrolling lines", hint: "Lines move up as they're spoken." },
] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number]["id"];

/** Bundled fonts, all under the SIL Open Font License (see THIRD_PARTY_NOTICES). */
export const VIDEO_FONTS = [
  { id: "inter", label: "Inter", family: "T2 Inter", hint: "Clean and neutral, made for screens." },
  { id: "atkinson", label: "Atkinson Hyperlegible Next", family: "T2 Atkinson", hint: "Letters that are hard to mix up, for low vision and small screens." },
  { id: "lexend", label: "Lexend", family: "T2 Lexend", hint: "Wide letters that are easy to read quickly." },
] as const;
export type VideoFontId = (typeof VIDEO_FONTS)[number]["id"];
export const videoFont = (id: VideoFontId) => VIDEO_FONTS.find((f) => f.id === id) ?? VIDEO_FONTS[0];

export const CAPTION_SIZES = [
  { id: "small", label: "Small", scale: 0.82 },
  { id: "medium", label: "Medium", scale: 1 },
  { id: "large", label: "Large", scale: 1.2 },
] as const;
export type CaptionSize = (typeof CAPTION_SIZES)[number]["id"];

export const WAVEFORM_STYLES = [
  { id: "pulse", label: "Pulse", hint: "Bars either side of the middle that pulse with the voice." },
  { id: "history", label: "Rolling", hint: "The last moments of sound roll in from the right." },
] as const;
export type WaveformStyle = (typeof WAVEFORM_STYLES)[number]["id"];

export const BACKGROUND_TYPES = ["color", "image"] as const;
export type BackgroundType = (typeof BACKGROUND_TYPES)[number];

/** An imported background image's file name (see src/main/background.ts). */
export const BACKGROUND_FILE = /^background-\d+\.jpg$/;

import type { CleanTurn } from "./cleanup";

// ---------------------------------------------------------------------------
// Caption layout

export interface CaptionWord {
  text: string;
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  speaker: string;
}

export interface CaptionLine {
  words: CaptionWord[];
  speaker: string;
  start: number;
  end: number;
}

export interface CaptionPage {
  lines: CaptionLine[];
  speaker: string;
  start: number;
  end: number;
}

/**
 * Break the words into lines no wider than `maxWidth` (as `measure` reports
 * a piece of text). A new speaker always starts a new line; a word too wide
 * for any line gets a line of its own.
 */
export function breakLines(words: CaptionWord[], measure: (text: string) => number, maxWidth: number): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let current: CaptionWord[] = [];
  const close = () => {
    if (current.length) lines.push({ words: current, speaker: current[0]!.speaker, start: current[0]!.start, end: current.at(-1)!.end });
    current = [];
  };
  for (const w of words) {
    const text = [...current, w].map((x) => x.text).join(" ");
    if (current.length && (w.speaker !== current[0]!.speaker || measure(text) > maxWidth)) close();
    current.push(w);
  }
  close();
  return lines;
}

/** Group lines into pages of up to `perPage` lines; a new speaker starts a new page. */
export function pageLines(lines: CaptionLine[], perPage: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  for (const line of lines) {
    const page = pages.at(-1);
    if (page && page.lines.length < perPage && page.speaker === line.speaker) {
      page.lines.push(line);
      page.end = line.end;
    } else pages.push({ lines: [line], speaker: line.speaker, start: line.start, end: line.end });
  }
  return pages;
}

/** Captions show a moment before their first word, and stay up until the next ones. */
export const LEAD_IN_SEC = 0.25;

/** The page on screen at `t`: each stays up until the next one's lead-in; null before the first. */
export function pageAt(pages: CaptionPage[], t: number): CaptionPage | null {
  let shown: CaptionPage | null = null;
  for (const p of pages) {
    if (t >= p.start - LEAD_IN_SEC) shown = p;
    else break;
  }
  return shown;
}

/** How long a scroll to the next line takes. */
export const SCROLL_SEC = 0.25;

/**
 * Scrolling captions: which line is at the reading position at `t`, as a
 * fraction while one line slides up into the next. 0 before the first line.
 */
export function scrollAt(lines: CaptionLine[], t: number): number {
  let at = 0;
  for (let i = 1; i < lines.length; i++) {
    const begin = lines[i]!.start - SCROLL_SEC;
    if (t >= lines[i]!.start) at = i;
    else if (t > begin) return i - 1 + (t - begin) / SCROLL_SEC;
    else break;
  }
  return at;
}

/** Where a word stands at `t`: already said, being said, or still to come. */
export function wordState(w: CaptionWord, t: number): "said" | "now" | "ahead" {
  if (t < w.start) return "ahead";
  // A short hold, so quick words don't flicker.
  return t < Math.max(w.end, w.start + 0.12) ? "now" : "said";
}

// ---------------------------------------------------------------------------
// Motion. Everything here is a function of the time in the clip, so a frame
// drawn for the preview is the same frame the export draws.

/** Timings, in seconds. */
export const MOTION = {
  /** Hook: each word fades in this long after the one before it… */
  hookStagger: 0.12,
  hookWordIn: 0.3,
  /** …the quote stays up until here, then lifts away; the logo and show name come back as it goes. */
  hookHold: 2.8,
  hookOut: 0.4,
  headerDelay: 0.25,
  headerIn: 0.4,
  /** Word pop: how long the bump lasts, and how much bigger the word gets at its peak. */
  popSec: 0.28,
  popScale: 0.13,
  /** Outro card: how long it stays after the audio ends, and how long it takes to come in. */
  outroSec: 2.5,
  outroIn: 0.45,
} as const;

/**
 * Whether a video gets the outro card: it's on, and there's a show name or a
 * website to point to. The video then runs MOTION.outroSec past the audio,
 * with silence under the card.
 */
export function hasOutro(style: { motion: { outro: boolean } }, showName: string, website: string): boolean {
  return style.motion.outro && !!(showName.trim() || website.trim());
}

/** How long the video runs, for audio of `audioSec` seconds. */
export function videoSeconds(audioSec: number, outro: boolean): number {
  return audioSec + (outro ? MOTION.outroSec : 0);
}

/** How far the outro card has come in at `t` (0 before the audio ends, 1 once it's up). */
export function outroIn(t: number, audioSec: number): number {
  return easeOut((t - audioSec) / MOTION.outroIn);
}

/** The outro's lines: a small one above, the show (or website) big, the website small below. */
export function outroLines(showName: string, website: string): { above: string; big: string; below: string } {
  const name = showName.trim(), site = website.trim();
  return name ? { above: "Full episode on", big: name, below: site } : { above: "Full episode at", big: site, below: "" };
}

/** Ease out: fast start, gentle stop. Clamped to 0–1. */
export function easeOut(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return 1 - (1 - c) ** 3;
}

/** Ease in and out, for movements that start and stop at rest. Clamped to 0–1. */
export function easeInOut(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c < 0.5 ? 4 * c ** 3 : 1 - (-2 * c + 2) ** 3 / 2;
}

const MIN_HOOK_WORDS = 3;
const MAX_HOOK_WORDS = 10;

/**
 * The hook: a short quote shown at the start of the video, word for word from
 * the clip's captions. Until the clip model picks one (M8d), it's the clip's
 * shortest whole sentence of 3–10 words by one speaker, not counting the first
 * sentence (that one is heard straight away, so it wouldn't tease anything).
 * Ties go to the earlier sentence. Null when no sentence fits.
 */
export function hookQuote(words: CaptionWord[]): CaptionWord[] | null {
  const ends = (w: CaptionWord) => /[.!?]["'”’)]*$/.test(w.text);
  const sentences: { words: CaptionWord[]; whole: boolean }[] = [];
  const lastBy = new Map<string, CaptionWord>();
  let current: CaptionWord[] = [];
  let clean = true;
  for (const w of words) {
    // Someone else cutting in breaks the sentence; what follows picks up mid-sentence.
    if (current.length && w.speaker !== current[0]!.speaker) {
      sentences.push({ words: current, whole: false });
      current = [];
    }
    if (!current.length) {
      const before = lastBy.get(w.speaker);
      clean = !before || ends(before);
    }
    current.push(w);
    lastBy.set(w.speaker, w);
    if (ends(w)) {
      sentences.push({ words: current, whole: clean });
      current = [];
    }
  }
  let best: CaptionWord[] | null = null;
  for (const s of sentences.slice(1)) {
    if (!s.whole || s.words.length < MIN_HOOK_WORDS || s.words.length > MAX_HOOK_WORDS) continue;
    if (!best || s.words.length < best.length) best = s.words;
  }
  return best;
}

/** How far each hook word has faded in at `t`, times how much of the hook is still up (0–1). */
export function hookWordAlpha(index: number, t: number): number {
  return easeOut((t - index * MOTION.hookStagger) / MOTION.hookWordIn) * (1 - hookOut(t));
}

/** How far the hook has lifted away (0 while it's up, 1 once it's gone). */
export function hookOut(t: number): number {
  return easeOut((t - MOTION.hookHold) / MOTION.hookOut);
}

/** How far the logo and show name have faded back in after the hook (0–1); they start once the quote is mostly gone. */
export function headerIn(t: number): number {
  return easeOut((t - MOTION.hookHold - MOTION.headerDelay) / MOTION.headerIn);
}

/** When the hook is gone and the logo and show name are fully back. */
export const HOOK_END = MOTION.hookHold + MOTION.headerDelay + MOTION.headerIn;

/** How much bigger the word being said is drawn at `t` (1 = normal size). */
export function popScale(w: CaptionWord, t: number): number {
  const x = (t - w.start) / MOTION.popSec;
  return x < 0 || x > 1 ? 1 : 1 + MOTION.popScale * Math.sin(Math.PI * x);
}

/** "#14213d" darkened by `amount` (0–1), for the background gradient. */
export function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * (1 - amount)).toString(16).padStart(2, "0");
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

// ---------------------------------------------------------------------------
// A clip's captions and waveform

/**
 * A clip's words as captions: the cleaned transcript's words between the
 * clip's first and last word (removed fillers left out, review corrections
 * in), timed from the start of the clip.
 */
export function clipCaptionWords(turns: CleanTurn[], clip: { firstWord: number; lastWord: number; start: number }): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (const turn of turns) {
    for (const w of turn.words) {
      if (w.index < clip.firstWord || w.index > clip.lastWord) continue;
      out.push({ text: w.text, start: w.start - clip.start, end: w.end - clip.start, speaker: turn.speaker });
    }
  }
  return out;
}

/**
 * Loudness for each video frame, 0–1, for the waveform: the RMS of each
 * frame's samples, scaled so the clip's loud parts (95th percentile, so one
 * spike doesn't flatten the rest) reach 1, with a square-root curve so quiet
 * speech still moves the bars.
 */
export function audioLevels(pcm: Int16Array, channels: number, sampleRate: number, fps = VIDEO_FPS): number[] {
  const perFrame = sampleRate / fps;
  const frames = Math.ceil(pcm.length / channels / perFrame);
  const rms: number[] = [];
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * perFrame), b = Math.min(pcm.length / channels, Math.floor((f + 1) * perFrame));
    let sum = 0;
    for (let i = a; i < b; i++) {
      for (let c = 0; c < channels; c++) {
        const v = pcm[i * channels + c]! / 32768;
        sum += v * v;
      }
    }
    rms.push(b > a ? Math.sqrt(sum / ((b - a) * channels)) : 0);
  }
  const sorted = [...rms].sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  return loud > 0 ? rms.map((r) => Math.min(1, Math.sqrt(r / loud))) : rms.map(() => 0);
}
