// Assembling a clip from decoded audio blocks, and writing it as a 16-bit WAV.
// Pure, so it's tested without a browser; the clip cutter page feeds it the
// blocks mediabunny decodes (src/renderer/src/cutter.ts). Doing the cut here
// rather than with mediabunny's own trim avoids a bug there: rounding at the
// cut can leave an empty block, which its PCM encoder then fails on.

/**
 * Collects the audio between `start` and `end` (seconds), sample-exact, from
 * decoded blocks in time order. Blocks may overlap the edges; anything
 * outside is dropped. Each block's position comes from its timestamp, but a
 * block that starts within a sample of where the previous one ended is
 * treated as following on, so rounding never leaves a gap or a doubled sample.
 */
export class ClipAssembler {
  private rate = 0;
  private channels = 0;
  private from = 0;
  private pcm: Int16Array = new Int16Array(0);
  /** Frames filled so far, counted from `from`. */
  private filled = 0;
  private next: number | null = null;

  constructor(
    private readonly start: number,
    private readonly end: number,
  ) {
    if (!(end > start) || start < 0) throw new Error("A clip must end after it starts.");
  }

  /** One decoded block: when it starts (seconds), its rate, and one array of samples (−1…1) per channel. */
  add(timestamp: number, sampleRate: number, channelData: Float32Array[]): void {
    const frames = channelData[0]?.length ?? 0;
    if (!frames) return;
    if (!this.rate) {
      this.rate = sampleRate;
      this.channels = channelData.length;
      this.from = Math.round(this.start * sampleRate);
      this.pcm = new Int16Array((Math.round(this.end * sampleRate) - this.from) * this.channels);
    } else if (sampleRate !== this.rate || channelData.length !== this.channels) {
      throw new Error("The audio's format changes partway through, so this clip can't be cut.");
    }
    let at = Math.round(timestamp * this.rate);
    if (this.next !== null && Math.abs(at - this.next) <= 1) at = this.next;
    this.next = at + frames;

    const total = this.pcm.length / this.channels;
    const first = Math.max(0, this.from - at);
    const last = Math.min(frames, this.from + total - at);
    for (let c = 0; c < this.channels; c++) {
      const data = channelData[c]!;
      for (let k = first; k < last; k++) {
        const v = Math.max(-1, Math.min(1, data[k]!));
        this.pcm[(at + k - this.from) * this.channels + c] = Math.round(v < 0 ? v * 32768 : v * 32767);
      }
    }
    if (last > first) this.filled = Math.max(this.filled, at + last - this.from);
  }

  /** True once every frame up to the end has been filled. */
  get complete(): boolean {
    return this.rate > 0 && this.filled * this.channels >= this.pcm.length;
  }

  /** The clip's samples (interleaved, 16-bit); shorter than asked if the audio ended first. */
  toPcm(): { pcm: Int16Array; sampleRate: number; channels: number } {
    if (!this.rate || !this.filled) throw new Error("No audio was found for this clip.");
    return { pcm: this.pcm.subarray(0, this.filled * this.channels), sampleRate: this.rate, channels: this.channels };
  }

  /** The clip as a WAV file. */
  toWav(): Uint8Array {
    const { pcm, sampleRate, channels } = this.toPcm();
    return wavFile(pcm, sampleRate, channels);
  }
}

/** A 16-bit PCM WAV file from interleaved samples. */
export function wavFile(pcm: Int16Array, sampleRate: number, channels: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
  return bytes;
}

/** A 16-bit PCM WAV file's samples (interleaved), rate and channels; null if it isn't one. */
export function readWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number; channels: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") return null;
  let p = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (p + 8 <= bytes.length) {
    const id = text(p);
    const size = view.getUint32(p + 4, true);
    if (id === "fmt ") fmt = { format: view.getUint16(p + 8, true), channels: view.getUint16(p + 10, true), rate: view.getUint32(p + 12, true), bits: view.getUint16(p + 22, true) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return null;
      const count = Math.floor(Math.min(size, bytes.length - p - 8) / 2);
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) pcm[i] = view.getInt16(p + 8 + i * 2, true);
      return { pcm, sampleRate: fmt.rate, channels: fmt.channels };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}
