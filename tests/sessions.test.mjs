// T2 会话与内容保存测试：页面身份、按帖恢复、防抖与保存循环、旧恢复不覆盖新帖、
// 恢复期输入不被旧记录覆盖、多标签冲突另存副本、容量/失败明确提示、无密钥备份导入导出。
// 依赖最小 fake IndexedDB（本文件自带，不改公共测试工具）与 DOM 桩，不启动浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- 最小 fake IndexedDB：覆盖 services/sessions.js 用到的 open/upgrade/tx/get/put/delete/getAll ----------
function installFakeIDB() {
  const databases = new Map();
  const inject = { failNextPut: null };
  class FakeRequest {
    constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  }
  const later = fn => Promise.resolve().then(fn);
  function makeStore() {
    const records = new Map();
    return {
      records,
      get(key) {
        const request = new FakeRequest();
        request.result = records.get(key);
        later(() => request.onsuccess?.({ target: request }));
        return request;
      },
      getAll() {
        const request = new FakeRequest();
        request.result = [...records.values()];
        later(() => request.onsuccess?.({ target: request }));
        return request;
      },
      put(tx, value) {
        const request = new FakeRequest();
        if (inject.failNextPut) {
          const error = inject.failNextPut; inject.failNextPut = null;
          request.error = error;
          tx.error = error;
          later(() => { tx.onerror?.({ target: tx }); });
          return request;
        }
        records.set(value.key, value);
        request.result = value.key;
        later(() => request.onsuccess?.({ target: request }));
        return request;
      },
      delete(key) {
        const request = new FakeRequest();
        records.delete(key);
        later(() => request.onsuccess?.({ target: request }));
        return request;
      }
    };
  }
  function makeDB(name, version) {
    const db = {
      name, version, stores: new Map(),
      close() {}, onversionchange: null,
      objectStoreNames: null,
      createObjectStore(storeName) {
        const store = makeStore();
        db.stores.set(storeName, store);
        return store;
      },
      transaction() {
        const tx = {
          error: null, oncomplete: null, onerror: null, onabort: null,
          objectStore(storeName) {
            const store = db.stores.get(storeName);
            if (!store) throw new Error(`没有 objectStore ${storeName}`);
            // put 需要事务上下文来模拟 QuotaExceeded 中止
            return {
              get: k => store.get(k),
              getAll: () => store.getAll(),
              delete: k => store.delete(k),
              put: value => store.put(tx, value)
            };
          }
        };
        setTimeout(() => { if (!tx.error) tx.oncomplete?.(); }, 0);
        return tx;
      }
    };
    db.objectStoreNames = { contains: name => db.stores.has(name) };
    return db;
  }
  globalThis.indexedDB = {
    open(name, version) {
      const request = new FakeRequest();
      setTimeout(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) { db = makeDB(name, version); databases.set(name, db); }
        request.result = db;
        if (fresh && request.onupgradeneeded) request.onupgradeneeded({ target: request, oldVersion: 0, newVersion: version });
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
  return { inject, databases };
}
const fakeIDB = installFakeIDB();

const { sessionOp, cleanSnapshot } = await import('../services/sessions.js');
const { exportBackup, validateBackup, importBackup } = await import('../services/backup.js');

async function removeAllSessions() {
  const all = await sessionOp({ op: 'list' });
  for (const item of all) await sessionOp({ op: 'remove', key: item.key });
}

function quotaError() {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

// ---------- chrome.storage.local 桩 ----------
function installChromeMock(store) {
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) if (Object.hasOwn(store, key)) out[key] = store[key];
          return out;
        },
        async set(values) { Object.assign(store, values); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
      }
    }
  };
  return store;
}

// ---------- 加载真实 context.js / sidebar/sessions.js（无 DOM，纯桩） ----------
function loadScript(relativePath, win, doc, loc) {
  const code = fs.readFileSync(path.join(root, relativePath), 'utf8');
  new Function('window', 'document', 'location', code)(win, doc, loc);
  return win;
}
function loadContext() {
  const win = { BXContext: null };
  loadScript('sidebar/context.js', win, {}, { origin: 'https://x.com' });
  return win.BXContext;
}
function createHarness(options = {}) {
  const opts = { slowGetMs: 0, failSaves: 0, ...options };
  const counters = { refresh: 0, emits: [], saves: 0, gets: 0, saveKeys: [] };
  const state = {
    mode: 'read', post: null, selected: '', editor: null, busy: false, error: '', notice: '',
    dictionary: null, explanation: '', practice: null, practiceAnswer: '', practiceFeedback: null,
    revision: '', revisionFeedback: null, idea: '', draft: '', draftNote: '', replyFeedback: null,
    target: '英语', tone: '自然', insertConfirm: false, binding: null, reqSeq: 0,
    draftCandidate: null, draftPostUrl: '', composing: false, pendingRender: false,
    sessionLoading: false, saveStatus: ''
  };
  const handlers = { element: {}, document: {}, window: {} };
  const label = { textContent: '' };
  const send = async (action, payload) => {
    assert.equal(action, 'SESSION');
    const op = payload.payload;
    if (op.op === 'get') {
      counters.gets++;
      if (opts.slowGetMs) { const delay = opts.slowGetMs; opts.slowGetMs = 0; await sleep(delay); }
      return sessionOp(op);
    }
    if (op.op === 'save') {
      counters.saveKeys.push(op.key);
      if (opts.failSaves > 0) { opts.failSaves--; throw new Error('模拟磁盘故障'); }
      counters.saves++;
      return sessionOp(op);
    }
    return sessionOp(op);
  };
  const BX = {
    state,
    send,
    refresh: () => { counters.refresh++; },
    emit: name => { counters.emits.push(name); },
    element: {
      addEventListener: (type, fn) => { handlers.element[type] = fn; },
      querySelector: selector => (selector === '#bx-save-status' ? label : null)
    }
  };
  const win = { BX, addEventListener: (type, fn) => { handlers.window[type] = fn; } };
  const doc = { hidden: false, addEventListener: (type, fn) => { handlers.document[type] = fn; } };
  const loc = { origin: 'https://x.com' };
  loadScript('sidebar/context.js', win, doc, loc);
  loadScript('sidebar/sessions.js', win, doc, loc);
  return {
    state, win, counters, label, opts,
    apply: post => { state.post = post; },
    fireInput: () => handlers.element.input?.(),
    firePagehide: () => handlers.window.pagehide?.(),
    fireVisibility: hidden => { doc.hidden = hidden; handlers.document.visibilitychange?.(); },
    sessionReadyCount: () => counters.emits.filter(name => name === 'session-ready').length
  };
}

// ================= A. 页面身份（context.js） =================
test('页面身份：稳定帖子/文章 ID，忽略查询参数与链接形态', () => {
  const ctx = loadContext();
  assert.equal(ctx.key('https://x.com/alice/status/123?s=20&t=abc'), 'post:123');
  assert.equal(ctx.key('https://x.com/i/status/123'), 'post:123');
  assert.equal(ctx.key('https://x.com/alice/status/123/photo/1'), 'post:123');
  assert.equal(ctx.key('https://www.x.com/alice/status/123'), 'post:123');
  assert.equal(ctx.key('https://x.com/i/article/999?foo=1'), 'article:999');
  assert.equal(ctx.key('https://x.com/compose/post'), 'compose');
  assert.equal(ctx.key('https://example.com/status/123'), '');
  assert.equal(ctx.key('https://x.com/alice/status/abc'), '');
  // 不同链接形态归一到同一 canonical
  assert.equal(ctx.canonical('https://x.com/alice/status/123?s=20'), 'https://x.com/i/status/123');
  assert.equal(ctx.canonical('https://x.com/i/status/123'), 'https://x.com/i/status/123');
  assert.equal(ctx.canonical('https://x.com/i/article/9'), 'https://x.com/i/article/9');
});

// ================= B. 服务层（services/sessions.js） =================
test('cleanSnapshot 只保留白名单字段，超容量明确报错且不删原记录', async () => {
  const cleaned = cleanSnapshot({ draft: '保留我', apiKeys: { openai: 'sk-x' }, post: { text: '不保留' }, reading: { busy: false } });
  assert.equal(cleaned.draft, '保留我');
  assert.ok(cleaned.reading);
  assert.equal(cleaned.apiKeys, undefined);
  assert.equal(cleaned.post, undefined);
  assert.throws(() => cleanSnapshot({ draft: 'x'.repeat(5_000_001) }), /会话过大.*原记录未删除/);
  assert.throws(() => cleanSnapshot('not-an-object'), /会话内容格式错误/);
});

test('保存/读取往返、revision 递增、内容相同不空转', async () => {
  await removeAllSessions();
  const first = await sessionOp({ op: 'save', key: 'post:1001', data: { draft: 'v1' }, revision: 0 });
  assert.equal(first.revision, 1);
  const again = await sessionOp({ op: 'save', key: 'post:1001', data: { draft: 'v1' }, revision: 5 });
  assert.equal(again.revision, 1, '内容相同直接返回现有记录，不制造冲突');
  const bumped = await sessionOp({ op: 'save', key: 'post:1001', data: { draft: 'v2' }, revision: 1 });
  assert.equal(bumped.revision, 2);
  const read = await sessionOp({ op: 'get', key: 'post:1001' });
  assert.equal(read.data.draft, 'v2');
});

test('多标签：revision 不匹配另存冲突副本，原记录不被覆盖', async () => {
  await removeAllSessions();
  await sessionOp({ op: 'save', key: 'post:1002', data: { draft: '标签一' }, revision: 0 }); // rev1
  await sessionOp({ op: 'save', key: 'post:1002', data: { draft: '标签二' }, revision: 1 }); // rev2：另一标签抢先
  const stale = await sessionOp({ op: 'save', key: 'post:1002', data: { draft: '落后稿' }, revision: 1 }); // 本标签 revision 落后
  assert.equal(stale.conflict, true);
  assert.match(stale.key, /^conflict:/);
  const original = await sessionOp({ op: 'get', key: 'post:1002' });
  assert.equal(original.data.draft, '标签二', '原记录保持另一标签的内容');
  assert.equal(original.revision, 2);
  const copy = await sessionOp({ op: 'get', key: stale.key });
  assert.equal(copy.data.draft, '落后稿', '冲突副本保存本地内容');
  assert.equal(copy.sourceKey, 'post:1002');
});

test('无效 key 拒绝；容量错误给出明确中文提示且不写入', async () => {
  await removeAllSessions();
  await sessionOp({ op: 'save', key: 'post:1003', data: { draft: '原稿' }, revision: 0 });
  await assert.rejects(sessionOp({ op: 'save', key: 'post:abc', data: { draft: 'x' }, revision: 0 }), /无效的帖子会话/);
  await assert.rejects(sessionOp({ op: 'get', key: '../../etc' }), /无效的帖子会话/);
  fakeIDB.inject.failNextPut = quotaError();
  await assert.rejects(sessionOp({ op: 'save', key: 'post:1003', data: { draft: '新稿' }, revision: 1 }), /存储空间不足.*原有记录未被删除/);
  const read = await sessionOp({ op: 'get', key: 'post:1003' });
  assert.equal(read.data.draft, '原稿', '容量失败后原记录保留');
  // 故障注入已消费，重试成功
  const retry = await sessionOp({ op: 'save', key: 'post:1003', data: { draft: '新稿' }, revision: 1 });
  assert.equal(retry.revision, 2);
});

test('导入：整包先校验、原子提交；冲突另存，不静默覆盖', async () => {
  await removeAllSessions();
  await sessionOp({ op: 'save', key: 'post:1004', data: { draft: '本地稿' }, revision: 0 });
  const before = await sessionOp({ op: 'list' });
  // 一个坏 key → 整包拒绝，库里什么都不变
  await assert.rejects(
    sessionOp({ op: 'import', data: [{ key: 'post:1004', data: { draft: '归档稿' } }, { key: 'bad key', data: {} }] }),
    /无效的帖子会话/
  );
  const afterFail = await sessionOp({ op: 'list' });
  assert.equal(afterFail.length, before.length);
  assert.equal((await sessionOp({ op: 'get', key: 'post:1004' })).data.draft, '本地稿');
  // 内容不同的同 key → 冲突副本；新 key → 直接入库
  const result = await sessionOp({ op: 'import', data: [
    { key: 'post:1004', data: { draft: '归档稿' } },
    { key: 'post:1005', data: { draft: '新帖稿' } }
  ] });
  assert.equal(result.imported, 2);
  assert.equal((await sessionOp({ op: 'get', key: 'post:1004' })).data.draft, '本地稿', '已有记录不被导入覆盖');
  const all = await sessionOp({ op: 'list' });
  const conflictItem = all.find(item => item.key.startsWith('conflict:'));
  assert.ok(conflictItem && conflictItem.data.draft === '归档稿', '冲突内容另存副本');
  assert.equal((await sessionOp({ op: 'get', key: 'post:1005' })).data.draft, '新帖稿');
  await removeAllSessions();
});

// ================= C. 备份导入导出（services/backup.js） =================
test('导出不含任何密钥；MDX 词典提示用原文件重新导入', async () => {
  const store = installChromeMock({
    apiKeys: { openai: 'sk-SECRET123' },
    settings: { modelProvider: 'openai', providers: { openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', apiKey: 'sk-INLINE456' } } },
    initPrompt: '我的规则',
    writingDrafts: [{ id: 'w1', text: '亲写稿' }],
    cards: [], growthMemories: [], savedPhrases: [],
    readingPrefs: { source: '自动检测' },
    glossary: { hello: '你好' },
    jevKey: 'jev-SECRET'
  });
  const archive = await exportBackup();
  const json = JSON.stringify(archive);
  assert.ok(!json.includes('sk-SECRET123'), 'apiKeys 不得进入备份');
  assert.ok(!json.includes('sk-INLINE456'), 'providers 里的密钥字段必须被剥离');
  assert.ok(!json.includes('jev-SECRET'), 'jevKey 不得进入备份');
  assert.equal(archive.format, 'babel-tower-backup');
  assert.equal(archive.version, 1);
  assert.ok(Array.isArray(archive.sessions));
  assert.equal(archive.dictionary.action, 'reimport-mdx-original');
  assert.equal(archive.storage.settings.providers.openai.apiKey, undefined);
  assert.equal(archive.storage.apiKeys, undefined);
  assert.equal(archive.storage.jevKey, undefined);
  // 跨扩展 ID：归档不携带任何扩展 ID 相关字段
  assert.equal(archive.extensionId, undefined);
  const counts = validateBackup(archive);
  assert.equal(counts.drafts, 1);
  assert.throws(() => validateBackup({ format: 'other', version: 1, storage: {}, sessions: [] }), /不是支持的巴别塔备份文件/);
  assert.throws(() => validateBackup({ format: 'babel-tower-backup', version: 2, storage: {}, sessions: [] }), /不是支持的巴别塔备份文件/);
  assert.throws(() => validateBackup({ format: 'babel-tower-backup', version: 1, storage: { writingDrafts: 'nope' }, sessions: [] }), /数据格式不正确/);
  void store;
});

test('导入：密钥不落盘、本地配置优先、会话失败则整体不写存储', async () => {
  await removeAllSessions();
  await sessionOp({ op: 'save', key: 'post:2001', data: { draft: '本地会话' }, revision: 0 });
  const store = installChromeMock({
    apiKeys: { openai: 'sk-LOCAL789' },
    settings: { modelProvider: 'openai', providers: { openai: { baseUrl: 'https://local.example/v1', model: 'local-model' } } },
    initPrompt: '本地规则',
    writingDrafts: [{ id: 'w1', text: '本地稿' }]
  });
  const archive = {
    format: 'babel-tower-backup', version: 1, createdAt: new Date().toISOString(),
    dictionary: { action: 'reimport-mdx-original' },
    sessions: [{ key: 'post:2002', data: { draft: '归档会话' } }],
    storage: {
      apiKeys: { openai: 'sk-ARCHIVE999' },
      jevKey: 'jev-ARCHIVE',
      settings: { modelProvider: 'openai', providers: {
        openai: { baseUrl: 'https://archive.example/v1', model: 'archive-model' },
        custom: { baseUrl: 'https://c.example/v1', model: 'c-model', apiKey: 'sk-SMUGGLE' }
      } },
      initPrompt: '归档规则',
      writingDrafts: [{ id: 'w1', text: '归档稿' }, { id: 'w2', text: '新归档稿' }]
    }
  };
  const result = await importBackup(archive);
  assert.match(result.dictionary, /MDX.*重新导入|重新导入.*MDX/);
  assert.match(result.dictionary, /密钥/);
  // 密钥不落盘、本地密钥不动
  assert.deepEqual(store.apiKeys, { openai: 'sk-LOCAL789' });
  assert.equal(store.jevKey, undefined);
  // 本地 provider 配置优先；归档新增 provider 进来但被剥掉密钥
  assert.equal(store.settings.providers.openai.baseUrl, 'https://local.example/v1');
  assert.equal(store.settings.providers.custom.baseUrl, 'https://c.example/v1');
  assert.equal(store.settings.providers.custom.apiKey, undefined);
  // initPrompt 本地优先；写作草稿按 id 冲突另存（本地 + 归档冲突副本 + 归档新条目）
  assert.equal(store.initPrompt, '本地规则');
  assert.equal(store.writingDrafts.length, 3);
  assert.equal(store.writingDrafts[0].text, '本地稿');
  assert.equal(store.writingDrafts[1].text, '归档稿');
  assert.ok(store.writingDrafts[1].importedConflict);
  assert.equal(store.writingDrafts[2].text, '新归档稿');
  // 会话真正入库
  assert.equal((await sessionOp({ op: 'get', key: 'post:2002' })).data.draft, '归档会话');
  assert.equal((await sessionOp({ op: 'get', key: 'post:2001' })).data.draft, '本地会话');
  // 会话归档非法 → sessionOp 原子拒绝，chrome.storage 一个字节都不写
  store.initPrompt = '本地规则2';
  const bad = { ...archive, sessions: [{ key: 'bad key', data: {} }], storage: { initPrompt: '应当不会写入' } };
  await assert.rejects(importBackup(bad), /无效的帖子会话/);
  assert.equal(store.initPrompt, '本地规则2', '会话导入失败后 chrome.storage 未被触碰');
  await removeAllSessions();
});

// ================= D. 侧栏会话控制器（sidebar/sessions.js 集成） =================
const POST_A = { url: 'https://x.com/alice/status/111?s=20', text: '正文A', author: 'alice' };
const POST_A_VARIANT = { url: 'https://x.com/i/status/111?t=9', text: '正文A', author: 'alice' };
const POST_B = { url: 'https://x.com/bob/status/222', text: '正文B', author: 'bob' };

async function seed(key, data) {
  await sessionOp({ op: 'save', key, data, revision: 0 });
}

test('同帖详情/返回/刷新：恢复正确内容，返回不回退到旧缓存', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: 'A稿', practiceAnswer: '作答A', practiceFeedback: { meaningNote: '清楚' } });
  const h = createHarness();
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready;
  assert.equal(h.state.draft, 'A稿');
  assert.equal(h.state.practiceAnswer, '作答A');
  assert.equal(h.state.practiceFeedback.meaningNote, '清楚');
  assert.equal(h.state.saveStatus, '已恢复本帖内容');
  assert.equal(h.label.textContent, '已恢复本帖内容');
  assert.equal(h.sessionReadyCount(), 1, '一次切换只发一次 session-ready');
  assert.ok(h.counters.refresh <= 3, `恢复期间的渲染应有界，实际 ${h.counters.refresh}`);

  // 编辑 → 立即保存 → 切走 → 切回：必须看到编辑后的内容（回归：slot.data 陈旧缓存）
  h.state.draft = 'A稿改';
  await h.win.BXSession.save(true);
  h.win.BXSession.switchTo(POST_B, h.apply);
  await h.win.BXSession.ready;
  assert.equal(h.state.draft, '', '切到新帖是干净状态');
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready;
  assert.equal(h.state.draft, 'A稿改', '返回同帖恢复的是刚保存的内容，不是旧缓存');
  await removeAllSessions();
});

test('身份按稳定 ID：查询参数变体不算切帖，不重复恢复', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: '稳定稿' });
  const h = createHarness();
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready;
  const gets = h.counters.gets;
  const readyBefore = h.sessionReadyCount();
  h.win.BXSession.switchTo(POST_A_VARIANT, h.apply); // /i/status/111?t=9
  await h.win.BXSession.ready;
  assert.equal(h.win.BXSession.key, 'post:111');
  assert.equal(h.counters.gets, gets, '同帖不同链接形态不再发 get');
  assert.equal(h.sessionReadyCount(), readyBefore, '不重复 session-ready');
  assert.equal(h.state.draft, '稳定稿', '状态未被重置');
  await removeAllSessions();
});

test('恢复期间的切帖挂起执行：旧恢复不覆盖新帖', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: 'A稿', practiceAnswer: 'A作答' });
  await seed('post:222', { draft: 'B稿' });
  const h = createHarness();
  h.opts.slowGetMs = 40; // 让 A 的恢复仍在途时就切到 B
  h.win.BXSession.switchTo(POST_A, h.apply);
  h.win.BXSession.switchTo(POST_B, h.apply);
  await h.win.BXSession.ready; // A 链结束时会按最近意图执行 B 切换
  await h.win.BXSession.ready; // B 链
  await sleep(10);
  assert.equal(h.win.BXSession.key, 'post:222');
  assert.equal(h.state.draft, 'B稿');
  assert.equal(h.state.practiceAnswer, '', 'A 的内容绝不落到 B 的状态上');
  assert.equal(h.state.sessionLoading, false);
  await removeAllSessions();
});

test('恢复期间的新输入不被旧记录覆盖，且最终入库', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: '旧稿', practiceAnswer: '作答A' });
  const h = createHarness();
  h.opts.slowGetMs = 40;
  h.win.BXSession.switchTo(POST_A, h.apply);
  await sleep(5); // 恢复请求在途
  h.state.draft = '键入中';
  h.fireInput();
  await h.win.BXSession.ready;
  assert.equal(h.state.draft, '键入中', '新输入不被异步恢复覆盖');
  assert.equal(h.state.practiceAnswer, '作答A', '未动字段正常恢复');
  await h.win.BXSession.save(true); // 等待 finally 触发的强制保存完成
  const stored = await sessionOp({ op: 'get', key: 'post:111' });
  assert.equal(stored.data.draft, '键入中', '合并后的输入已入库');
  assert.equal(stored.data.practiceAnswer, '作答A');
  await removeAllSessions();
});

test('保存防抖与去重：不产生保存循环，也不逐键狂写', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: '起点' });
  const h = createHarness();
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready;
  const base = h.counters.saves;
  h.win.BXSession.save(); // 内容无变化
  h.win.BXSession.save();
  h.fireInput();
  await sleep(600);
  assert.equal(h.counters.saves, base, '无变化的 save/refresh 不落库（无保存循环）');
  h.state.draft = '起点x';
  h.fireInput();
  await sleep(120);
  assert.equal(h.counters.saves, base, '防抖窗口内不发送');
  await sleep(500);
  assert.equal(h.counters.saves, base + 1, '到点只发一次');
  await removeAllSessions();
});

test('保存失败明确提示、不静默丢稿，回切与 pagehide 自动重试', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: '原稿' });
  const h = createHarness();
  h.opts.failSaves = 1;
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready;
  h.state.draft = '险稿';
  // 切帖时旧帖立即落盘——这次保存失败
  h.win.BXSession.switchTo(POST_B, h.apply);
  await h.win.BXSession.ready;
  await sleep(20);
  assert.match(h.state.notice || h.state.saveStatus, /上一帖保存失败/, '切走后的失败必须留下明确提示');
  assert.match(h.state.notice || h.state.saveStatus, /模拟磁盘故障|保存失败/);
  // 库里仍是旧内容（没有半写），本地草稿在 slot 里等待重试
  assert.equal((await sessionOp({ op: 'get', key: 'post:111' })).data.draft, '原稿');
  // pagehide 冲刷：失败槽自动重试并成功
  h.firePagehide();
  await sleep(120);
  assert.equal((await sessionOp({ op: 'get', key: 'post:111' })).data.draft, '险稿', '回冲后险稿入库，不丢');
  await removeAllSessions();
});

test('恢复失败与保存失败都不吞错误；恢复中失败显示恢复错误', async () => {
  await removeAllSessions();
  const h = createHarness();
  const originalSend = h.win.BX.send;
  h.win.BX.send = async (action, payload) => {
    if (payload.payload?.op === 'get') throw new Error('读取故障');
    return originalSend(action, payload);
  };
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready;
  assert.match(h.state.error, /恢复失败.*读取故障/);
  assert.equal(h.state.sessionLoading, false, '恢复失败也要解除加载态');
  await removeAllSessions();
});

test('浏览器重启（新页面实例）后恢复正确内容', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: '重启前的稿', replyFeedback: { note: '反馈' } });
  const h1 = createHarness();
  h1.win.BXSession.switchTo(POST_A, h1.apply);
  await h1.win.BXSession.ready;
  h1.state.draft = '重启前的稿·改';
  await h1.win.BXSession.save(true);
  // 模拟重启：全新 window/state/控制器实例，同一存储
  const h2 = createHarness();
  assert.equal(h2.win.BXSession.key, '');
  h2.win.BXSession.switchTo(POST_A, h2.apply);
  await h2.win.BXSession.ready;
  assert.equal(h2.state.draft, '重启前的稿·改');
  assert.equal(h2.state.replyFeedback.note, '反馈');
  assert.equal(h2.state.saveStatus, '已恢复本帖内容');
  await removeAllSessions();
});

test('多标签冲突：本地保存另存副本并提示，后续保存走副本键', async () => {
  await removeAllSessions();
  await seed('post:111', { draft: '初始' }); // rev1
  const h = createHarness();
  h.win.BXSession.switchTo(POST_A, h.apply);
  await h.win.BXSession.ready; // 采纳 revision 1
  // 另一标签抢先保存 → rev2
  await sessionOp({ op: 'save', key: 'post:111', data: { draft: '另一标签' }, revision: 1 });
  h.state.draft = '本标签';
  await h.win.BXSession.save(true);
  assert.match(h.state.saveStatus, /已另存冲突副本/);
  assert.match(h.state.notice, /已另存冲突副本/);
  assert.equal((await sessionOp({ op: 'get', key: 'post:111' })).data.draft, '另一标签', '另一标签的原记录不被覆盖');
  // 首次冲突请求发往原键（服务端判定冲突），返回后本地切换到副本键
  assert.equal(h.counters.saveKeys[h.counters.saveKeys.length - 1], 'post:111');
  h.state.draft = '本标签续';
  await h.win.BXSession.save(true);
  const nextKey = h.counters.saveKeys[h.counters.saveKeys.length - 1];
  assert.match(nextKey, /^conflict:/, '冲突后的保存改走副本键');
  assert.equal((await sessionOp({ op: 'get', key: nextKey })).data.draft, '本标签续');
  assert.equal((await sessionOp({ op: 'get', key: 'post:111' })).data.draft, '另一标签', '原键始终不被本标签覆盖');
  await removeAllSessions();
});

test('无记录的新帖：不写空壳记录；首次输入后才入库', async () => {
  await removeAllSessions();
  const h = createHarness();
  h.win.BXSession.switchTo(POST_B, h.apply);
  await h.win.BXSession.ready;
  assert.equal(h.state.saveStatus, '');
  assert.equal(h.counters.saves, 0, '空状态不写库');
  assert.equal((await sessionOp({ op: 'get', key: 'post:222' })), null);
  h.state.draft = '第一笔';
  h.fireInput();
  await sleep(600);
  assert.equal(h.counters.saves, 1);
  assert.equal((await sessionOp({ op: 'get', key: 'post:222' })).data.draft, '第一笔');
  await removeAllSessions();
});
