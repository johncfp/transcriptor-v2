// The hidden clip cutter page. The main process sends a job (the episode
// audio's size and the clips' times); this page reads the audio through IPC,
// only the parts it needs, decodes it with mediabunny (which uses the
// browser's own WebCodecs) and cuts each clip to a 16-bit WAV. With a video
// job it also draws each clip's frames (with the preview's own drawing code)
// and encodes them with the clip's audio into an MP4 per shape. The main
// process saves the files. See src/main/clipCutter.ts.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamSource,
} from "mediabunny";
import type { CutJob, CutProgress, CutResult, VideoJob } from "../../shared/cutter";
import { audioLevels, SHAPES, VIDEO_FPS, type CaptionWord, type ShapeId } from "../../shared/video";
import { ClipAssembler, fadeEdges, wavFile } from "../../shared/wav";
import { drawFrame, makeScene } from "./video/drawFrame";
import { loadVideoFont } from "./video/fonts";

declare global {
  interface Window {
    cutter: {
      onJob(fn: (job: CutJob) => void): void;
      read(jobId: string, start: number, end: number): Promise<Uint8Array>;
      progress(jobId: string, p: CutProgress): void;
      done(jobId: string, result: CutResult): void;
      ready(): void;
    };
  }
}

type Pcm = { pcm: Int16Array; sampleRate: number; channels: number };

async function cutAll(job: CutJob): Promise<CutResult> {
  const input = new Input({
    source: new StreamSource({
      getSize: () => job.size,
      read: (start, end) => window.cutter.read(job.id, start, end),
      prefetchProfile: "fileSystem",
    }),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("The episode's file has no audio to cut clips from.");
    if (!(await track.canDecode())) throw new Error("This audio format can't be decoded here, so its clips can't be cut.");
    const sink = new AudioSampleSink(track);
    const pcms: Pcm[] = [];
    for (const clip of job.clips) {
      // mediabunny decodes; the cut itself is ours (see ClipAssembler for why).
      const assembler = new ClipAssembler(clip.start, clip.end);
      for await (const sample of sink.samples(clip.start, clip.end)) {
        try {
          if (!sample.numberOfFrames) continue;
          const channels: Float32Array[] = [];
          for (let c = 0; c < sample.numberOfChannels; c++) {
            const data = new Float32Array(sample.numberOfFrames);
            sample.copyTo(data, { planeIndex: c, format: "f32-planar" });
            channels.push(data);
          }
          assembler.add(sample.timestamp, sample.sampleRate, channels);
        } finally {
          sample.close();
        }
      }
      const pcm = assembler.toPcm();
      fadeEdges(pcm.pcm, pcm.sampleRate, pcm.channels);
      pcms.push(pcm);
    }
    const clips = pcms.map((p) => wavFile(p.pcm, p.sampleRate, p.channels));
    if (!job.video) return { clips };
    return { clips, videos: await makeVideos(job.id, job.video, pcms) };
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Video

const loadImage = async (bytes: Uint8Array | null) => (bytes ? createImageBitmap(new Blob([bytes as BlobPart])) : null);

async function makeVideos(jobId: string, video: VideoJob, pcms: Pcm[]): Promise<Uint8Array[][]> {
  const sizes = SHAPES.filter((s) => video.clips.some((c) => c.shapes.includes(s.id)));
  for (const s of sizes) {
    if (!(await canEncodeVideo("avc", { width: s.width, height: s.height }))) {
      throw new Error("This computer can't make H.264 video, so the videos can't be made. The WAV files are fine.");
    }
  }
  await loadVideoFont(video.style.font);
  const [logo, background] = await Promise.all([loadImage(video.logo), loadImage(video.background)]);
  const frames = (p: Pcm) => Math.ceil((p.pcm.length / p.channels / p.sampleRate) * VIDEO_FPS);
  const total = pcms.reduce((n, p, i) => n + frames(p) * (video.clips[i]?.shapes.length ?? 0), 0);
  const progress = { done: 0, total };
  window.cutter.progress(jobId, progress);

  const out: Uint8Array[][] = [];
  for (let i = 0; i < pcms.length; i++) {
    const pcm = pcms[i]!;
    const clip = video.clips[i]!;
    const levels = audioLevels(pcm.pcm, pcm.channels, pcm.sampleRate);
    const perShape: Uint8Array[] = [];
    for (const shape of clip.shapes) {
      perShape.push(await renderOne(jobId, video, shape, clip.words, pcm, levels, logo, background, progress));
    }
    out.push(perShape);
  }
  return out;
}

async function renderOne(
  jobId: string,
  video: VideoJob,
  shape: ShapeId,
  words: CaptionWord[],
  pcm: Pcm,
  levels: number[],
  logo: ImageBitmap | null,
  background: ImageBitmap | null,
  progress: CutProgress,
): Promise<Uint8Array> {
  const spec = SHAPES.find((s) => s.id === shape)!;
  const canvas = new OffscreenCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d")!;
  const scene = makeScene(ctx, {
    width: spec.width,
    height: spec.height,
    style: video.style,
    showName: video.showName,
    logo,
    background,
    levels,
    words,
  });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  // Hardware where the computer has it, Chromium's own encoder where it doesn't.
  const frames = new CanvasSource(canvas, { codec: "avc", quality: QUALITY_HIGH, keyFrameInterval: 2, hardwareAcceleration: "no-preference" });
  // AAC encoders take 44.1 or 48 kHz; other rates (16 kHz recordings, say) are resampled for the video.
  const native = pcm.sampleRate === 44100 || pcm.sampleRate === 48000;
  const resample = native ? {} : { transform: { sampleRate: 48000 } };
  const sound = new AudioSampleSource({ codec: "aac", quality: QUALITY_HIGH, ...resample });
  // The sound goes in early by the encoder's priming, which the MP4 then marks as not to be played.
  const early = (await aacDelay(native ? pcm.sampleRate : 48000, pcm.channels)) / (native ? pcm.sampleRate : 48000);
  output.addVideoTrack(frames, { frameRate: VIDEO_FPS });
  output.addAudioTrack(sound);
  await output.start();

  const seconds = pcm.pcm.length / pcm.channels / pcm.sampleRate;
  const count = Math.ceil(seconds * VIDEO_FPS);
  const perSecond = pcm.sampleRate * pcm.channels;
  for (let f = 0; f < count; f++) {
    const t = f / VIDEO_FPS;
    // The audio a second at a time alongside the frames, so the MP4 interleaves them.
    if (f % VIDEO_FPS === 0) {
      const a = Math.round(t * pcm.sampleRate) * pcm.channels;
      const b = Math.min(pcm.pcm.length, a + perSecond);
      if (b > a) {
        await sound.add(new AudioSample({ data: pcm.pcm.slice(a, b), format: "s16", numberOfChannels: pcm.channels, sampleRate: pcm.sampleRate, timestamp: t - early }));
      }
    }
    drawFrame(ctx, scene, t);
    await frames.add(t, 1 / VIDEO_FPS);
    progress.done++;
    if (progress.done % 15 === 0) window.cutter.progress(jobId, progress);
  }
  frames.close();
  sound.close();
  await output.finalize();
  window.cutter.progress(jobId, progress);
  return new Uint8Array(output.target.buffer!);
}

const delays = new Map<string, Promise<number>>();

/**
 * Frames of silence this computer's AAC encoder puts before the sound it's
 * given: macOS's adds its 2112 frames of priming, Windows' none. Without
 * allowing for it the sound plays that much late (48 ms at 44.1 kHz).
 * Measured once per format by encoding a burst of noise and finding it again
 * in the decoded result.
 */
function aacDelay(sampleRate: number, channels: number): Promise<number> {
  const key = `${sampleRate}/${channels}`;
  let delay = delays.get(key);
  if (!delay) delays.set(key, (delay = measureAacDelay(sampleRate, channels)));
  return delay;
}

async function measureAacDelay(sampleRate: number, channels: number): Promise<number> {
  const frames = sampleRate;
  const at = Math.round(sampleRate / 4);
  const W = 1024;
  const burst = new Float32Array(frames);
  let seed = 1;
  for (let i = 0; i < W; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    burst[at + i] = (seed / 2147483648 - 0.5) * 1.2 * Math.sin((Math.PI * i) / W);
  }
  const planar = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) planar.set(burst, c * frames);

  let failure: unknown = null;
  const chunks: EncodedAudioChunk[] = [];
  let config: AudioDecoderConfig | undefined;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      config ??= meta?.decoderConfig;
    },
    error: (e) => (failure = e),
  });
  encoder.configure({ codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate: 128000 });
  encoder.encode(new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp: 0, data: planar }));
  await encoder.flush();
  encoder.close();

  const heard = new Float32Array(frames + 8192);
  let pos = 0;
  const decoder = new AudioDecoder({
    output: (data) => {
      const n = Math.min(data.numberOfFrames, heard.length - pos);
      if (n > 0) {
        const left = new Float32Array(data.numberOfFrames);
        data.copyTo(left, { planeIndex: 0, format: "f32-planar" });
        heard.set(left.subarray(0, n), pos);
      }
      pos += data.numberOfFrames;
      data.close();
    },
    error: (e) => (failure = e),
  });
  decoder.configure(config ?? { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels });
  for (const chunk of chunks) decoder.decode(chunk);
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;

  let best = 0, bestScore = -Infinity;
  for (let lag = 0; lag <= 4096; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) s += burst[at + i]! * heard[at + lag + i]!;
    if (s > bestScore) [best, bestScore] = [lag, s];
  }
  return best;
}

window.cutter.onJob(async (job) => {
  try {
    window.cutter.done(job.id, await cutAll(job));
  } catch (err) {
    window.cutter.done(job.id, { error: err instanceof Error ? err.message : String(err) });
  }
});
window.cutter.ready();
