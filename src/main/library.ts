import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface LibraryDocument {
  id: string;
  title: string;
  section: string;
  relativePath: string;
}

export interface LibraryStatus {
  root: string | null;
  documents: LibraryDocument[];
  sections: string[];
  chunks: number;
  warnings: string[];
  indexDurationMs?: number;
  indexedAt?: number;
  indexedBytes?: number;
}

export interface LibraryProgress {
  phase: 'scan' | 'index';
  completed: number;
  total: number;
}

export interface SourcePassage {
  id: string;
  documentId: string;
  title: string;
  section: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

export interface LibrarySearchOptions {
  focusDocumentId?: string;
  section?: string;
  limit?: number;
  maxChars?: number;
}

interface IndexedPassage extends Omit<SourcePassage, 'score'> {
  length: number;
}

interface IndexState {
  root: string | null;
  documents: LibraryDocument[];
  paths: Map<string, string>;
  passages: IndexedPassage[];
  postings: Map<string, Map<number, number>>;
  averageLength: number;
  warnings: string[];
  indexDurationMs?: number;
  indexedAt?: number;
  indexedBytes: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CORPUS_BYTES = 100 * 1024 * 1024;
const MAX_DOCUMENTS = 2_000;
// Bound the discovery list even when most candidate files cannot be indexed.
const MAX_CANDIDATES = 10_000;
const MAX_PASSAGES = 60_000;
const CHUNK_CHARS = 2_000;
const OVERLAP_CHARS = 240;
const STOP_WORDS = new Set('a an and are as at be been being but by can could did do does for from had has have he her here him his how i if in into is it its me my of on or our she should so than that the their them then there these they this those to us was we were what when where which who why will with would you your'.split(' '));

function emptyState(): IndexState {
  return {
    root: null,
    documents: [],
    paths: new Map(),
    passages: [],
    postings: new Map(),
    averageLength: 1,
    warnings: [],
    indexedBytes: 0,
  };
}

/** Local lexical retrieval, not semantic or cross-language translation.
 * English and Chinese work independently. A Chinese question will not reliably
 * retrieve an English-only synonym; include both languages in article aliases.
 */
function tokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en');
  const result: string[] = [];
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) result.push(chars[0]!);
    for (let index = 0; index < chars.length - 1; index += 1) {
      result.push(chars[index]! + chars[index + 1]!);
    }
  }
  for (const word of normalized.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!STOP_WORDS.has(word)) result.push(word);
  }
  return result;
}

function titleFor(text: string, filename: string): string {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const declared = frontmatter?.[1]?.match(/^title:\s*['"]?(.+?)['"]?\s*$/m)?.[1];
  const heading = text.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1];
  return (declared || heading || path.basename(filename, path.extname(filename))).slice(0, 300);
}

/** Preserve original source line numbers, including for unusually long lines. */
function* chunks(text: string): Generator<{ text: string; startLine: number; endLine: number }> {
  type Piece = { text: string; line: number };
  // Generate incrementally: a file with millions of short lines must not create
  // millions of temporary objects before the passage limit can be applied.
  function* pieces(): Generator<Piece> {
    let offset = 0;
    let lineNumber = 1;
    while (offset <= text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline === -1 ? text.length : newline;
      const line = text.slice(offset, end).replace(/\r$/, '');
      if (line.length <= CHUNK_CHARS) {
        yield { text: line, line: lineNumber };
      } else {
        for (let start = 0; start < line.length; start += CHUNK_CHARS - OVERLAP_CHARS) {
          yield { text: line.slice(start, start + CHUNK_CHARS), line: lineNumber };
          if (start + CHUNK_CHARS >= line.length) break;
        }
      }
      if (newline === -1) break;
      offset = newline + 1;
      lineNumber += 1;
    }
  }
  let pending: Piece[] = [];
  let size = 0;
  const flush = () => {
    if (pending.length === 0) return undefined;
    const value = pending.map((piece) => piece.text).join('\n');
    return value.trim() ? { text: value, startLine: pending[0]!.line, endLine: pending[pending.length - 1]!.line } : undefined;
  };
  for (const piece of pieces()) {
    if (pending.length && size + piece.text.length + 1 > CHUNK_CHARS) {
      const chunk = flush();
      if (chunk) yield chunk;
      // Retain full short lines only. Long-line fragments overlap themselves.
      const tail: Piece[] = [];
      let tailSize = 0;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const candidate = pending[index]!;
        if (tailSize + candidate.text.length + 1 > OVERLAP_CHARS) break;
        tail.unshift(candidate);
        tailSize += candidate.text.length + 1;
      }
      pending = tailSize + piece.text.length + 1 <= CHUNK_CHARS ? tail : [];
      size = pending.reduce((sum, item) => sum + item.text.length + 1, 0);
    }
    pending.push(piece);
    size += piece.text.length + 1;
  }
  const chunk = flush();
  if (chunk) yield chunk;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.min(max, Math.floor(value)));
}

export class KnowledgeLibrary {
  private state: IndexState = emptyState();
  private loadRevision = 0;

  status(): LibraryStatus {
    return {
      root: this.state.root,
      documents: this.state.documents.map((document) => ({ ...document })),
      sections: [...new Set(this.state.documents.map((document) => document.section))].sort(),
      chunks: this.state.passages.length,
      warnings: [...this.state.warnings],
      ...(this.state.indexedAt === undefined ? {} : {
        indexDurationMs: this.state.indexDurationMs,
        indexedAt: this.state.indexedAt,
        indexedBytes: this.state.indexedBytes,
      }),
    };
  }

  /** Switching to an empty task must invalidate any in-flight import too. */
  clear(): LibraryStatus {
    ++this.loadRevision;
    this.state = emptyState();
    return this.status();
  }

  /** Rebuild atomically. Invalid roots leave the previous usable index intact.
   * Scan progress reports discovered candidates in total, with completed=0.
   * Index progress has a fixed total and counts attempted files, including skips.
   * Callbacks are advisory and cannot invalidate an otherwise usable import.
   */
  async load(root: string, onProgress?: (progress: LibraryProgress) => void): Promise<LibraryStatus> {
    const revision = ++this.loadRevision;
    const started = performance.now();
    const resolvedRoot = await realpath(path.resolve(root));
    if (!(await stat(resolvedRoot)).isDirectory()) throw new Error('Choose a folder containing Markdown or text articles.');
    const next = emptyState();
    next.root = resolvedRoot;
    let bytesRead = 0;
    let totalTerms = 0;
    let capped = false;
    const candidates: string[] = [];
    const warn = (message: string) => {
      if (next.warnings.length < 50) next.warnings.push(message);
    };
    const progress = (phase: LibraryProgress['phase'], completed: number): void => {
      if (revision !== this.loadRevision) return;
      try { onProgress?.({ phase, completed, total: candidates.length }); } catch { /* A UI observer does not own the index. */ }
    };
    progress('scan', 0);
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (candidates.length >= MAX_CANDIDATES || revision !== this.loadRevision) return;
      if (depth > 20) {
        warn(`Skipped deeply nested folder: ${path.relative(resolvedRoot, directory)}`);
        return;
      }
      let entries;
      try {
        entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        if (depth === 0) throw new Error('Cannot read library folder. Check its permissions and try again.');
        warn(`Cannot read folder: ${path.relative(resolvedRoot, directory) || '.'}`);
        return;
      }
      for (const entry of entries) {
        if (revision !== this.loadRevision) return;
        if (candidates.length >= MAX_CANDIDATES) {
          warn('Library scan limited to 10,000 candidate files; use a smaller vault folder.');
          return;
        }
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(filename, depth + 1);
        else if (entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name)) {
          candidates.push(filename);
          if (candidates.length % 100 === 0) {
            progress('scan', 0);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }
      progress('scan', 0);
    };
    await walk(resolvedRoot, 0);
    if (revision !== this.loadRevision) return this.status();
    progress('index', 0);
    let completed = 0;
    for (const filename of candidates) {
      if (capped || revision !== this.loadRevision) break;
      const relativePath = path.relative(resolvedRoot, filename).split(path.sep).join('/');
      try {
        const info = await stat(filename);
        if (info.size > MAX_FILE_BYTES) {
          warn(`Skipped file over 10 MB: ${relativePath}`);
          continue;
        }
        if (next.documents.length >= MAX_DOCUMENTS || bytesRead + info.size > MAX_CORPUS_BYTES || next.passages.length >= MAX_PASSAGES) {
          capped = true;
          warn('Library limit reached (2,000 documents, 100 MB, or 60,000 passages); use a smaller vault folder.');
          break;
        }
        const data = await readFile(filename);
        if (data.byteLength > MAX_FILE_BYTES || bytesRead + data.byteLength > MAX_CORPUS_BYTES) {
          warn(`Skipped growing or oversized file: ${relativePath}`);
          continue;
        }
        bytesRead += data.byteLength;
        const text = data.toString('utf8');
        if (!text.trim() || text.includes('\0')) continue;
        const document: LibraryDocument = {
          id: createHash('sha256').update(relativePath).digest('hex').slice(0, 16),
          title: titleFor(text, filename),
          section: relativePath.includes('/') ? relativePath.split('/')[0]! : 'Vault root',
          relativePath,
        };
        next.documents.push(document);
        next.paths.set(document.id, filename);
        next.indexedBytes += data.byteLength;
        let number = 0;
        for (const chunk of chunks(text)) {
          if (revision !== this.loadRevision) break;
          if (next.passages.length >= MAX_PASSAGES) {
            capped = true;
            warn('Library passage limit reached; use a smaller vault folder.');
            break;
          }
          const words = tokens(`${document.title}\n${chunk.text}`);
          const counts = new Map<string, number>();
          for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
          const index = next.passages.length;
          next.passages.push({
            id: `${document.id}:${++number}`,
            documentId: document.id,
            title: document.title,
            section: document.section,
            relativePath,
            ...chunk,
            length: words.length,
          });
          totalTerms += words.length;
          for (const [word, count] of counts) {
            let postings = next.postings.get(word);
            if (!postings) {
              postings = new Map();
              next.postings.set(word, postings);
            }
            postings.set(index, count);
          }
          // Large single files also yield, so setup UI and IPC remain usable.
          if (number % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch {
        warn(`Cannot read article: ${relativePath}`);
      } finally {
        ++completed;
        progress('index', completed);
        // Avoid keeping the main event loop busy across many small documents.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    next.averageLength = totalTerms / Math.max(1, next.passages.length) || 1;
    next.indexDurationMs = Math.round(performance.now() - started);
    next.indexedAt = Date.now();
    if (revision === this.loadRevision) this.state = next;
    return this.status();
  }

  resolveDocument(id: string): string | undefined {
    return this.state.paths.get(id);
  }

  search(query: string, options: LibrarySearchOptions = {}): SourcePassage[] {
    const limit = boundedInteger(options.limit, 6, 20);
    const maxChars = boundedInteger(options.maxChars, 12_000, 40_000);
    if (!limit || !maxChars) return [];
    const terms = [...new Set(tokens(query.slice(-12_000)))].slice(-256);
    const state = this.state;
    const scores = new Map<number, number>();
    for (const term of terms) {
      const postings = state.postings.get(term);
      if (!postings) continue;
      const idf = Math.log(1 + (state.passages.length - postings.size + 0.5) / (postings.size + 0.5));
      for (const [index, frequency] of postings) {
        const passage = state.passages[index]!;
        if (options.section && passage.section !== options.section) continue;
        const denominator = frequency + 1.2 * (0.25 + 0.75 * passage.length / state.averageLength);
        const score = idf * frequency * 2.2 / denominator;
        scores.set(index, (scores.get(index) ?? 0) + score);
      }
    }
    const ranked = [...scores].map(([index, score]) => ({
      index,
      score: score * (state.passages[index]!.documentId === options.focusDocumentId ? 1.4 : 1),
    })).sort((a, b) => b.score - a.score || a.index - b.index);

    // Reserve at most half the budget for focus, leaving space for wider evidence.
    const focusCount = limit === 1 ? 1 : Math.min(2, Math.floor(limit / 2));
    const focus = ranked.filter((item) => state.passages[item.index]!.documentId === options.focusDocumentId).slice(0, focusCount);
    if (options.focusDocumentId && !focus.length) {
      const first = state.passages.findIndex((passage) => passage.documentId === options.focusDocumentId && (!options.section || passage.section === options.section));
      if (first >= 0) focus.push({ index: first, score: 0 });
    }
    const selected = [...focus];
    const selectedIndices = new Set(selected.map((item) => item.index));
    // Prefer a supporting document before filling remaining slots from focus.
    const support = ranked.find((item) => state.passages[item.index]!.documentId !== options.focusDocumentId);
    if (support && selected.length < limit) {
      selected.push(support);
      selectedIndices.add(support.index);
    }
    const perDocument = new Map<string, number>();
    for (const item of selected) {
      const id = state.passages[item.index]!.documentId;
      perDocument.set(id, (perDocument.get(id) ?? 0) + 1);
    }
    for (const item of ranked) {
      if (selected.length >= limit) break;
      if (selectedIndices.has(item.index)) continue;
      const id = state.passages[item.index]!.documentId;
      // Diversity matters for synthesis across a hundred articles.
      if ((perDocument.get(id) ?? 0) >= Math.max(2, Math.ceil(limit / 2))) continue;
      selected.push(item);
      selectedIndices.add(item.index);
      perDocument.set(id, (perDocument.get(id) ?? 0) + 1);
    }

    let remaining = maxChars;
    const result: SourcePassage[] = [];
    for (const item of selected) {
      if (remaining <= 0) break;
      const { length: _length, ...passage } = state.passages[item.index]!;
      const text = passage.text.slice(0, remaining);
      // Count only displayed lines when a final passage is trimmed to budget.
      const endLine = Math.min(passage.endLine, passage.startLine + text.split('\n').length - 1);
      result.push({ ...passage, text, endLine, score: item.score });
      remaining -= text.length;
    }
    return result;
  }
}
