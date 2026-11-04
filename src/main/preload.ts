import { contextBridge, ipcRenderer } from 'electron';
import type { PeekApi, PeekEvent } from '../shared/types';

// Deliberately expose a small capability API, never ipcRenderer or Node objects.
const api: PeekApi = {
  bootstrap: () => ipcRenderer.invoke('peek:bootstrap'),
  ask: (request) => ipcRenderer.invoke('peek:ask', request),
  cancel: () => ipcRenderer.invoke('peek:cancel'),
  nextQuestion: (since) => ipcRenderer.invoke('peek:next-question', since),
  transcribe: (chunk) => ipcRenderer.invoke('peek:transcribe', chunk),
  chooseLibrary: () => ipcRenderer.invoke('peek:choose-library'),
  reloadLibrary: () => ipcRenderer.invoke('peek:reload-library'),
  openSource: (id) => ipcRenderer.invoke('peek:open-source', id),
  audioStatus: (status) => ipcRenderer.invoke('peek:audio-status', status),
  openCredentials: () => ipcRenderer.invoke('peek:open-credentials'),
  setModel: (model) => ipcRenderer.invoke('peek:set-model', model),
  listTasks: () => ipcRenderer.invoke('peek:tasks-list'),
  createTask: (context) => ipcRenderer.invoke('peek:tasks-create', context),
  selectTask: (id) => ipcRenderer.invoke('peek:tasks-select', id),
  updateTask: (context) => ipcRenderer.invoke('peek:tasks-update', context),
  deleteTask: (id) => ipcRenderer.invoke('peek:tasks-delete', id),
  setVisible: (visible) => ipcRenderer.invoke('peek:visible', visible),
  setPreparationMode: (preparing) => ipcRenderer.invoke('peek:preparing', preparing),
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, message: PeekEvent): void => listener(message);
    ipcRenderer.on('peek:event', receive);
    return () => ipcRenderer.removeListener('peek:event', receive);
  },
};
contextBridge.exposeInMainWorld('peek', api);
