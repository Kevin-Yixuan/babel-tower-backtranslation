import { planSessionImport, sessionOp } from './sessions.js';
import { normalizeSettings, validateProviders } from './settings.js';
import { withContentStorage } from './content-storage.js';
import { stableJson } from './util.js';
const arrays = ['cards', 'savedPhrases'];
const objects = ['readingPrefs', 'glossary'];
const keys = ['settings', 'initPrompt', ...arrays, ...objects];
// 已不再支持的功能留下的旧数据：旧备份里出现这些键时只跳过并在预览里说明，不报错、不导入。
const RETIRED_KEYS = ['writingDrafts', 'growthMemories', 'growthSettings', 'discoveryPrefs', 'documents', 'documentFolders', 'agentSessions'];
const retiredIn = archive => RETIRED_KEYS.filter(name => archive.storage[name] !== undefined);

// Compare content independently of the identity assigned to a restored copy.
function recordContent(record) {
  const { id, importedConflict, importedFromId, ...content } = record;
  return stableJson(content);
}
function mergeRecords(local = [], incoming = []) {
  const records = [...local];
  let imported = 0, skipped = 0, extra = 0;
  for (const item of incoming) {
    const duplicate = records.some(record => stableJson(record) === stableJson(item)
      || (item.id && record.importedFromId === item.id && recordContent(record) === recordContent(item)));
    if (duplicate) { skipped++; continue; }
    if (item.id && records.some(record => record.id === item.id)) {
      records.push({ ...item, id: crypto.randomUUID(), importedConflict: true, importedFromId: item.id });
      extra++;
    } else { records.push(item); imported++; }
  }
  return { records, imported, skipped, extra };
}
function mergeSettings(currentRaw, incomingRaw) {
  const incoming = normalizeSettings(incomingRaw), current = normalizeSettings(currentRaw || {});
  const providers = { ...current.providers };
  let imported = 0, skipped = 0, extra = 0;
  for (const [id, config] of Object.entries(validateProviders(incoming.providers))) {
    if (!Object.hasOwn(currentRaw?.providers || {}, id)) { providers[id] = config; imported++; }
    else if (stableJson(providers[id]) === stableJson(config)
      || Object.entries(providers).some(([key, value]) => key.startsWith('import_') && stableJson(value) === stableJson(config))) skipped++;
    else { providers['import_' + crypto.randomUUID()] = config; extra++; }
  }
  if (Object.keys(providers).length > 40) throw new Error('合并后模型配置超过 40 组，请先整理配置再导入。');
  return { settings: { ...(currentRaw ? current : incoming), providers }, imported, skipped, extra };
}

export async function exportBackup() {
  const stored = await chrome.storage.local.get(keys);
  if (stored.settings) stored.settings = { ...normalizeSettings(stored.settings), providers: validateProviders(normalizeSettings(stored.settings).providers) };
  return { format: 'babel-tower-backup', version: 1, createdAt: new Date().toISOString(),
    storage: stored, sessions: await sessionOp({ op: 'list' }), dictionary: { action: 'reimport-mdx-original' } };
}
export function validateBackup(archive) {
  if (archive?.format !== 'babel-tower-backup' || archive.version !== 1 || !archive.storage
    || typeof archive.storage !== 'object' || Array.isArray(archive.storage) || !Array.isArray(archive.sessions)) throw new Error('不是支持的巴别塔备份文件。');
  if (JSON.stringify(archive).length > 40_000_000) throw new Error('备份过大，请拆分导入。');
  for (const name of arrays) if (archive.storage[name] !== undefined && (!Array.isArray(archive.storage[name]) || archive.storage[name].some(x => !x || typeof x !== 'object' || Array.isArray(x)))) throw new Error(name + ' 数据格式不正确。');
  for (const name of objects) if (archive.storage[name] !== undefined && (!archive.storage[name] || typeof archive.storage[name] !== 'object' || Array.isArray(archive.storage[name]))) throw new Error(name + ' 数据格式不正确。');
  if (archive.storage.initPrompt !== undefined && typeof archive.storage.initPrompt !== 'string') throw new Error('提示词数据不正确。');
  if (archive.storage.settings) validateProviders(normalizeSettings(archive.storage.settings).providers);
  return { sessions: archive.sessions.length, cards: archive.storage.cards?.length || 0,
    phrases: archive.storage.savedPhrases?.length || 0, unsupported: retiredIn(archive) };
}
// 合并计划：预览与实际导入共用同一套判定，两个数字必须一致。
// 导入 = 以原身份写入；跳过 = 本地优先、不写；另存 = 以冲突副本写入（原记录不动）。
async function planImport(archive) {
  const old = await chrome.storage.local.get(keys);
  const localSessions = await sessionOp({ op: 'list' });
  let imported = 0, skipped = 0, extra = 0;
  for (const name of arrays) {
    if (!archive.storage[name]) continue;
    const plan = mergeRecords(old[name], archive.storage[name]);
    imported += plan.imported; skipped += plan.skipped; extra += plan.extra;
  }
  for (const name of objects) if (archive.storage[name]) {
    for (const field of Object.keys(archive.storage[name])) {
      if (old[name] && Object.hasOwn(old[name], field)) skipped++; else imported++;
    }
  }
  if (archive.storage.initPrompt) { if (old.initPrompt) skipped++; else imported++; }
  if (archive.storage.settings) {
    const plan = mergeSettings(old.settings, archive.storage.settings);
    imported += plan.imported; skipped += plan.skipped; extra += plan.extra;
  }
  const sessionPlan = planSessionImport(localSessions, archive.sessions);
  imported += sessionPlan.imported; skipped += sessionPlan.skipped; extra += sessionPlan.extra;
  return { imported, skipped, extra };
}

// 设置页「选择备份」后的预览：只读，不写任何数据。
export async function previewBackup(archive) {
  const counts = validateBackup(archive);
  return { ...counts, ...await planImport(archive) };
}

export function importBackup(archive) {
  return withContentStorage(() => performImport(archive));
}
async function performImport(archive) {
  const counts = validateBackup(archive);
  archive = structuredClone(archive);
  const plan = await planImport(archive);
  const old = await chrome.storage.local.get(keys);
  const next = {};
  for (const name of arrays) {
    if (!archive.storage[name]) continue;
    next[name] = mergeRecords(old[name], archive.storage[name]).records;
  }
  for (const name of objects) if (archive.storage[name]) next[name] = { ...archive.storage[name], ...(old[name] || {}) };
  if (!old.initPrompt && archive.storage.initPrompt) next.initPrompt = archive.storage.initPrompt;
  if (archive.storage.settings) {
    next.settings = mergeSettings(old.settings, archive.storage.settings).settings;
    // API keys are never accepted from the archive; existing local keys are untouched.
  }
  // Session import validates everything and commits atomically first. If local storage
  // subsequently fails, tell the user exactly which part was already imported.
  await sessionOp({ op: 'import', data: archive.sessions });
  try { await chrome.storage.local.set(next); }
  catch { throw new Error('帖子会话已导入，其余数据保存失败。原数据保留；请导出备份并清理空间后重试。'); }
  return { ...counts, ...plan, dictionary: '请用原始 MDX 文件重新导入词典。密钥需在新安装中重新填写。' };
}
