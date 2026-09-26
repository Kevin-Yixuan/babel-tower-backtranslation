// User-authored work is never evicted. Model results can be cleared explicitly in settings.
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
const fields = ['selected', 'dictionary', 'explanation', 'reading', 'practice', 'practiceAnswer', 'practiceFeedback',
  'revision', 'revisionFeedback', 'idea', 'draft', 'draftNote', 'replyFeedback', 'draftCandidate', 'draftPostUrl', 'target', 'tone', 'reply', 'insertMode'];
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
    if (!Array.isArray(data) || data.length > 10000) throw new Error('导入会话数量或格式不正确。');
    // Validate the entire archive before starting an atomic transaction.
    const incoming = data.map(item => { checkKey(item.key); return { ...item, data: cleanSnapshot(item.data) }; });
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite'), store = tx.objectStore('sessions');
      for (const item of incoming) {
        const req = store.get(item.key);
        req.onsuccess = () => {
          const existing = req.result;
          if (existing && JSON.stringify(existing.data) !== JSON.stringify(item.data)) {
            const conflictKey = 'conflict:' + crypto.randomUUID();
            store.put({ ...item, key: conflictKey, sourceKey: item.sourceKey || item.key, revision: 1, updatedAt: Date.now() });
          } else if (!existing) store.put({ key: item.key, sourceKey: item.sourceKey, data: item.data, revision: 1, updatedAt: Date.now() });
        };
      }
      tx.oncomplete = () => resolve({ imported: incoming.length });
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
