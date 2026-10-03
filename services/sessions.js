// User-authored work is never evicted. Model results can be cleared explicitly in settings.
import './session-fields.js';
import { stableJson } from './agent-data.js';
let opening;
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const req = indexedDB.open('babel-tower-sessions', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sessions', { keyPath: 'key' });
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = null; }; resolve(req.result); };
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}
const fields = globalThis.BXSessionFields;
export function cleanSnapshot(value) {
  const data = {};
  if (!value || typeof value !== 'object') throw new Error('会话内容格式错误。');
  for (const field of fields) if (Object.hasOwn(value, field)) data[field] = value[field];
  const json = JSON.stringify(data);
  if (json.length > 5_000_000) throw new Error('会话过大，请先导出并清理；原记录未删除。');
  return JSON.parse(json);
}
function checkKey(key) {
  if (typeof key !== 'string' || !/^(post|article):[0-9]+$|^compose$|^conflict:[a-zA-Z0-9:-]+$/.test(key)) throw new Error('无效的帖子会话。');
}
function normalizeImport(data) {
  if (!Array.isArray(data) || data.length > 10000) throw new Error('导入会话数量或格式不正确。');
  return data.map(item => { checkKey(item?.key); return { ...item, data: cleanSnapshot(item.data) }; });
}
function mergeSessionRecords(local, incoming) {
  const records = new Map(local.map(item => [item.key, item]));
  const writes = [];
  let imported = 0, skipped = 0, extra = 0;
  for (const item of incoming) {
    const sourceKey = item.sourceKey || item.key;
    const duplicate = [...records.values()].some(record => (record.key === item.key || record.sourceKey === sourceKey)
      && stableJson(record.data) === stableJson(item.data));
    if (duplicate) { skipped++; continue; }
    const conflict = records.has(item.key);
    const record = { key: conflict ? 'conflict:' + crypto.randomUUID() : item.key,
      sourceKey: conflict ? sourceKey : item.sourceKey, data: item.data, revision: 1, updatedAt: Date.now() };
    records.set(record.key, record);
    writes.push(record);
    if (conflict) extra++; else imported++;
  }
  return { writes, imported, skipped, extra };
}
export function planSessionImport(local, data) {
  return mergeSessionRecords(local, normalizeImport(data));
}
// 容量与底层错误必须给出明确中文提示；事务中止时原有记录保持不变。
function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('浏览器存储空间不足，本次操作未写入；原有记录未被删除。请先导出备份并清理空间后重试。');
  return error instanceof Error ? error : new Error('保存失败，请导出内容后重试。');
}
let queue = Promise.resolve();
export function sessionOp(payload) {
  const run = queue.then(() => operate(payload));
  queue = run.catch(() => {});
  return run;
}
async function operate({ op, key, data, revision = 0 } = {}) {
  const db = await database();
  if (!['get', 'list', 'save', 'remove', 'import'].includes(op)) throw new Error('未知会话操作。');
  if (op !== 'list' && op !== 'import') checkKey(key);
  if (op === 'list') return request(db.transaction('sessions').objectStore('sessions').getAll());
  if (op === 'get') return (await request(db.transaction('sessions').objectStore('sessions').get(key))) || null;
  if (op === 'import') {
    // Validate the entire archive before starting an atomic transaction.
    const incoming = normalizeImport(data);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite'), store = tx.objectStore('sessions');
      let plan;
      const req = store.getAll();
      req.onsuccess = () => {
        plan = mergeSessionRecords(req.result, incoming);
        for (const record of plan.writes) store.put(record);
      };
      tx.oncomplete = () => resolve({ imported: plan.writes.length, extra: plan.extra, skipped: plan.skipped });
      tx.onabort = tx.onerror = () => reject(tx.error?.name === 'QuotaExceededError' ? storageError(tx.error) : new Error('会话导入失败，未提交。'));
    });
  }
  const snapshot = op === 'save' ? cleanSnapshot(data) : null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite'), store = tx.objectStore('sessions');
    let result;
    if (op === 'remove') { store.delete(key); result = { removed: key }; }
    else {
      const req = store.get(key);
      req.onsuccess = () => {
        const current = req.result;
        const identical = current && JSON.stringify(current.data) === JSON.stringify(snapshot);
        if (identical) { result = current; return; }
        if (current && revision !== current.revision) {
          const conflictKey = 'conflict:' + crypto.randomUUID();
          result = { key: conflictKey, sourceKey: key, data: snapshot, revision: 1, updatedAt: Date.now(), conflict: true };
          store.put(result);
        } else {
          result = { key, data: snapshot, revision: (current?.revision || 0) + 1, updatedAt: Date.now() };
          store.put(result);
        }
      };
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(storageError(tx.error));
  });
}
