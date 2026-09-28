import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import type { Transcriber } from "./transcribe/types";

/**
 * `npm run smoke` launches the built app with TRANSCRIPTOR_SMOKE_DIR set.
 * The app then uses that folder as its profile and runs a scripted pass:
 * key storage, adding an audio file, transcribing it against a local fake
 * ElevenLabs, reviewing it (suggested names, filler removal, removing a word
 * by hand, marking it reviewed), and the Settings screen. It saves
 * screenshots plus a report, then quits.
 */
const dir = process.env.TRANSCRIPTOR_SMOKE_DIR;
export const SMOKE = dir ? { dir, userData: join(dir, "profile") } : null;

let fakeApiUrl = "";

/** In smoke mode, send transcription to the local fake instead of ElevenLabs. */
export function smokeTranscriber(real: Transcriber): Transcriber {
  if (!SMOKE) return real;
  return { ...real, transcribe: (req) => real.transcribe({ ...req, baseUrl: fakeApiUrl }) };
}

function startFakeApi(): Promise<void> {
  const words = [
    ["Hey,", 0], ["I'm", 0], ["Nigel.", 0], ["Um,", 0], ["welcome", 0], ["to", 0], ["the", 0], ["show,", 0], ["Pete.", 0],
    ["Thanks,", 1], ["uh,", 1], ["really", 1], ["glad", 1], ["to", 1], ["be", 1], ["here.", 1],
  ] as const;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          language_code: "en",
          audio_duration_secs: 4.5,
          words: words.map(([text, speaker], i) => ({
            text,
            type: "word",
            start: i * 0.5,
            end: i * 0.5 + 0.4,
            speaker_id: `speaker_${speaker}`,
            // One shaky word, to show the confidence colouring.
            logprob: text === "glad" ? -1.2 : -0.01,
          })),
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      fakeApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

/** A valid WAV file: 9 s of silence, long enough to cover the fake words. */
function writeWav(path: string): void {
  const samples = 16000 * 9;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, buf);
}

export function runSmokeTest(win: BrowserWindow, hooks: { checkForUpdate: () => Promise<string | null> }): void {
  if (!SMOKE) return;
  const { dir } = SMOKE;
  const finish = (report: Record<string, unknown>) => {
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  };
  const timeout = setTimeout(() => finish({ ok: false, error: "timed out" }), 30_000);
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code);
  const shot = async (name: string) =>
    writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG());
  const click = (selector: string, text: string) =>
    js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`);

  win.webContents.once("did-finish-load", async () => {
    try {
      await startFakeApi();
      await pause(1000);
      const probe = await js<{ hasApi: boolean; heading: string | null; intake: string | null }>(`(async () => ({
        hasApi: typeof window.api === "object",
        heading: document.querySelector("h1")?.textContent ?? null,
        intake: window.api ? (await window.api.getSettings()).processing.intake : null,
      }))()`);
      win.show();
      await pause(300);
      await shot("home.png");

      // Keys: save, read back the hint, delete; then save one for the run below.
      const keys = await js<{ hint: string; removed: boolean }>(`(async () => {
        const saved = await window.api.setKey("elevenlabs", "sk_smoke_test_1234");
        const removed = await window.api.deleteKey("elevenlabs");
        await window.api.setKey("elevenlabs", "sk_smoke_test_5678");
        return {
          hint: saved.find((k) => k.providerId === "elevenlabs").hint,
          removed: !removed.find((k) => k.providerId === "elevenlabs").saved,
        };
      })()`);
      const keyRoundTrip = keys.hint === "1234" && keys.removed;

      await js(`window.api.updateSettings({ show: { hosts: ["Nigel T."] } })`);

      // Pipeline: queue a file (plus one that must be rejected) and wait for the transcript.
      const wav = join(dir, "episode-386.wav");
      writeWav(wav);
      writeFileSync(join(dir, "notes.txt"), "not audio");
      const added = await js<{ added: number; rejected: string[] }>(`(async () => {
        const r = await window.api.addFiles(${JSON.stringify([wav, join(dir, "notes.txt")])});
        return { added: r.added.length, rejected: r.rejected.map((x) => x.fileName) };
      })()`);
      let status = "";
      for (let i = 0; i < 40 && status !== "needs-review" && status !== "failed"; i++) {
        await pause(150);
        status = await js<string>(`window.api.listJobs().then((j) => j[0]?.status ?? "")`);
      }
      await pause(300);
      await shot("episodes.png");

      // Review: suggested names and cleaned text, then remove "really" by hand and mark reviewed.
      await click("button", "Review");
      await pause(500);
      const readTurns = () =>
        js<string[]>(
          `[...document.querySelectorAll(".turn")].map((t) => t.querySelector(".speaker").textContent + ": " + t.querySelector("p").textContent)`,
        );
      const turns = await readTurns();
      // Playback: audio loads over t2-media://, clicking a word seeks there, playing moves the playhead.
      await pause(500);
      await click(".word", "glad");
      await pause(400);
      const seeked = await js<{ duration: number; time: number; current: string | null }>(`({
        duration: document.querySelector("audio").duration,
        time: document.querySelector("audio").currentTime,
        current: document.querySelector(".word.current")?.textContent ?? null,
      })`);
      await js(`document.querySelector("audio").play()`);
      await pause(1300);
      const played = await js<{ time: number; current: string | null }>(`({
        time: document.querySelector("audio").currentTime,
        current: document.querySelector(".word.current")?.textContent ?? null,
      })`);
      await js(`document.querySelector("audio").pause()`);
      await pause(200);
      await shot("review.png");
      const playback =
        Math.abs(seeked.duration - 9) < 0.1 &&
        Math.abs(seeked.time - 6) < 0.05 &&
        seeked.current === "glad" &&
        played.time > 6.8 &&
        played.current !== "glad";

      await click(".word", "really");
      await pause(200);
      await click("button", "Remove word");
      await pause(300);
      const afterRemove = await readTurns();
      await click("button", "Mark as reviewed");
      await pause(300);
      const finalStatus = await js<string>(`window.api.listJobs().then((j) => j[0]?.status ?? "")`);

      await click(".nav-item", "Settings");
      await pause(500);
      const sections = await js<string[]>(`[...document.querySelectorAll("h2")].map((h) => h.textContent)`);
      await shot("settings.png");

      // Packaged builds only: can the public releases feed be read without a token?
      const newerVersion = app.isPackaged ? await hooks.checkForUpdate() : "skipped (not packaged)";

      clearTimeout(timeout);
      const pipeline = added.added === 1 && added.rejected[0] === "notes.txt" && status === "needs-review";
      const review =
        turns[0] === "Nigel T.: Hey, I'm Nigel. Welcome to the show, Pete." &&
        turns[1] === "Pete: Thanks, really glad to be here." &&
        afterRemove[1] === "Pete: Thanks, glad to be here." &&
        finalStatus === "ready";
      finish({
        ok:
          probe.hasApi &&
          probe.heading === "Episodes" &&
          probe.intake === "approve" &&
          keyRoundTrip &&
          pipeline &&
          review &&
          playback &&
          sections.length >= 5,
        heading: probe.heading,
        intake: probe.intake,
        keyRoundTrip,
        added,
        status,
        turns,
        afterRemove,
        seeked,
        played,
        finalStatus,
        sections,
        newerVersion,
      });
    } catch (err) {
      clearTimeout(timeout);
      finish({ ok: false, error: String(err) });
    }
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
