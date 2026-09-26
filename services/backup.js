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
export async function importBackup(archive) {
  const counts = validateBackup(archive);
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
  return { ...counts, dictionary: '请用原始 MDX 文件重新导入词典。密钥需在新安装中重新填写。' };
}
