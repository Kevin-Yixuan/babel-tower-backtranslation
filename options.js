import { DEFAULT_SETTINGS, PROVIDERS, parseGlossary, normalizeBaseUrl, permissionOrigin } from './shared.js';
import { flashModelSuggestion } from './services/settings.js';
import { mountDictionaryPanel } from './mdx/dictionary-panel.js';

const $ = selector => document.querySelector(selector);
const send = (action, payload = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ action, ...payload }, response => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!response?.ok) { const error = new Error(response?.error || '操作失败。'); error.code = response?.code || ''; reject(error); }
    resolve(response.data);
  });
});
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// provider drafts hold form state per provider so switching tabs never loses input
const providerDrafts = {};
let loadedSettings; // 最近一次「生效」的设置；未保存的表单改动不写入这里
let dirty = false;   // 生效配置与表单的差异标记：只有未保存修改时才提示
let formVersion = 0; // 每次编辑递增；连接测试按发起时的版本判定结果是否还属于当前配置
let testRun = 0;     // 连接测试序号：晚到的旧结果不覆盖新一次测试
let saving = false;  // 保存进行中禁止重复提交

function setDirty(next) {
  dirty = Boolean(next);
  const label = $('#settings-dirty-status');
  if (label) label.textContent = dirty ? '有未保存的修改，保存后才生效。' : '所有修改已保存。';
  const hint = $('#settings-save-hint');
  if (hint) hint.textContent = dirty ? '有未保存的修改 · 保存后生效' : '所有修改已保存';
}
function markFormEdit() { formVersion++; setDirty(true); }
// 离开/刷新只在有未保存修改时提示；干净页面不拦。
window.addEventListener('beforeunload', event => { if (!dirty) return; event.preventDefault(); event.returnValue = ''; });

function status(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}
function switchTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
    button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false');
  });
  document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== tab);
  status('');
  if (tab === 'saved') loadSaved();
}
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));

// 表单编辑统一走这里：既标记未保存，也让在途连接测试作废。
for (const selector of ['#provider-label', '#provider-kind', '#provider-base-url', '#provider-model', '#provider-key',
  '#model-provider', '#target-language', '#auto-translate', '#hover-lookup']) {
  const node = document.querySelector(selector);
  if (!node) continue;
  node.addEventListener('input', markFormEdit);
  node.addEventListener('change', markFormEdit);
}

// ---------- provider fields ----------

function activeProvider() { return $('#model-provider').value; }
let shownProvider = null; // provider whose values are currently displayed in the form

function stashActiveProvider() {
  if (!shownProvider) return;
  providerDrafts[shownProvider] = {
    label: $('#provider-label').value.trim(), kind: $('#provider-kind').value,
    baseUrl: $('#provider-base-url').value.trim(),
    model: $('#provider-model').value.trim(),
    key: $('#provider-key').value
  };
}

function showProvider(id) {
  shownProvider = id;
  const draft = providerDrafts[id] || { baseUrl: '', model: '', key: '' };
  $('#provider-label').value = draft.label || PROVIDERS[id]?.label || '';
  $('#provider-kind').value = draft.kind || PROVIDERS[id]?.kind || 'chat';
  $('#delete-provider').disabled = Boolean(PROVIDERS[id]);
  $('#provider-base-url').value = draft.baseUrl;
  $('#provider-model').value = draft.model;
  $('#provider-key').value = draft.key;
  $('#provider-base-url').placeholder = PROVIDERS[id]?.baseUrl || 'https://…';
  $('#test-result').textContent = '';
  $('#test-result').classList.remove('error', 'ok');
}

$('#model-provider').onchange = () => { stashActiveProvider(); showProvider(activeProvider()); };

// 表单为空时按占位符回落到内置默认地址，权限申请与实际请求始终针对同一个 origin
function effectiveBaseUrl(id, draft) {
  return (draft && draft.baseUrl) || PROVIDERS[id]?.baseUrl || '';
}

// Flash／低延迟模型：仅展示建议，从不写入任何配置
function renderModelHint() {
  const hint = flashModelSuggestion(loadedSettings);
  $('#model-hint').textContent = hint ? `推荐尝试：${hint.model}（${hint.note}）· ${hint.reason}` : '当前已是推荐的低延迟模型。';
}

async function ensureOrigin(baseUrl) {
  const origin = permissionOrigin(baseUrl); // throws explicit error on bad url
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`未授予 ${origin} 的网络访问权限，无法连接。请允许后重试。`);
}

$('#test-model').onclick = async () => {
  const button = $('#test-model');
  const result = $('#test-result');
  if (button.disabled) return;
  stashActiveProvider();
  const id = activeProvider();
  const draft = providerDrafts[id];
  // 结果绑定发起时的配置与表单版本：中途切换或编辑后晚到的结果不再回写。
  const run = ++testRun;
  const version = formVersion;
  const stillCurrent = () => run === testRun && version === formVersion && id === activeProvider();
  const discard = () => {
    result.textContent = id === activeProvider() ? '表单已修改，先前的测试结果已忽略。' : '已切换配置，先前的测试结果已忽略。';
    result.classList.remove('error', 'ok');
  };
  button.disabled = true;
  result.textContent = '测试中……';
  result.classList.remove('error', 'ok');
  try {
    const baseUrl = effectiveBaseUrl(id, draft);
    ensureOriginSyncCheck(baseUrl);
    await ensureOrigin(baseUrl);
    const data = await send('TEST_MODEL', { payload: { provider: id, label: draft.label, kind: draft.kind, baseUrl, model: draft.model, key: draft.key } });
    // 连接测试只读：不写入任何配置，也不把结果贴到别的配置上。
    if (!stillCurrent()) { discard(); return; }
    result.textContent = data.message;
    result.classList.add('ok');
  } catch (error) {
    if (!stillCurrent()) { discard(); return; }
    result.textContent = error.message;
    result.classList.add('error');
  } finally {
    button.disabled = false;
  }
};

function ensureOriginSyncCheck(baseUrl) {
  // surface empty/malformed url before requesting permissions
  normalizeBaseUrl(baseUrl);
}

// ---------- save / load ----------

async function settingsPayload() {
  stashActiveProvider();
  const providers = {};
  const apiKeys = {};
  for (const id of Object.keys(providerDrafts)) {
    const draft = providerDrafts[id] || {};
    providers[id] = { label: draft.label, kind: draft.kind, baseUrl: draft.baseUrl ?? '', model: draft.model ?? '' };
    apiKeys[id] = draft.key || ''; // always send all slots so clearing a field actually deletes the stored key
  }
  return {
    modelProvider: activeProvider(),
    autoTranslate: $('#auto-translate').checked, hoverLookup: $('#hover-lookup').checked,
    providers,
    apiKeys,
    targetLanguage: $('#target-language').value
  };
}
async function saveSettings() {
  if (saving) return; // 重复点击不重复提交
  saving = true;
  const buttons = [$('#save-main')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const payload = await settingsPayload();
    const active = payload.providers[payload.modelProvider];
    if (active?.baseUrl) await ensureOrigin(active.baseUrl);
    const saved = await send('SAVE_SETTINGS', { payload });
    // 保存成功后才把草稿提升为「生效配置」；下拉里的名称同步为新 label
    loadedSettings = saved || { ...loadedSettings, ...payload };
    $('#active-config').textContent = '当前使用：' + payload.providers[payload.modelProvider].label;
    for (const option of $('#model-provider').options) {
      const draft = providerDrafts[option.value];
      if (draft?.label) option.text = draft.label;
    }
    renderModelHint();
    setDirty(false); // 保存成功才生效，也才清掉「未保存」标记；失败保留原配置与输入
    status('已保存。已打开的 X 页面会立即应用新设置。');
  } catch (error) { status(error.message, true); }
  finally { saving = false; buttons.forEach(button => { button.disabled = false; }); }
}
$('#save-main').onclick = saveSettings;

async function loadSaved() {
  try {
    const cards = await send('LIST_CARDS');
    $('#saved-list').innerHTML = cards.length ? cards.map(card => `<article class="saved-card"><small>${card.kind === 'word' ? '词语' : card.kind === 'structure' ? '结构' : '句子'} · ${new Date(card.createdAt).toLocaleDateString('zh-CN')}</small><p>${esc(card.text)}</p>${card.note ? `<small>${esc(card.note)}</small>` : ''}<footer>${card.url ? `<a href="${esc(card.url)}" target="_blank" rel="noopener noreferrer">原帖 ↗</a>` : ''}<button data-delete="${esc(card.id)}">删除</button></footer></article>`).join('') : '<p class="hint">还没有收藏。先到 X 上选中一句想留下的表达。</p>';
    document.querySelectorAll('[data-delete]').forEach(button => button.onclick = async () => { await send('DELETE_CARD', { id: button.dataset.delete }); loadSaved(); });
  } catch (error) { status(error.message, true); }
}
$('#export-saved').onclick = async () => {
  try {
    const cards = await send('LIST_CARDS');
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), cards }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'backwrite-x-saved.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { status(error.message, true); }
};
$('#glossary-file').onchange = async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const entries = parseGlossary(await file.text(), file.name);
    const result = await send('IMPORT_GLOSSARY', { entries });
    $('#glossary-count').textContent = `已导入 ${result.count} 个词条`;
    status('词表只保存在当前浏览器。');
  } catch (error) { status(error.message, true); }
};

// 独立导入页：大词典导入要跑几分钟，弹窗一关就断，必须在独立标签页进行
document.querySelector('#open-mdx-import').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('mdx/import.html') });
};

try {
  const data = await send('PRIVATE_SETTINGS');
  const settings = data.settings || DEFAULT_SETTINGS;
  loadedSettings = settings;
  for (const id of Object.keys(settings.providers)) providerDrafts[id] = {};
  $('#model-provider').innerHTML = Object.entries(settings.providers).map(([id,cfg]) => '<option value="' + esc(id) + '">' + esc(cfg.label || PROVIDERS[id]?.label || id) + '</option>').join('');
  $('#auto-translate').checked = settings.autoTranslate !== false;
  $('#hover-lookup').checked = settings.hoverLookup !== false;
  $('#active-config').textContent = '当前使用：' + (settings.providers[settings.modelProvider]?.label || settings.modelProvider);
  $('#target-language').value = settings.targetLanguage || '英语';
  for (const id of Object.keys(providerDrafts)) {
    providerDrafts[id] = {
      label: settings.providers[id].label, kind: settings.providers[id].kind,
      baseUrl: settings.providers?.[id]?.baseUrl ?? PROVIDERS[id]?.baseUrl ?? '',
      model: settings.providers?.[id]?.model ?? PROVIDERS[id]?.model ?? '',
      key: data.apiKeys?.[id] ?? (id === 'openai' ? (data.openaiKey || '') : '')
    };
  }
  $('#model-provider').value = settings.modelProvider;
  showProvider(activeProvider());
  renderModelHint();
  $('#glossary-count').textContent = data.glossaryCount ? `已导入 ${data.glossaryCount} 个词条` : '尚未导入本地词表';
} catch (error) { status(error.message, true); }

// 词典面板：导入状态、进度、取消与索引管理；状态行复用底部 #status
mountDictionaryPanel(document.querySelector('#mdx-root'), {
  onStatusChange: (text, isError) => status(text, Boolean(isError))
});

$('#add-provider').onclick = () => {
  stashActiveProvider();
  const id = 'custom_' + crypto.randomUUID();
  providerDrafts[id] = { label: '自定义 API', kind: 'chat', baseUrl: '', model: '', key: '' };
  const option = new Option('自定义 API', id);
  $('#model-provider').add(option); $('#model-provider').value = id; showProvider(id);
};
$('#delete-provider').onclick = () => {
  const id = activeProvider();
  if (PROVIDERS[id] || !confirm('删除此自定义配置？点击保存后生效。')) return;
  delete providerDrafts[id]; $('#model-provider').selectedOptions[0].remove();
  showProvider(activeProvider());
};
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export-backup').onclick = async () => {
  try { download(await send('BACKUP', { payload: { op: 'export' } }), 'babel-tower-backup.json'); status('备份已导出，不含密钥和 MDX 词典。'); }
  catch (error) { status(error.message, true); }
};
let importArchive;
$('#import-backup').onchange = async event => {
  $('#confirm-import').hidden = true; importArchive = null;
  try {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 40_000_000) throw new Error('备份文件超过 40 MB。');
    const archive = JSON.parse(await file.text());
    const counts = await send('BACKUP', { payload: { op: 'preview', archive } });
    importArchive = archive;
    $('#backup-preview').textContent = '将合并：' + counts.sessions + ' 个帖子会话、' + counts.cards + ' 条收藏、' + counts.phrases + ' 条常用表达。导入 ' + counts.imported
      + ' 项、跳过 ' + counts.skipped + ' 项、另存 ' + counts.extra + ' 项。冲突内容另存，不删除原记录。MDX 需重新导入，密钥不迁移。'
      + (counts.unsupported?.length ? ' 备份里的 ' + counts.unsupported.join('、') + ' 属于已不再支持的功能，未导入。' : '');
    $('#confirm-import').hidden = false;
  } catch (error) { status(error.message, true); }
};
$('#confirm-import').onclick = async () => {
  if (!importArchive) return;
  $('#confirm-import').disabled = true;
  try {
    const result = await send('BACKUP', { payload: { op: 'import', archive: importArchive } });
    status('数据已合并：导入 ' + result.imported + ' 项、跳过 ' + result.skipped + ' 项、另存 ' + result.extra
      + ' 项。' + result.dictionary + ' 请刷新设置页查看导入的配置。');
    importArchive = null; $('#confirm-import').hidden = true; await listSessions();
  } catch (error) { status(error.message, true); }
  finally { $('#confirm-import').disabled = false; }
};
// ---------- 历史记录：摘要 / 搜索 / 最近 20 条 / 原帖链接 / 冲突可见 ----------
const SESSION_PAGE = 20;
let sessionRows = [];
let sessionQuery = '';
let sessionLimit = SESSION_PAGE;

function sessionSummary(item) {
  const data = item?.data || {};
  const parts = [data.draft, data.selected, data.reply, data.draftNote,
    data.readingInput && typeof data.readingInput.manualText === 'string' ? data.readingInput.manualText : '']
    .filter(value => typeof value === 'string' && value.trim());
  return parts.map(value => value.trim().replace(/\s+/g, ' ')).join(' · ').slice(0, 160) || '（没有可展示的草稿正文）';
}
function sessionHref(item) {
  const match = /^post:(\d+)$/.exec(item?.key || '') || /^post:(\d+)$/.exec(item?.sourceKey || '');
  return match ? 'https://x.com/i/status/' + match[1] : '';
}
function sessionMatches(item, query) {
  if (!query) return true;
  const haystack = [item.key, item.sourceKey || '', sessionSummary(item), JSON.stringify(item.data || {})].join('\n').toLowerCase();
  return haystack.includes(query);
}
function sessionCard(item) {
  const row = document.createElement('div'); row.className = 'session-item';
  const label = document.createElement('b');
  label.textContent = (item.sourceKey ? '冲突副本 · ' + item.sourceKey : item.key) + ' · ' + new Date(item.updatedAt).toLocaleString();
  const summary = document.createElement('p'); summary.className = 'session-summary'; summary.textContent = sessionSummary(item);
  row.append(label, summary);
  const href = sessionHref(item);
  if (href) {
    const link = document.createElement('a');
    link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '原帖 ↗';
    row.append(link);
  }
  const draft = typeof item.data?.draft === 'string' ? item.data.draft : '';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制草稿'; copy.disabled = !draft;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(draft); status('草稿已复制到剪贴板。'); }
    catch (error) { status('复制失败：' + error.message, true); }
  };
  row.append(copy);
  // 原始 JSON 折叠为技术详情，默认收起，不占版面也不泄露到摘要里。
  const preview = document.createElement('details'), summaryTag = document.createElement('summary'), text = document.createElement('pre');
  summaryTag.textContent = '技术详情'; text.textContent = JSON.stringify(item.data, null, 2); preview.append(summaryTag, text);
  row.append(preview);
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除此记录';
  remove.onclick = async () => {
    if (!confirm('删除此记录？此操作不可撤销，建议先导出备份。')) return;
    try { await send('SESSION', { payload: { op: 'remove', key: item.key } }); await listSessions(); }
    catch (error) { status(error.message, true); }
  };
  row.append(remove);
  return row;
}
function renderSessions() {
  const root = $('#session-list'); root.replaceChildren();
  const matched = sessionRows.filter(item => sessionMatches(item, sessionQuery));
  if (!matched.length) {
    root.textContent = sessionRows.length ? '没有匹配的记录。' : '尚无保存的帖子会话。';
    return;
  }
  const visible = matched.slice(0, sessionLimit);
  for (const item of visible) root.append(sessionCard(item));
  if (matched.length > visible.length) {
    const more = document.createElement('button'); more.type = 'button'; more.textContent = '显示更多';
    more.onclick = () => { sessionLimit += SESSION_PAGE; renderSessions(); };
    root.append(more);
  }
}
async function listSessions() {
  try {
    const sessions = await send('SESSION', { payload: { op: 'list' } });
    sessionRows = sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderSessions();
  } catch (error) { status(error.message, true); }
}
const sessionSearch = $('#session-search');
sessionSearch.addEventListener('input', () => {
  sessionQuery = sessionSearch.value.trim().toLowerCase();
  sessionLimit = SESSION_PAGE;
  renderSessions();
});
$('#refresh-sessions').onclick = listSessions;
listSessions();
