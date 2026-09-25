// Minimal in-memory IndexedDB for tests. Keeps `npm test` dependency-free.
// Supports exactly what mdx/mdx-db.js uses: open/upgrade, put/get/count/clear,
// key-range cursors, index cursors with direction, and deleteDatabase.

class FakeKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    this.lower = lower; this.upper = upper; this.lowerOpen = lowerOpen; this.upperOpen = upperOpen;
  }
  includes(key) {
    if (this.lower !== undefined) {
      if (this.lowerOpen ? !(key > this.lower) : !(key >= this.lower)) return false;
    }
    if (this.upper !== undefined) {
      if (this.upperOpen ? !(key < this.upper) : !(key <= this.upper)) return false;
    }
    return true;
  }
  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
  static only(value) { return new FakeKeyRange(value, value); }
}

function valueAt(record, keyPath) {
  return String(keyPath).split('.').reduce((value, part) => (value == null ? undefined : value[part]), record);
}

class FakeCursor {
  constructor(entries, range, direction, request) {
    this.entries = entries.filter(entry => !range || range.includes(entry.key));
    if (direction === 'prev') this.entries.reverse();
    this.position = 0;
    this.request = request;
  }
  get value() { return this.entries[this.position - 1]?.value; }
  get key() { return this.entries[this.position - 1]?.key; }
  continue() {
    if (this.position >= this.entries.length) { this.request.result = null; }
    else { this.request.result = this; this.position++; }
    this.request.onsuccess?.({ target: this.request });
  }
}

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}

class FakeObjectStore {
  constructor(name, keyPath) {
    this.name = name; this.keyPath = keyPath;
    this.records = new Map();
    this._indexes = new Map();
    // Real IDB exposes objectStoreNames/indexNames as DOMStringList with .contains().
    this.indexNames = { contains: name => this._indexes.has(name) };
  }
  createIndex(name, keyPath) { this._indexes.set(name, { name, keyPath }); return { name, keyPath }; }
  #keyOf(value) {
    const key = valueAt(value, this.keyPath);
    if (key === undefined) throw new Error(`缺少主键 ${this.keyPath}`);
    return key;
  }
  put(value) {
    const request = new FakeRequest();
    this.records.set(this.#keyOf(value), value);
    request.result = this.#keyOf(value);
    Promise.resolve().then(() => request.onsuccess?.({ target: request }));
    return request;
  }
  get(key) {
    const request = new FakeRequest();
    request.result = this.records.get(key);
    Promise.resolve().then(() => request.onsuccess?.({ target: request }));
    return request;
  }
  count() {
    const request = new FakeRequest();
    request.result = this.records.size;
    Promise.resolve().then(() => request.onsuccess?.({ target: request }));
    return request;
  }
  clear() {
    const request = new FakeRequest();
    this.records.clear();
    Promise.resolve().then(() => request.onsuccess?.({ target: request }));
    return request;
  }
  delete(key) {
    const request = new FakeRequest();
    this.records.delete(key);
    Promise.resolve().then(() => request.onsuccess?.({ target: request }));
    return request;
  }
  openCursor(range, direction = 'next') {
    const request = new FakeRequest();
    const entries = [...this.records.entries()].map(([key, value]) => ({ key, value }));
    const cursor = new FakeCursor(entries, range, direction, request);
    Promise.resolve().then(() => cursor.continue());
    return request;
  }
  index(name) {
    const definition = this._indexes.get(name);
    if (!definition) throw new Error(`没有索引 ${name}`);
    const records = this.records;
    return {
      openCursor(range, direction = 'next') {
        const request = new FakeRequest();
        const entries = [...records.values()]
          .map(value => ({ key: valueAt(value, definition.keyPath), value }))
          .filter(entry => entry.key !== undefined);
        const cursor = new FakeCursor(entries, range, direction, request);
        Promise.resolve().then(() => cursor.continue());
        return request;
      }
    };
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db; this.names = names; this.mode = mode;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    setTimeout(() => this.oncomplete?.(), 0);
  }
  objectStore(name) {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`没有 objectStore ${name}`);
    return store;
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name; this.version = version;
    this.stores = new Map();
  }
  get objectStoreNames() {
    return { contains: name => this.stores.has(name) };
  }
  createObjectStore(name, options = {}) {
    const store = new FakeObjectStore(name, options.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction(names, mode) { return new FakeTransaction(this, names, mode); }
  close() { /* no-op */ }
}

const databases = new Map();

export function installFakeIndexedDb() {
  const indexedDB = {
    open(name, version) {
      const request = new FakeRequest();
      setTimeout(() => {
        let db = databases.get(name);
        if (!db) { db = new FakeDatabase(name, version); databases.set(name, db); }
        const upgrade = new FakeRequest();
        upgrade.result = db;
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded({ target: request, oldVersion: 0, newVersion: version });
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    },
    deleteDatabase(name) {
      const request = new FakeRequest();
      setTimeout(() => { databases.delete(name); request.onsuccess?.({ target: request }); }, 0);
      return request;
    }
  };
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = FakeKeyRange;
  return { indexedDB, IDBKeyRange: FakeKeyRange, reset: () => databases.clear() };
}

export { FakeKeyRange };
