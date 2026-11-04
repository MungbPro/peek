import { contextBridge, ipcRenderer } from 'electron';
import type { PeekApi, PeekEvent } from '../shared/types';

// Deliberately expose a small capability API, never ipcRenderer or Node objects.
const api: PeekApi = {
  bootstrap: () => ipcRenderer.invoke('peek:bootstrap'),
  ask: (request) => ipcRenderer.invoke('peek:ask', request),
  cancel: () => ipcRenderer.invoke('peek:cancel'),
  transcribe: (chunk) => ipcRenderer.invoke('peek:transcribe', chunk),
  chooseLibrary: () => ipcRenderer.invoke('peek:choose-library'),
  reloadLibrary: () => ipcRenderer.invoke('peek:reload-library'),
  openSource: (id) => ipcRenderer.invoke('peek:open-source', id),
  audioStatus: (status) => ipcRenderer.invoke('peek:audio-status', status),
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, message: PeekEvent): void => listener(message);
    ipcRenderer.on('peek:event', receive);
    return () => ipcRenderer.removeListener('peek:event', receive);
  },
};
contextBridge.exposeInMainWorld('peek', api);
