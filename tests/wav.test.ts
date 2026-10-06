import assert from "node:assert/strict";
import { test } from "node:test";
import { ClipAssembler, readWav, wavFile } from "../src/shared/wav";

const RATE = 44100;
/** Sample n of a test signal: a ramp that wraps, so every position is recognisable. */
const value = (n: number) => ((n % 20000) - 10000) / 32768;
/** As the WAV stores it. */
const int16 = (v: number) => Math.round(v < 0 ? v * 32768 : v * 32767) + 0; // + 0 turns -0 into 0

/** Decoded blocks of `size` frames covering [0, totalFrames), with timestamps off by up to `jitter` seconds. */
function* blocks(totalFrames: number, size = 1024, channels = 1, jitter = 0) {
  for (let at = 0; at < totalFrames; at += size) {
    const n = Math.min(size, totalFrames - at);
    const data = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: n }, (_, k) => value(at + k) * (c ? -1 : 1)));
    yield { timestamp: at / RATE + (at % 3 === 0 ? jitter : -jitter), data };
  }
}

function samples(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset);
  const channels = view.getUint16(22, true);
  const count = view.getUint32(40, true) / 2;
  return { rate: view.getUint32(24, true), channels, values: Array.from({ length: count }, (_, i) => view.getInt16(44 + i * 2, true)) };
}

test("a clip is cut sample-exact from blocks that straddle its edges", () => {
  // Start and end mid-block, at times that don't land on a sample: the case that broke mediabunny's trim.
  const start = 1431.958;
  const end = 1457.528;
  const from = Math.round(start * RATE);
  const to = Math.round(end * RATE);
  const clip = new ClipAssembler(start, end);
  // Only blocks near the clip, as the decoder would give.
  const first = Math.floor(from / 1024) * 1024 - 2048;
  for (let at = first; at < to + 4096; at += 1024) {
    clip.add(at / RATE, RATE, [Float32Array.from({ length: 1024 }, (_, k) => value(at + k))]);
  }
  assert.ok(clip.complete);
  const { rate, channels, values } = samples(clip.toWav());
  assert.deepEqual([rate, channels, values.length], [RATE, 1, to - from]);
  assert.ok(values.every((v, i) => v === int16(value(from + i))), "every sample in place, first to last");
});

test("timestamps that round a sample off don't leave gaps or doubled samples; stereo is interleaved", () => {
  const clip = new ClipAssembler(0.5, 1.5);
  for (const b of blocks(RATE * 2, 1024, 2, 0.4 / RATE)) clip.add(b.timestamp, RATE, b.data);
  const { channels, values } = samples(clip.toWav());
  assert.equal(channels, 2);
  assert.equal(values.length, RATE * 2);
  const from = RATE / 2;
  for (let i = 0; i < RATE; i++) {
    assert.equal(values[i * 2], int16(value(from + i)));
    assert.equal(values[i * 2 + 1], int16(-value(from + i)));
  }
});

test("empty blocks are skipped; audio that ends early gives a shorter clip; nothing found is an error", () => {
  const clip = new ClipAssembler(1, 3);
  clip.add(1, RATE, [new Float32Array(0)]);
  for (const b of blocks(RATE * 2)) clip.add(b.timestamp, RATE, b.data); // audio ends at 2 s
  assert.ok(!clip.complete);
  assert.equal(samples(clip.toWav()).values.length, RATE);
  assert.throws(() => new ClipAssembler(5, 6).toWav(), /No audio was found/);
  assert.throws(() => new ClipAssembler(6, 5), /end after it starts/);
});

test("a format change partway through is an error, not a garbled clip", () => {
  const clip = new ClipAssembler(0, 1);
  clip.add(0, RATE, [new Float32Array(1024)]);
  assert.throws(() => clip.add(1024 / RATE, 48000, [new Float32Array(1024)]), /format changes/);
  assert.throws(() => clip.add(1024 / RATE, RATE, [new Float32Array(1024), new Float32Array(1024)]), /format changes/);
});

test("WAV header: RIFF/WAVE, PCM, rate, channels, 16-bit, sizes", () => {
  const wav = wavFile(Int16Array.from([1, -1, 32767, -32768]), 16000, 2);
  const view = new DataView(wav.buffer);
  const text = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  assert.deepEqual([text(0), text(8), text(12), text(36)], ["RIFF", "WAVE", "fmt ", "data"]);
  assert.deepEqual(
    [view.getUint32(4, true), view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true), view.getUint32(40, true)],
    [36 + 8, 1, 2, 16000, 64000, 4, 16, 8],
  );
  assert.deepEqual([view.getInt16(44, true), view.getInt16(50, true)], [1, -32768]);
});

test("reading a WAV back: samples, rate and channels; anything else is null", () => {
  const wav = wavFile(Int16Array.from([1, -2, 3, -4]), 22050, 2);
  const back = readWav(wav)!;
  assert.deepEqual([...back.pcm], [1, -2, 3, -4]);
  assert.deepEqual([back.sampleRate, back.channels], [22050, 2]);
  assert.equal(readWav(new Uint8Array(10)), null);
  const float = wav.slice();
  new DataView(float.buffer).setUint16(20, 3, true); // IEEE float, not 16-bit PCM
  assert.equal(readWav(float), null);
});
