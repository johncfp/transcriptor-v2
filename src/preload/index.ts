import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, type Api } from "../shared/api";

/** Subscribe to a main-process event; returns an unsubscribe function. */
function listen<T>(channel: string, fn: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: Api = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  defaultOutputFolder: () => ipcRenderer.invoke(IPC.defaultOutputFolder),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  listKeys: () => ipcRenderer.invoke(IPC.listKeys),
  setKey: (id, key) => ipcRenderer.invoke(IPC.setKey, id, key),
  deleteKey: (id) => ipcRenderer.invoke(IPC.deleteKey, id),
  keychainAvailable: () => ipcRenderer.invoke(IPC.keychainAvailable),
  listJobs: () => ipcRenderer.invoke(IPC.listJobs),
  pickAudio: () => ipcRenderer.invoke(IPC.pickAudio),
  addFiles: (paths) => ipcRenderer.invoke(IPC.addFiles, paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  approveJob: (id) => ipcRenderer.invoke(IPC.approveJob, id),
  cancelJob: (id) => ipcRenderer.invoke(IPC.cancelJob, id),
  retryJob: (id) => ipcRenderer.invoke(IPC.retryJob, id),
  removeJob: (id) => ipcRenderer.invoke(IPC.removeJob, id),
  getTranscript: (id) => ipcRenderer.invoke(IPC.getTranscript, id),
  onJobsChanged: (fn) => listen(IPC.jobsChanged, fn),
  onShowJob: (fn) => listen(IPC.showJob, fn),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.getUpdateStatus),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  onUpdateStatus: (fn) => listen(IPC.updateStatusChanged, fn),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  appVersion: () => ipcRenderer.invoke(IPC.appVersion),
};

contextBridge.exposeInMainWorld("api", api);
