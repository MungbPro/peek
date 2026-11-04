export interface LibraryDocument { id: string; title: string; section: string; relativePath: string }
export interface LibraryStatus { root: string | null; documents: LibraryDocument[]; sections: string[]; chunks: number; warnings: string[] }
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
  transcriptionReady: boolean; warnings: string[];
}
export interface AskRequest { intent: string; followUp: boolean; focusDocumentId?: string; section?: string; language?: 'zh' | 'en' }
export interface AudioChunk { data: ArrayBuffer; mimeType: string; startedAt: number; endedAt: number }
export type AudioStatus = { state: 'idle' | 'recording' | 'error'; message?: string };
export type PeekEvent =
  | { type: 'interaction'; active: boolean }
  | { type: 'trigger'; followUp: boolean }
  | { type: 'answer-start'; requestId: string; sources: SourcePassage[]; transcript: string }
  | { type: 'answer-delta'; requestId: string; delta: string }
  | { type: 'answer-done'; requestId: string }
  | { type: 'answer-error'; requestId: string; message: string }
  | { type: 'warning'; message: string }
  | { type: 'library'; library: LibraryStatus };
export interface PeekApi {
  bootstrap(): Promise<Bootstrap>;
  ask(request: AskRequest): Promise<void>;
  cancel(): Promise<void>;
  transcribe(chunk: AudioChunk): Promise<{ text: string }>;
  chooseLibrary(): Promise<LibraryStatus | null>;
  reloadLibrary(): Promise<LibraryStatus>;
  openSource(documentId: string): Promise<void>;
  audioStatus(status: AudioStatus): Promise<void>;
  onEvent(listener: (event: PeekEvent) => void): () => void;
}
declare global { interface Window { peek: PeekApi } }
