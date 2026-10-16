// Checks one exported MP4 against what it should be:
//  - container: tracks, codecs, durations, first timestamps (mediabunny);
//  - sound: Chromium's own decode of the MP4 (as a player hears it) lined up
//    against the clip's WAV, by cross-correlation at the start, middle and end;
//  - pictures: Chromium's <video> element seeked to frame k, compared with
//    the app's drawFrame rendered at frames k-3..k+3. The best match should be k.
// Together: the captions shown at time t are the ones for the audio heard at t.
import { readFileSync, writeFileSync } from "node:fs";
import { ipcRenderer } from "electron";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { audioLevels, VIDEO_FPS, type CaptionWord } from "@repo/src/shared/video";
import type { VideoSettings } from "@repo/src/shared/settings";
import { readWav } from "@repo/src/shared/wav";
import { drawFrame, makeScene } from "@repo/src/renderer/src/video/drawFrame";
import { loadVideoFont } from "@repo/src/renderer/src/video/fonts";

interface Job {
  mp4: string;
  wav: string;
  width: number;
  height: number;
  words: CaptionWord[];
  style: VideoSettings;
  showName: string;
  website: string;
  /** With the outro card: the video runs on past the WAV, silent. */
  outro: boolean;
  logoPath: string | null;
  backgroundPath?: string | null;
  clipSeconds: number;
  /** Save the middle checked frame as a PNG here. */
  snapshot?: string;
}
const job = JSON.parse(readFileSync(new URLSearchParams(location.search).get("jobFile")!, "utf8")) as Job;
const r2 = (n: number) => Math.round(n * 100) / 100;

async function container(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  let packets = 0, keys = 0;
  for await (const p of new EncodedPacketSink(v!).packets()) {
    packets++;
    if (p.type === "key") keys++;
  }
  return {
    format: (await input.getFormat()).name,
    videoCodec: await v!.getCodecParameterString(),
    audioCodec: await a!.getCodecParameterString(),
    size: [v!.displayWidth, v!.displayHeight],
    audioRate: a!.sampleRate,
    audioChannels: a!.numberOfChannels,
    videoSeconds: r2(await v!.computeDuration()),
    audioSeconds: r2(await a!.computeDuration()),
    videoFirst: await v!.getFirstTimestamp(),
    audioFirst: await a!.getFirstTimestamp(),
    frames: packets,
    keyFrames: keys,
    mbPerMin: r2((bytes.length / 1e6 / job.clipSeconds) * 60),
  };
}

/** Lag (ms) of `x` around `at` seconds against `ref`, ±maxMs, by normalised cross-correlation. */
function locate(x: Float32Array, ref: Float32Array, rate: number, at: number, maxMs = 100) {
  const W = Math.round(rate * 0.5), MAX = Math.round((rate * maxMs) / 1000), from = Math.round(at * rate);
  const seg = x.subarray(from, from + W);
  let sx = 0;
  for (const v of seg) sx += v * v;
  let best = { lag: 0, r: -2 };
  for (let lag = -MAX; lag <= MAX; lag++) {
    const o = from + lag;
    if (o < 0 || o + W > ref.length) continue;
    let s = 0, sr = 0;
    for (let i = 0; i < W; i++) {
      const q = ref[o + i]!;
      s += seg[i]! * q;
      sr += q * q;
    }
    const c = s / Math.sqrt(sx * sr || 1);
    if (c > best.r) best = { lag, r: c };
  }
  // Positive: the MP4's sound comes later than it should.
  return { at: r2(at), offsetMs: r2((-best.lag / rate) * 1000), corr: r2(best.r) };
}

async function sound(mp4: Uint8Array, wav: Uint8Array) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const heard = await ctx.decodeAudioData(buf(mp4));
  const ref = await ctx.decodeAudioData(buf(wav));
  const x = heard.getChannelData(0), R = ref.getChannelData(0);
  const len = ref.duration;
  // Under the outro card: the loudest sample heard after the clip's sound has ended.
  let tailPeak = 0;
  for (let i = Math.round((len + 0.15) * 48000); i < x.length - 2400; i++) tailPeak = Math.max(tailPeak, Math.abs(x[i]!));
  return {
    heardSeconds: r2(heard.duration),
    wavSeconds: r2(len),
    tailPeak: Math.round(tailPeak * 1e5) / 1e5,
    points: [0.3, len * 0.25, len * 0.5, len * 0.75, len - 1.5].map((t) => locate(x, R, 48000, t)),
  };
}

async function pictures(mp4: Uint8Array, wav: Uint8Array) {
  await loadVideoFont(job.style.font);
  const bitmap = async (p?: string | null) => (p ? createImageBitmap(new Blob([readFileSync(p)])) : null);
  const logo = await bitmap(job.logoPath);
  const background = await bitmap(job.backgroundPath);
  const pcm = readWav(wav)!;
  const levels = audioLevels(pcm.pcm, pcm.channels, pcm.sampleRate);
  const full = new OffscreenCanvas(job.width, job.height);
  const fctx = full.getContext("2d")!;
  const scene = makeScene(fctx, { width: job.width, height: job.height, style: job.style, showName: job.showName, website: job.website, logo, background, levels, words: job.words });
  const sw = job.width / 4, sh = job.height / 4;
  const small = new OffscreenCanvas(sw, sh);
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  const shrink = (src: CanvasImageSource) => {
    sctx.drawImage(src, 0, 0, sw, sh);
    return sctx.getImageData(0, 0, sw, sh).data;
  };
  const expected = (k: number) => {
    drawFrame(fctx, scene, k / VIDEO_FPS);
    return shrink(full);
  };
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    return s / ((a.length / 4) * 3);
  };

  const video = document.createElement("video");
  video.muted = true;
  video.src = URL.createObjectURL(new Blob([mp4 as BlobPart], { type: "video/mp4" }));
  await new Promise((ok, fail) => {
    video.onloadeddata = ok;
    video.onerror = () => fail(new Error(`video element: ${video.error?.message}`));
  });
  const last = Math.floor(video.duration * VIDEO_FPS) - 1;
  // Frames where a word starts (the highlight moves, or a page turns), spread over the clip; plus the ends.
  const starts = job.words.map((w) => Math.ceil(w.start * VIDEO_FPS)).filter((k) => k > 3 && k < last - 3);
  // The opening quote moves in the first seconds; the outro card comes in just after the sound ends.
  const end = Math.ceil(job.clipSeconds * VIDEO_FPS);
  const outroPicks = job.outro ? [end + 3, end + 9].filter((k) => k < last - 3) : [];
  // The card holds still at the very end, so neighbouring frames there tie; the end of the sound is checked instead.
  const picks = [2, 20, 90, ...Array.from({ length: 10 }, (_, i) => starts[Math.floor(((i + 0.5) / 10) * starts.length)]!), ...outroPicks, job.outro ? end - 3 : last - 3];
  const rows = [];
  for (const [n, k] of picks.entries()) {
    video.currentTime = (k + 0.5) / VIDEO_FPS;
    await new Promise((ok) => (video.onseeked = ok));
    if (job.snapshot && n === 8) {
      const c = new OffscreenCanvas(job.width, job.height);
      c.getContext("2d")!.drawImage(video, 0, 0);
      writeFileSync(job.snapshot, new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()));
    }
    const got = shrink(video);
    const scores = [-3, -2, -1, 0, 1, 2, 3].map((d) => ({ d, diff: diff(got, expected(k + d)) }));
    const best = scores.reduce((a, b) => (b.diff < a.diff ? b : a));
    const others = scores.filter((s) => s.d !== best.d).map((s) => s.diff);
    rows.push({ frame: k, bestOffset: best.d, diff: r2(best.diff), nextBest: r2(Math.min(...others)) });
  }
  return { duration: r2(video.duration), frames: rows, allAtZero: rows.every((r) => r.bestOffset === 0), worstDiff: Math.max(...rows.map((r) => r.diff)) };
}

(async () => {
  try {
    const mp4 = readFileSync(job.mp4), wav = readFileSync(job.wav);
    const out = { container: await container(mp4), sound: await sound(mp4, wav), pictures: await pictures(mp4, wav) };
    ipcRenderer.send("verified", out);
  } catch (err) {
    ipcRenderer.send("verified", { error: String((err as Error).stack ?? err) });
  }
})();
