import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeLibrary } from '../src/main/library.js';

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

test('retrieves from a 100-article library with 10,000 words per article', async () => {
  const files: Record<string, string> = {};
  const paragraph = 'literature narrative memory character voice history context culture author reading ';
  for (let index = 0; index < 100; index += 1) {
    files[`Section ${index % 5}/article-${index}.md`] = `# Article ${index}\n${paragraph.repeat(1_000)}\nDistinct evidence articlemarker${index}.`;
  }
  await vault(files, async (folder) => {
    const library = new KnowledgeLibrary();
    const status = await library.load(folder);
    assert.equal(status.documents.length, 100);
    assert.equal(status.warnings.length, 0);
    assert.ok(status.chunks > 1_000);
    const [hit] = library.search('articlemarker87');
    assert.ok(hit?.relativePath.endsWith('article-87.md'));
    assert.ok(hit.text.includes('articlemarker87'));
  });
});
