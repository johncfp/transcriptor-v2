// Preload for the hidden clip cutter page: just the four messages it needs.
import { contextBridge, ipcRenderer } from "electron";
import { CUTTER_IPC, type CutJob, type CutResult } from "../shared/cutter";

contextBridge.exposeInMainWorld("cutter", {
  onJob: (fn: (job: CutJob) => void) => ipcRenderer.on(CUTTER_IPC.job, (_e, job: CutJob) => fn(job)),
  read: (jobId: string, start: number, end: number): Promise<Uint8Array> => ipcRenderer.invoke(CUTTER_IPC.read, jobId, start, end),
  done: (jobId: string, result: CutResult) => ipcRenderer.send(CUTTER_IPC.done, jobId, result),
  ready: () => ipcRenderer.send(CUTTER_IPC.ready),
});
