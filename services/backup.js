import { sessionOp } from './sessions.js';
import { normalizeSettings, validateProviders } from './settings.js';
const arrays = ['writingDrafts', 'cards', 'growthMemories', 'savedPhrases'];
const objects = ['growthSettings', 'discoveryPrefs', 'readingPrefs', 'glossary'];
const keys = ['settings', 'initPrompt', ...arrays, ...objects];

export async function exportBackup() {
  const stored = await chrome.storage.local.get(keys);
  if (stored.settings) stored.settings = { ...normalizeSettings(stored.settings), providers: validateProviders(normalizeSettings(stored.settings).providers) };
  return { format: 'babel-tower-backup', version: 1, createdAt: new Date().toISOString(),
    storage: stored, sessions: await sessionOp({ op: 'list' }), dictionary: { action: 'reimport-mdx-original' } };
}
export function validateBackup(archive) {
  if (archive?.format !== 'babel-tower-backup' || archive.version !== 1 || !archive.storage || !Array.isArray(archive.sessions)) throw new Error('不是支持的巴别塔备份文件。');
  if (JSON.stringify(archive).length > 40_000_000) throw new Error('备份过大，请拆分导入。');
  for (const name of arrays) if (archive.storage[name] !== undefined && (!Array.isArray(archive.storage[name]) || archive.storage[name].some(x => !x || typeof x !== 'object' || Array.isArray(x)))) throw new Error(name + ' 数据格式不正确。');
  for (const name of objects) if (archive.storage[name] !== undefined && (!archive.storage[name] || typeof archive.storage[name] !== 'object' || Array.isArray(archive.storage[name]))) throw new Error(name + ' 数据格式不正确。');
  if (archive.storage.initPrompt !== undefined && typeof archive.storage.initPrompt !== 'string') throw new Error('提示词数据不正确。');
  if (archive.storage.settings) validateProviders(normalizeSettings(archive.storage.settings).providers);
  return { sessions: archive.sessions.length, drafts: archive.storage.writingDrafts?.length || 0,
    cards: archive.storage.cards?.length || 0, memories: archive.storage.growthMemories?.length || 0,
    phrases: archive.storage.savedPhrases?.length || 0 };
}
// 合并计划：预览与实际导入共用同一套判定，两个数字必须一致。
// 导入 = 以原身份写入；跳过 = 本地优先、不写；另存 = 以冲突副本写入（原记录不动）。
async function planImport(archive) {
  const old = await chrome.storage.local.get(keys);
  const localSessions = await sessionOp({ op: 'list' });
  const byKey = new Map(localSessions.map(item => [item.key, item]));
  let imported = 0, skipped = 0, extra = 0;
  for (const name of arrays) {
    if (!archive.storage[name]) continue;
    const local = old[name] || [];
    for (const item of archive.storage[name]) {
      if (local.some(x => JSON.stringify(x) === JSON.stringify(item))) skipped++;
      else if (item?.id && local.some(x => x.id === item.id)) extra++;
      else imported++;
    }
  }
  for (const name of objects) if (archive.storage[name]) {
    for (const field of Object.keys(archive.storage[name])) {
      if (old[name] && Object.hasOwn(old[name], field)) skipped++; else imported++;
    }
  }
  if (archive.storage.initPrompt !== undefined) { if (old.initPrompt) skipped++; else imported++; }
  if (archive.storage.settings) {
    const incoming = validateProviders(normalizeSettings(archive.storage.settings).providers);
    const current = normalizeSettings(old.settings || {}).providers;
    for (const [id, config] of Object.entries(incoming)) {
      if (!old.settings?.providers?.[id]) imported++;
      else if (JSON.stringify(current[id]) !== JSON.stringify(config)) extra++;
      else skipped++;
    }
  }
  for (const item of archive.sessions) {
    const existing = byKey.get(item.key);
    if (!existing) imported++;
    else if (JSON.stringify(existing.data) === JSON.stringify(item.data)) skipped++;
    else extra++;
  }
  return { imported, skipped, extra };
}

// 设置页「选择备份」后的预览：只读，不写任何数据。
export async function previewBackup(archive) {
  const counts = validateBackup(archive);
  return { ...counts, ...await planImport(archive) };
}

export async function importBackup(archive) {
  const counts = validateBackup(archive);
  const plan = await planImport(archive);
  const old = await chrome.storage.local.get(keys);
  const next = {};
  for (const name of arrays) {
    if (!archive.storage[name]) continue;
    const merged = [...(old[name] || [])];
    for (const item of archive.storage[name]) {
      if (merged.some(x => JSON.stringify(x) === JSON.stringify(item))) continue;
      const collision = item.id && merged.some(x => x.id === item.id);
      merged.push(collision ? { ...item, id: crypto.randomUUID(), importedConflict: true } : item);
    }
    next[name] = merged;
  }
  for (const name of objects) if (archive.storage[name]) next[name] = { ...archive.storage[name], ...(old[name] || {}) };
  if (!old.initPrompt && archive.storage.initPrompt) next.initPrompt = archive.storage.initPrompt;
  if (archive.storage.settings) {
    const incoming = normalizeSettings(archive.storage.settings), current = normalizeSettings(old.settings || {});
    const providers = { ...current.providers };
    for (const [id, config] of Object.entries(validateProviders(incoming.providers))) {
      if (!old.settings?.providers?.[id]) providers[id] = config;
      else if (JSON.stringify(providers[id]) !== JSON.stringify(config)) providers['import_' + crypto.randomUUID()] = config;
    }
    next.settings = { ...(old.settings ? current : incoming), providers };
    // API keys are never accepted from the archive; existing local keys are untouched.
  }
  // Session import validates everything and commits atomically first. If local storage
  // subsequently fails, tell the user exactly which part was already imported.
  await sessionOp({ op: 'import', data: archive.sessions });
  try { await chrome.storage.local.set(next); }
  catch { throw new Error('帖子会话已导入，其余数据保存失败。原数据保留；请导出备份并清理空间后重试。'); }
  return { ...counts, ...plan, dictionary: '请用原始 MDX 文件重新导入词典。密钥需在新安装中重新填写。' };
}
