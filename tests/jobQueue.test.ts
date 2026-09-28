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
    reviewOptions: () => ({ reviewStep: true, cleanup: { repetitions: false }, hosts: [] }),
    write: () => Promise.reject(new Error("no writer in this test")),
    canWrite: () => false,
    exportEpisode: () => ({ folder: "out", files: [] }),
    autoExport: () => false,
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
  assert.deepEqual(statuses(queue.list()), ["needs-review", "transcribing"]);
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

test("review off: straight to ready; edits are saved with speaker suggestions", async () => {
  const { queue, file, calls } = setup({
    reviewOptions: () => ({ reviewStep: false, cleanup: { repetitions: true }, hosts: ["Nigel T."] }),
  });
  queue.add([file("a.mp3")]);
  await tick();
  calls[0]!.resolve(TRANSCRIPT);
  await tick();
  const job = queue.list()[0]!;
  assert.equal(job.status, "ready");
  const edits = queue.edits(job.id)!;
  assert.equal(edits.cleanup.repetitions, true);
  assert.equal(edits.suggestedNames[0]?.name, "Nigel T.", "first speaker suggested as the host");
});

test("review on: edits persist and marking reviewed makes the job ready", async () => {
  const { queue, file, calls } = setup();
  queue.add([file("a.mp3")]);
  await tick();
  calls[0]!.resolve(TRANSCRIPT);
  await tick();
  const id = queue.list()[0]!.id;
  assert.equal(queue.list()[0]!.status, "needs-review");

  const edits = queue.edits(id)!;
  queue.saveEdits(id, { ...edits, speakerNames: ["Nigel T.", "Pete M."], removed: [1] });
  assert.deepEqual(queue.edits(id)!.speakerNames, ["Nigel T.", "Pete M."]);
  assert.deepEqual(queue.edits(id)!.removed, [1]);

  queue.markReviewed(id);
  assert.equal(queue.list()[0]!.status, "ready");
});

test("jobs saved by alpha.1 as 'transcribed' load as needing review", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "t2-queue-"));
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  writeFileSync(
    join(dataDir, "jobs.json"),
    JSON.stringify([{ id, filePath: "x.mp3", fileName: "x.mp3", status: "transcribed" }]),
  );
  const { queue } = setup({ dataDir });
  assert.equal(queue.list()[0]!.status, "needs-review");
});

// --- Show notes -------------------------------------------------------------

const WRITTEN = {
  version: 1 as const,
  provider: "fake",
  model: "fake",
  generatedAt: "",
  details: { episodeNumber: "", title: "", sponsors: "", nextWeek: "" },
  host: [],
  guest: null,
  runtimeSec: 60,
  notes: { titleSuggestion: "T", summary: "S", aboutGuest: "", timestamps: [], topics: [], quotes: [], rapidFire: [], takeaways: [], resources: [] },
  reference: { topics: [], keywords: [], highNotes: [], quotes: [], frameworks: [] },
  research: null,
  checks: { quotesDropped: [], timestampsDropped: 0, linksDropped: 0 },
};

async function transcribed(overrides: Partial<JobQueueDeps> = {}) {
  const s = setup(overrides);
  s.queue.add([s.file("Episode 386.mp3")]);
  await tick();
  s.calls[0]!.resolve(TRANSCRIPT);
  await tick();
  return { ...s, id: s.queue.list()[0]!.id };
}

test("writing: details are saved, notes written, and the episode number is guessed", async () => {
  const seen: string[] = [];
  const { queue, id, events } = await transcribed({
    write: async (req) => {
      seen.push(req.details.sponsors);
      req.onStage("Writing show notes");
      return WRITTEN;
    },
  });
  assert.equal(queue.details(id)!.episodeNumber, "386");
  queue.markReviewed(id);
  queue.write(id, { episodeNumber: "386", title: "", sponsors: "CalmDesk", nextWeek: "" });
  await tick();
  await tick();
  assert.equal(queue.list()[0]!.status, "written");
  assert.deepEqual(seen, ["CalmDesk"]);
  assert.equal(queue.details(id)!.sponsors, "CalmDesk");
  assert.equal(queue.writing(id)!.notes.summary, "S");
  assert.deepEqual(events, ["transcribed", "written"]);
});

test("writing: a failure keeps the transcript, and retry writes again rather than re-transcribing", async () => {
  let fail = true;
  const { queue, id, calls } = await transcribed({
    write: async () => {
      if (fail) throw new Error("Claude rejected the API key.");
      return WRITTEN;
    },
  });
  queue.markReviewed(id);
  queue.write(id, { episodeNumber: "", title: "", sponsors: "", nextWeek: "" });
  await tick();
  const job = queue.list()[0]!;
  assert.deepEqual([job.status, job.failedStep, job.error], ["failed", "writing", "Claude rejected the API key."]);
  assert.ok(queue.transcript(id), "transcript still there");

  fail = false;
  queue.retry(id);
  await tick();
  await tick();
  assert.equal(queue.list()[0]!.status, "written");
  assert.equal(calls.length, 1, "no second transcription");
});

test("writing: cancelling returns the episode to where it was", async () => {
  const { queue, id } = await transcribed({
    write: (req) =>
      new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new AbortedError("aborted")))),
  });
  queue.markReviewed(id);
  queue.write(id, { episodeNumber: "", title: "", sponsors: "", nextWeek: "" });
  await tick();
  assert.equal(queue.list()[0]!.status, "writing");
  queue.cancel(id);
  await tick();
  assert.equal(queue.list()[0]!.status, "ready");
});

test("writing: with review off and a writing key, notes are written automatically", async () => {
  const { queue } = await transcribed({
    reviewOptions: () => ({ reviewStep: false, cleanup: { repetitions: false }, hosts: [] }),
    canWrite: () => true,
    write: async () => WRITTEN,
  });
  await tick();
  await tick();
  assert.equal(queue.list()[0]!.status, "written");
});

test("writing: an episode still needing review can't be written yet", async () => {
  const { queue, id } = await transcribed({ write: async () => WRITTEN });
  queue.write(id, { episodeNumber: "", title: "", sponsors: "", nextWeek: "" });
  assert.equal(queue.list()[0]!.status, "needs-review");
});

test("export: automatic after writing, recorded on the job; a failed export doesn't undo the notes", async () => {
  let exports = 0;
  let broken = false;
  const { queue, id } = await transcribed({
    write: async () => WRITTEN,
    autoExport: () => true,
    exportEpisode: (data) => {
      exports++;
      if (broken) throw new Error("Couldn't save the file. If it's open in Word, close it and export again.");
      assert.equal(data.writing?.notes.summary, "S");
      return { folder: "C:/out/Episode 386", files: ["a.docx"] };
    },
  });
  queue.markReviewed(id);
  queue.write(id, { episodeNumber: "386", title: "", sponsors: "", nextWeek: "" });
  await tick();
  await tick();
  let job = queue.list()[0]!;
  assert.equal(job.status, "written");
  assert.equal(exports, 1);
  assert.equal(job.exported?.folder, "C:/out/Episode 386");

  broken = true;
  queue.write(id, { episodeNumber: "386", title: "", sponsors: "", nextWeek: "" });
  await tick();
  await tick();
  job = queue.list()[0]!;
  assert.equal(job.status, "written", "notes still count as written");
  assert.match(job.exportError!, /close it and export again/);

  broken = false;
  queue.exportNow(id, ["txt"]);
  assert.equal(queue.list()[0]!.exportError, undefined);
});

test("export: the transcript can be exported before any show notes exist", async () => {
  let writing: unknown = "unset";
  const { queue, id } = await transcribed({
    exportEpisode: (data) => {
      writing = data.writing;
      return { folder: "out", files: [] };
    },
  });
  queue.exportNow(id, ["docx"]);
  assert.equal(writing, null);
});
