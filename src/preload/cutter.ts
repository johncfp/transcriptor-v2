// Preload for the hidden clip cutter page: just the messages it needs.
import { contextBridge, ipcRenderer } from "electron";
import { CUTTER_IPC, type CutJob, type CutProgress, type CutResult } from "../shared/cutter";

contextBridge.exposeInMainWorld("cutter", {
  onJob: (fn: (job: CutJob) => void) => ipcRenderer.on(CUTTER_IPC.job, (_e, job: CutJob) => fn(job)),
  read: (jobId: string, start: number, end: number): Promise<Uint8Array> => ipcRenderer.invoke(CUTTER_IPC.read, jobId, start, end),
  progress: (jobId: string, p: CutProgress) => ipcRenderer.send(CUTTER_IPC.progress, jobId, { done: p.done, total: p.total }),
  done: (jobId: string, result: CutResult) => ipcRenderer.send(CUTTER_IPC.done, jobId, result),
  ready: () => ipcRenderer.send(CUTTER_IPC.ready),
});
