import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import type { SavedTask, TaskContext, TaskSource, TaskSummary, TaskTurn } from '../shared/tasks';
export type { SavedTask, TaskContext, TaskSource, TaskSummary, TaskTurn } from '../shared/tasks';

export const TASK_LIMITS = {
  tasks: 100,
  turns: 1000,
  questionCharacters: 24_000,
  answerCharacters: 12_000,
  taskBytes: 32 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
} as const;

type TaskErrorCode = 'invalid' | 'not_found' | 'corrupt' | 'limit' | 'io';
export class TaskStoreError extends Error {
  constructor(readonly code: TaskErrorCode, message: string) { super(message); this.name = 'TaskStoreError'; }
}
export interface NewTaskTurn { question: string; answer: string; model: string; sources?: TaskSource[] }
export interface TaskStoreOptions {
  now?: () => number;
  /** Injected only by tests to verify that a failed atomic replace preserves history. */
  replaceFile?: (temporary: string, destination: string) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_ERROR = 'This task could not be read safely. Back up its JSON file before repairing it; the saved file was not changed.';
const WRITE_ERROR = 'The task could not be saved. Check disk space and folder permissions; the previous saved history has not been replaced.';
const LIMIT_ERROR = 'Task storage has reached its size limit. Export or delete an older task, or start a new task; no saved history was truncated.';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskStoreError('invalid', 'Invalid task data.');
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && !value.trim())) {
    throw new TaskStoreError('invalid', 'Invalid or oversized task text.');
  }
  // Preserve the authorized question and answer exactly, including whitespace.
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TaskStoreError('invalid', 'Invalid task ID.');
  return value.toLowerCase();
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new TaskStoreError('invalid', 'Invalid task timestamp.');
  }
  return value;
}
function relativePath(value: unknown): string {
  const path = string(value, 4096);
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TaskStoreError('invalid', 'Task sources must use a relative document path.');
  }
  return path;
}
function context(value: unknown): TaskContext {
  const raw = record(value);
  const libraryPath = string(raw.libraryPath, 4096, true);
  if (libraryPath && !isAbsolute(libraryPath) && !win32.isAbsolute(libraryPath)) throw new TaskStoreError('invalid', 'The task library must be an absolute folder path.');
  const result: TaskContext = { libraryPath, model: string(raw.model, 200) };
  if (raw.focusDocumentId !== undefined) result.focusDocumentId = string(raw.focusDocumentId, 256, true);
  if (raw.focusRelativePath !== undefined) result.focusRelativePath = raw.focusRelativePath === '' ? '' : relativePath(raw.focusRelativePath);
  if (raw.focusTitle !== undefined) result.focusTitle = string(raw.focusTitle, 512, true);
  if (raw.section !== undefined) result.section = string(raw.section, 512, true);
  return result;
}
function sources(value: unknown): TaskSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new TaskStoreError('invalid', 'Invalid task source list.');
  return value.map(item => {
    const raw = record(item);
    const startLine = raw.startLine;
    const endLine = raw.endLine;
    if (typeof startLine !== 'number' || typeof endLine !== 'number' || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new TaskStoreError('invalid', 'Invalid source line references.');
    }
    return {
      relativePath: relativePath(raw.relativePath), startLine, endLine,
      ...(raw.title !== undefined ? { title: string(raw.title, 512, true) } : {}),
    };
  });
}
function newTurn(value: unknown): NewTaskTurn & { sources: TaskSource[] } {
  const raw = record(value);
  return {
    question: string(raw.question, TASK_LIMITS.questionCharacters),
    answer: string(raw.answer, TASK_LIMITS.answerCharacters),
    model: string(raw.model, 200), sources: sources(raw.sources),
  };
}
function decode(value: unknown, expectedId: string): SavedTask {
  const raw = record(value);
  if (raw.version !== 1 || id(raw.id) !== expectedId || !Array.isArray(raw.turns) || raw.turns.length > TASK_LIMITS.turns) {
    throw new TaskStoreError('corrupt', READ_ERROR);
  }
  const createdAt = timestamp(raw.createdAt);
  const updatedAt = timestamp(raw.updatedAt);
  if (updatedAt < createdAt) throw new TaskStoreError('corrupt', READ_ERROR);
  const turnIds = new Set<string>();
  const turns = raw.turns.map(value => {
    const rawTurn = record(value);
    const turnId = id(rawTurn.id);
    const time = timestamp(rawTurn.createdAt);
    if (turnIds.has(turnId) || time < createdAt || time > updatedAt) throw new TaskStoreError('corrupt', READ_ERROR);
    turnIds.add(turnId);
    return { ...newTurn(rawTurn), id: turnId, createdAt: time };
  });
  return {
    version: 1, id: expectedId, name: string(raw.name, 640), createdAt, updatedAt,
    context: context(raw.context), turns,
  };
}
function taskName(taskContext: TaskContext, createdAt: number): string {
  const title = taskContext.focusTitle?.trim()
    || taskContext.section?.trim()
    || '对话任务';
  const time = new Date(createdAt).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${title} · ${time}`;
}

/**
 * Local plaintext history explicitly requested by the user. Only successful
 * question/answer pairs and allowlisted task context are accepted. Audio,
 * screenshots, credentials, and the rolling transcript are never store fields.
 * There is no cache or index: each task is one atomically replaced JSON file.
 */
export class TaskStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly replaceFile: (temporary: string, destination: string) => Promise<void>;

  constructor(private readonly directory: string, options: TaskStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.replaceFile = options.replaceFile ?? rename;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskStoreError('io', 'The task folder must be a local directory, not a symbolic link.');
      await chmod(this.directory, 0o700);
    } catch (error) {
      if (error instanceof TaskStoreError) throw error;
      throw new TaskStoreError('io', 'The task folder is unavailable. Check its location and permissions.');
    }
  }

  private filename(taskId: string): string { return join(this.directory, `${id(taskId)}.json`); }

  private async inventory(): Promise<Array<{ id: string; bytes: number }>> {
    const result: Array<{ id: string; bytes: number }> = [];
    let entries = 0;
    let totalBytes = 0;
    for await (const entry of await opendir(this.directory)) {
      if (++entries > 2048) throw new TaskStoreError('limit', LIMIT_ERROR);
      if (!entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5))) continue;
      const taskId = id(entry.name.slice(0, -5));
      const info = await lstat(this.filename(taskId));
      if (!info.isFile() || info.isSymbolicLink()) throw new TaskStoreError('corrupt', READ_ERROR);
      if (info.size > TASK_LIMITS.taskBytes) throw new TaskStoreError('limit', LIMIT_ERROR);
      totalBytes += info.size;
      result.push({ id: taskId, bytes: info.size });
      if (result.length > TASK_LIMITS.tasks || totalBytes > TASK_LIMITS.totalBytes) throw new TaskStoreError('limit', LIMIT_ERROR);
    }
    return result;
  }

  private async read(taskId: string): Promise<SavedTask> {
    const normalized = id(taskId);
    const filename = this.filename(normalized);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > TASK_LIMITS.taskBytes) throw new TaskStoreError('corrupt', READ_ERROR);
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new TaskStoreError('corrupt', READ_ERROR);
        // Read at most the observed size plus one byte, detecting growth rather
        // than following an unbounded file that changes under the application.
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== info.size) throw new TaskStoreError('corrupt', READ_ERROR);
        return decode(JSON.parse(buffer.subarray(0, length).toString('utf8')), normalized);
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TaskStoreError('not_found', 'This task no longer exists. Choose another task or start a new one.');
      throw new TaskStoreError('corrupt', READ_ERROR);
    }
  }

  private async persist(task: SavedTask, creating = false): Promise<void> {
    const encoded = Buffer.from(`${JSON.stringify(task)}\n`, 'utf8');
    if (encoded.byteLength > TASK_LIMITS.taskBytes || task.turns.length > TASK_LIMITS.turns) throw new TaskStoreError('limit', LIMIT_ERROR);
    const files = await this.inventory();
    const previous = files.find(file => file.id === task.id);
    if (creating && (previous || files.length >= TASK_LIMITS.tasks)) throw new TaskStoreError('limit', LIMIT_ERROR);
    if (files.reduce((sum, file) => sum + file.bytes, 0) - (previous?.bytes ?? 0) + encoded.byteLength > TASK_LIMITS.totalBytes) throw new TaskStoreError('limit', LIMIT_ERROR);
    const destination = this.filename(task.id);
    const temporary = join(this.directory, `${task.id}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await file.chmod(0o600);
        await file.writeFile(encoded);
        await file.sync();
      } finally { await file.close(); }
      await this.replaceFile(temporary, destination);
      created = false;
      // Nothing fallible after commit: a rejected save leaves the prior JSON.
    } catch { throw new TaskStoreError('io', WRITE_ERROR); }
    finally { if (created) await unlink(temporary).catch(() => {}); }
  }

  list(): Promise<TaskSummary[]> {
    return this.serial(async () => {
      await this.ensureDirectory();
      const result: TaskSummary[] = [];
      for (const entry of await this.inventory()) {
        const task = await this.read(entry.id);
        result.push({ id: task.id, name: task.name, createdAt: task.createdAt, updatedAt: task.updatedAt, turnCount: task.turns.length, context: task.context });
      }
      return result.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    });
  }

  create(taskContext: TaskContext): Promise<SavedTask> {
    return this.serial(async () => {
      const nextContext = context(taskContext);
      await this.ensureDirectory();
      const createdAt = timestamp(this.now());
      const task: SavedTask = { version: 1, id: randomUUID(), name: taskName(nextContext, createdAt), createdAt, updatedAt: createdAt, context: nextContext, turns: [] };
      await this.persist(task, true);
      return task;
    });
  }

  get(taskId: string): Promise<SavedTask> {
    return this.serial(async () => { id(taskId); await this.ensureDirectory(); return this.read(taskId); });
  }

  updateContext(taskId: string, taskContext: TaskContext): Promise<SavedTask> {
    return this.serial(async () => {
      id(taskId);
      const nextContext = context(taskContext);
      await this.ensureDirectory();
      const previous = await this.read(taskId);
      const task = { ...previous, context: nextContext, name: taskName(nextContext, previous.createdAt), updatedAt: Math.max(previous.updatedAt, timestamp(this.now())) };
      await this.persist(task);
      return task;
    });
  }

  appendTurn(taskId: string, value: NewTaskTurn): Promise<SavedTask> {
    return this.serial(async () => {
      id(taskId);
      const fields = newTurn(value);
      await this.ensureDirectory();
      const previous = await this.read(taskId);
      if (previous.turns.length >= TASK_LIMITS.turns) throw new TaskStoreError('limit', LIMIT_ERROR);
      const createdAt = Math.max(previous.updatedAt, timestamp(this.now()));
      const turn: TaskTurn = { ...fields, id: randomUUID(), createdAt };
      const task = { ...previous, updatedAt: createdAt, turns: [...previous.turns, turn] };
      await this.persist(task);
      return task;
    });
  }

  delete(taskId: string): Promise<void> {
    return this.serial(async () => {
      id(taskId);
      await this.ensureDirectory();
      const filename = this.filename(taskId);
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink()) throw new TaskStoreError('corrupt', READ_ERROR);
        // No read/parse required, so even an oversized or corrupt task can be
        // explicitly deleted without changing any other task or source article.
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        if (error instanceof TaskStoreError) throw error;
        throw new TaskStoreError('io', 'The task could not be deleted. Check folder permissions and retry.');
      }
    });
  }
}
