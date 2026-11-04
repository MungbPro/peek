import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, TaskStoreError, TASK_LIMITS, type NewTaskTurn, type TaskContext } from '../src/main/tasks';

const context: TaskContext = {
  libraryPath: '/synthetic-vault', model: 'gpt-6.1-sol', focusDocumentId: 'synthetic-document',
  focusRelativePath: '文学/记忆.md', focusTitle: '记忆与叙事', section: '文学',
};
const turn: NewTaskTurn = {
  question: '记忆怎样改变叙述？\nHow does memory change the narrative?',
  answer: '记忆改变叙述顺序。(文学/记忆.md:3-5)', model: 'gpt-6.1-sol',
  sources: [{ relativePath: '文学/记忆.md', startLine: 3, endLine: 5, title: '记忆与叙事' }],
};

async function fixture<T>(run: (directory: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'peek-tasks-test-'));
  try { return await run(join(root, 'tasks'), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('tasks reopen with exact authorized Q&A, citations, context, and bounded summaries', () => fixture(async directory => {
  let clock = 1000;
  const store = new TaskStore(directory, { now: () => clock++ });
  const created = await store.create(context);
  assert.match(created.name, /^记忆与叙事 · /);
  assert.equal(created.turns.length, 0);
  const appended = await store.appendTurn(created.id, turn);
  assert.equal(appended.turns[0].question, turn.question);
  assert.equal(appended.turns[0].answer, turn.answer);
  assert.deepEqual(appended.turns[0].sources, turn.sources);
  const reopened = new TaskStore(directory);
  assert.deepEqual(await reopened.get(created.id), appended);
  const listed = await reopened.list();
  assert.deepEqual(listed, [{ id: appended.id, name: appended.name, createdAt: appended.createdAt, updatedAt: appended.updatedAt, turnCount: 1, context: appended.context }]);
  assert.equal('turns' in listed[0], false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, `${created.id}.json`))).mode & 0o777, 0o600);
  }
}));

test('mutations serialize without losing concurrent turns or updated task context', () => fixture(async directory => {
  let clock = 1000;
  const store = new TaskStore(directory, { now: () => clock++ });
  const first = await store.create({ libraryPath: '', model: 'gpt-6.1-sol' });
  assert.match(first.name, /^对话任务 · /);
  const second = await store.create({ ...context, focusTitle: '', section: '现代文学' });
  assert.match(second.name, /^现代文学 · /);
  await Promise.all([
    store.appendTurn(first.id, { ...turn, question: 'first question' }),
    store.updateContext(first.id, { ...context, model: 'gpt-6-astra' }),
    store.appendTurn(first.id, { ...turn, question: 'second question', model: 'gpt-6-astra' }),
  ]);
  const saved = await store.get(first.id);
  assert.deepEqual(saved.turns.map(item => item.question), ['first question', 'second question']);
  assert.equal(saved.context.model, 'gpt-6-astra');
  assert.equal(saved.turns[0].model, 'gpt-6.1-sol');
  assert.equal(saved.turns[1].model, 'gpt-6-astra');
  assert.match(saved.name, /^记忆与叙事 · /);
  assert.equal((await store.list())[0].id, first.id);
}));

test('failed atomic replace preserves prior JSON and removes temporary sensitive content', () => fixture(async directory => {
  const normal = new TaskStore(directory);
  const task = await normal.create(context);
  await normal.appendTurn(task.id, turn);
  const filename = join(directory, `${task.id}.json`);
  const before = await readFile(filename, 'utf8');
  const failing = new TaskStore(directory, { replaceFile: async () => { throw new Error('synthetic private filesystem error'); } });
  await assert.rejects(() => failing.appendTurn(task.id, { ...turn, question: 'Do not commit this turn' }), error => error instanceof TaskStoreError && error.code === 'io' && !error.message.includes('private'));
  await assert.rejects(() => failing.updateContext(task.id, { ...context, model: 'gpt-6-astra' }), { code: 'io' });
  await assert.rejects(() => failing.create(context), { code: 'io' });
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.deepEqual(await readdir(directory), [`${task.id}.json`]);
  assert.equal((await new TaskStore(directory).get(task.id)).turns.length, 1);
}));

test('only allowlisted task data is persisted, without keys, screenshots, audio, excerpts, or rolling buffers', () => fixture(async directory => {
  const secret = 'synthetic-private-material-must-not-be-saved';
  const store = new TaskStore(directory);
  const task = await store.create({ ...context, apiKey: secret, screenshot: secret, transcriptBuffer: secret } as TaskContext);
  await store.appendTurn(task.id, {
    ...turn, apiKey: secret, audio: secret, transcript: secret,
    sources: [{ ...turn.sources![0], text: secret, rawAudio: secret }],
  } as unknown as NewTaskTurn);
  const raw = await readFile(join(directory, `${task.id}.json`), 'utf8');
  assert.equal(raw.includes(secret), false);
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved.context).sort(), ['focusDocumentId', 'focusRelativePath', 'focusTitle', 'libraryPath', 'model', 'section']);
  assert.deepEqual(Object.keys(saved.turns[0]).sort(), ['answer', 'createdAt', 'id', 'model', 'question', 'sources']);
  assert.deepEqual(Object.keys(saved.turns[0].sources[0]).sort(), ['endLine', 'relativePath', 'startLine', 'title']);
}));

test('invalid IDs and traversal source paths cannot access other files', () => fixture(async (directory, root) => {
  const store = new TaskStore(directory);
  const task = await store.create(context);
  const outside = join(root, 'outside.json');
  await writeFile(outside, 'keep this file');
  for (const invalid of ['../outside', '/tmp/escape', `${task.id}/../outside`, 'not-a-uuid']) {
    await assert.rejects(() => store.get(invalid), { code: 'invalid' });
    await assert.rejects(() => store.delete(invalid), { code: 'invalid' });
  }
  for (const path of ['../outside.md', '/outside.md', 'C:\\outside.md', 'folder/../outside.md']) {
    await assert.rejects(() => store.appendTurn(task.id, { ...turn, sources: [{ relativePath: path, startLine: 1, endLine: 2 }] }), { code: 'invalid' });
  }
  await assert.rejects(() => store.create({ libraryPath: 'relative-vault', model: 'gpt-6.1-sol' }), { code: 'invalid' });
  assert.equal(await readFile(outside, 'utf8'), 'keep this file');
  assert.equal((await store.get(task.id)).turns.length, 0);
}));

test('symbolic task files and task folders are refused without following them', { skip: process.platform === 'win32' }, () => fixture(async (directory, root) => {
  const store = new TaskStore(directory);
  const task = await store.create(context);
  const external = join(root, 'outside.json');
  const externalContent = JSON.stringify(task);
  await writeFile(external, externalContent);
  const linkedId = randomUUID();
  await symlink(external, join(directory, `${linkedId}.json`));
  await assert.rejects(() => store.get(linkedId), { code: 'corrupt' });
  await assert.rejects(() => store.appendTurn(linkedId, turn), { code: 'corrupt' });
  await assert.rejects(() => store.delete(linkedId), { code: 'corrupt' });
  const linkedDirectory = join(root, 'linked-tasks');
  await symlink(directory, linkedDirectory);
  await assert.rejects(() => new TaskStore(linkedDirectory).list(), { code: 'io' });
  assert.equal(await readFile(external, 'utf8'), externalContent);
}));

test('corrupt and oversized files are not overwritten; explicit deletion removes only that task', () => fixture(async (directory, root) => {
  const store = new TaskStore(directory);
  const broken = await store.create(context);
  const preserved = await store.create(context);
  const filename = join(directory, `${broken.id}.json`);
  await writeFile(filename, '{broken json');
  await assert.rejects(() => store.get(broken.id), { code: 'corrupt' });
  await assert.rejects(() => store.appendTurn(broken.id, turn), { code: 'corrupt' });
  assert.equal(await readFile(filename, 'utf8'), '{broken json');
  await truncate(filename, TASK_LIMITS.taskBytes + 1);
  await assert.rejects(() => store.get(broken.id), { code: 'corrupt' });
  assert.equal((await stat(filename)).size, TASK_LIMITS.taskBytes + 1);
  const source = join(root, 'original-article.md');
  await writeFile(source, 'Original article');
  await store.delete(broken.id);
  await store.delete(broken.id);
  await assert.rejects(() => store.get(broken.id), { code: 'not_found' });
  assert.equal((await store.get(preserved.id)).id, preserved.id);
  assert.equal(await readFile(source, 'utf8'), 'Original article');
}));

test('question, answer, and turn limits reject without trimming previous history', () => fixture(async directory => {
  const store = new TaskStore(directory, { now: () => 1000 });
  const task = await store.create(context);
  const exact = await store.appendTurn(task.id, { ...turn, question: '问'.repeat(TASK_LIMITS.questionCharacters), answer: '答'.repeat(TASK_LIMITS.answerCharacters) });
  assert.equal(exact.turns[0].question.length, TASK_LIMITS.questionCharacters);
  assert.equal(exact.turns[0].answer.length, TASK_LIMITS.answerCharacters);
  const filename = join(directory, `${task.id}.json`);
  const before = await readFile(filename, 'utf8');
  await assert.rejects(() => store.appendTurn(task.id, { ...turn, question: 'x'.repeat(TASK_LIMITS.questionCharacters + 1) }), { code: 'invalid' });
  await assert.rejects(() => store.appendTurn(task.id, { ...turn, answer: 'x'.repeat(TASK_LIMITS.answerCharacters + 1) }), { code: 'invalid' });
  assert.equal(await readFile(filename, 'utf8'), before);
  const full = { ...task, turns: Array.from({ length: TASK_LIMITS.turns }, () => ({ ...turn, sources: [], id: randomUUID(), createdAt: 1000 })) };
  await writeFile(filename, JSON.stringify(full));
  const fullBefore = await readFile(filename, 'utf8');
  await assert.rejects(() => store.appendTurn(task.id, turn), { code: 'limit' });
  assert.equal(await readFile(filename, 'utf8'), fullBefore);
  assert.equal((await store.get(task.id)).turns.length, TASK_LIMITS.turns);
}));

test('task-count limit rejects new tasks without deleting any existing task', () => fixture(async directory => {
  const store = new TaskStore(directory);
  const ids: string[] = [];
  for (let index = 0; index < TASK_LIMITS.tasks; index++) ids.push((await store.create({ libraryPath: '', model: 'gpt-6.1-sol' })).id);
  await assert.rejects(() => store.create(context), { code: 'limit' });
  assert.equal((await store.list()).length, TASK_LIMITS.tasks);
  assert.equal((await store.get(ids[0])).id, ids[0]);
  assert.equal((await store.get(ids.at(-1)!)).id, ids.at(-1));
}));
