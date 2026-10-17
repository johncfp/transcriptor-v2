// Draws one frame of a video clip. The same code draws the Settings preview,
// the Clips tab preview and every exported frame, so what's previewed is what's
// exported. Layout scales with the frame's shorter side; positions are fixed
// per shape. Caption layout itself is in src/shared/video.ts.

import type { VideoSettings } from "../../../shared/settings";
import {
  breakLines,
  CAPTION_SIZES,
  cardIn,
  darken,
  easeInOut,
  easeOut,
  headerIn,
  HOOK_END,
  hookOut,
  hookQuote,
  hookWordAlpha,
  hasOutro,
  isKeyword,
  MOTION,
  nameCards,
  outroIn,
  outroLines,
  pageAt,
  pageLines,
  popScale,
  quoteMoment,
  quoteWords,
  scrollAt,
  stamp,
  VIDEO_FPS,
  videoFont,
  wordState,
  type CaptionLine,
  type CaptionPage,
  type CaptionWord,
  type NameCard,
} from "../../../shared/video";

export interface FrameScene {
  width: number;
  height: number;
  style: VideoSettings;
  showName: string;
  /** From the show profile, for the outro card. */
  website: string;
  /** The show's hosts, so name cards can say Host or Guest. */
  hosts: string[];
  /** The clip's pull quote (raw word indexes), checked against the transcript; null = none. */
  quote: { firstWord: number; lastWord: number } | null;
  /** The clip's keywords, normalized. */
  keywords: string[];
  logo: CanvasImageSource | null;
  background: CanvasImageSource | null;
  /** Loudness per video frame, 0–1, for the waveform. */
  levels: number[];
  lines: CaptionLine[];
  pages: CaptionPage[];
  /** Pixel sizes worked out once per scene. */
  unit: number;
  captionPx: number;
  /** The hook quote laid out to fit where the logo and show name go; null = no hook. */
  hook: HookLayout | null;
  /** Whether the outro card follows the audio (see hasOutro). */
  outro: boolean;
  /** Name cards (lower thirds), when they're on. */
  cards: NameCard[];
  /** The pull-quote moment laid out over the captions; null = none. */
  pull: PullLayout | null;
}

interface PullLayout {
  lines: { word: CaptionWord; width: number }[][];
  words: CaptionWord[];
  px: number;
  lineH: number;
  /** Baseline of the first line. */
  top: number;
}

/** How long the clip's audio is, from its waveform levels (one per frame). */
export const audioSeconds = (s: FrameScene) => s.levels.length / VIDEO_FPS;

interface HookLayout {
  lines: { text: string; width: number }[][];
  px: number;
  lineH: number;
  /** Baseline of the first line. */
  top: number;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const wide = (s: { width: number; height: number }) => s.width > s.height;
const square = (s: { width: number; height: number }) => s.width === s.height;

/** Lines per page in word-by-word captions. */
const pageSize = (s: { width: number; height: number }) => (wide(s) ? 2 : 3);
/** Rows when scrolling: the line before (faded), the line being read, and the ones coming. */
const scrollRows = (s: { width: number; height: number }) => (wide(s) ? 3 : 4);

const font = (style: VideoSettings, weight: 600 | 700, px: number) => `${weight} ${Math.round(px)}px "${videoFont(style.font).family}", sans-serif`;

/** Lay the captions out for this frame size and style. Call once per clip and shape. */
export function makeScene(
  ctx: Ctx,
  input: Omit<FrameScene, "lines" | "pages" | "unit" | "captionPx" | "hook" | "outro" | "cards" | "pull"> & { words: CaptionWord[] },
): FrameScene {
  const unit = Math.min(input.width, input.height) / 1080;
  const scale = CAPTION_SIZES.find((c) => c.id === input.style.captionSize)?.scale ?? 1;
  const captionPx = 72 * unit * scale * (wide(input) ? 0.95 : 1);
  ctx.font = font(input.style, 700, captionPx);
  const lines = breakLines(input.words, (t) => ctx.measureText(t).width, input.width - 2 * margin(input, unit));
  const hook = input.style.motion.hook ? layoutHook(ctx, input, unit, captionPx) : null;
  const outro = hasOutro(input.style, input.showName, input.website);
  const cards = input.style.motion.nameCards ? nameCards(input.words, input.hosts) : [];
  const quote = quoteWords(input.words, input.quote);
  // Not when the quote is said while the opening quote is still up: it was just shown.
  const pull = input.style.motion.pullQuote && quote.length && !(hook && quote[0]!.start < HOOK_END + 0.5) ? layoutPull(ctx, input, unit, captionPx, quote) : null;
  return { ...input, lines, pages: pageLines(lines, pageSize(input)), unit, captionPx, hook, outro, cards, pull };
}

/** Break `widths` into at most `maxLines` lines no wider than `maxW`, as big as fits in `maxH`, from `px` down to `minPx`. */
function fit(ctx: Ctx, style: VideoSettings, texts: string[], maxW: number, maxH: number, px: number, minPx: number, maxLines: number) {
  for (;;) {
    ctx.font = font(style, 700, px);
    const space = ctx.measureText(" ").width;
    const lines: { i: number; width: number }[][] = [];
    let width = 0;
    texts.forEach((text, i) => {
      const w = ctx.measureText(text).width;
      const line = lines.at(-1);
      if (line && width + space + w <= maxW) {
        line.push({ i, width: w });
        width += space + w;
      } else {
        lines.push([{ i, width: w }]);
        width = w;
      }
    });
    const lineH = px * 1.18;
    const fits = lines.length <= maxLines && lines.length * lineH <= maxH && lines.every((l) => l.every((w) => w.width <= maxW));
    if (fits || px * 0.92 < minPx) return { lines, px, lineH };
    px *= 0.92;
  }
}

/**
 * The pull-quote moment: the quote's words over the caption area (from the
 * speaker's name down to above the waveform), as big as fits in three lines,
 * left-aligned under a large opening quote mark.
 */
function layoutPull(
  ctx: Ctx,
  input: { width: number; height: number; style: VideoSettings },
  unit: number,
  captionPx: number,
  quote: CaptionWord[],
): PullLayout {
  const L = layout({ ...input, unit });
  const areaTop = speakerTop(L, captionPx, unit) - captionPx * 0.5;
  const areaBottom = L.waveY - L.waveH / 2 - 40 * unit;
  const maxW = input.width - 2 * margin(input, unit);
  const startPx = (wide(input) ? 100 : square(input) ? 96 : 120) * unit;
  const f = fit(ctx, input.style, quote.map((w) => w.text), maxW, (areaBottom - areaTop) * 0.8, startPx, 44 * unit, 3);
  const block = f.px * 0.8 + f.lines.length * f.lineH;
  const top = areaTop + (areaBottom - areaTop - block) / 2 + f.px * 0.8 + f.px * 0.9;
  return { lines: f.lines.map((l) => l.map(({ i, width }) => ({ word: quote[i]!, width }))), words: quote, px: f.px, lineH: f.lineH, top };
}

/** The pull quote, each word landing as it's said, over the captions. */
function drawPull(ctx: Ctx, s: FrameScene, pull: PullLayout, t: number, k: number): void {
  const x0 = margin(s, s.unit);
  ctx.textAlign = "left";
  // The opening quote mark, above the first line.
  ctx.font = font(s.style, 700, pull.px * 2);
  ctx.fillStyle = withAlpha(s.style.colors.highlight, k);
  ctx.fillText("\u201C", x0 - pull.px * 0.08, pull.top - pull.px * 0.55);
  ctx.font = font(s.style, 700, pull.px);
  const space = ctx.measureText(" ").width;
  pull.lines.forEach((line, row) => {
    let x = x0;
    const y = pull.top + row * pull.lineH;
    for (const { word, width } of line) {
      const st = stamp(word, t);
      if (st.alpha > 0.01) {
        ctx.save();
        const cx = x + width / 2, cy = y - pull.px * 0.35;
        ctx.translate(cx, cy);
        ctx.scale(st.scale, st.scale);
        ctx.translate(-cx, -cy);
        const color = s.style.motion.keywords && isKeyword(word, s.keywords) ? s.style.colors.highlight : s.style.colors.text;
        ctx.fillStyle = withAlpha(color, st.alpha * k);
        ctx.fillText(word.text, x, y);
        ctx.restore();
      }
      x += width + space;
    }
  });
}

/**
 * Fit the hook quote into the space above the captions, where the logo and
 * show name go: as big as fits in three lines at most, centred there. Its
 * words keep the transcript's text; only the quote marks are added.
 */
function layoutHook(
  ctx: Ctx,
  input: { width: number; height: number; style: VideoSettings; words: CaptionWord[]; quote: { firstWord: number; lastWord: number } | null },
  unit: number,
  captionPx: number,
): HookLayout | null {
  // The clip's pull quote, picked with the clip; clips without one get the shortest whole sentence.
  const picked = quoteWords(input.words, input.quote);
  const quote = picked.length ? picked : hookQuote(input.words);
  if (!quote) return null;
  const texts = quote.map((w, i) => (i === 0 ? "“" : "") + w.text + (i === quote.length - 1 ? "”" : ""));
  const L = layout({ ...input, unit });
  const areaTop = L.logoTop;
  const areaBottom = speakerTop(L, captionPx, unit) - 40 * unit;
  const maxW = input.width - 2 * margin(input, unit);
  let px = (wide(input) ? 80 : square(input) ? 72 : 84) * unit;
  for (;;) {
    ctx.font = font(input.style, 700, px);
    const space = ctx.measureText(" ").width;
    const lines: { text: string; width: number }[][] = [];
    let width = 0;
    for (const text of texts) {
      const w = ctx.measureText(text).width;
      const line = lines.at(-1);
      if (line && width + space + w <= maxW) {
        line.push({ text, width: w });
        width += space + w;
      } else {
        lines.push([{ text, width: w }]);
        width = w;
      }
    }
    const lineH = px * 1.18;
    const fits = lines.length <= 3 && lines.length * lineH <= areaBottom - areaTop && lines.every((l) => l.every((w) => w.width <= maxW));
    if (fits || px <= 36 * unit) {
      const block = lines.length * lineH;
      return { lines, px, lineH, top: areaTop + (areaBottom - areaTop - block) / 2 + px * 0.9 };
    }
    px *= 0.92;
  }
}

const margin = (s: { width: number; height: number }, unit: number) => (wide(s) ? 120 : 80) * unit;

/** Where things go, per shape. */
function layout(s: { width: number; height: number; unit: number }) {
  const u = s.unit;
  if (wide(s))
    return { logoTop: 60 * u, logo: 130 * u, nameY: 240 * u, captionTop: 420 * u, waveY: s.height - 150 * u, waveH: 150 * u, progressY: s.height - 30 * u };
  if (square(s))
    return { logoTop: 60 * u, logo: 130 * u, nameY: 245 * u, captionTop: 430 * u, waveY: s.height - 130 * u, waveH: 140 * u, progressY: s.height - 24 * u };
  return { logoTop: 170 * u, logo: 170 * u, nameY: 420 * u, captionTop: 800 * u, waveY: s.height - 360 * u, waveH: 220 * u, progressY: s.height - 130 * u };
}

/** Baseline of the speaker's name above the captions. */
const speakerTop = (L: { captionTop: number }, captionPx: number, unit: number) => L.captionTop - captionPx * 0.9 - 30 * unit;

/** A moment for a still preview: partway into the second line, after the hook has gone. */
export function stillTime(s: FrameScene): number {
  const after = s.hook ? HOOK_END + 0.2 : 0;
  const line = s.lines.find((l, i) => i >= 1 && l.start >= after) ?? s.lines[1] ?? s.lines[0];
  const word = line?.words[Math.floor(line.words.length / 2)];
  return word ? Math.max(after, word.start + 0.05) : after;
}

function drawBackground(ctx: Ctx, s: FrameScene): void {
  const { width: W, height: H } = s;
  if (s.style.backgroundType === "image" && s.background) {
    // Cover the frame, then darken so the captions stay readable.
    const img = s.background as { width: number; height: number };
    const k = Math.max(W / img.width, H / img.height);
    const w = img.width * k, h = img.height * k;
    ctx.drawImage(s.background, (W - w) / 2, (H - h) / 2, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, s.style.colors.background);
  g.addColorStop(1, darken(s.style.colors.background, 0.45));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** A soft light in the highlight colour that drifts slowly and brightens with the voice. */
function drawGlow(ctx: Ctx, s: FrameScene, t: number): void {
  const { width: W, height: H } = s;
  // The last few frames' loudness, so the light swells rather than flickers.
  const f = Math.floor(t * VIDEO_FPS);
  let level = 0;
  for (let i = 0; i < 4; i++) level += (s.levels[f - i] ?? 0) / 4;
  const x = W * (0.5 + 0.3 * Math.sin(t * 0.35));
  const y = H * (0.42 + 0.12 * Math.cos(t * 0.27));
  const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(W, H) * 0.42);
  g.addColorStop(0, withAlpha(s.style.colors.highlight, 0.1 + 0.08 * level));
  g.addColorStop(1, withAlpha(s.style.colors.highlight, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** The hook quote, word by word, until it lifts away at HOOK_END. */
function drawHook(ctx: Ctx, s: FrameScene, hook: HookLayout, t: number): void {
  const lift = hookOut(t) * 60 * s.unit;
  ctx.font = font(s.style, 700, hook.px);
  ctx.textAlign = "left";
  const space = ctx.measureText(" ").width;
  let i = 0;
  hook.lines.forEach((line, row) => {
    const width = line.reduce((n, w) => n + w.width, 0) + space * (line.length - 1);
    let x = (s.width - width) / 2;
    for (const w of line) {
      const alpha = hookWordAlpha(i, t);
      const rise = (1 - easeOut((t - i * MOTION.hookStagger) / MOTION.hookWordIn)) * 30 * s.unit;
      if (alpha > 0.01) {
        ctx.fillStyle = withAlpha(s.style.colors.text, alpha);
        ctx.fillText(w.text, x, hook.top + row * hook.lineH + rise - lift);
      }
      x += w.width + space;
      i++;
    }
  });
  // A short bar in the highlight colour under the quote.
  const barAlpha = easeOut(t / 0.4) * (1 - hookOut(t));
  if (barAlpha > 0.01) {
    const y = hook.top + (hook.lines.length - 1) * hook.lineH + hook.px * 0.5 - lift;
    ctx.fillStyle = withAlpha(s.style.colors.highlight, barAlpha);
    ctx.beginPath();
    ctx.roundRect(s.width / 2 - 60 * s.unit, y, 120 * s.unit, 8 * s.unit, 4 * s.unit);
    ctx.fill();
  }
}

/**
 * The outro card, once the audio has ended: the background colour comes up
 * over the frame, then the logo, "Full episode on", the show name and the
 * website rise into place, centred.
 */
function drawOutro(ctx: Ctx, s: FrameScene, L: ReturnType<typeof layout>, t: number): void {
  const { width: W, height: H, unit: u } = s;
  const o = outroIn(t, audioSeconds(s));
  // The background (gradient or image, and the glow) fades back in over everything.
  ctx.globalAlpha = o;
  drawBackground(ctx, s);
  if (s.style.motion.glow) drawGlow(ctx, s, t);
  const lines = outroLines(s.showName, s.website);
  const maxW = W - 2 * margin(s, u);
  const logo = s.style.showLogo && s.logo ? (s.logo as { width: number; height: number }) : null;
  const logoSize = L.logo * 1.25;
  const abovePx = 44 * u, bigPx = (wide(s) ? 96 : 88) * u, belowPx = 40 * u;
  // Heights of each piece and the gaps between them, to centre the whole block.
  const parts = [logo ? logoSize + 50 * u : 0, abovePx * 1.3, bigPx * 1.25, lines.below ? belowPx * 1.5 : 0];
  const block = parts.reduce((a, b) => a + b, 0);
  let y = (H - block) / 2 + (1 - o) * 50 * u;
  ctx.globalAlpha = o;
  if (logo) {
    // A small pop as it arrives.
    const k = Math.min(logoSize / logo.width, logoSize / logo.height) * (0.85 + 0.15 * outroIn(t - 0.1, audioSeconds(s)));
    ctx.drawImage(s.logo!, (W - logo.width * k) / 2, y + (logoSize - logo.height * k) / 2, logo.width * k, logo.height * k);
    y += parts[0]!;
  }
  ctx.textAlign = "center";
  ctx.font = font(s.style, 600, abovePx);
  ctx.fillStyle = s.style.colors.highlight;
  ctx.fillText(lines.above, W / 2, y + abovePx, maxW);
  y += parts[1]!;
  ctx.font = font(s.style, 700, bigPx);
  ctx.fillStyle = s.style.colors.text;
  ctx.fillText(lines.big, W / 2, y + bigPx, maxW);
  y += parts[2]!;
  if (lines.below) {
    ctx.font = font(s.style, 600, belowPx);
    ctx.fillStyle = withAlpha(s.style.colors.text, 0.75);
    ctx.fillText(lines.below, W / 2, y + belowPx * 1.2, maxW);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

/** How far into the clip, as a bar along the bottom. */
function drawProgress(ctx: Ctx, s: FrameScene, t: number, y: number): void {
  const seconds = audioSeconds(s);
  if (!seconds) return;
  const m = margin(s, s.unit);
  const w = s.width - 2 * m;
  const p = Math.max(0, Math.min(1, t / seconds));
  const h = 8 * s.unit;
  ctx.fillStyle = withAlpha(s.style.colors.text, 0.18);
  ctx.beginPath();
  ctx.roundRect(m, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = s.style.colors.highlight;
  ctx.beginPath();
  ctx.roundRect(m, y - h / 2, Math.max(h, w * p), h, h / 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(m + w * p, y, 11 * s.unit, 0, Math.PI * 2);
  ctx.fill();
}

/** Pulse: bars either side of the middle; the middle ones are now and the outer ones a moment ago, so the sound ripples outward. */
function drawPulse(ctx: Ctx, s: FrameScene, t: number, y: number, maxH: number): void {
  const f = Math.floor(t * VIDEO_FPS);
  const bars = wide(s) ? 61 : 41;
  const mid = (bars - 1) / 2;
  const m = margin(s, s.unit);
  const step = (s.width - 2 * m) / bars;
  const barW = Math.max(2, step * 0.6);
  for (let b = 0; b < bars; b++) {
    const d = Math.abs(b - mid);
    const level = (s.levels[f - Math.round(d)] ?? 0) * (1 - d / (mid * 1.25));
    const h = 6 * s.unit + Math.min(1, level) * maxH;
    ctx.fillStyle = d <= 1 ? s.style.colors.highlight : withAlpha(s.style.colors.text, 0.55);
    ctx.beginPath();
    ctx.roundRect(m + b * step + (step - barW) / 2, y - h / 2, barW, h, Math.min(barW / 2, 7 * s.unit));
    ctx.fill();
  }
}

/** Rolling: the last moments of sound, newest on the right. */
function drawWaveform(ctx: Ctx, s: FrameScene, t: number, y: number, maxH: number): void {
  const f = Math.floor(t * VIDEO_FPS);
  const bars = wide(s) ? 72 : 48;
  const m = margin(s, s.unit);
  const step = (s.width - 2 * m) / bars;
  for (let b = 0; b < bars; b++) {
    const level = s.levels[f - bars + 1 + b] ?? 0;
    const h = 6 * s.unit + Math.min(1, level) * maxH;
    ctx.fillStyle = b === bars - 1 ? s.style.colors.highlight : withAlpha(s.style.colors.text, 0.5);
    ctx.beginPath();
    ctx.roundRect(m + b * step, y - h / 2, Math.max(2, step * 0.55), h, Math.min(4 * s.unit, step * 0.27));
    ctx.fill();
  }
}

function drawWords(ctx: Ctx, s: FrameScene, line: CaptionLine, x: number, y: number, t: number, boxed: boolean, alpha = 1): void {
  const space = ctx.measureText(" ").width;
  for (const w of line.words) {
    const width = ctx.measureText(w.text).width;
    const state = wordState(w, t);
    // Word pop: the word being said (and its box) grows for a moment, from its middle.
    const scale = state === "now" && s.style.motion.pop ? popScale(w, t) : 1;
    if (scale !== 1) {
      const cx = x + width / 2, cy = y - s.captionPx * 0.33;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
    }
    if (state === "now" && boxed) {
      ctx.fillStyle = s.style.colors.highlight;
      ctx.beginPath();
      ctx.roundRect(x - 12 * s.unit, y - s.captionPx * 0.98, width + 24 * s.unit, s.captionPx * 1.3, 14 * s.unit);
      ctx.fill();
    }
    // Keywords stay in the highlight colour, underlined, once said.
    const key = state === "said" && s.style.motion.keywords && isKeyword(w, s.keywords);
    const color =
      state === "now"
        ? boxed
          ? s.style.colors.background
          : s.style.colors.highlight
        : state === "said"
          ? key
            ? s.style.colors.highlight
            : s.style.colors.text
          : withAlpha(s.style.colors.text, 0.42);
    ctx.fillStyle = alpha < 1 ? withAlpha(color, alpha * (state === "ahead" ? 0.42 : 1)) : color;
    ctx.fillText(w.text, x, y);
    if (key) ctx.fillRect(x, y + s.captionPx * 0.14, width, 6 * s.unit);
    if (scale !== 1) ctx.restore();
    x += width + space;
  }
}

export function drawFrame(ctx: Ctx, s: FrameScene, t: number): void {
  const { width: W } = s;
  const L = layout(s);
  ctx.save();
  ctx.textBaseline = "alphabetic";
  drawBackground(ctx, s);
  if (s.style.motion.glow) drawGlow(ctx, s, t);

  // The hook first; the logo and show name come in as it lifts away.
  if (s.hook && t < HOOK_END) drawHook(ctx, s, s.hook, t);
  ctx.globalAlpha = s.hook ? headerIn(t) : 1;
  if (s.style.showLogo && s.logo) {
    const img = s.logo as { width: number; height: number };
    const k = Math.min(L.logo / img.width, L.logo / img.height);
    ctx.drawImage(s.logo, (W - img.width * k) / 2, L.logoTop + (L.logo - img.height * k) / 2, img.width * k, img.height * k);
  }
  if (s.style.showShowName && s.showName) {
    ctx.textAlign = "center";
    ctx.font = font(s.style, 600, 40 * s.unit);
    ctx.fillStyle = withAlpha(s.style.colors.text, 0.85);
    ctx.fillText(s.showName, W / 2, L.nameY, W - 2 * margin(s, s.unit));
  }
  ctx.globalAlpha = 1;

  // Captions, giving way to the pull quote while it's up.
  const pullUp = s.pull ? quoteMoment(s.pull.words, t) : 0;
  ctx.globalAlpha = 1 - pullUp;
  ctx.textAlign = "left";
  const x = margin(s, s.unit);
  const lineH = s.captionPx * 1.42;
  const speakerY = speakerTop(L, s.captionPx, s.unit);
  if (s.style.captionStyle === "highlight") {
    const page = pageAt(s.pages, t);
    if (page) {
      if (showLabel(s, page.speaker)) drawSpeaker(ctx, s, page.speaker, x, speakerY);
      ctx.font = font(s.style, 700, s.captionPx);
      page.lines.forEach((line, i) => drawWords(ctx, s, line, x, L.captionTop + i * lineH, t, true));
    }
  } else {
    // Each scroll eases in and out rather than sliding at one speed.
    const raw = scrollAt(s.lines, t);
    const at = Math.floor(raw) + easeInOut(raw - Math.floor(raw));
    const current = s.lines[Math.round(at)];
    if (current && t >= current.start - 0.25) {
      if (showLabel(s, current.speaker)) drawSpeaker(ctx, s, current.speaker, x, speakerY);
      ctx.font = font(s.style, 700, s.captionPx);
      // A band of rows from captionTop: row 0 is the line before (faded), row 1 the line
      // being read, then the ones coming. Lines slide up a row as the next one starts.
      const rows = scrollRows(s);
      ctx.save();
      ctx.beginPath();
      // From the top of row 0's letters to below the last row's descenders.
      ctx.rect(0, L.captionTop - s.captionPx * 1.05, W, (rows - 1) * lineH + s.captionPx * 1.45);
      ctx.clip();
      for (let i = Math.max(0, Math.floor(at) - 2); i < Math.min(s.lines.length, Math.ceil(at) + rows); i++) {
        const row = i - at + 1;
        if (row <= -1 || row >= rows) continue;
        // Full strength from the reading row down; the line before at 45%; fading out above it.
        const opacity = row >= 1 ? 1 : row >= 0 ? 0.45 + 0.55 * row : 0.45 * (row + 1);
        if (opacity <= 0.02) continue;
        drawWords(ctx, s, s.lines[i]!, x, L.captionTop + row * lineH, t, false, opacity);
      }
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  if (s.pull && pullUp > 0.001) drawPull(ctx, s, s.pull, t, pullUp);

  if (s.style.waveform) (s.style.waveformStyle === "pulse" ? drawPulse : drawWaveform)(ctx, s, t, L.waveY, L.waveH);
  if (s.style.motion.progress) drawProgress(ctx, s, t, L.progressY);
  for (const card of s.cards) {
    const k = cardIn(card, t);
    if (k > 0.001) drawCard(ctx, s, L, card, k);
  }
  if (s.outro && s.levels.length && t > audioSeconds(s)) drawOutro(ctx, s, L, t);
  ctx.restore();
}

/** The name above the captions; with name cards on, only speakers who get no card (not named in review) keep it. */
function showLabel(s: FrameScene, speaker: string): boolean {
  if (!s.style.showSpeakers || !speaker) return false;
  return !s.cards.some((c) => c.name === speaker);
}

/**
 * A name card, just above the waveform: a highlight bar, the name, and Host or
 * Guest (with the show's name). It slides in from the left edge and back out.
 */
function drawCard(ctx: Ctx, s: FrameScene, L: ReturnType<typeof layout>, card: NameCard, k: number): void {
  const u = s.unit;
  const h = (wide(s) || square(s) ? 120 : 140) * u;
  const namePx = h * 0.37, rolePx = h * 0.23;
  const role = s.showName.trim() ? `${card.role} · ${s.showName.trim()}` : card.role;
  ctx.font = font(s.style, 700, namePx);
  const nameW = ctx.measureText(card.name).width;
  ctx.font = font(s.style, 600, rolePx);
  const roleW = ctx.measureText(role).width;
  const m = margin(s, u);
  const w = Math.min(s.width - 2 * m, Math.max(nameW, roleW) + 72 * u);
  const y = L.waveY - L.waveH / 2 - 30 * u - h;
  const x = m - (1 - k) * (w + m);
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.5);
  ctx.fillStyle = withAlpha(s.style.colors.text, 0.1);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 16 * u);
  ctx.fill();
  ctx.fillStyle = s.style.colors.highlight;
  ctx.beginPath();
  ctx.roundRect(x, y, 12 * u, h, [16 * u, 0, 0, 16 * u]);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.fillStyle = s.style.colors.text;
  ctx.font = font(s.style, 700, namePx);
  ctx.fillText(card.name, x + 40 * u, y + h * 0.48, w - 56 * u);
  ctx.fillStyle = s.style.colors.highlight;
  ctx.font = font(s.style, 600, rolePx);
  ctx.fillText(role, x + 40 * u, y + h * 0.8, w - 56 * u);
  ctx.restore();
}

function drawSpeaker(ctx: Ctx, s: FrameScene, name: string, x: number, y: number): void {
  ctx.font = font(s.style, 600, 42 * s.unit);
  ctx.fillStyle = s.style.colors.highlight;
  ctx.fillText(name, x, y);
}

/** "#rrggbb" at an opacity, as rgba(). */
function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
