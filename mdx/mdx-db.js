// IndexedDB storage for the imported dictionary.
// Everything stays on this device; nothing is synced or uploaded.
//
// Two word stores ("words" / "words2") alternate like generations: lookups always read the
// store named by the ready `meta` record, while a new import writes into the *other* store and
// only flips `meta.store` after every batch is written and verified. Cancel, corrupt files,
// unsupported formats or a crashed browser therefore never touch the ready index: the old
// store keeps answering queries and the half-written staging store is discarded.
// NOTE: nothing here may clear the active store before the switch.

export const DB_NAME = 'backwrite-x-dictionary';
export const DB_VERSION = 2;
export const STORE_META = 'meta';
export const STORE_WORDS = 'words';        // generation A (existed in schema v1)
export const STORE_WORDS_ALT = 'words2';   // generation B (added in schema v2)
export const WORD_STORES = [STORE_WORDS, STORE_WORDS_ALT];

const META_KEY = 'current';     // the ready index (status: 'ready')
const STAGING_KEY = 'staging';  // in-progress import (status: 'importing')

function request(requestObject) {
  return new Promise((resolve, reject) => {
    requestObject.onsuccess = () => resolve(requestObject.result);
    requestObject.onerror = () => reject(requestObject.error || new Error('IndexedDB 操作失败。'));
  });
}

function createIndexes(store) {
  if (!store.indexNames.contains('order')) store.createIndex('order', 'order', { unique: false });
  if (!store.indexNames.contains('kind')) store.createIndex('kind', 'kind', { unique: false });
}

export function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB，无法建立本地词典索引。'));
      return;
    }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
      for (const name of WORD_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          createIndexes(db.createObjectStore(name, { keyPath: 'word' }));
        }
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error('无法打开本地词典数据库。'));
    // Another tab may hold the database open during a schema bump; fail loudly instead of hanging.
    open.onblocked = () => reject(new Error('词典数据库正被其他页面占用，请关闭其它导入/查词页面后重试。'));
  });
}

async function withStore(name, mode, run) {
  const db = await openDb();
  try {
    const tx = db.transaction(name, mode);
    const result = await run(tx.objectStore(name), tx);
    await transactionDone(tx);
    return result;
  } finally {
    db.close();
  }
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('写入失败。'));
    tx.onabort = () => reject(tx.error || new Error('写入被取消。'));
  });
}

// ---------------------------------------------------------------- meta

export async function saveMeta(meta) {
  await withStore(STORE_META, 'readwrite', store => store.put({ ...meta, id: META_KEY }));
}

export async function loadMeta() {
  return withStore(STORE_META, 'readonly', store => request(store.get(META_KEY)));
}

/** The word store a ready meta record points at; legacy v1 metas live in `words`. */
export function storeFor(meta) {
  return meta && WORD_STORES.includes(meta.store) ? meta.store : STORE_WORDS;
}

async function resolveStore(store) {
  if (store) return store;
  return storeFor(await loadMeta());
}

// ---------------------------------------------------------------- staging lifecycle

export async function saveStaging(record) {
  await withStore(STORE_META, 'readwrite', store => store.put({ ...record, id: STAGING_KEY }));
}

export async function loadStaging() {
  const record = await withStore(STORE_META, 'readonly', store => request(store.get(STAGING_KEY)));
  return record || null;
}

export async function clearStagingRecord() {
  await withStore(STORE_META, 'readwrite', store => store.delete(STAGING_KEY));
}

/** Heartbeat used to tell "another tab is importing" from "a crashed import left garbage".
 *  The indexer refreshes it every ~5s, so anything older than this is a crashed run. */
export const STAGING_HEARTBEAT_MS = 30 * 1000;

function stagingIsLive(record) {
  if (!record) return false;
  const beat = record.heartbeatAt || record.startedAt || 0;
  return Date.now() - beat < STAGING_HEARTBEAT_MS;
}

/**
 * Prepare a clean store for a new import without touching the ready one.
 * Throws `reason: 'busy'` when another page is importing right now.
 */
export async function beginImport({ fileName = '' } = {}) {
  const existing = await loadStaging();
  if (stagingIsLive(existing)) {
    const busy = new Error('另一个页面正在导入词典，请等待它完成或关闭那个页面后重试。');
    busy.reason = 'busy';
    throw busy;
  }
  if (existing) await discardImport(existing).catch(() => {}); // leftovers from a crashed run
  const meta = await loadMeta();
  const active = storeFor(meta);
  const target = WORD_STORES.find(name => name !== active);
  await clearStore(target);
  const record = {
    store: target, previousStore: active, fileName,
    startedAt: Date.now(), heartbeatAt: Date.now(), status: 'importing'
  };
  await saveStaging(record);
  return record;
}

/** Refresh the heartbeat while writing so other tabs can tell the import is alive. */
export async function touchStaging(record) {
  await saveStaging({ ...record, heartbeatAt: Date.now() });
}

/**
 * A new import is complete and verified: flip `meta` to the staging store in one put,
 * then free the previous generation (best effort). From this point lookups read the new store.
 */
export async function activateImport(stats) {
  const record = await loadStaging();
  if (!record || !WORD_STORES.includes(record.store)) {
    const error = new Error('导入状态记录丢失，无法切换到新索引；原有词典未被修改。');
    error.reason = 'staging-lost';
    throw error;
  }
  const previous = storeFor(await loadMeta());
  await saveMeta({ ...stats, store: record.store, status: 'ready' }); // the switch
  await clearStagingRecord().catch(() => {});
  if (previous !== record.store) await clearStore(previous).catch(() => {});
  return record;
}

/** Failure / cancel path: drop the staging store and record. Never clears the ready store. */
export async function discardImport(record = null) {
  const staging = record || await loadStaging();
  if (!staging) return;
  const active = storeFor(await loadMeta());
  if (staging.store && staging.store !== active && WORD_STORES.includes(staging.store)) {
    await clearStore(staging.store).catch(() => {});
  }
  const current = await loadStaging();
  if (current && (!staging.store || current.store === staging.store)) {
    await clearStagingRecord().catch(() => {});
  }
}

/**
 * Clean up after an import that never finished (browser closed, tab crashed).
 * A live heartbeat is respected so a second tab cannot wipe a running import;
 * a record that already points at the ready store only needs the record removed.
 */
export async function sweepStaging() {
  const record = await loadStaging();
  if (!record) return null;
  const active = storeFor(await loadMeta());
  if (record.store === active) {
    await clearStagingRecord().catch(() => {});
    return 'record-cleared';
  }
  if (stagingIsLive(record)) return 'live';
  await discardImport(record).catch(() => {});
  return 'swept';
}

// ---------------------------------------------------------------- words

export async function clearAll() {
  await withStore(STORE_META, 'readwrite', store => store.clear());
  for (const name of WORD_STORES) await clearStore(name);
}

export async function clearStore(name) {
  await withStore(name, 'readwrite', store => store.clear());
}

export async function countWords(store) {
  const name = await resolveStore(store);
  return withStore(name, 'readonly', store_ => request(store_.count()));
}

/** Write one batch inside a single transaction. Returns the number of rows written. */
export async function writeBatch(rows, store) {
  if (!rows.length) return 0;
  const name = await resolveStore(store);
  return withStore(name, 'readwrite', store_ => {
    for (const row of rows) store_.put(row);
    return rows.length;
  });
}

export async function getWord(word, store) {
  const name = await resolveStore(store);
  return withStore(name, 'readonly', store_ => request(store_.get(word)));
}

const PREFIX_UPPER = String.fromCharCode(0xffff); // primary-key range upper bound for prefix scans

/** Prefix match using the primary key range - no scan of the whole store. */
export async function searchPrefix(prefix, limit = 12, store) {
  const key = String(prefix || '').toLowerCase();
  if (!key) return [];
  const name = await resolveStore(store);
  return withStore(name, 'readonly', store_ => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(key, key + PREFIX_UPPER);
    const out = [];
    const cursor = store_.openCursor(range);
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item || out.length >= limit) return resolve(out);
      out.push(item.value);
      item.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  }));
}

/** Neighbouring headwords, used by the 上一个 / 下一个 词条 navigation. */
export async function neighbours(order, span = 1, store) {
  const name = await resolveStore(store);
  const db = await openDb();
  try {
    const tx = db.transaction(name, 'readonly');
    const index = tx.objectStore(name).index('order');
    const previous = await cursorCollect(index, IDBKeyRange.bound(order - span, order - 1), 'prev', span);
    const next = await cursorCollect(index, IDBKeyRange.bound(order + 1, order + span), 'next', span);
    await transactionDone(tx);
    return { previous: previous.reverse(), next };
  } finally {
    db.close();
  }
}

function cursorCollect(index, range, direction, limit) {
  return new Promise((resolve, reject) => {
    const out = [];
    const cursor = index.openCursor(range, direction);
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item || out.length >= limit) return resolve(out);
      out.push(item.value);
      item.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request_ = indexedDB.deleteDatabase(DB_NAME);
    request_.onsuccess = () => resolve();
    request_.onerror = () => reject(request_.error);
    request_.onblocked = () => reject(new Error('请先关闭正在使用词典的页面再删除索引。'));
  });
}
