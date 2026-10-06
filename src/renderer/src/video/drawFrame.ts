// Draws one frame of a video clip. The same code draws the Settings preview,
// the Clips tab preview and every exported frame, so what's previewed is what's
// exported. Layout scales with the frame's shorter side; positions are fixed
// per shape. Caption layout itself is in src/shared/video.ts.

import type { VideoSettings } from "../../../shared/settings";
import {
  breakLines,
  CAPTION_SIZES,
  darken,
  pageAt,
  pageLines,
  scrollAt,
  videoFont,
  wordState,
  type CaptionLine,
  type CaptionPage,
  type CaptionWord,
} from "../../../shared/video";

export interface FrameScene {
  width: number;
  height: number;
  style: VideoSettings;
  showName: string;
  logo: CanvasImageSource | null;
  background: CanvasImageSource | null;
  /** Loudness per video frame, 0–1, for the waveform. */
  levels: number[];
  lines: CaptionLine[];
  pages: CaptionPage[];
  /** Pixel sizes worked out once per scene. */
  unit: number;
  captionPx: number;
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
  input: Omit<FrameScene, "lines" | "pages" | "unit" | "captionPx"> & { words: CaptionWord[] },
): FrameScene {
  const unit = Math.min(input.width, input.height) / 1080;
  const scale = CAPTION_SIZES.find((c) => c.id === input.style.captionSize)?.scale ?? 1;
  const captionPx = 72 * unit * scale * (wide(input) ? 0.95 : 1);
  ctx.font = font(input.style, 700, captionPx);
  const lines = breakLines(input.words, (t) => ctx.measureText(t).width, input.width - 2 * margin(input, unit));
  return { ...input, lines, pages: pageLines(lines, pageSize(input)), unit, captionPx };
}

const margin = (s: { width: number; height: number }, unit: number) => (wide(s) ? 120 : 80) * unit;

/** Where things go, per shape. */
function layout(s: FrameScene) {
  const u = s.unit;
  if (wide(s)) return { logoTop: 60 * u, logo: 130 * u, nameY: 240 * u, captionTop: 420 * u, waveY: s.height - 150 * u, waveH: 150 * u };
  if (square(s)) return { logoTop: 60 * u, logo: 130 * u, nameY: 245 * u, captionTop: 430 * u, waveY: s.height - 130 * u, waveH: 140 * u };
  return { logoTop: 170 * u, logo: 170 * u, nameY: 420 * u, captionTop: 800 * u, waveY: s.height - 360 * u, waveH: 220 * u };
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

function drawWaveform(ctx: Ctx, s: FrameScene, t: number, y: number, maxH: number): void {
  const f = Math.floor(t * 30);
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
    if (state === "now" && boxed) {
      ctx.fillStyle = s.style.colors.highlight;
      ctx.beginPath();
      ctx.roundRect(x - 12 * s.unit, y - s.captionPx * 0.98, width + 24 * s.unit, s.captionPx * 1.3, 14 * s.unit);
      ctx.fill();
    }
    const color =
      state === "now"
        ? boxed
          ? s.style.colors.background
          : s.style.colors.highlight
        : state === "said"
          ? s.style.colors.text
          : withAlpha(s.style.colors.text, 0.42);
    ctx.fillStyle = alpha < 1 ? withAlpha(color, alpha * (state === "ahead" ? 0.42 : 1)) : color;
    ctx.fillText(w.text, x, y);
    x += width + space;
  }
}

export function drawFrame(ctx: Ctx, s: FrameScene, t: number): void {
  const { width: W } = s;
  const L = layout(s);
  ctx.save();
  ctx.textBaseline = "alphabetic";
  drawBackground(ctx, s);

  // Logo and show name.
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

  // Captions.
  ctx.textAlign = "left";
  const x = margin(s, s.unit);
  const lineH = s.captionPx * 1.42;
  const speakerY = L.captionTop - s.captionPx * 0.9 - 30 * s.unit;
  if (s.style.captionStyle === "highlight") {
    const page = pageAt(s.pages, t);
    if (page) {
      if (s.style.showSpeakers && page.speaker) drawSpeaker(ctx, s, page.speaker, x, speakerY);
      ctx.font = font(s.style, 700, s.captionPx);
      page.lines.forEach((line, i) => drawWords(ctx, s, line, x, L.captionTop + i * lineH, t, true));
    }
  } else {
    const at = scrollAt(s.lines, t);
    const current = s.lines[Math.round(at)];
    if (current && t >= current.start - 0.25) {
      if (s.style.showSpeakers && current.speaker) drawSpeaker(ctx, s, current.speaker, x, speakerY);
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

  if (s.style.waveform) drawWaveform(ctx, s, t, L.waveY, L.waveH);
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
