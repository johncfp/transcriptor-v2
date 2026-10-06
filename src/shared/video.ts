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
