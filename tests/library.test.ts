import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeLibrary, type LibraryProgress } from '../src/main/library.js';
import { performance } from 'node:perf_hooks';

async function vault(files: Record<string, string>, run: (folder: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'peek-library-test-'));
  try {
    for (const [relative, text] of Object.entries(files)) {
      const filename = path.join(folder, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, text);
    }
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('indexes Markdown and text with stable titles, sections, and exact line citations', async () => {
  const lines = ['---', 'title: "Narrative distance"', '---', '# Notes', '', 'Free indirect discourse blends a narrator with a character’s voice.', 'A second observation.'];
  await vault({ 'Theory/narrator.md': lines.join('\n'), 'root.txt': 'Other reading.' }, async (folder) => {
    const library = new KnowledgeLibrary();
    const status = await library.load(folder);
    assert.equal(status.documents.length, 2);
    assert.deepEqual(status.sections, ['Theory', 'Vault root']);
    const [hit] = library.search('free indirect discourse');
    assert.ok(hit);
    assert.equal(hit.title, 'Narrative distance');
    assert.equal(hit.relativePath, 'Theory/narrator.md');
    assert.equal(hit.text, lines.slice(hit.startLine - 1, hit.endLine).join('\n'));
    assert.equal(library.resolveDocument(hit.documentId), await realpath(path.join(folder, 'Theory/narrator.md')));
    assert.equal(library.resolveDocument('../../secret'), undefined);
    const firstId = hit.documentId;
    await library.load(folder);
    assert.equal(library.search('free indirect discourse')[0]?.documentId, firstId);
    // Public snapshots cannot mutate the internal document metadata.
    status.documents[0]!.title = 'Changed';
    assert.notEqual(library.status().documents[0]?.title, 'Changed');
  });
});

test('finds Chinese passages without whitespace and English passages in a mixed vault', async () => {
  await vault({
    '中国文学/鲁迅.md': '# 鲁迅的叙事艺术\n通过叙事视角与反讽展现人物的精神困境。',
    'English/modernism.md': '# Modernist narrative\nAn unreliable narrator creates uncertainty about an account.',
    'Other/garden.md': '# Gardens\nFlowers grow in the soil.',
  }, async (folder) => {
    const library = new KnowledgeLibrary();
    await library.load(folder);
    assert.equal(library.search('鲁迅叙事视角')[0]?.relativePath, '中国文学/鲁迅.md');
    assert.equal(library.search('unreliable narrator')[0]?.relativePath, 'English/modernism.md');
    assert.deepEqual(library.search('quantum electrodynamics'), []);
  });
});

test('focus reserves article context while retaining relevant evidence from elsewhere', async () => {
  await vault({
    'Section A/focus.md': '# Main article\nNarrative identity and memory form the argument.\n' + 'Narrative memory matters. '.repeat(300),
    'Section B/support.md': '# Related evidence\nMemory and narrative identity are socially reconstructed.',
    'Section B/unrelated.md': '# Engineering\nDistributed data networks and packet switching.',
  }, async (folder) => {
    const library = new KnowledgeLibrary();
    const status = await library.load(folder);
    const focus = status.documents.find((document) => document.relativePath.endsWith('focus.md'))!;
    const hits = library.search('memory narrative identity', { focusDocumentId: focus.id, limit: 4 });
    assert.equal(hits[0]?.documentId, focus.id);
    assert.ok(hits.some((hit) => hit.relativePath === 'Section B/support.md'));
    assert.ok(hits.length <= 4);
    assert.ok(hits.every((hit) => !hit.relativePath.endsWith('unrelated.md')));
    const filtered = library.search('memory narrative identity', { focusDocumentId: focus.id, section: 'Section B' });
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((hit) => hit.section === 'Section B'));
    const fallback = library.search('nonexistentterm', { focusDocumentId: focus.id });
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0]?.score, 0);
  });
});

test('bounds passages and prompt characters even for a single giant Markdown paragraph', async () => {
  await vault({ 'long.md': '# Long article\n' + 'characterization narrative '.repeat(1_000) }, async (folder) => {
    const library = new KnowledgeLibrary();
    const status = await library.load(folder);
    assert.ok(status.chunks > 5);
    const hits = library.search('characterization narrative', { limit: 2, maxChars: 2_050 });
    assert.ok(hits.length <= 2);
    assert.ok(hits.reduce((sum, hit) => sum + hit.text.length, 0) <= 2_050);
    assert.ok(hits.every((hit) => hit.startLine >= 1 && hit.endLine <= 2));
    assert.deepEqual(library.search('narrative', { maxChars: 0 }), []);
    assert.deepEqual(library.search('narrative', { limit: 0 }), []);
    assert.deepEqual(library.search('narrative', { limit: -3 }), []);
  });
});

test('skips hidden folders, dependencies, non-text files, and symlink traversal', async () => {
  await vault({
    '.obsidian/secret.md': 'secretobsidian',
    '.hidden.md': 'secrethidden',
    'node_modules/dependency.md': 'secretdependency',
    'image.pdf': 'secretpdf',
    'visible.md': 'publicpassage',
  }, async (folder) => {
    const external = await mkdtemp(path.join(os.tmpdir(), 'peek-external-test-'));
    try {
      await writeFile(path.join(external, 'secret.md'), 'secretoutside');
      await symlink(external, path.join(folder, 'linked-folder'), 'dir');
      await symlink(path.join(external, 'secret.md'), path.join(folder, 'linked.md'), 'file');
      const library = new KnowledgeLibrary();
      const status = await library.load(folder);
      assert.equal(status.documents.length, 1);
      assert.deepEqual(library.search('secretoutside secretobsidian secretdependency secretpdf'), []);
      assert.equal(library.search('publicpassage').length, 1);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test('invalid reload preserves a usable library, and oversize files are reported', async () => {
  await vault({ 'good.md': 'reliablecontext', 'large.md': 'x'.repeat(10 * 1024 * 1024 + 1) }, async (folder) => {
    const library = new KnowledgeLibrary();
    const status = await library.load(folder);
    assert.equal(status.documents.length, 1);
    assert.ok(status.warnings.some((warning) => warning.includes('over 10 MB')));
    await assert.rejects(library.load(path.join(folder, 'missing')));
    assert.equal(library.search('reliablecontext').length, 1);
  });
});

test('reports ordered discovery/index progress and committed metrics without exposing file contents', async () => {
  const files = { 'A/first.md': '# Chinese\n叙事结构与时代记忆。', 'second.txt': 'Narrative evidence.', 'empty.md': '' };
  await vault(files, async folder => {
    const library = new KnowledgeLibrary();
    const events: LibraryProgress[] = [];
    assert.equal(library.status().indexDurationMs, undefined);
    const before = Date.now();
    const status = await library.load(folder, progress => events.push(progress));
    assert.ok(events.length > 2);
    const indexing = events.filter(event => event.phase === 'index');
    assert.deepEqual(indexing.map(event => event.completed), [0, 1, 2, 3]);
    assert.ok(indexing.every(event => event.total === 3));
    const scans = events.filter(event => event.phase === 'scan');
    assert.ok(scans.every(event => event.completed === 0));
    assert.ok(scans.every((event, index) => index === 0 || event.total >= scans[index - 1]!.total));
    assert.equal(events.at(-1)?.phase, 'index');
    assert.ok(events.every(event => Object.keys(event).sort().join(',') === 'completed,phase,total'));
    assert.equal(status.documents.length, 2);
    assert.equal(status.indexedBytes, Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    assert.ok(Number.isFinite(status.indexDurationMs) && status.indexDurationMs! >= 0);
    assert.ok(status.indexedAt! >= before && status.indexedAt! <= Date.now());
    const prior = library.status();
    await assert.rejects(library.load(path.join(folder, 'missing'), progress => events.push(progress)));
    assert.deepEqual(library.status(), prior);
    assert.ok(library.search('叙事结构').length);
    // A renderer/IPC observer failing cannot discard successfully indexed data.
    const reloaded = await library.load(folder, () => { throw new Error('observer disconnected'); });
    assert.equal(reloaded.documents.length, 2);
    assert.equal(reloaded.warnings.length, 0);
  });
});

test('clearing for a different task removes old evidence and cancels pending index publication', async () => {
  await vault({ 'one.md': 'privatepriorcontext', 'two.md': 'additionalcontext' }, async folder => {
    const library = new KnowledgeLibrary();
    const prior = await library.load(folder);
    const priorId = prior.documents[0]!.id;
    assert.ok(library.search('privatepriorcontext').length);
    const next = await library.load(folder, progress => {
      if (progress.phase === 'index' && progress.completed === 1) library.clear();
    });
    assert.equal(next.root, null);
    assert.equal(next.documents.length, 0);
    assert.equal(next.indexedAt, undefined);
    assert.equal(library.resolveDocument(priorId), undefined);
    assert.deepEqual(library.search('privatepriorcontext additionalcontext'), []);
    assert.equal((await library.load(folder)).documents.length, 2);
  });
});

test('discovery is bounded and reaching the document cap remains observable', async () => {
  const files: Record<string, string> = {};
  // Discovery and document limits must both terminate with visible warnings.
  for (let index = 0; index < 10_002; index++) files[`article-${index}.md`] = `# Article ${index}\nEvidence.`;
  await vault(files, async folder => {
    const library = new KnowledgeLibrary();
    const events: LibraryProgress[] = [];
    const status = await library.load(folder, progress => events.push(progress));
    assert.equal(status.documents.length, 2_000);
    assert.ok(status.warnings.some(warning => warning.includes('Library limit')));
    const last = events.at(-1)!;
    assert.equal(last.total, 10_000);
    assert.ok(status.warnings.some(warning => warning.includes('scan limited')));
    assert.equal(last.completed, 2_001);
    assert.ok(events.every(event => event.completed <= event.total));
  });
});

test('retrieves from 100 diverse bilingual articles with at least 10,000 English words each', async t => {
  const files: Record<string, string> = {};
  const vocabulary = 'literature narrative memory character voice history context culture author reading identity migration archive testimony modernism realism metaphor irony dialogue silence rhythm translation reader witness agency landscape allegory ethics genre perspective narrator temporality symbolism ambiguity desire distance interpretation embodiment tradition intertextuality fragment sequence argument evidence language register speech representation structure materiality imagination community empire colonialism gender class ritual ecology realism reception literacy publication performance audience manuscript revision adaptation historical poetic rhetorical aesthetic comparative criticism canon vernacular displacement belonging testimony conflict reconciliation genealogy marginality subjectivity perception recollection uncertainty'.split(' ');
  const chinese = ['叙事视角连接个人记忆与时代经验', '作品通过反讽揭示人物精神困境', '现代文学重新思考传统与社会变迁', '不同译本影响读者对文化意象的理解', '叙述距离让人物声音呈现多重层次', '地方经验与迁徙主题相互映照', '诗歌节奏与象征共同组织情感', '历史档案和个人见证构成复杂对话', '文学批评需要比较证据与解释', '文本结构中的留白引导读者参与'];
  let characters = 0;
  let chineseCharacters = 0;
  for (let article = 0; article < 100; article += 1) {
    let seed = article + 1;
    const paragraphs: string[] = [];
    for (let paragraph = 0; paragraph < 100; paragraph++) {
      const words: string[] = [];
      for (let word = 0; word < 100; word++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        // A larger synthetic lexicon stresses postings beyond repeated prose.
        words.push(word % 3 === 0 ? `concept${seed % 20_000}` : vocabulary[seed % vocabulary.length]!);
      }
      const zh = chinese[(article + paragraph) % chinese.length]! + '；' + chinese[(article * 3 + paragraph * 7) % chinese.length]! + '。';
      chineseCharacters += Array.from(zh.match(/\p{Script=Han}/gu) ?? []).length;
      paragraphs.push(words.join(' ') + '.\n' + zh);
    }
    const text = `# Article ${article} 文学比较研究\n${paragraphs.join('\n\n')}\nDistinct evidence articlemarker${article}.`;
    characters += text.length;
    files[`Section ${article % 5}/article-${article}.md`] = text;
  }
  await vault(files, async folder => {
    const library = new KnowledgeLibrary();
    const events: LibraryProgress[] = [];
    const status = await library.load(folder, progress => events.push(progress));
    assert.equal(status.documents.length, 100);
    assert.equal(status.warnings.length, 0);
    assert.ok(status.chunks > 1_000);
    assert.equal(events.at(-1)?.completed, 100);
    const queryStart = performance.now();
    const [hit] = library.search('articlemarker87');
    const retrievalMs = performance.now() - queryStart;
    assert.ok(hit?.relativePath.endsWith('article-87.md'));
    assert.ok(hit.text.includes('articlemarker87'));
    const broadQueryStart = performance.now();
    assert.ok(library.search('叙事视角 人物精神困境 memory narrative interpretation').length > 0);
    const broadQueryMs = performance.now() - broadQueryStart;
    t.diagnostic(JSON.stringify({ synthetic: true, articles: 100, englishWordsAtLeast: 1_000_000, chineseCharacters, characters, indexedBytes: status.indexedBytes, passages: status.chunks, indexDurationMs: status.indexDurationMs, uniqueMarkerQueryMs: Number(retrievalMs.toFixed(2)), broadBilingualQueryMs: Number(broadQueryMs.toFixed(2)) }));
  });
});
