// Milestone 7.4 sync check for CI (macOS and Windows): the app's own cutter
// makes videos from generated audio and words, then verify.ts checks each MP4
// (sound against the clip's WAV, pictures against drawFrame). Also checks each
// WAV is sample-exact against the source. No episode audio or API calls.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { DEFAULT_SETTINGS, type VideoSettings } from "@repo/src/shared/settings";
import { SHAPES, type CaptionWord, type ShapeId } from "@repo/src/shared/video";
import { fadeEdges, readWav, wavFile } from "@repo/src/shared/wav";
import { cutClips } from "@repo/src/main/clipCutter";

const REPO = process.env.REPO!;
const HERE = process.env.HERE!;
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
app.setPath("userData", join(OUT, "profile"));
app.on("window-all-closed", () => {});

// ---------------------------------------------------------------------------
// Fixtures

/** Seeded noise with a syllable-like envelope: every position is recognisable by correlation. */
function episode(rate: number, channels: number, seconds: number): string {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const n = rate * seconds;
  const pcm = new Int16Array(n * channels);
  let env = 0.3;
  for (let i = 0; i < n; i++) {
    if (i % Math.round(rate / 8) === 0) env = 0.05 + rnd() * 0.6;
    for (let c = 0; c < channels; c++) pcm[i * channels + c] = Math.round((rnd() * 2 - 1) * env * 32767 * (c ? 0.7 : 1));
  }
  const f = join(OUT, `episode-${rate}-${channels}ch.wav`);
  writeFileSync(f, wavFile(pcm, rate, channels));
  return f;
}

const LOREM = "so the thing about farmers is that they adopt tools when the value is obvious and the risk is small which means startups need proof on real farms first".split(" ");
/** Words every 0.3–0.6 s from the clip's start, with the speaker changing every 12 words; a sentence ends every 7 words, so there's an opening quote. */
function words(seconds: number): CaptionWord[] {
  const out: CaptionWord[] = [];
  let t = 0.2, i = 0;
  while (t < seconds - 0.6) {
    const len = 0.25 + ((i * 7) % 5) * 0.06;
    out.push({ text: LOREM[i % LOREM.length]! + (i % 7 === 6 ? "." : ""), start: +t.toFixed(3), end: +(t + len).toFixed(3), speaker: Math.floor(i / 12) % 2 ? "Delaney" : "Brian" });
    t += len + 0.05 + ((i * 3) % 4) * 0.04;
    i++;
  }
  return out;
}

/** A BGRA bitmap as an image file. */
function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number], kind: "png" | "jpeg"): Buffer {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, bl, a] = px(x, y);
      b.set([bl, g, r, a], (y * w + x) * 4);
    }
  const img = nativeImage.createFromBitmap(b, { width: w, height: h });
  return kind === "png" ? img.toPNG() : img.toJPEG(85);
}

// ---------------------------------------------------------------------------

const cutter = {
  preload: join(REPO, "out/preload/cutter.js"),
  load: (win: BrowserWindow) => win.loadFile(join(REPO, "out/renderer/cutter.html")),
};

function verify(input: unknown): Promise<Record<string, unknown>> {
  const f = join(OUT, `verify-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(input));
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const log: string[] = [];
  win.webContents.on("console-message", (e) => log.push(`${e.level}: ${e.message}`));
  return new Promise((resolve) => {
    const done = (r: Record<string, unknown>) => {
      if (log.length) writeFileSync(f.replace(".json", ".log"), log.join("\n"));
      if (!win.isDestroyed()) win.destroy();
      resolve(r);
    };
    ipcMain.once("verified", (_e, r) => done(r));
    win.webContents.on("render-process-gone", (_e, d) => done({ error: `verify page gone: ${d.reason}` }));
    void win.loadFile(join(HERE, "verify.html"), { query: { jobFile: f } });
  });
}

interface Run {
  name: string;
  audio: string;
  clip: { start: number; end: number };
  style: VideoSettings;
  shapes: ShapeId[];
  logo: Buffer | null;
  background: Buffer | null;
  /** For the outro card; "" (with no show name) means none. */
  website: string;
}

async function run(r: Run) {
  const dir = join(OUT, r.name);
  mkdirSync(dir, { recursive: true });
  const seconds = r.clip.end - r.clip.start;
  const w = words(seconds);
  const logoPath = r.logo ? join(dir, "logo.png") : null;
  const bgPath = r.background ? join(dir, "background.jpg") : null;
  if (logoPath) writeFileSync(logoPath, r.logo!);
  if (bgPath) writeFileSync(bgPath, r.background!);
  const t0 = Date.now();
  const cut = await cutClips(r.audio, [r.clip], cutter, { video: { style: r.style, showName: "LOL a Podcast", website: r.website, logo: r.logo, background: r.background, clips: [{ words: w, shapes: r.shapes }] } });
  const ms = Date.now() - t0;
  const wavPath = join(dir, "clip.wav");
  writeFileSync(wavPath, cut.wavs[0]!);
  // The WAV, sample for sample, against the source with the same edge fades (2.0.0-beta.7).
  const src = readWav(new Uint8Array(require("node:fs").readFileSync(r.audio)))!;
  const got = readWav(cut.wavs[0]!)!;
  const from = Math.round(r.clip.start * src.sampleRate) * src.channels;
  const want = src.pcm.slice(from, from + Math.round(seconds * src.sampleRate) * src.channels);
  fadeEdges(want, src.sampleRate, src.channels);
  const wavExact = got.pcm.length === want.length && got.pcm.every((v, i) => v === want[i]);
  const results = [];
  for (const [j, shape] of r.shapes.entries()) {
    const mp4 = join(dir, `${shape}.mp4`);
    writeFileSync(mp4, cut.videos[0]![j]!);
    const spec = SHAPES.find((s) => s.id === shape)!;
    results.push({ shape, ...(await verify({ mp4, wav: wavPath, width: spec.width, height: spec.height, words: w, style: r.style, showName: "LOL a Podcast", website: r.website, outro: r.style.motion.outro, logoPath, backgroundPath: bgPath, clipSeconds: seconds, snapshot: join(dir, `${shape}.png`) })) });
  }
  return { name: r.name, outro: r.style.motion.outro, clipSeconds: seconds, renderMs: ms, speedX: +((seconds * r.shapes.length) / (ms / 1000)).toFixed(2), wavExact, results };
}

app.whenReady().then(async () => {
  const report: Record<string, unknown> = { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome };
  try {
    const stereo44 = episode(44100, 2, 90);
    const mono16 = episode(16000, 1, 90);
    const logo = image(256, 256, (x, y) => ((x - 128) ** 2 + (y - 128) ** 2 < 120 ** 2 ? [252, 163, 17, 255] : [0, 0, 0, 0]), "png");
    const background = image(800, 600, (x, y) => [40 + (x * 150) / 800, 90, 60 + (y * 150) / 600, 255], "jpeg");
    const base = { ...DEFAULT_SETTINGS.video, enabled: true };
    const all = SHAPES.map((s) => s.id);
    report.runs = [
      // 44.1 kHz stereo (no resampling), word highlight, every shape: the 60 s case from the 7.0 spike.
      // All the motion on (the defaults), with the outro card.
      await run({ name: "highlight-44k", audio: stereo44, clip: { start: 12.3456, end: 72.3456 }, style: { ...base, font: "inter" }, shapes: all, logo, background: null, website: "lol.example" }),
      // 16 kHz mono (resampled to 48 kHz for AAC), scrolling captions, a background image.
      await run({ name: "scroll-16k-image", audio: mono16, clip: { start: 30.017, end: 55.5 }, style: { ...base, captionStyle: "scroll", font: "atkinson", backgroundType: "image", backgroundImage: "background-1.jpg", waveformStyle: "history", motion: { ...base.motion, pop: false, outro: false } }, shapes: ["vertical", "square"], logo, background, website: "lol.example" }),
    ];
    const rows = (report.runs as { wavExact: boolean; outro: boolean; clipSeconds: number; results: Record<string, any>[] }[]).flatMap((r) =>
      r.results.map((x) => ({ ...x, wavExact: r.wavExact, outro: r.outro, clipSeconds: r.clipSeconds })),
    );
    report.summary = {
      videos: rows.length,
      errors: rows.filter((x) => x.error).map((x) => x.error),
      wavExact: rows.every((x) => x.wavExact),
      soundOffsetsMs: [...new Set(rows.flatMap((x) => x.sound?.points.map((p: { offsetMs: number }) => p.offsetMs) ?? []))],
      minSoundCorr: Math.min(...rows.flatMap((x) => x.sound?.points.map((p: { corr: number }) => p.corr) ?? [0])),
      picturesAllAtZero: rows.every((x) => x.pictures?.allAtZero),
      durations: rows.map((x) => [x.container?.videoSeconds, x.container?.audioSeconds, x.sound?.heardSeconds, x.pictures?.duration]),
      // With the outro card the video runs 2.5 s past the clip, silent under the card; without it, it doesn't.
      outroOk: rows.every(
        (x) => Math.abs((x.container?.videoSeconds ?? 0) - (x.clipSeconds + (x.outro ? 2.5 : 0))) <= 0.05 && (!x.outro || (x.sound?.tailPeak ?? 1) < 0.002),
      ),
      tailPeaks: rows.map((x) => x.sound?.tailPeak),
    };
    const s = report.summary as { errors: string[]; wavExact: boolean; soundOffsetsMs: number[]; minSoundCorr: number; picturesAllAtZero: boolean; outroOk: boolean };
    report.ok = !s.errors.length && s.wavExact && s.soundOffsetsMs.every((o) => Math.abs(o) <= 1) && s.minSoundCorr >= 0.9 && s.picturesAllAtZero && s.outroOk;
  } catch (err) {
    report.ok = false;
    report.error = String((err as Error).stack ?? err);
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, summary: report.summary, error: report.error }, null, 2));
  app.exit(report.ok ? 0 : 1);
});
