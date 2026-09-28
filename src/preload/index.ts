import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Api } from "../shared/api";

const api: Api = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  defaultOutputFolder: () => ipcRenderer.invoke(IPC.defaultOutputFolder),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  listKeys: () => ipcRenderer.invoke(IPC.listKeys),
  setKey: (id, key) => ipcRenderer.invoke(IPC.setKey, id, key),
  deleteKey: (id) => ipcRenderer.invoke(IPC.deleteKey, id),
  keychainAvailable: () => ipcRenderer.invoke(IPC.keychainAvailable),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  appVersion: () => ipcRenderer.invoke(IPC.appVersion),
};

contextBridge.exposeInMainWorld("api", api);
