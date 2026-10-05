// The hidden clip cutter page. The main process sends a job (the episode
// audio's size and the clips' times); this page reads the audio through IPC,
// only the parts it needs, and cuts each clip to a 16-bit WAV with mediabunny,
// which decodes with the browser's own WebCodecs. The main process saves the
// files. See src/main/clipCutter.ts.

import { ALL_FORMATS, BufferTarget, Conversion, Input, Output, StreamSource, WavOutputFormat } from "mediabunny";
import type { CutJob, CutResult } from "../../shared/cutter";

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

async function cut(job: CutJob, clip: { start: number; end: number }): Promise<Uint8Array> {
  const input = new Input({
    source: new StreamSource({
      getSize: () => job.size,
      read: (start, end) => window.cutter.read(job.id, start, end),
      prefetchProfile: "fileSystem",
    }),
    formats: ALL_FORMATS,
  });
  try {
    const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start: clip.start, end: clip.end },
      audio: { codec: "pcm-s16" },
      video: { discard: true },
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error("The episode's audio couldn't be read for cutting clips.");
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("A clip came out empty.");
    return new Uint8Array(buffer);
  } finally {
    input.dispose();
  }
}

window.cutter.onJob(async (job) => {
  try {
    const clips: Uint8Array[] = [];
    for (const clip of job.clips) clips.push(await cut(job, clip));
    window.cutter.done(job.id, { clips });
  } catch (err) {
    window.cutter.done(job.id, { error: err instanceof Error ? err.message : String(err) });
  }
});
window.cutter.ready();
