import { contextBridge, ipcRenderer } from 'electron';
import type { PeekSetupApi } from '../shared/types';

// This window cannot capture audio/screens or read stored credentials.
const api: PeekSetupApi = {
  bootstrap: () => ipcRenderer.invoke('peek:credentials-bootstrap'),
  save: request => ipcRenderer.invoke('peek:credentials-save', request),
  remove: targetId => ipcRenderer.invoke('peek:credentials-remove', targetId),
  openKeyPage: () => ipcRenderer.invoke('peek:credentials-open-key-page'),
  close: () => ipcRenderer.invoke('peek:credentials-close'),
};
contextBridge.exposeInMainWorld('peekSetup', api);
