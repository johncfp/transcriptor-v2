import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  httpErrorMessage,
  logprobToConfidence,
  parseElevenLabs,
  transcribeElevenLabs,
} from "../src/main/transcribe/elevenlabs";
import { AbortedError } from "../src/main/transcribe/multipart";

const approx = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test("keeps words, drops spacing and audio events, maps confidence", () => {
  const t = parseElevenLabs({
    language_code: "en",
    audio_duration_secs: 912.4,
    words: [
      { text: "Hello", type: "word", start: 0, end: 0.4, speaker_id: "speaker_0", logprob: -0.02 },
      { text: " ", type: "spacing", start: 0.4, end: 0.42 },
      { text: "world", type: "word", start: 0.42, end: 0.8, speaker_id: "speaker_1", logprob: Math.log(0.3) },
      { text: "(laughs)", type: "audio_event", start: 0.8, end: 1.0 },
    ],
  });
  assert.deepEqual(
    t.words.map((w) => w.text),
    ["Hello", "world"],
  );
  approx(t.words[0]!.confidence, logprobToConfidence(-0.02));
  approx(t.words[1]!.confidence, 0.3);
  assert.equal(t.durationSec, 912.4);
  assert.equal(t.language, "en");
  assert.equal(t.speakerCount, 2);
});

test("speakers are numbered by first appearance", () => {
  const t = parseElevenLabs({
    words: [
      { text: "a", type: "word", start: 0, end: 1, speaker_id: "speaker_3" },
      { text: "b", type: "word", start: 1, end: 2, speaker_id: "speaker_1" },
      { text: "c", type: "word", start: 2, end: 3, speaker_id: "speaker_3" },
    ],
  });
  assert.deepEqual(
    t.words.map((w) => w.speaker),
    [0, 1, 0],
  );
});

test("unusable responses give no words", () => {
  assert.equal(parseElevenLabs(null).words.length, 0);
  assert.equal(parseElevenLabs({ words: [{ text: "x", type: "word", start: "?", end: 1 }] }).words.length, 0);
});

test("error messages", () => {
  assert.match(httpErrorMessage(401, "{}", "ElevenLabs"), /rejected the API key/);
  assert.match(httpErrorMessage(429, "", "ElevenLabs"), /429/);
  assert.match(httpErrorMessage(422, JSON.stringify({ detail: { message: "bad file" } }), "ElevenLabs"), /bad file/);
  assert.match(httpErrorMessage(500, "not json", "ElevenLabs"), /\(500\)\.$/);
});

// A local stand-in for the ElevenLabs API that records what it received.
function fakeServer(respond: (body: Buffer, req: http.IncomingMessage) => [number, unknown]) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const [status, json] = respond(Buffer.concat(chunks), req);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

function audioFile(bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "t2-test-"));
  const path = join(dir, "episode.mp3");
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

test("uploads the file as multipart with the key and reports progress", async () => {
  let received: { body: Buffer; key: string | undefined; type: string | undefined } | null = null;
  const server = await fakeServer((body, req) => {
    received = { body, key: req.headers["xi-api-key"] as string, type: req.headers["content-type"] };
    return [200, { audio_duration_secs: 3, words: [{ text: "Hi", type: "word", start: 0, end: 1, speaker_id: "speaker_0" }] }];
  });
  try {
    const filePath = audioFile(3 * 1024 * 1024);
    const progress: (number | null)[] = [];
    const t = await transcribeElevenLabs({
      filePath,
      apiKey: "sk_test",
      baseUrl: server.url,
      onProgress: (_stage, p) => progress.push(p),
    });
    assert.equal(t.words[0]!.text, "Hi");
    assert.ok(received);
    const r = received as { body: Buffer; key: string; type: string };
    assert.equal(r.key, "sk_test");
    assert.match(r.type, /^multipart\/form-data; boundary=/);
    const text = r.body.toString("latin1");
    assert.match(text, /name="model_id"\r\n\r\nscribe_v2\r\n/);
    assert.match(text, /name="diarize"\r\n\r\ntrue\r\n/);
    assert.match(text, /name="file"; filename="episode.mp3"/);
    assert.ok(r.body.length > 3 * 1024 * 1024, "the whole file was sent");
    // Upload fractions only go up, stop short of 1, then switch to "waiting".
    const fractions = progress.filter((p): p is number => p !== null);
    assert.ok(fractions.length > 2);
    assert.ok(fractions.every((p, i) => i === 0 || p >= fractions[i - 1]!));
    assert.ok(Math.max(...fractions) <= 0.99);
    assert.equal(progress.at(-1), null);
  } finally {
    server.close();
  }
});

test("a rejected key becomes a readable error", async () => {
  const server = await fakeServer(() => [401, { detail: { message: "invalid_api_key" } }]);
  try {
    await assert.rejects(
      transcribeElevenLabs({ filePath: audioFile(1000), apiKey: "bad", baseUrl: server.url }),
      /rejected the API key/,
    );
  } finally {
    server.close();
  }
});

test("no speech found is an error, not an empty transcript", async () => {
  const server = await fakeServer(() => [200, { words: [] }]);
  try {
    await assert.rejects(
      transcribeElevenLabs({ filePath: audioFile(1000), apiKey: "k", baseUrl: server.url }),
      /didn't find any speech/,
    );
  } finally {
    server.close();
  }
});

test("an unreachable server gives a connection message", async () => {
  await assert.rejects(
    transcribeElevenLabs({ filePath: audioFile(1000), apiKey: "k", baseUrl: "http://127.0.0.1:1" }),
    /Couldn't reach ElevenLabs/,
  );
});

test("cancelling aborts the upload", async () => {
  const server = await fakeServer(() => [200, { words: [] }]);
  try {
    const abort = new AbortController();
    const run = transcribeElevenLabs({
      filePath: audioFile(20 * 1024 * 1024),
      apiKey: "k",
      baseUrl: server.url,
      signal: abort.signal,
      onProgress: (_s, p) => p !== null && p > 0.1 && abort.abort(),
    });
    await assert.rejects(run, AbortedError);
  } finally {
    server.close();
  }
});

test("false starts: no_verbatim is sent only when asked for, and recorded", async () => {
  const bodies: string[] = [];
  const server = await fakeServer((body) => {
    bodies.push(body.toString("latin1"));
    return [200, { words: [{ text: "Hi", type: "word", start: 0, end: 1, speaker_id: "speaker_0" }] }];
  });
  try {
    const plain = await transcribeElevenLabs({ filePath: audioFile(100), apiKey: "k", baseUrl: server.url });
    const clean = await transcribeElevenLabs({
      filePath: audioFile(100),
      apiKey: "k",
      baseUrl: server.url,
      removeFalseStarts: true,
    });
    assert.doesNotMatch(bodies[0]!, /no_verbatim/);
    assert.match(bodies[1]!, /name="no_verbatim"\r\n\r\ntrue\r\n/);
    assert.equal(plain.falseStartsRemoved, undefined);
    assert.equal(clean.falseStartsRemoved, true);
  } finally {
    server.close();
  }
});
