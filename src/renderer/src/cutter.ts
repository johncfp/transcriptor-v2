// The hidden clip cutter page. The main process sends a job (the episode
// audio's size and the clips' times); this page reads the audio through IPC,
// only the parts it needs, decodes it with mediabunny (which uses the
// browser's own WebCodecs) and cuts each clip to a 16-bit WAV. The main
// process saves the files. See src/main/clipCutter.ts.

import { ALL_FORMATS, AudioSampleSink, Input, StreamSource } from "mediabunny";
import type { CutJob, CutResult } from "../../shared/cutter";
import { ClipAssembler } from "../../shared/wav";

declare global {
  interface Window {
    cutter: {
      onJob(fn: (job: CutJob) => void): void;
      read(jobId: string, start: number, end: number): Promise<Uint8Array>;
      done(jobId: string, result: CutResult): void;
      ready(): void;
    };
  }
}

async function cutAll(job: CutJob): Promise<Uint8Array[]> {
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
    const out: Uint8Array[] = [];
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
      out.push(assembler.toWav());
    }
    return out;
  } finally {
    input.dispose();
  }
}

window.cutter.onJob(async (job) => {
  try {
    window.cutter.done(job.id, { clips: await cutAll(job) });
  } catch (err) {
    window.cutter.done(job.id, { error: err instanceof Error ? err.message : String(err) });
  }
});
window.cutter.ready();
