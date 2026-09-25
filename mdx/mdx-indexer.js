// Import orchestration: parse -> extract -> batched IndexedDB writes, with progress and cancel.
// The ready index is never touched while a new file imports: rows go into a staging store
// (see mdx-db.js), are verified, and only then become the active index in one atomic switch.
// Cancel, corrupt data, unsupported formats or a full disk all end in discardImport(), so the
// previous dictionary keeps answering queries throughout.
import { MdxReader, blobRandomAccess } from './mdx-reader.js';
import { extractEntry, redirectTarget } from './mdx-html.js';
import {
  activateImport, beginImport, countWords, discardImport, searchPrefix, touchStaging, writeBatch
} from './mdx-db.js';

export const MODES = {
  compact: { label: '精简', keepHtml: false, maxSenses: 10, maxExamples: 4 },
  full: { label: '完整', keepHtml: true, maxSenses: 14, maxExamples: 6, maxSafeHtml: 12000 }
};

const DEFAULT_BATCH = 400;

export function cancelError() {
  const error = new Error('已取消导入。');
  error.reason = 'cancelled';
  return error;
}

function aborted(signal) {
  return Boolean(signal?.aborted);
}

/** Map low-level storage failures to actionable messages before they reach the UI. */
export function toImportError(error) {
  if (!error) return new Error('导入失败。');
  if (error.reason === 'cancelled') return error;
  const described = `${error.name || ''} ${error.message || ''}`;
  if (error.name === 'QuotaExceededError' || /quota/i.test(described)) {
    const wrapped = new Error('浏览器存储空间不足，导入已停止并清理了临时数据。原有词典未被修改；释放一些空间后可以重试。');
    wrapped.reason = 'quota';
    return wrapped;
  }
  return error;
}

function verifyError(message) {
  const error = new Error(message);
  error.reason = 'verify-failed';
  return error;
}

/**
 * @param {Object} options
 * @param {File|Blob} options.file            the .mdx file picked by the user
 * @param {'compact'|'full'} [options.mode]
 * @param {AbortSignal} [options.signal]
 * @param {(progress:{phase:string,message:string,done:number,total:number,percent:number}) => void} [options.onProgress]
 * @param {boolean} [options.hasResourceFile] whether a companion .mdd is available
 */
export async function importDictionary(options) {
  const {
    file, mode = 'compact', signal, onProgress = () => {}, batchSize = DEFAULT_BATCH,
    hasResourceFile = false
  } = options;
  const settings = MODES[mode] || MODES.compact;
  const report = (phase, message, done, total) => onProgress({
    phase, message, done, total,
    percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0
  });

  if (!file) throw new Error('请先选择一个 .mdx 词典文件。');
  if (/\.eubak$/i.test(file.name || '')) {
    throw new Error('.eubak 只是欧路词典的配置备份（里面只有 .mdx 的路径，没有词条）。请选择实际的 .mdx 文件。');
  }

  const started = Date.now();
  report('open', '正在读取词典文件头…', 0, 100);
  const reader = await new MdxReader(blobRandomAccess(file)).open();
  if (aborted(signal)) throw cancelError();

  // ---- headwords (read-only; the ready index is not touched yet) --------
  const totalKeywords = reader.meta.numEntries;
  const words = new Array(totalKeywords);
  const offsets = new Float64Array(totalKeywords);
  let ki = 0;
  report('keywords', `正在读取 ${totalKeywords.toLocaleString()} 个词头…`, 0, totalKeywords);
  for await (const { keywords } of reader.readKeywordBlocks({ signal })) {
    for (const { word, recordOffset } of keywords) {
      if (ki >= totalKeywords) break;
      words[ki] = word;
      offsets[ki] = recordOffset;
      ki++;
    }
    report('keywords', `正在读取词头…（${ki.toLocaleString()} / ${totalKeywords.toLocaleString()}）`, ki, totalKeywords);
  }
  if (aborted(signal)) throw cancelError();
  if (!ki) throw new Error('这个词典里没有读到任何词头，导入中止，不会建立空索引。');

  // ---- staging: writes go to the inactive store, never to the ready one --
  let staging;
  try {
    staging = await beginImport({ fileName: file.name || '' });
  } catch (error) {
    throw toImportError(error);
  }

  try {
    let next = 0;                 // pointer into words[]
    let order = 0;
    let realEntries = 0;
    let redirectEntries = 0;
    let emptyEntries = 0;
    let duplicateHeadwords = 0;
    let suffixedKeys = 0;
    let pending = [];
    // Headwords are stored lower-cased, so the same key can legitimately appear twice with
    // different content (LDOCE5++ has "apple" both as a real entry and as a link to an image
    // resource). Duplicates get a suffixed key so no headword is silently lost, and a real
    // entry always wins the plain key over a redirect.
    const usedKeys = new Set();
    const storedKind = new Map();
    const blocksTotal = reader.recordBlocks.length;
    let blocksDone = 0;
    let lastHeartbeat = Date.now();

    const KEY_SEPARATOR = String.fromCharCode(1); // suffixed duplicate keys: base + 0x01 + n

    const flush = async () => {
      if (!pending.length) return;
      const rows = pending;
      pending = [];
      await writeBatch(rows, staging.store);
      if (aborted(signal)) throw cancelError();
    };

    for await (const { block, flat } of reader.readRecordBlocks({ signal })) {
      blocksDone++;
      const blockEnd = block.decompStart + flat.length;
      if (next < totalKeywords && offsets[next] < block.decompStart) next++; // safety: skip orphans
      if (next >= totalKeywords || offsets[next] >= blockEnd) {
        report('records', `正在写入词条…（${blocksDone} / ${blocksTotal} 块）`, blocksDone, blocksTotal);
        continue;
      }
      const byOffset = new Map();
      for (const record of reader.extractRecords(block, flat)) byOffset.set(record.offset, record.text);

      while (next < totalKeywords && offsets[next] < blockEnd) {
        const word = words[next];
        const raw = byOffset.get(offsets[next]) ?? '';
        next++;
        if (!word) continue;
        const baseKey = word.toLowerCase();
        const redirect = redirectTarget(raw);
        let kind = 'entry';
        if (redirect) kind = 'redirect';
        else if (!raw) kind = 'missing';

        let key = baseKey;
        if (usedKeys.has(baseKey)) {
          duplicateHeadwords++;
          if (kind === 'entry' && storedKind.get(baseKey) !== 'entry') {
            storedKind.set(baseKey, 'entry'); // real entry upgrades a previously stored link
          } else {
            key = `${baseKey}${KEY_SEPARATOR}${duplicateHeadwords}`;
            suffixedKeys++;
          }
        } else {
          usedKeys.add(baseKey);
          storedKind.set(baseKey, kind);
        }
        if (redirect) {
          pending.push({ word: key, display: word, order: order++, kind: 'redirect', target: redirect.toLowerCase() });
          redirectEntries++;
        } else if (raw) {
          const entry = extractEntry(raw, {
            hasResourceFile,
            maxSenses: settings.maxSenses,
            maxExamples: settings.maxExamples,
            maxSafeHtml: settings.maxSafeHtml || 12000,
            keepHtml: settings.keepHtml
          });
          const row = {
            word: key,
            display: word,
            order: order++,
            kind: 'entry',
            headword: entry.headword || word,
            pronunciation: entry.pronunciation,
            senses: entry.senses,
            text: entry.text,
            media: entry.media
          };
          if (settings.keepHtml) row.html = entry.safeHtml;
          if (!entry.senses.length && !entry.text) emptyEntries++;
          pending.push(row);
          realEntries++;
        } else {
          // Record missing in the file - keep the headword so the entry is still reachable.
          pending.push({ word: key, display: word, order: order++, kind: 'missing', target: '' });
          emptyEntries++;
        }
        if (pending.length >= batchSize) await flush();
      }
      report('records', `正在写入词条…（${blocksDone} / ${blocksTotal} 块，已存 ${(usedKeys.size + suffixedKeys).toLocaleString()} 条）`, blocksDone, blocksTotal);
      if (Date.now() - lastHeartbeat > 5000) {
        lastHeartbeat = Date.now();
        await touchStaging(staging);
      }
    }
    if (aborted(signal)) throw cancelError();
    await flush();

    // ---- verify the staging store before anything becomes visible --------
    report('verify', '正在校验新索引…', 0, 100);
    const stats = {
      ...reader.meta,
      mode,
      fileName: file.name || '',
      fileSize: file.size,
      hasResourceFile,
      importedAt: new Date().toISOString(),
      status: 'ready',
      wordCount: usedKeys.size + suffixedKeys,
      headwordsRead: order,
      realEntries,
      redirectEntries,
      emptyEntries,
      duplicateHeadwords,
      durationMs: Date.now() - started
    };
    const written = await countWords(staging.store);
    if (written !== stats.wordCount) {
      throw verifyError(`新索引校验失败：写入 ${written} 条，应为 ${stats.wordCount} 条。已放弃切换，原有词典未受影响，可重新导入。`);
    }
    const probes = [words[0], words[Math.floor(ki / 2)], words[ki - 1]].filter(Boolean);
    for (const probe of probes) {
      const hit = await searchPrefix(String(probe).toLowerCase(), 1, staging.store);
      if (!hit.length) {
        throw verifyError(`新索引校验失败：词头「${probe}」未写入。已放弃切换，原有词典未受影响，可重新导入。`);
      }
    }

    // ---- single atomic switch; only now does the old store get freed -----
    await activateImport(stats);
    report('done', `导入完成：${realEntries.toLocaleString()} 个词条，${redirectEntries.toLocaleString()} 个跳转条目。`, 100, 100);
    return stats;
  } catch (error) {
    // Cancel / corrupt block / quota / verification failure: drop the staging data only.
    await discardImport(staging).catch(() => {});
    throw toImportError(error);
  }
}
