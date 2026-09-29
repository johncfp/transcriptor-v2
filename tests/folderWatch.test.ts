import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { FolderWatcher, type FolderWatcherDeps } from "../src/main/watch/folderWatcher";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "t2-watch-"));
  const root = join(base, "My Drive", "Podcast");
  mkdirSync(root, { recursive: true });
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const put = (rel: string, body = "audio") => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  const watcher = (machine: string, extra: Partial<FolderWatcherDeps> = {}) => {
    const queued: { path: string; relPath: string }[] = [];
    const w = new FolderWatcher({
      root,
      inboxDir: join(base, machine, "inbox"),
      statePath: join(base, machine, "folder-watch.json"),
      machineId: machine,
      machineName: `${machine}'s laptop`,
      onFile: (path, relPath) => {
        queued.push({ path, relPath });
        return `job-${machine}-${queued.length}`;
      },
      now: clock.now,
      ...extra,
    });
    return { w, queued };
  };
  return { base, root, clock, put, watcher };
}

test("folder watch: existing files skipped; a new file in a subfolder is taken once stable and claimed, then moved to Done", async () => {
  const { root, clock, put, watcher } = setup();
  put("old episode.mp3");
  put("Done/ignored.mp3");
  const { w, queued } = watcher("A");
  await w.scan(); // first look: only notes what's there

  put("Show A/Episode 12.m4a", "new audio");
  put("Show A/notes.txt");
  put("Transcriptor Exports/also ignored.mp3");
  await w.scan(); // seen, not yet stable
  clock.advance(10_000);
  await w.scan();
  assert.equal(queued.length, 0, "not stable for 20 s yet");
  clock.advance(15_000);
  await w.scan(); // stable: writes a claim
  const claims = readdirSync(join(root, ".transcriptor", "claims"));
  assert.equal(claims.length, 1);
  assert.match(readFileSync(join(root, ".transcriptor", "claims", claims[0]!), "utf8"), /"file":"Show A\/Episode 12\.m4a"/);
  clock.advance(30_000);
  await w.scan();
  assert.equal(queued.length, 0, "waits for other computers' claims to sync");
  clock.advance(31_000);
  await w.scan();

  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.relPath, join("Show A", "Episode 12.m4a"));
  assert.equal(readFileSync(queued[0]!.path, "utf8"), "new audio", "a copy in the app's inbox");
  assert.equal(basename(queued[0]!.path), "Episode 12.m4a", "keeping its name, which becomes the episode's");
  assert.ok(existsSync(join(root, "Show A", "Episode 12.m4a")), "the original stays until it's transcribed");
  assert.equal(w.status().pickedUp, 1);

  await w.transcribed("job-A-1");
  assert.ok(!existsSync(join(root, "Show A", "Episode 12.m4a")));
  assert.ok(existsSync(join(root, "Done", "Show A", "Episode 12.m4a")), "moved to Done, keeping its subfolder");
  assert.deepEqual(readdirSync(join(root, ".transcriptor", "claims")), [], "claims removed");
  assert.ok(existsSync(join(root, "old episode.mp3")), "files there before watching are left alone");

  // Nothing more to take.
  clock.advance(120_000);
  await w.scan();
  clock.advance(120_000);
  await w.scan();
  assert.equal(queued.length, 1);
});

test("folder watch: two computers on one shared folder: the earliest claim wins, the other skips", async () => {
  const { clock, put, watcher } = setup();
  const a = watcher("machine-a");
  const b = watcher("machine-b");
  await a.w.scan();
  await b.w.scan();
  put("ep.wav");
  await a.w.scan();
  await b.w.scan();
  clock.advance(21_000);
  await b.w.scan(); // B claims first
  clock.advance(1_000);
  await a.w.scan(); // A claims a second later
  clock.advance(61_000);
  await a.w.scan();
  await b.w.scan();
  assert.equal(b.queued.length, 1, "B claimed first");
  assert.equal(a.queued.length, 0, "A saw B's earlier claim and skipped");
  clock.advance(200_000);
  await a.w.scan();
  clock.advance(200_000);
  await a.w.scan();
  assert.equal(a.queued.length, 0, "and doesn't come back to it");
});

test("folder watch: a file still changing isn't taken; state survives a restart; a new folder starts over", async () => {
  const { root, clock, put, watcher } = setup();
  const first = watcher("A");
  await first.w.scan();
  const path = put("growing.mp3", "a");
  await first.w.scan();
  for (let i = 0; i < 4; i++) {
    clock.advance(15_000);
    // Drive is still writing it: same size, newer modification time.
    utimesSync(path, new Date(), new Date(Date.now() + (i + 1) * 60_000));
    await first.w.scan();
  }
  assert.equal(first.queued.length, 0);

  // Restart: the same folder keeps its state, so the file isn't treated as "already there".
  const second = watcher("A");
  await second.w.scan();
  clock.advance(21_000);
  await second.w.scan();
  clock.advance(61_000);
  await second.w.scan();
  assert.equal(second.queued.length, 1, "picked up after the restart");

  // Another folder: its existing files are skipped.
  const other = join(root, "..", "Other");
  mkdirSync(other);
  writeFileSync(join(other, "x.mp3"), "x");
  const moved = watcher("A", { root: other });
  await moved.w.scan();
  clock.advance(100_000);
  await moved.w.scan();
  clock.advance(100_000);
  await moved.w.scan();
  assert.equal(moved.queued.length, 0);
});

test("folder watch: Done keeps earlier files; a missing folder is a readable error", async () => {
  const { root, clock, put, watcher } = setup();
  const { w } = watcher("A");
  await w.scan();
  put("Done/ep.mp3", "earlier");
  put("ep.mp3", "new one");
  await w.scan();
  clock.advance(21_000);
  await w.scan();
  clock.advance(61_000);
  await w.scan();
  await w.transcribed("job-A-1");
  assert.equal(readFileSync(join(root, "Done", "ep.mp3"), "utf8"), "earlier");
  assert.equal(readFileSync(join(root, "Done", "ep (2).mp3"), "utf8"), "new one");

  const gone = watcher("B", { root: join(root, "nope") });
  await gone.w.scan();
  assert.match(gone.w.status().error ?? "", /can't be found/);
});
