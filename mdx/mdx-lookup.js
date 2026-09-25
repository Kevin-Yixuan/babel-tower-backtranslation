// Offline lookups against the local index: exact match, redirect resolution (词条跳转),
// neighbour navigation and prefix suggestions.
import { getWord, loadMeta, neighbours, searchPrefix, storeFor } from './mdx-db.js';

const MAX_HOPS = 5;

export function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function status() {
  const meta = await loadMeta();
  if (!meta) return { ready: false, meta: null };
  return { ready: meta.status === 'ready', meta };
}

export function mediaNotice(meta, entry) {
  if (!meta || meta.hasResourceFile) return '';
  if (!entry?.media) return '';
  const missing = [];
  if (entry.media.images) missing.push(`${entry.media.images} 张图片`);
  if (entry.media.audio) missing.push(`${entry.media.audio} 处发音`);
  if (!missing.length) return '';
  return `该条目含 ${missing.join('、')}，但本次没有提供配套的 .mdd 资源文件，因此无法显示图片与发音。`;
}

/**
 * Look up a word. Redirects (@@@LINK) are followed so "acquit yourself honourably"
 * lands on the real entry; the hop path is returned so the UI can show 跳转来源.
 */
export async function lookup(word, { followRedirects = true } = {}) {
  const meta = await loadMeta();
  if (!meta || meta.status !== 'ready') {
    return { found: false, reason: 'no-index', message: '本地词典尚未导入完成，无法离线查词。' };
  }
  const key = normalizeKey(word);
  if (!key) return { found: false, reason: 'empty', message: '请输入要查的词。' };
  const store = storeFor(meta);

  const hops = [];
  let current = key;
  let row = null;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    row = await getWord(current, store);
    if (!row) break;
    if (row.kind !== 'redirect' || !followRedirects) break;
    hops.push({ from: current, to: row.target });
    if (!row.target || row.target === current) break;
    current = row.target;
  }

  if (!row) {
    const suggestions = await searchPrefix(key, 6, store);
    return {
      found: false,
      reason: 'not-found',
      message: `本地词典里没有「${word}」。`,
      suggestions: suggestions.map(item => item.display || item.word)
    };
  }
  if (row.kind === 'missing') {
    return { found: false, reason: 'missing-record', message: `「${word}」在词典里的释义内容缺失。`, row };
  }
  if (row.kind === 'redirect' && row.target) {
    const target = await getWord(row.target, store);
    if (!target || target.kind !== 'entry') {
      return {
        found: false,
        reason: 'broken-redirect',
        message: `「${word}」指向「${row.target}」，但该条目不在这份词典里。`,
        hops
      };
    }
    if (!target.senses?.length && !target.text) {
      return {
        found: false,
        reason: 'resource-entry',
        message: `「${word}」指向「${row.target}」，那是一条图片 / 发音资源条目，没有文字释义。`,
        hops
      };
    }
    return { found: true, row: target, requested: word, hops, notice: mediaNotice(meta, target), meta };
  }
  if (!row.senses?.length && !row.text) {
    // e.g. LDOCE5++ also carries "apple" as an embedded image record: reachable, but no prose.
    return {
      found: false,
      reason: 'resource-entry',
      message: `「${word}」在本词典里是一条图片 / 发音资源条目，没有文字释义。`,
      row, hops
    };
  }
  return { found: true, row, requested: word, hops, notice: mediaNotice(meta, row), meta };
}

/** 上一个 / 下一个 词条，按导入顺序（即词典原顺序）。 */
export async function neighboursOf(word, span = 1) {
  const store = storeFor(await loadMeta());
  const row = await getWord(normalizeKey(word), store);
  if (!row || typeof row.order !== 'number') return { previous: [], next: [] };
  return neighbours(row.order, span, store);
}

export async function suggest(prefix, limit = 10) {
  const key = normalizeKey(prefix);
  if (!key) return [];
  const rows = await searchPrefix(key, limit, storeFor(await loadMeta()));
  return rows.map(item => ({ word: item.display || item.word, kind: item.kind }));
}
