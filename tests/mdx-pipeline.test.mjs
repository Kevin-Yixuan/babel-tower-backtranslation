import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-idb.mjs';

installFakeIndexedDb();

import { MdxReader, blobRandomAccess } from '../mdx/mdx-reader.js';
import { importDictionary, toImportError } from '../mdx/mdx-indexer.js';
import { countWords, loadStaging } from '../mdx/mdx-db.js';
import { lookup, neighboursOf, status, suggest } from '../mdx/mdx-lookup.js';
import { asFile, buildMdx, entryHtml } from './mdx-fixture.mjs';

const ENTRIES = [
  { word: 'apple', html: entryHtml('apple', { pos: 'n.', defZh: '苹果', defEn: 'a round fruit', examples: ['an apple a day'] }) },
  { word: 'apples', html: '@@@LINK=apple' },
  { word: 'apply', html: entryHtml('apply', { pos: 'v.', defZh: '申请；应用', defEn: 'to make a request', examples: ['apply for a job', 'apply the rule'] }) },
  { word: 'appliance', html: entryHtml('appliance', { pos: 'n.', defZh: '器具', defEn: 'a device', examples: ['household appliance'] }) },
  { word: 'zebra', html: entryHtml('zebra', { pos: 'n.', defZh: '斑马', defEn: 'a striped animal', examples: ['a zebra crossing'] }) }
];

let fixtureFile;
before(() => {
  fixtureFile = asFile(buildMdx(ENTRIES), 'fixture.mdx');
});

async function importFixture(options = {}) {
  const progress = [];
  const stats = await importDictionary({
    file: fixtureFile, ...options,
    onProgress: event => { progress.push(event); options.onProgress?.(event); }
  });
  return { stats, progress };
}

test('reader reads the fixture header and reports the encryption flags', async () => {
  const reader = await new MdxReader(blobRandomAccess(fixtureFile)).open();
  assert.equal(reader.meta.numEntries, ENTRIES.length);
  assert.equal(reader.meta.title, 'Fixture Dictionary');
  assert.equal(reader.meta.encrypted, 2);
  assert.equal(reader.meta.keyIndexEncrypted, true);
  assert.equal(reader.meta.keywordHeaderEncrypted, false);
});

test('encrypted keyword index decrypts to the real headwords', async () => {
  const reader = await new MdxReader(blobRandomAccess(fixtureFile)).open();
  const words = [];
  for await (const { keywords } of reader.readKeywordBlocks()) words.push(...keywords.map(item => item.word));
  assert.deepEqual(words, ENTRIES.map(entry => entry.word));
});

test('import stores entries, resolves redirects and reports progress', async () => {
  const { stats, progress } = await importFixture();
  assert.equal(stats.status, 'ready');
  assert.equal(stats.wordCount, ENTRIES.length);
  assert.equal(stats.realEntries, 4);
  assert.equal(stats.redirectEntries, 1);
  assert.ok(progress.some(item => item.phase === 'keywords'));
  assert.ok(progress.some(item => item.phase === 'records'));
  assert.ok(progress.some(item => item.phase === 'done'));
  assert.equal(progress.at(-1).percent, 100);
});

test('lookup keeps 词性、释义 和 例句', async () => {
  await importFixture();
  const result = await lookup('apply');
  assert.equal(result.found, true);
  assert.equal(result.row.headword, 'apply');
  assert.equal(result.row.senses[0].pos, 'v.');
  assert.equal(result.row.senses[0].defZh, '申请；应用');
  assert.equal(result.row.senses[0].defEn, 'to make a request');
  assert.deepEqual(result.row.senses[0].examples, ['apply for a job', 'apply the rule']);
});

test('词条跳转 follows @@@LINK and reports the hop', async () => {
  await importFixture();
  const result = await lookup('apples');
  assert.equal(result.found, true);
  assert.equal(result.row.word, 'apple');
  assert.deepEqual(result.hops, [{ from: 'apples', to: 'apple' }]);
  assert.equal(result.row.senses[0].defZh, '苹果');
});

test('missing words are reported with suggestions, never as an empty hit', async () => {
  await importFixture();
  const result = await lookup('appl');
  assert.equal(result.found, false);
  assert.equal(result.reason, 'not-found');
  assert.match(result.message, /本地词典里没有/);
  assert.ok(result.suggestions.includes('apple'));
});

test('missing 图片/音频 resources are called out explicitly', async () => {
  await importFixture();
  const result = await lookup('zebra');
  assert.equal(result.found, true);
  assert.equal(result.row.media.audio >= 1, true);
  assert.equal(result.row.media.images >= 1, true);
  assert.match(result.notice, /\.mdd 资源文件/);
});

test('上一个 / 下一个 词条 navigation follows dictionary order', async () => {
  await importFixture();
  const result = await lookup('apply');
  const around = await neighboursOf('apply');
  assert.equal(around.previous.at(-1)?.word, 'apples');
  assert.equal(around.next[0]?.word, 'appliance');
  assert.equal(typeof result.row.order, 'number');
});

test('prefix suggestions come from the local index', async () => {
  await importFixture();
  const list = await suggest('app', 5);
  assert.deepEqual(list.map(item => item.word).sort(), ['apple', 'apples', 'appliance', 'apply']);
});

test('status reports readiness only after a finished import', async () => {
  await importFixture();
  const state = await status();
  assert.equal(state.ready, true);
  assert.equal(state.meta.mode, 'compact');
});

test('cancel stops the import and throws a cancellable error', async () => {
  const controller = new AbortController();
  await assert.rejects(
    importFixture({
      signal: controller.signal,
      onProgress: event => { if (event.phase === 'keywords') controller.abort(); }
    }),
    error => error.reason === 'cancelled' && /已取消/.test(error.message)
  );
});

test('duplicate headwords are kept, and a real entry beats a link', async () => {
  // LDOCE5++ carries "apple" twice: a real entry and an @@@LINK to an embedded image.
  const file = asFile(buildMdx([
    { word: 'apple', html: '@@@LINK=ldoce4188jpg' },
    { word: 'Apple', html: entryHtml('Apple', { defZh: '苹果（公司）', defEn: 'a technology company' }) },
    { word: 'zebra', html: entryHtml('zebra') }
  ]));
  const stats = await importDictionary({ file });
  assert.equal(stats.headwordsRead, 3, 'every headword in the file is read');
  assert.equal(stats.duplicateHeadwords, 1);
  assert.equal(stats.wordCount, 2, 'the link is replaced by the real entry under the same key');
  const result = await lookup('apple');
  assert.equal(result.found, true);
  assert.equal(result.row.senses[0].defZh, '苹果（公司）', 'the real entry wins the plain key');
});

test('a word that only resolves to an image record says so instead of showing nothing', async () => {
  const file = asFile(buildMdx([
    { word: 'apples', html: '@@@LINK=shotjpg' },
    { word: 'shotjpg', html: '<span id="shotjpg" src="data:image/jpeg;base64,AAAA"></span>' },
    { word: 'zebra', html: entryHtml('zebra') }
  ]));
  await importDictionary({ file });
  const result = await lookup('apples');
  assert.equal(result.found, false);
  assert.equal(result.reason, 'resource-entry');
  assert.match(result.message, /图片/);
});

test('.eubak is refused with the real reason', async () => {
  await assert.rejects(
    importDictionary({ file: asFile(Buffer.from('<Dicts/>'), 'words.eubak') }),
    /配置备份/
  );
});

test('a file that is not an MDX is refused, not imported as an empty list', async () => {
  await assert.rejects(
    importDictionary({ file: asFile(Buffer.from('just some plain text, not a dictionary at all'), 'notes.txt') }),
    error => error.reason === 'not-mdx' || error.reason === 'no-source'
  );
});

test('a keyword-header encrypted dictionary reports the real blocker', async () => {
  const file = asFile(buildMdx(ENTRIES, { encrypted: 1 }), 'locked.mdx');
  await assert.rejects(
    new MdxReader(blobRandomAccess(file)).open(),
    error => error.reason === 'encrypted-keyword-header' && /注册码/.test(error.message)
  );
});

// ---- replacement safety: a failed/cancelled import must never touch the ready index --------

test('cancel during record writes keeps the old library; the retry completes', async () => {
  await importFixture();
  const before = await status();
  const beforeCount = await countWords();
  assert.equal((await lookup('apply')).found, true);

  const other = asFile(buildMdx([
    { word: 'newword', html: entryHtml('newword', { defZh: '新词', defEn: 'a fresh word' }) },
    { word: 'another', html: entryHtml('another') }
  ]), 'other.mdx');
  const controller = new AbortController();
  await assert.rejects(
    importDictionary({
      file: other, batchSize: 1, signal: controller.signal,
      onProgress: event => { if (event.phase === 'records') controller.abort(); }
    }),
    error => error.reason === 'cancelled' && /已取消/.test(error.message)
  );

  // Old library fully intact: ready meta, same count, old words queryable, new words absent.
  const after = await status();
  assert.equal(after.ready, true);
  assert.equal(after.meta.wordCount, before.meta.wordCount);
  assert.equal(await countWords(), beforeCount);
  assert.equal((await lookup('apply')).found, true);
  assert.equal((await lookup('newword')).found, false);
  assert.equal(await loadStaging(), null, 'staging leftovers are cleaned');

  // Retry the same file without changes - it must complete and switch.
  const stats = await importDictionary({ file: other, batchSize: 1 });
  assert.equal(stats.status, 'ready');
  assert.equal((await lookup('newword')).found, true);
  assert.equal((await lookup('apply')).found, false, 'old store is only released after the switch');
  assert.equal(await countWords(), stats.wordCount);
  assert.equal(await loadStaging(), null);
});

test('a corrupt record block fails the import but keeps the previous library', async () => {
  await importFixture();
  const beforeCount = await countWords();
  const bad = Buffer.from(buildMdx([{ word: 'auditnew', html: entryHtml('auditnew') }]));
  bad[bad.length - 8] ^= 255; // corrupt the record block payload
  await assert.rejects(
    importDictionary({ file: asFile(bad, 'corrupt.mdx') }),
    error => error.reason === 'decompress-failed' || /损坏|解压/.test(error.message)
  );
  assert.equal((await status()).ready, true);
  assert.equal(await countWords(), beforeCount);
  assert.equal((await lookup('apply')).found, true);
  assert.equal(await loadStaging(), null);
});

test('an MDX 3.0 file is refused and the previous library survives', async () => {
  await importFixture();
  const beforeCount = await countWords();
  const file = asFile(buildMdx(ENTRIES, { engine: '3.0' }), 'v3.mdx');
  await assert.rejects(
    importDictionary({ file }),
    error => error.reason === 'unsupported-version' && /3\.0/.test(error.message)
  );
  assert.equal((await status()).ready, true);
  assert.equal(await countWords(), beforeCount);
  assert.equal((await lookup('apply')).found, true);
  assert.equal(await loadStaging(), null);
});

test('cancelling the very first import leaves no index and no staging leftovers', async () => {
  const { clearAll } = await import('../mdx/mdx-db.js');
  await clearAll();
  const controller = new AbortController();
  await assert.rejects(
    importDictionary({
      file: fixtureFile, signal: controller.signal,
      onProgress: event => { if (event.phase === 'keywords') controller.abort(); }
    }),
    error => error.reason === 'cancelled'
  );
  assert.equal((await status()).ready, false);
  assert.equal(await countWords(), 0);
  assert.equal(await loadStaging(), null);
  assert.equal((await lookup('apply')).reason, 'no-index');
});

test('quota failures are reported as recoverable, never as a broken library', () => {
  const quota = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  const mapped = toImportError(quota);
  assert.equal(mapped.reason, 'quota');
  assert.match(mapped.message, /存储空间不足/);
  assert.match(mapped.message, /原有词典未被修改/);
  const cancelled = Object.assign(new Error('已取消导入。'), { reason: 'cancelled' });
  assert.equal(toImportError(cancelled), cancelled, 'cancel messages pass through unchanged');
});

test('a legacy v1 index (meta without a store field) stays queryable and can be replaced', async () => {
  const { clearAll, saveMeta, writeBatch } = await import('../mdx/mdx-db.js');
  await clearAll();
  // Recreate what schema-v1 code left behind: rows in `words`, meta without `store`.
  await writeBatch([
    { word: 'legacyword', display: 'legacyword', order: 0, kind: 'entry', headword: 'legacyword',
      pronunciation: '', senses: [{ pos: 'n.', signpost: '', grammar: '', defEn: 'old definition', defZh: '旧词条', examples: [] }],
      text: 'legacyword', media: { images: 0, audio: 0 } },
    { word: 'legacylink', display: 'legacylink', order: 1, kind: 'redirect', target: 'legacyword' }
  ], 'words');
  await saveMeta({ status: 'ready', title: 'Legacy Dictionary', wordCount: 2, realEntries: 1, redirectEntries: 1, importedAt: '2026-01-01T00:00:00.000Z' });

  const state = await status();
  assert.equal(state.ready, true, 'legacy meta must count as ready');
  const hit = await lookup('legacyword');
  assert.equal(hit.found, true);
  assert.equal(hit.row.senses[0].defZh, '旧词条');
  assert.equal((await lookup('legacylink')).found, true, 'legacy redirects resolve');
  assert.equal(await countWords(), 2, 'legacy rows are read from the v1 store');

  // Replacing it goes through the staging path and releases the legacy store afterwards.
  const stats = await importDictionary({ file: fixtureFile });
  assert.equal(stats.status, 'ready');
  assert.equal((await lookup('legacyword')).found, false);
  assert.equal((await lookup('apply')).found, true);
  assert.equal(await countWords(), stats.wordCount);
});

test('crashed-import leftovers are swept without touching the ready index; live imports are protected', async () => {
  await importFixture();
  const before = await status();
  const beforeCount = await countWords();
  const { beginImport, discardImport, saveStaging, sweepStaging, writeBatch } = await import('../mdx/mdx-db.js');

  // Simulate a browser that died mid-import: partial rows in the inactive store + stale record.
  const stagingStore = before.meta.store === 'words' ? 'words2' : 'words';
  await writeBatch([{ word: 'halfrow', display: 'halfrow', order: 0, kind: 'missing' }], stagingStore);
  await saveStaging({
    store: stagingStore, status: 'importing',
    startedAt: Date.now() - 600000, heartbeatAt: Date.now() - 600000
  });

  assert.equal((await lookup('apply')).found, true, 'ready index answers while garbage sits in staging');
  assert.equal(await sweepStaging(), 'swept');
  assert.equal(await loadStaging(), null, 'staging record removed');
  assert.equal(await countWords(stagingStore), 0, 'staging leftovers removed');
  assert.equal(await countWords(), beforeCount, 'ready store untouched');
  assert.equal((await status()).ready, true);

  // A fresh heartbeat means "another tab is importing right now": do not wipe it, refuse instead.
  await saveStaging({ store: stagingStore, status: 'importing', startedAt: Date.now(), heartbeatAt: Date.now() });
  assert.equal(await sweepStaging(), 'live');
  assert.notEqual(await loadStaging(), null);
  await assert.rejects(beginImport(), error => error.reason === 'busy' && /另一个页面/.test(error.message));
  await discardImport(); // test cleanup
  assert.equal(await loadStaging(), null);
  assert.equal((await status()).ready, true);
  assert.equal((await lookup('apply')).found, true);
});
