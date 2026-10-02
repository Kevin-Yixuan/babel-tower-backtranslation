// T1 专项：options.html/options.js 固定设置页行为测试（不启动浏览器）。
// 最小 DOM + chrome 桩驱动真实 options.js 模块，覆盖任务书硬性要求：
//  1) 未保存配置时不能改变当前生效配置；
//  2) 密钥不进网页 DOM、日志、默认导出内容；
//  3) Chat Completions 与 Responses 各一条可复现的配置切换测试；
//  4) 权限被拒、错误密钥给出明确错误。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, saveSettings } from '../services/settings.js';
import { classifyModelHttpError } from '../shared.js';
import { exportBackup } from '../services/backup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- 控制台日志采集（密钥泄漏断言用） ----------
const consoleLines = [];
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[method] = (...args) => {
    consoleLines.push(args.map(arg => {
      try { return typeof arg === 'string' ? arg : JSON.stringify(arg); } catch { return String(arg); }
    }).join(' '));
  };
}
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));

// ---------- 最小 DOM ----------

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach(name => this.set.add(name)); }
  remove(...names) { names.forEach(name => this.set.delete(name)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : Boolean(force);
    if (want) this.set.add(name); else this.set.delete(name);
    return want;
  }
}

const camelize = name => name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

class FakeElement {
  constructor(tag = 'div', doc = null) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = {};
    this._text = '';
    this._innerHTML = null;
    this._value = '';
    this._options = this.tagName === 'SELECT' ? [] : null;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.files = null;
    this.type = '';
    this.href = '';
    this.download = '';
    if (doc) doc._all.push(this);
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this._setId(String(value)); }
  _setId(value) {
    this.attributes.id = value;
    if (this.ownerDocument) this.ownerDocument._ids.set(value, this);
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(value) { this.classList = new FakeClassList(); String(value || '').split(/\s+/).filter(Boolean).forEach(c => this.classList.set.add(c)); }
  get textContent() { return this._text + this.children.map(child => (typeof child === 'string' ? child : child.textContent)).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; this._innerHTML = null; }
  get text() { return this._text; }
  set text(value) { this._text = String(value ?? ''); }
  get innerHTML() { return this._innerHTML ?? this._text; }
  set innerHTML(value) {
    this._innerHTML = String(value); this._text = ''; this.children = [];
    if (this._options) {
      this._options = [];
      for (const match of String(value).matchAll(/<option value="([^"]*)">([\s\S]*?)<\/option>/g)) {
        const option = new FakeOption(match[2], match[1]);
        option.parentNode = this;
        this._options.push(option);
      }
      if (this._options.length && !this._options.some(option => option.value === this._value)) {
        this._value = this._options[0].value;
      }
    }
  }
  get value() {
    if (this._options && this._options.length && !this._options.some(option => option.value === this._value)) return '';
    return this._value;
  }
  set value(v) { this._value = String(v); }
  get options() { return this._options || []; }
  get selectedOptions() { return this._options ? this._options.filter(option => option.value === this.value) : []; }
  add(option) { option.parentNode = this; if (!this._options) this._options = []; this._options.push(option); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'id') this._setId(String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = value !== false && value !== 'false';
    if (name.startsWith('data-')) this.dataset[camelize(name.slice(5))] = String(value);
  }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler); }
  append(...nodes) { for (const node of nodes) if (node) { this.children.push(node); if (node instanceof FakeElement) node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = [...nodes].filter(Boolean); this._innerHTML = null; this._text = ''; }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    if (parent._options) {
      const index = parent._options.indexOf(this);
      if (index >= 0) parent._options.splice(index, 1);
      if (parent._value === this.value) parent._value = parent._options[0]?.value ?? '';
    }
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }
  focus() {}
  click() { if (typeof this.onclick === 'function') return this.onclick(); }
  *descendants() {
    for (const child of this.children) {
      if (child instanceof FakeElement) { yield child; yield* child.descendants(); }
    }
  }
  querySelector(selector) {
    for (const node of this.descendants()) if (matches(node, selector)) return node;
    return null;
  }
}

function matches(node, selector) {
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return node.tagName === selector.toUpperCase();
}

class FakeOption extends FakeElement {
  constructor(text = '', value = '') {
    super('option');
    this._text = String(text);
    this._value = String(value);
  }
}
globalThis.Option = FakeOption;

class FakeDocument {
  constructor() { this._ids = new Map(); this._all = []; }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this._ids.get(id) || null; }
  querySelector(selector) {
    if (selector.startsWith('#')) return this._ids.get(selector.slice(1)) || null;
    const matchesAll = this.querySelectorAll(selector.replace(/:last-of-type$/, ''));
    if (selector.endsWith(':last-of-type')) return matchesAll[matchesAll.length - 1] || null;
    return matchesAll[0] || null;
  }
  querySelectorAll(selector) {
    const match = /^\[data-([a-z-]+)\](?::last-of-type)?$/.exec(selector);
    if (!match) throw new Error('DOM 桩不支持的选择器：' + selector);
    const key = camelize(match[1]);
    return this._all.filter(node => node.dataset && key in node.dataset);
  }
}

function element(doc, tag, attrs = {}) {
  const node = doc.createElement(tag);
  if (attrs.id) node.setAttribute('id', attrs.id);
  if (attrs.type) node.setAttribute('type', attrs.type);
  if (attrs.value !== undefined) node.value = String(attrs.value);
  if (attrs.checked) node.checked = true;
  if (attrs.hidden) node.hidden = true;
  if (attrs.className) node.className = attrs.className;
  if (attrs.dataset) Object.assign(node.dataset, attrs.dataset);
  return node;
}

function optionIn(select, value, text) {
  const option = new FakeOption(text ?? value, value);
  option.parentNode = select;
  select._options.push(option);
  return option;
}

function buildDocument() {
  const doc = new FakeDocument();
  for (const tab of ['home', 'preferences', 'agent', 'filters', 'saved', 'dictionary', 'data']) {
    const button = element(doc, 'button', { dataset: { tab } });
    if (tab === 'home') button.className = 'active';
  }
  for (const panel of ['home', 'preferences', 'agent', 'filters', 'saved', 'dictionary', 'data']) {
    element(doc, 'section', { dataset: { panel }, hidden: panel !== 'home' });
  }
  element(doc, 'input', { id: 'agent-base-url' });
  element(doc, 'input', { id: 'agent-model' });
  element(doc, 'input', { id: 'agent-key', type: 'password' });
  element(doc, 'button', { id: 'test-agent' });
  element(doc, 'div', { id: 'agent-connection' });
  const agentSelect = element(doc, 'select', { id: 'agent-provider' });
  optionIn(agentSelect, 'pi');
  element(doc, 'input', { id: 'provider-label' });
  element(doc, 'input', { id: 'provider-base-url' });
  element(doc, 'input', { id: 'provider-model' });
  element(doc, 'input', { id: 'provider-key', type: 'password' });
  element(doc, 'input', { id: 'jev-key', type: 'password' });
  element(doc, 'input', { id: 'filter-limit', type: 'number', value: '80' });
  element(doc, 'input', { id: 'filter-threshold', type: 'range', value: '82' });
  element(doc, 'input', { id: 'glossary-file', type: 'file' });
  element(doc, 'input', { id: 'import-backup', type: 'file' });
  element(doc, 'input', { id: 'auto-translate', type: 'checkbox', checked: true });
  element(doc, 'input', { id: 'hover-lookup', type: 'checkbox', checked: true });
  element(doc, 'input', { id: 'filter-enabled', type: 'checkbox' });

  const providerSelect = element(doc, 'select', { id: 'model-provider' });
  optionIn(providerSelect, 'chat', 'Chat Completions');
  const kindSelect = element(doc, 'select', { id: 'provider-kind' });
  kindSelect._options = []; kindSelect._value = '';
  kindSelect.add(new FakeOption('Chat Completions', 'chat'));
  kindSelect.add(new FakeOption('Responses', 'responses'));
  kindSelect.value = 'chat';
  const languageSelect = element(doc, 'select', { id: 'target-language' });
  for (const language of ['英语', '西班牙语', '日语', '法语', '德语', '葡萄牙语', '韩语', '阿拉伯语']) {
    optionIn(languageSelect, language);
  }
  languageSelect.value = '英语';

  for (const id of ['add-provider', 'delete-provider', 'test-model', 'add-rule', 'refresh-jev',
    'save-main', 'save-filter', 'export-saved', 'open-mdx-import', 'export-backup',
    'confirm-import', 'refresh-sessions']) {
    element(doc, 'button', { id });
  }
  element(doc, 'input', { id: 'session-search', type: 'search' });
  for (const id of ['status', 'rules', 'jev-diagnostics', 'test-result', 'active-config', 'mdx-root',
    'saved-list', 'session-list', 'backup-preview', 'glossary-count', 'threshold-label', 'model-hint',
    'settings-dirty-status', 'settings-save-hint']) {
    element(doc, id === 'test-result' ? 'span' : 'div', { id });
  }
  return doc;
}

// ---------- chrome 桩 ----------
// 保存走 services/settings.js 的真实实现（与后台同一条链路），这里只替换存储与网络等系统接口。

function makeStorageLocal(page) {
  return {
    async get(keys) {
      const out = {};
      for (const key of [].concat(keys)) {
        if (key === 'settings') out.settings = structuredClone(page.store.settings);
        else if (key === 'jevKey') out.jevKey = page.store.jevKey;
        else if (key === 'apiKeys') out.apiKeys = { ...page.store.apiKeys };
        else if (key === 'openaiKey') out.openaiKey = page.store.openaiKey || '';
        else if (key === 'glossary') out.glossary = page.store.glossary || {};
        else if (Object.hasOwn(page.store, key)) out[key] = structuredClone(page.store[key]);
      }
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) page.store[key] = structuredClone(value);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete page.store[key];
    }
  };
}

function installFakeIndexedDB() {
  const makeRequest = fire => { const request = { onsuccess: null, onerror: null }; setTimeout(() => fire(request), 0); return request; };
  const store = {
    getAll: () => makeRequest(request => { request.result = []; request.onsuccess?.({ target: request }); }),
    get: () => makeRequest(request => { request.result = undefined; request.onsuccess?.({ target: request }); }),
    put: () => makeRequest(request => request.onsuccess?.({ target: request })),
    delete: () => makeRequest(request => request.onsuccess?.({ target: request }))
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        request.result = {
          onversionchange: null,
          close() {},
          createObjectStore() { return store; },
          transaction() { return { error: null, oncomplete: null, onerror: null, objectStore() { return store; }, abort() {} }; }
        };
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    },
    deleteDatabase() { return makeRequest(request => request.onsuccess?.({ target: request })); },
    databases: async () => []
  };
}

function makeChrome(page) {
  return {
    runtime: {
      lastError: null,
      getURL: relative => 'chrome-extension://t1test/' + relative,
      sendMessage(message, callback) {
        Promise.resolve()
          .then(() => page.route(message))
          .then(data => callback({ ok: true, data }))
          .catch(error => callback({ ok: false, error: error.message || '操作失败。', code: error.code || '' }));
      }
    },
    permissions: {
      async contains({ origins = [] }) { return origins.every(origin => page.granted.has(origin)); },
      async request({ origins = [] }) {
        page.permissionRequests.push([...origins]);
        if (page.permissionResponder) return page.permissionResponder(origins);
        origins.forEach(origin => page.granted.add(origin));
        return true;
      }
    },
    tabs: { create: options => { page.tabCreates.push(options); return options; } },
    storage: { local: page.storageLocal }
  };
}

const defaultTestModel = async payload => {
  if (!payload.key) {
    const error = new Error(`请先填写 ${payload.label} API Key。`);
    error.code = 'no_key';
    throw error;
  }
  return { ok: true, latencyMs: 15, message: `${payload.label} 连接正常，模型 ${payload.model} 已确认响应（15 ms）。` };
};

async function route(page, message) {
  page.messages.push({ action: message.action, payload: message.payload });
  switch (message.action) {
    case 'PRIVATE_SETTINGS':
      return {
        settings: normalizeSettings(page.store.settings || {}),
        apiKeys: { ...page.store.apiKeys },
        openaiKey: page.store.apiKeys.openai || '',
        jevKey: page.store.jevKey || '',
        glossaryCount: 0
      };
    case 'JEV_STATUS':
      return { state: 'disabled', enabled: false, used: 0, dailyLimit: 80, stats: {}, cacheCount: 0 };
    case 'LIST_CARDS': return [];
    case 'SESSION': return [];
    case 'IMPORT_GLOSSARY': return { count: 0 };
    case 'DELETE_CARD': return null;
    // 真实生产保存逻辑（services/settings.js），与后台同一条实现。
    case 'SAVE_SETTINGS': return saveSettings(message.payload, page.storageLocal);
    case 'TEST_MODEL': return page.testModel(message.payload);
    case 'BACKUP':
      if (message.payload?.op === 'export') return exportBackup();
      throw new Error('未知备份操作。');
    default: throw new Error('未知操作：' + message.action);
  }
}

// ---------- 页面打开 ----------

let importSeq = 0;
let currentBlobSink = null;

// store 在“重载页面”之间共享：保存写进 store，重开页面读同一份存储
function makeStore(seed = {}) {
  return {
    settings: structuredClone(seed.settings || {}),
    apiKeys: { ...(seed.apiKeys || {}) },
    jevKey: seed.jevKey || ''
  };
}

async function openPage(store = makeStore()) {
  installFakeIndexedDB();
  const page = {
    store,
    messages: [],
    permissionRequests: [],
    permissionResponder: null,
    granted: new Set(),
    confirmAnswer: true,
    tabCreates: [],
    testModel: defaultTestModel,
    blobs: []
  };
  page.route = message => route(page, message);
  page.storageLocal = makeStorageLocal(page);
  page.document = buildDocument();
  globalThis.document = page.document;
  // 系统接口替身：离开提示只在有未保存修改时触发（真实行为由浏览器回归覆盖）。
  globalThis.window = { listeners: {}, addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }, removeEventListener() {} };
  globalThis.chrome = makeChrome(page);
  globalThis.confirm = () => page.confirmAnswer;
  currentBlobSink = page.blobs;
  if (!URL.createObjectURL.__t1wrapped) {
    const original = URL.createObjectURL;
    URL.createObjectURL = blob => { if (currentBlobSink) currentBlobSink.push(blob); return 'blob:t1test'; };
    URL.createObjectURL.__t1wrapped = true;
    URL.revokeObjectURL = () => {};
    void original;
  }
  await import(`../options.js?page=${++importSeq}`);
  await sleep(30); // listSessions / JEV 诊断 / MDX 面板 refresh 收尾
  page.el = id => page.document.getElementById(id);
  page.selectProvider = id => { page.el('model-provider').value = id; page.el('model-provider').onchange(); };
  page.click = async id => { const handler = page.el(id).onclick; assert.equal(typeof handler, 'function', `#${id} 应可点击`); await handler(); };
  return page;
}

function collectDomText(page) {
  const parts = [];
  for (const node of page.document._all) {
    parts.push(node.textContent, node.innerHTML || '');
    for (const [name, value] of Object.entries(node.attributes)) parts.push(`${name}=${value}`);
    if (node.type !== 'password') parts.push(String(node.value ?? ''));
    for (const [name, value] of Object.entries(node.dataset)) parts.push(`${name}:${value}`);
  }
  return parts.join('\n');
}

function seedSettings(overrides = {}) {
  return {
    modelProvider: 'custom_alpha',
    targetLanguage: '日语',
    providers: {
      custom_alpha: { label: '网关A（聊天）', kind: 'chat', baseUrl: 'https://a.example.com/v1', model: 'org/alpha-chat' },
      custom_beta: { label: '网关B（响应）', kind: 'responses', baseUrl: 'https://b.example.com/v1', model: 'models/beta-resp' }
    },
    autoTranslate: true,
    hoverLookup: true,
    filterEnabled: false,
    filterRules: [],
    filterThreshold: 0.82,
    filterDailyLimit: 80,
    ...overrides
  };
}

const seedKeys = () => ({
  custom_alpha: 'sk-alpha-SECRET-AAA',
  custom_beta: 'sk-beta-SECRET-BBB',
  openai: 'sk-openai-SECRET-CCC'
});

// ================= A. 装配审查（popup 复制遗留） =================

test('装配：options.js 引用的元素都在 options.html，且保留弹窗时代的假设已清理', async () => {
  const js = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
  const referenced = new Set();
  for (const match of js.matchAll(/\$\('#([\w-]+)'\)/g)) referenced.add(match[1]);
  for (const match of js.matchAll(/querySelector\('#([\w-]+)'\)/g)) referenced.add(match[1]);
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  for (const id of referenced) assert.ok(htmlIds.has(id), `options.html 缺少 options.js 引用的 #${id}`);
  // 密钥输入必须是 password，且初始 HTML 源码里没有任何默认密钥
  assert.match(html, /id="provider-key" type="password"/);
  assert.equal(/sk-[A-Za-z0-9]/.test(html), false, 'options.html 源码不得含密钥样例');
  // 弹窗尺寸约束已解除；页面不再加载 popup.js
  const css = fs.readFileSync(path.join(root, 'popup.css'), 'utf8');
  assert.match(css, /\.options-page\{[^}]*width:auto/);
  assert.equal(/popup\.js/.test(html), false);
  assert.equal(js.includes('open-settings'), false, 'options.js 不应残留弹窗入口');
  // 页面真实加载并渲染 Flash 建议（只读）
  const page = await openPage({ settings: seedSettings(), apiKeys: seedKeys() });
  assert.match(page.el('model-hint').textContent, /推荐尝试：/, '应展示 Flash 低延迟建议');
  assert.match(page.el('model-hint').textContent, /不会更改你的选择/);
  assert.equal(page.store.settings.modelProvider, 'custom_alpha', '建议不改变生效配置');
  assert.equal(page.el('active-config').textContent, '当前使用：网关A（聊天）');
  assert.equal(page.el('target-language').value, '日语');
  assert.equal(page.el('provider-key').value, 'sk-alpha-SECRET-AAA', '密码框回填当前密钥（便于编辑）');
  assert.equal(page.el('provider-key').type, 'password');
});

// ================= B. 未保存配置不改变生效配置 =================

test('未保存的配置改动、切换与连接测试都不改变当前生效配置', async () => {
  const page = await openPage({ settings: seedSettings(), apiKeys: seedKeys() });
  const settingsBefore = JSON.stringify(page.store.settings);
  const keysBefore = JSON.stringify(page.store.apiKeys);

  // 改当前配置的每个字段（名称、协议、地址、模型、密钥）
  page.el('provider-label').value = '改了名但没保存';
  page.el('provider-kind').value = 'responses';
  page.el('provider-base-url').value = 'https://changed.example.com/v1';
  page.el('provider-model').value = 'totally/not-saved';
  page.el('provider-key').value = 'sk-EDITED-NOT-SAVED';
  // 切到另一配置再切回（草稿不丢，但不落库）
  page.selectProvider('custom_beta');
  page.el('provider-model').value = 'beta/also-changed';
  page.selectProvider('custom_alpha');
  // 连接测试是只读操作
  await page.click('test-model');
  // 切 tab 也不落库
  page.document.querySelectorAll('[data-tab]')[1].onclick();
  page.document.querySelectorAll('[data-tab]')[0].onclick();
  await sleep(10);

  assert.equal(page.messages.some(message => message.action === 'SAVE_SETTINGS'), false, '没有点保存就不应发 SAVE_SETTINGS');
  assert.equal(JSON.stringify(page.store.settings), settingsBefore, '生效配置一个字节都没变');
  assert.equal(JSON.stringify(page.store.apiKeys), keysBefore, '密钥存储未变');
  // 草稿仍在表单里（不丢输入，只是未生效）
  assert.equal(page.el('provider-model').value, 'totally/not-saved');
  assert.equal(page.el('provider-label').value, '改了名但没保存');
});

// ================= C. 两种协议的配置切换 =================

test('协议切换①（Chat→Responses）：保存前不生效，保存后重载仍是所选配置', async () => {
  const seed = { settings: seedSettings(), apiKeys: seedKeys() };
  let page = await openPage(seed);
  assert.equal(page.el('model-provider').value, 'custom_alpha');
  assert.equal(page.el('provider-kind').value, 'chat');
  assert.equal(page.el('provider-model').value, 'org/alpha-chat');

  // 切到 Responses 协议配置
  page.selectProvider('custom_beta');
  assert.equal(page.el('provider-kind').value, 'responses');
  assert.equal(page.el('provider-model').value, 'models/beta-resp', '模型名含 "/" 原样回显');
  assert.equal(page.el('provider-key').value, 'sk-beta-SECRET-BBB');
  // 未保存：生效配置仍是 chat 配置
  assert.equal(page.store.settings.modelProvider, 'custom_alpha');
  assert.equal(page.messages.some(message => message.action === 'SAVE_SETTINGS'), false);

  await page.click('save-main');
  assert.equal(page.store.settings.modelProvider, 'custom_beta', '保存后才切换生效配置');
  assert.equal(page.store.settings.providers.custom_beta.kind, 'responses');
  assert.equal(page.store.settings.providers.custom_alpha.kind, 'chat', '另一配置的协议不受影响');
  assert.equal(page.store.settings.providers.custom_beta.model, 'models/beta-resp');
  assert.equal(page.store.apiKeys.custom_alpha, seedKeys().custom_alpha, '切换不丢其他配置的密钥');
  assert.equal(page.el('active-config').textContent, '当前使用：网关B（响应）');

  // 重载页面（新模块实例 + 同一存储）：切换结果稳定
  page = await openPage(seed);
  assert.equal(page.el('model-provider').value, 'custom_beta');
  assert.equal(page.el('provider-kind').value, 'responses');
  assert.equal(page.el('provider-model').value, 'models/beta-resp');
});

test('协议切换②（Responses→Chat + 重命名）：稳定配置 ID 不变、数据不丢', async () => {
  const seed = { settings: seedSettings({ modelProvider: 'custom_beta' }), apiKeys: seedKeys() };
  let page = await openPage(seed);
  assert.equal(page.el('provider-kind').value, 'responses');

  // 切回 Chat 配置并重命名
  page.selectProvider('custom_alpha');
  assert.equal(page.el('provider-kind').value, 'chat');
  page.el('provider-label').value = '网关A改名了';
  assert.equal(page.store.settings.modelProvider, 'custom_beta', '改名过程中生效配置未变');

  await page.click('save-main');
  const id = 'custom_alpha';
  assert.equal(page.store.settings.modelProvider, id, '生效配置切到 chat 配置');
  assert.equal(page.store.settings.providers[id].label, '网关A改名了', '重命名生效');
  assert.equal(page.store.settings.providers[id].kind, 'chat');
  assert.equal(page.store.settings.providers[id].model, 'org/alpha-chat', '重命名不丢模型名');
  assert.equal(page.store.apiKeys[id], 'sk-alpha-SECRET-AAA', '重命名不丢密钥（ID 稳定）');
  assert.equal(page.store.settings.providers.custom_beta.kind, 'responses', '另一配置不受影响');
  // 下拉中的旧名同步刷新
  const option = page.el('model-provider').options.find(item => item.value === id);
  assert.equal(option.text, '网关A改名了');

  page = await openPage(seed);
  assert.equal(page.el('model-provider').value, id);
  assert.equal(page.el('provider-label').value, '网关A改名了');
  assert.equal(page.el('provider-key').value, 'sk-alpha-SECRET-AAA');
  assert.equal(page.el('provider-kind').value, 'chat');
});

// ================= D. 添加自定义配置 + 按域名请求权限 =================

test('添加自定义配置：按该域名请求权限，连接测试不落库，保存后生效', async () => {
  const page = await openPage({ settings: seedSettings(), apiKeys: seedKeys() });
  await page.click('add-provider');
  const newId = page.el('model-provider').value;
  assert.match(newId, /^custom_[0-9a-f-]{36}$/, '新配置获得稳定 ID');
  assert.equal(page.el('delete-provider').disabled, false, '自定义配置可删除');

  page.el('provider-label').value = '新网关';
  page.el('provider-base-url').value = 'https://new.example.com/v1';
  page.el('provider-model').value = 'org/new-model';
  page.el('provider-key').value = 'sk-new-SECRET-DDD';
  await page.click('test-model');
  assert.deepEqual(page.permissionRequests, [['https://new.example.com/*']], '按域名（origin/*）请求权限');
  assert.equal(page.el('test-result').classList.contains('ok'), true);
  assert.equal(page.el('test-result').textContent.includes('sk-new-SECRET-DDD'), false, '结果回显不含密钥');
  assert.equal(page.messages.some(message => message.action === 'SAVE_SETTINGS'), false, '测试连接不落库');
  assert.equal(page.store.settings.providers[newId], undefined);

  await page.click('save-main');
  assert.equal(page.store.settings.modelProvider, newId);
  assert.equal(page.store.settings.providers[newId].model, 'org/new-model');
  assert.equal(page.store.apiKeys[newId], 'sk-new-SECRET-DDD');
  assert.equal(page.permissionRequests.length, 1, '保存时同域名已授权，不重复请求');
});

// ================= E. 权限被拒绝 =================

test('权限被拒：明确报错并指明域名，且不发出测试请求', async () => {
  const page = await openPage({ settings: seedSettings(), apiKeys: seedKeys() });
  page.permissionResponder = () => false;
  await page.click('test-model');
  const result = page.el('test-result');
  assert.match(result.textContent, /未授予 https:\/\/a\.example\.com\/\* 的网络访问权限/, '错误必须指明被拒的域名');
  assert.ok(result.classList.contains('error'));
  assert.equal(result.classList.contains('ok'), false);
  assert.equal(page.messages.some(message => message.action === 'TEST_MODEL'), false, '未授权时不应发出网络测试');
  assert.deepEqual(page.permissionRequests, [['https://a.example.com/*']]);
  // 拒绝权限同样不改变生效配置
  assert.equal(page.store.settings.modelProvider, 'custom_alpha');
});

// ================= F. 错误密钥 =================

test('错误密钥：连接测试给出明确错误且不回显密钥', async () => {
  const page = await openPage({ settings: seedSettings(), apiKeys: seedKeys() });
  page.testModel = async payload => {
    const error = new Error(classifyModelHttpError(401, payload.label));
    error.code = 'http';
    throw error;
  };
  await page.click('test-model');
  const result = page.el('test-result');
  assert.match(result.textContent, /密钥无效或无权限/);
  assert.match(result.textContent, /API Key/);
  assert.ok(result.classList.contains('error'));
  assert.equal(result.textContent.includes('sk-alpha-SECRET-AAA'), false, '错误文案不包含密钥');
  assert.equal(page.store.settings.modelProvider, 'custom_alpha', '失败的测试不改变生效配置');
});

// ================= G. 密钥不进 DOM / 日志 / 默认导出 =================

test('密钥不进 DOM、控制台日志与默认导出内容', async () => {
  consoleLines.length = 0;
  const page = await openPage({ settings: seedSettings(), apiKeys: seedKeys(), jevKey: 'jev-SECRET-EEE' });
  const secrets = [...Object.values(page.store.apiKeys), page.store.jevKey];

  // 浏览所有配置（密钥会进表单），跑连接测试，切 tab，触发状态文案
  page.selectProvider('custom_beta');
  page.selectProvider('custom_alpha');
  await page.click('test-model');
  page.document.querySelectorAll('[data-tab]')[1].onclick();
  page.document.querySelectorAll('[data-tab]')[0].onclick();
  await sleep(10);

  const domText = collectDomText(page);
  for (const secret of secrets) {
    assert.equal(domText.includes(secret), false, `DOM 中不得出现密钥 ${secret.slice(0, 8)}…`);
  }
  assert.equal(page.el('provider-key').type, 'password', '密钥输入必须是 password 型');
  for (const line of consoleLines) {
    for (const secret of secrets) assert.equal(line.includes(secret), false, '控制台日志不得出现密钥');
  }

  // 默认导出（真实 services/backup.js exportBackup 路径）
  await page.click('export-backup');
  await sleep(10);
  assert.equal(page.blobs.length, 1, '导出应生成一个文件');
  const text = await page.blobs[0].text();
  const archive = JSON.parse(text);
  assert.equal(archive.format, 'babel-tower-backup');
  assert.ok(archive.storage.settings, '导出包含设置');
  assert.ok(Object.hasOwn(archive.storage.settings.providers, 'custom_alpha'), '导出包含自定义配置');
  for (const secret of secrets) assert.equal(text.includes(secret), false, '默认导出内容不得含密钥');
  assert.equal(Object.hasOwn(archive.storage, 'apiKeys'), false, '导出存储不含 apiKeys');
  assert.equal(Object.hasOwn(archive.storage, 'jevKey'), false, '导出存储不含 jevKey');
});
