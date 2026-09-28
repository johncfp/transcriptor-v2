import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DriveClient, parseFolderId, type DriveFile } from "../src/main/watch/driveClient";
import { DriveWatcher } from "../src/main/watch/driveWatcher";
import { authorizationUrl, base64url, pkcePair, type GoogleTokens } from "../src/main/watch/googleAuth";

test("PKCE: the challenge is the base64url SHA-256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, base64url(createHash("sha256").update(verifier).digest()));
  const url = new URL(authorizationUrl({ redirectUri: "http://127.0.0.1:5000/callback", challenge, state: "s" }));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.readonly");
});

test("folder links and ids", () => {
  assert.equal(parseFolderId("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing"), "1AbCdEfGhIjKlMnOp");
  assert.equal(parseFolderId("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
  assert.equal(parseFolderId("1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
  assert.equal(parseFolderId("not a folder"), null);
});

/** A fake Drive folder the watcher can poll. */
function fakeDrive(initial: DriveFile[]) {
  const files = [...initial];
  const downloads: string[] = [];
  let failNext = false;
  return {
    files,
    downloads,
    failOnce: () => (failNext = true),
    drive: {
      listFolder: async () => [...files],
      download: async (id: string, path: string) => {
        if (failNext) {
          failNext = false;
          throw new Error("network");
        }
        downloads.push(id);
        writeFileSync(path, "audio");
      },
    },
  };
}

function watcher(drive: ReturnType<typeof fakeDrive>["drive"], dir: string, onFile: (p: string) => void, folderId = "folder1") {
  return new DriveWatcher({
    drive,
    folderId,
    inboxDir: join(dir, "inbox"),
    statePath: join(dir, "watch-state.json"),
    onFile,
  });
}

test("watcher: files already there are left alone; new audio is downloaded and queued", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t2-drive-"));
  const fake = fakeDrive([{ id: "old-episode-1", name: "Episode 380.mp3", mimeType: "audio/mpeg" }]);
  const queued: string[] = [];
  const w = watcher(fake.drive, dir, (p) => queued.push(p));

  assert.deepEqual(await w.check(), [], "first look only takes a baseline");
  fake.files.push(
    { id: "new-episode-2", name: "Episode 386.m4a", mimeType: "audio/mp4" },
    { id: "notes-file-3", name: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  );
  const added = await w.check();
  assert.equal(added.length, 1);
  assert.match(added[0]!, /new-epis Episode 386\.m4a$/);
  assert.deepEqual(queued, added);
  assert.deepEqual(fake.downloads, ["new-episode-2"]);
  assert.deepEqual(await w.check(), [], "nothing twice");
});

test("watcher: a failed download is retried; state survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t2-drive-"));
  const fake = fakeDrive([]);
  const queued: string[] = [];
  const errors: string[] = [];
  const w = new DriveWatcher({
    drive: fake.drive,
    folderId: "folder1",
    inboxDir: join(dir, "inbox"),
    statePath: join(dir, "watch-state.json"),
    onFile: (p) => queued.push(p),
    onError: (e) => errors.push(e),
  });
  await w.check(); // baseline of an empty folder
  fake.files.push({ id: "ep-1-abcdefgh", name: "ep1.wav", mimeType: "audio/wav" });
  fake.failOnce();
  assert.deepEqual(await w.check(), []);
  assert.match(errors[0]!, /Couldn't download ep1\.wav/);
  assert.equal((await w.check()).length, 1, "retried on the next check");

  // A new watcher over the same state file doesn't re-import anything.
  const again = watcher(fake.drive, dir, (p) => queued.push(p));
  assert.deepEqual(await again.check(), []);
  assert.equal(queued.length, 1);

  // Pointing at a different folder takes a fresh baseline.
  const other = fakeDrive([{ id: "x-1234567890", name: "a.mp3", mimeType: "audio/mpeg" }]);
  assert.deepEqual(await watcher(other.drive, dir, () => {}, "folder2").check(), []);
});

test("Drive client: lists with paging, refreshes an expired token, downloads to disk", async () => {
  const seen: { path: string; auth: string }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    seen.push({ path: url.pathname + url.search, auth: String(req.headers.authorization) });
    if (req.headers.authorization === "Bearer stale") {
      res.writeHead(401).end();
      return;
    }
    if (url.pathname === "/drive/v3/files") {
      const page2 = url.searchParams.get("pageToken") === "p2";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          page2
            ? { files: [{ id: "b", name: "b.mp3", mimeType: "audio/mpeg" }] }
            : { files: [{ id: "a", name: "a.mp3", mimeType: "audio/mpeg" }], nextPageToken: "p2" },
        ),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.alloc(1000, 1));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    let tokens: GoogleTokens = { accessToken: "stale", expiresAt: Date.now() + 3_600_000, refreshToken: "r" };
    let refreshed = 0;
    const client = new DriveClient({
      getTokens: () => tokens,
      saveTokens: (t) => (tokens = t),
      refresh: async (t) => {
        refreshed++;
        return { ...t, accessToken: "fresh", expiresAt: Date.now() + 3_600_000 };
      },
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const files = await client.listFolder("folder'1");
    assert.deepEqual(files.map((f) => f.id), ["a", "b"]);
    assert.equal(refreshed, 1, "a 401 triggers one refresh");
    const query = new URLSearchParams(seen[0]!.path.split("?")[1]);
    assert.equal(query.get("q"), "'folder\\'1' in parents and trashed = false", "quotes in the id are escaped");

    const dir = mkdtempSync(join(tmpdir(), "t2-drive-"));
    await client.download("a", join(dir, "a.mp3"));
    assert.equal(readFileSync(join(dir, "a.mp3")).length, 1000);
  } finally {
    server.close();
  }
});
