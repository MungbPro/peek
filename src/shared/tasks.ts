export interface TaskContext {
  libraryPath: string;
  model: string;
  focusDocumentId?: string;
  focusRelativePath?: string;
  focusTitle?: string;
  section?: string;
}
export interface TaskSource { relativePath: string; startLine: number; endLine: number; title?: string }
export interface TaskTurn {
  id: string; question: string; answer: string; createdAt: number; model: string; sources: TaskSource[];
}
export interface SavedTask {
  version: 1; id: string; name: string; createdAt: number; updatedAt: number;
  context: TaskContext; turns: TaskTurn[];
}
export interface TaskSummary {
  id: string; name: string; createdAt: number; updatedAt: number; turnCount: number; context: TaskContext;
}
