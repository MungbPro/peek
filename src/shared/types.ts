import type { SavedTask, TaskContext, TaskSummary } from './tasks';
export type { SavedTask, TaskContext, TaskSummary, TaskTurn } from './tasks';
export interface LibraryDocument { id: string; title: string; section: string; relativePath: string }
export interface LibraryProgress { phase: 'scan' | 'index'; completed: number; total: number }
export interface LibraryStatus { root: string | null; documents: LibraryDocument[]; sections: string[]; chunks: number; warnings: string[]; indexDurationMs?: number; indexedAt?: number; indexedBytes?: number }
export interface SourcePassage {
  id: string; documentId: string; title: string; section: string; relativePath: string;
  startLine: number; endLine: number; text: string; score: number;
}
export interface PublicConfig {
  language: 'zh' | 'en';
  model: string; inputDeviceId: string; transcriptWindowSeconds: number;
  hotkeys: { ask: string; toggle: string; followUp: string };
  interactionModifiers: string[];
}
export interface Bootstrap {
  config: PublicConfig; library: LibraryStatus; chatReady: boolean;
  transcriptionReady: boolean; warnings: string[]; shortcutWarnings: string[]; modelSelectionAvailable: boolean;
  tasks: TaskSummary[]; activeTask: SavedTask | null;
}
export interface AskRequest { requestId: string; intent: string; followUp: boolean; focusDocumentId?: string; section?: string; language?: 'zh' | 'en' }
export interface AudioChunk { data: ArrayBuffer; mimeType: string; startedAt: number; endedAt: number }
export type AudioStatus = { state: 'idle' | 'recording' | 'error'; message?: string };
export type PeekEvent =
  | { type: 'interaction'; active: boolean }
  | { type: 'trigger'; followUp: boolean }
  | { type: 'answer-start'; requestId: string; sources: SourcePassage[]; transcript: string }
  | { type: 'answer-delta'; requestId: string; delta: string }
  | { type: 'answer-done'; requestId: string }
  | { type: 'answer-error'; requestId: string; message: string }
  | { type: 'answer-warning'; requestId: string; message: string }
  | { type: 'answer-metadata'; requestId: string; serviceTier: string }
  | { type: 'task-saved'; task: SavedTask }
  | { type: 'library-progress'; progress: LibraryProgress }
  | { type: 'warning'; message: string }
  | { type: 'credentials-changed'; chatReady: boolean; transcriptionReady: boolean }
  | { type: 'library'; library: LibraryStatus };
export interface PeekApi {
  bootstrap(): Promise<Bootstrap>;
  ask(request: AskRequest): Promise<void>;
  cancel(): Promise<void>;
  nextQuestion(since: number): Promise<void>;
  transcribe(chunk: AudioChunk): Promise<{ text: string }>;
  chooseLibrary(): Promise<LibraryStatus | null>;
  reloadLibrary(): Promise<LibraryStatus>;
  openSource(documentId: string): Promise<void>;
  audioStatus(status: AudioStatus): Promise<void>;
  openCredentials(): Promise<void>;
  setModel(model: string): Promise<string>;
  listTasks(): Promise<TaskSummary[]>;
  createTask(context: TaskContext): Promise<SavedTask>;
  selectTask(id: string): Promise<{ task: SavedTask; library: LibraryStatus; needsPreparation: boolean; warning: string }>;
  updateTask(context: TaskContext): Promise<SavedTask>;
  deleteTask(id: string): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  setPreparationMode(preparing: boolean): Promise<void>;
  onEvent(listener: (event: PeekEvent) => void): () => void;
}
export interface CredentialTarget {
  id: 'chat' | 'transcription'; label: string; baseUrl: string; stored: boolean;
  source: 'secure' | 'environment' | 'none'; disabled: boolean;
}
export interface CredentialBootstrap {
  language: 'zh' | 'en'; secureStorageAvailable: boolean; storageError?: string;
  targets: CredentialTarget[];
}
export interface CredentialResult {
  ok: boolean;
  code: 'saved' | 'verified' | 'removed' | 'invalid_key' | 'unauthorized' | 'forbidden' | 'quota' | 'network' | 'unavailable' | 'storage' | 'cancelled' | 'busy' | 'invalid_target' | 'unsupported';
  state?: CredentialBootstrap;
}
export interface PeekSetupApi {
  bootstrap(): Promise<CredentialBootstrap>;
  save(request: { targetId: string; key: string; verify: boolean }): Promise<CredentialResult>;
  remove(targetId: string): Promise<CredentialResult>;
  openKeyPage(): Promise<void>;
  close(): Promise<void>;
}
declare global { interface Window { peek: PeekApi; peekSetup: PeekSetupApi } }
