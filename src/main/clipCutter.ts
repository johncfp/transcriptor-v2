import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { CUTTER_IPC, type CutJob, type CutProgress, type CutResult, type VideoJob } from "../shared/cutter";
import { AbortedError } from "./transcribe/multipart";

/**
 * Cuts social clips out of an episode's audio as WAV files, and can make
 * them into MP4 videos. Decoding and encoding need the browser's WebCodecs,
 * which the main process doesn't have, so each call opens a hidden, sandboxed
 * page (src/renderer/src/cutter.ts) that runs mediabunny. The page never sees
 * the file path: it reads the bytes it needs through IPC, from the one file
 * this call opened.
 */
export interface CutterOptions {
  preload: string;
  /** Loads the cutter page into the window (the Vite dev server or the built file). */
  load: (win: BrowserWindow) => Promise<void>;
}

interface Running {
  fd: number;
  size: number;
  sender: WebContents;
  settle: (result: CutResult) => void;
  onProgress?: (p: CutProgress) => void;
}

const running = new Map<string, Running>();
let handlersInstalled = false;

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  // Only the window running a job may read that job's file, and only within it.
  ipcMain.handle(CUTTER_IPC.read, (e, id: unknown, start: unknown, end: unknown) => {
    const job = typeof id === "string" ? running.get(id) : undefined;
    if (!job || e.sender !== job.sender) throw new Error("No such job.");
    const from = Math.max(0, Math.min(job.size, Math.floor(Number(start) || 0)));
    const to = Math.max(from, Math.min(job.size, Math.floor(Number(end) || 0)));
    const bytes = Buffer.alloc(to - from);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(job.fd, bytes, read, bytes.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, read);
  });
  ipcMain.on(CUTTER_IPC.progress, (e, id: unknown, p: CutProgress) => {
    const job = typeof id === "string" ? running.get(id) : undefined;
    if (job && e.sender === job.sender && Number.isFinite(p?.done) && Number.isFinite(p?.total)) job.onProgress?.({ done: p.done, total: p.total });
  });
  ipcMain.on(CUTTER_IPC.done, (e, id: unknown, result: CutResult) => {
    const job = typeof id === "string" ? running.get(id) : undefined;
    if (job && e.sender === job.sender) job.settle(result);
  });
}

/**
 * Generous: decoding an hour of MP3 to reach a late clip takes seconds, not
 * minutes, and video renders at about 3x real time even in software.
 */
const timeoutMs = (clips: { start: number; end: number }[], video?: VideoJob) =>
  60_000 +
  clips.length * 30_000 +
  (video ? clips.reduce((ms, c, i) => ms + (c.end - c.start) * 1000 * (video.clips[i]?.shapes.length ?? 0), 0) : 0);

export interface CutOptions {
  video?: VideoJob;
  onProgress?: (p: CutProgress) => void;
  /** Aborting closes the cutter and rejects with AbortedError. */
  signal?: AbortSignal;
}

/** WAVs for the clips, and with `video`, their MP4s (videos[clip][shape]). */
export async function cutClips(
  filePath: string,
  clips: { start: number; end: number }[],
  opts: CutterOptions,
  more: CutOptions = {},
): Promise<{ wavs: Uint8Array[]; videos: Uint8Array[][] }> {
  if (!clips.length) return { wavs: [], videos: [] };
  if (more.signal?.aborted) throw new AbortedError("aborted");
  installHandlers();
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    throw new Error("The episode's audio file was moved or deleted, so its clips can't be cut.");
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  const id = randomUUID();
  let onReady: ((e: Electron.IpcMainEvent) => void) | null = null;
  let onAbort: (() => void) | null = null;
  let aborted = false;
  try {
    const job: CutJob = { id, size: fstatSync(fd).size, clips, ...(more.video ? { video: more.video } : {}) };
    const result = await new Promise<CutResult>((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: more.video ? "Making the videos took too long." : "Cutting the clips took too long." }),
        timeoutMs(clips, more.video),
      );
      const settle = (r: CutResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      running.set(id, { fd, size: job.size, sender: win.webContents, settle, onProgress: more.onProgress });
      win.webContents.on("render-process-gone", () => settle({ error: "The clip cutter stopped unexpectedly." }));
      onAbort = () => {
        aborted = true;
        settle({ error: "cancelled" });
      };
      more.signal?.addEventListener("abort", onAbort);
      onReady = (e: Electron.IpcMainEvent) => {
        if (e.sender === win.webContents) win.webContents.send(CUTTER_IPC.job, job);
      };
      ipcMain.on(CUTTER_IPC.ready, onReady);
      opts.load(win).catch(() => settle({ error: "The clip cutter couldn't start." }));
    });
    if (aborted) throw new AbortedError("aborted");
    if (result.error !== undefined) throw new Error(result.error);
    if (result.clips.length !== clips.length) throw new Error("Some clips didn't come back from the cutter.");
    const videos = (result.videos ?? []).map((perShape) => perShape.map((v) => new Uint8Array(v)));
    if (more.video && videos.length !== clips.length) throw new Error("Some videos didn't come back from the cutter.");
    return { wavs: result.clips.map((c) => new Uint8Array(c)), videos };
  } finally {
    if (onReady) ipcMain.removeListener(CUTTER_IPC.ready, onReady);
    if (onAbort) more.signal?.removeEventListener("abort", onAbort);
    running.delete(id);
    closeSync(fd);
    if (!win.isDestroyed()) win.destroy();
  }
}
