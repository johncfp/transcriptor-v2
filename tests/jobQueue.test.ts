import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../src/shared/jobs";
import type { Transcript } from "../src/shared/transcript";
import { JobQueue, type JobEvent, type JobQueueDeps } from "../src/main/jobQueue";
import { AbortedError } from "../src/main/transcribe/multipart";
import type { TranscribeRequest, Transcriber } from "../src/main/transcribe/types";

const TRANSCRIPT: Transcript = {
  version: 1,
  provider: "fake",
  model: "fake",
  durationSec: 60,
  speakerCount: 2,
  words: [
    { text: "Welcome", start: 0, end: 0.5, speaker: 0 },
    { text: "Thanks", start: 1, end: 1.5, speaker: 1 },
  ],
  createdAt: "2026-09-28T00:00:00.000Z",
};

/** A transcriber whose calls finish only when the test says so. */
function fakeTranscriber() {
  const calls: { req: TranscribeRequest; resolve: (t: Transcript) => void; reject: (e: Error) => void }[] = [];
  const transcriber: Transcriber = {
    providerId: "elevenlabs",
    label: "Fake",
    maxBytes: 1000,
    transcribe: (req) =>
      new Promise((resolve, reject) => {
        calls.push({ req, resolve, reject });
        req.signal?.addEventListener("abort", () => reject(new AbortedError("aborted")));
      }),
  };
  return { transcriber, calls };
}

function setup(overrides: Partial<JobQueueDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "t2-queue-"));
  const fake = fakeTranscriber();
  const events: JobEvent["type"][] = [];
  const deps: JobQueueDeps = {
    dataDir,
    transcriber: fake.transcriber,
    getKey: () => "key",
    needsApproval: () => true,
    onEvent: (e) => events.push(e.type),
    ...overrides,
  };
  const file = (name: string, bytes = 10) => {
    const p = join(dataDir, name);
    writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };
  return { queue: new JobQueue(deps), deps, dataDir, file, events, ...fake };
}

const tick = () => new Promise((r) => setImmediate(r));
const statuses = (jobs: Job[]) => jobs.map((j) => j.status);

test("rejects non-audio, empty, oversized and duplicate files", () => {
  const { queue, file } = setup();
  const ok = file("a.mp3");
  const r = queue.add([file("notes.txt"), file("empty.wav", 0), file("huge.wav", 2000), ok, ok]);
  assert.equal(r.added.length, 1);
  assert.deepEqual(
    r.rejected.map((x) => x.fileName),
    ["notes.txt", "empty.wav", "huge.wav", "a.mp3"],
  );
  assert.match(r.rejected[3]!.reason, /Already in the queue/);
});

test("manual files start right away and run one at a time", async () => {
  const { queue, file, calls, events } = setup();
  queue.add([file("1.mp3"), file("2.mp3")]);
  await tick();
  assert.deepEqual(statuses(queue.list()), ["transcribing", "queued"]);
  assert.equal(calls.length, 1);

  calls[0]!.resolve(TRANSCRIPT);
  await tick();
  assert.deepEqual(statuses(queue.list()), ["transcribed", "transcribing"]);
  assert.equal(queue.list()[0]!.wordCount, 2);
  assert.deepEqual(queue.transcript(queue.list()[0]!.id)?.words, TRANSCRIPT.words);
  assert.deepEqual(events, ["transcribed"]);
});

test("watched files wait for approval when the setting says so", async () => {
  let approve = true;
  const { queue, file, calls, events } = setup({ needsApproval: () => approve });
  queue.add([file("w1.mp3")], "watch");
  await tick();
  assert.equal(queue.list()[0]!.status, "awaiting-approval");
  assert.equal(calls.length, 0);
  assert.deepEqual(events, ["awaiting-approval"]);

  queue.approve(queue.list()[0]!.id);
  await tick();
  assert.equal(queue.list()[0]!.status, "transcribing");

  approve = false;
  queue.add([file("w2.mp3")], "watch");
  assert.equal(queue.list()[1]!.status, "queued");
});

test("a missing key fails with a pointer to Settings", async () => {
  const { queue, file, events } = setup({ getKey: () => null });
  queue.add([file("a.mp3")]);
  await tick();
  const job = queue.list()[0]!;
  assert.equal(job.status, "failed");
  assert.match(job.error!, /Add your ElevenLabs Scribe API key in Settings/);
  assert.deepEqual(events, ["failed"]);
});

test("cancel stops the running job, retry runs it again", async () => {
  const { queue, file, calls } = setup();
  queue.add([file("a.mp3")]);
  await tick();
  const id = queue.list()[0]!.id;
  queue.cancel(id);
  await tick();
  assert.equal(queue.list()[0]!.status, "cancelled");
  assert.equal(queue.isBusy(), false);

  queue.retry(id);
  await tick();
  assert.equal(queue.list()[0]!.status, "transcribing");
  assert.equal(calls.length, 2);
});

test("a job interrupted by a restart is queued again and resumes", async () => {
  const first = setup();
  first.queue.add([first.file("a.mp3")]);
  await tick();
  assert.equal(first.queue.list()[0]!.status, "transcribing");

  // A new queue over the same folder, as after a crash.
  const again = setup({ dataDir: first.dataDir });
  assert.equal(again.queue.list()[0]!.status, "queued");
});

test("remove deletes the saved transcript but never the audio", async () => {
  const { queue, file, calls, dataDir } = setup();
  const audio = file("a.mp3");
  queue.add([audio]);
  await tick();
  calls[0]!.resolve(TRANSCRIPT);
  await tick();
  const id = queue.list()[0]!.id;
  assert.ok(existsSync(join(dataDir, "episodes", id, "transcript.json")));

  queue.remove(id);
  assert.equal(queue.list().length, 0);
  assert.equal(existsSync(join(dataDir, "episodes", id)), false);
  assert.ok(existsSync(audio));
});

test("a damaged jobs.json is ignored, and unknown ids can't read files", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "t2-queue-"));
  writeFileSync(
    join(dataDir, "jobs.json"),
    JSON.stringify([{ id: "../../etc", filePath: "x", fileName: "x", status: "queued" }, 42]),
  );
  const { queue } = setup({ dataDir });
  assert.equal(queue.list().length, 0);
  assert.equal(queue.transcript("../../etc"), null);
});
