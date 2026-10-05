import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { CUTTER_IPC, type CutJob, type CutResult } from "../shared/cutter";

/**
 * Cuts social clips out of an episode's audio as WAV files. Decoding needs
 * the browser's WebCodecs, which the main process doesn't have, so each call
 * opens a hidden, sandboxed page (src/renderer/src/cutter.ts) that runs
 * mediabunny. The page never sees the file path: it reads the bytes it needs
 * through IPC, from the one file this call opened.
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
  ipcMain.on(CUTTER_IPC.done, (e, id: unknown, result: CutResult) => {
    const job = typeof id === "string" ? running.get(id) : undefined;
    if (job && e.sender === job.sender) job.settle(result);
  });
}

/** Generous: decoding an hour of MP3 to reach a late clip takes seconds, not minutes. */
const timeoutMs = (clips: number) => 60_000 + clips * 30_000;

export async function cutClips(filePath: string, clips: { start: number; end: number }[], opts: CutterOptions): Promise<Uint8Array[]> {
  if (!clips.length) return [];
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
  try {
    const job: CutJob = { id, size: fstatSync(fd).size, clips };
    const result = await new Promise<CutResult>((resolve) => {
      const timer = setTimeout(() => resolve({ error: "Cutting the clips took too long." }), timeoutMs(clips.length));
      const settle = (r: CutResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      running.set(id, { fd, size: job.size, sender: win.webContents, settle });
      win.webContents.on("render-process-gone", () => settle({ error: "The clip cutter stopped unexpectedly." }));
      onReady = (e: Electron.IpcMainEvent) => {
        if (e.sender === win.webContents) win.webContents.send(CUTTER_IPC.job, job);
      };
      ipcMain.on(CUTTER_IPC.ready, onReady);
      opts.load(win).catch(() => settle({ error: "The clip cutter couldn't start." }));
    });
    if (result.error !== undefined) throw new Error(result.error);
    if (result.clips.length !== clips.length) throw new Error("Some clips didn't come back from the cutter.");
    return result.clips.map((c) => new Uint8Array(c));
  } finally {
    if (onReady) ipcMain.removeListener(CUTTER_IPC.ready, onReady);
    running.delete(id);
    closeSync(fd);
    if (!win.isDestroyed()) win.destroy();
  }
}
