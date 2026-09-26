import { DEFAULT_SETTINGS, PROVIDERS, PROVIDER_IDS, parseGlossary, normalizeBaseUrl, permissionOrigin } from './shared.js';
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
let rules = [];
// provider drafts hold form state per provider so switching tabs never loses input
const providerDrafts = {};
let loadedSettings;
let initialData;

function status(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}
function switchTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== tab);
  status('');
  if (tab === 'saved') loadSaved();
  if (tab === 'filters') refreshJevDiagnostics();
}
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));

function renderRules() {
  $('#rules').innerHTML = rules.length ? rules.map((rule, index) => `<div class="rule"><input type="checkbox" data-rule-enabled="${index}" ${rule.enabled ? 'checked' : ''} aria-label="启用此规则"><input type="text" data-rule-text="${index}" value="${esc(rule.text)}" placeholder="描述想折叠的帖子" maxlength="180"><button data-rule-delete="${index}" aria-label="删除规则">×</button></div>`).join('') : '<p class="hint">还没有规则。点击“添加”，用一句话描述想折叠的内容。</p>';
  document.querySelectorAll('[data-rule-enabled]').forEach(input => input.onchange = () => { rules[Number(input.dataset.ruleEnabled)].enabled = input.checked; });
  document.querySelectorAll('[data-rule-text]').forEach(input => input.oninput = () => { rules[Number(input.dataset.ruleText)].text = input.value; });
  document.querySelectorAll('[data-rule-delete]').forEach(button => button.onclick = () => { rules.splice(Number(button.dataset.ruleDelete), 1); renderRules(); });
}
$('#add-rule').onclick = () => {
  if (rules.length >= 8) { status('最多添加 8 条规则。', true); return; }
  rules.push({ id: crypto.randomUUID(), text: '', enabled: true }); renderRules();
  document.querySelector('[data-rule-text]:last-of-type')?.focus();
};
$('#filter-threshold').oninput = () => { $('#threshold-label').textContent = `${$('#filter-threshold').value}%`; };

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

async function ensureOrigin(baseUrl) {
  const origin = permissionOrigin(baseUrl); // throws explicit error on bad url
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`未授予 ${origin} 的网络访问权限，无法连接。请允许后重试。`);
}

$('#test-model').onclick = async () => {
  const button = $('#test-model');
  const result = $('#test-result');
  stashActiveProvider();
  const id = activeProvider();
  const draft = providerDrafts[id];
  button.disabled = true;
  result.textContent = '测试中……';
  result.classList.remove('error', 'ok');
  try {
    ensureOriginSyncCheck(draft.baseUrl);
    await ensureOrigin(draft.baseUrl);
    const data = await send('TEST_MODEL', { payload: { provider: id, label: draft.label, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model, key: draft.key } });
    result.textContent = data.message;
    result.classList.add('ok');
  } catch (error) {
    result.textContent = error.message;
    result.classList.add('error');
  } finally {
    button.disabled = false;
  }
};

function ensureOriginSyncCheck(baseUrl) {
  // surface empty/malformed url before requesting permissions
  normalizeBaseUrl(baseUrl || PROVIDERS[activeProvider()]?.baseUrl);
}

// ---------- Jev diagnostics ----------

async function refreshJevDiagnostics() {
  const box = $('#jev-diagnostics');
  try {
    const data = await send('JEV_STATUS');
    const s = data.stats || {};
    const stateLabel = { disabled: '未开启', no_key: '缺 Jev 密钥', limited: '今日已达上限', ok: '已开启' }[data.state] || (data.enabled ? '已开启' : '未开启');
    const judged = s.judged ?? 0;
    const parts = [
      `状态：${stateLabel}`,
      `今日 API 请求 ${data.used}/${data.dailyLimit}（实际发出的请求，含重试）`,
      `已判断 ${judged} · 未命中 ${Math.max(0, judged - (s.collapsed ?? 0))}`,
      `命中折叠 ${s.collapsed ?? 0}`,
      `跳过 ${s.skipped ?? 0}`,
      `缓存命中 ${s.cached ?? 0}（缓存 ${data.cacheCount} 条）`,
      `失败 ${s.failed ?? 0}`,
      `达上限 ${s.limited ?? 0}`
    ];
    box.innerHTML = `<p class="hint">${parts.join(' · ')}</p>${s.lastError ? `<p class="hint" style="color:#a05240">最近错误：${esc(s.lastError)}</p>` : ''}<p class="hint">命中只折叠并可展开；失败会自动重试 2 次，仍失败的帖子标记为失败并计入此处。每日上限按实际 API 请求数硬性封顶。</p>`;
  } catch (error) { box.innerHTML = `<p class="hint" style="color:#a05240">${esc(error.message)}</p>`; }
}
$('#refresh-jev').onclick = refreshJevDiagnostics;

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
    targetLanguage: $('#target-language').value,
    jevKey: $('#jev-key').value.trim(),
    filterEnabled: $('#filter-enabled').checked,
    filterRules: rules,
    filterThreshold: Number($('#filter-threshold').value) / 100,
    filterDailyLimit: Number($('#filter-limit').value)
  };
}
async function saveSettings() {
  try {
    const payload = await settingsPayload();
    if (payload.filterEnabled && (!payload.jevKey || !payload.filterRules.some(rule => rule.enabled && rule.text.trim()))) throw new Error('开启筛选前，请填写 Jev Key 并启用至少一条规则。');
    const active = payload.providers[payload.modelProvider];
    if (active?.baseUrl) await ensureOrigin(active.baseUrl);
    await send('SAVE_SETTINGS', { payload }); $('#active-config').textContent = '当前使用：' + payload.providers[payload.modelProvider].label; status('已保存。已打开的 X 页面会立即应用新的筛选与写作设置。');
    refreshJevDiagnostics();
  } catch (error) { status(error.message, true); }
}
$('#save-main').onclick = saveSettings;
$('#save-filter').onclick = saveSettings;

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
  loadedSettings = settings; initialData = data;
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
  $('#jev-key').value = data.jevKey || '';
  $('#filter-enabled').checked = Boolean(settings.filterEnabled);
  $('#filter-threshold').value = Math.round((settings.filterThreshold ?? DEFAULT_SETTINGS.filterThreshold) * 100);
  $('#threshold-label').textContent = `${$('#filter-threshold').value}%`;
  $('#filter-limit').value = settings.filterDailyLimit || 80;
  rules = Array.isArray(settings.filterRules) ? settings.filterRules.map(rule => ({ ...rule })) : [];
  renderRules();
  $('#glossary-count').textContent = data.glossaryCount ? `已导入 ${data.glossaryCount} 个词条` : '尚未导入本地词表';
  refreshJevDiagnostics();
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
    $('#backup-preview').textContent = '将合并：' + counts.sessions + ' 个帖子会话、' + counts.drafts + ' 份写作草稿、' + counts.cards + ' 条收藏、' + counts.memories + ' 条学习记录。冲突内容另存，不删除原记录。MDX 需重新导入，密钥不迁移。';
    $('#confirm-import').hidden = false;
  } catch (error) { status(error.message, true); }
};
$('#confirm-import').onclick = async () => {
  if (!importArchive) return;
  $('#confirm-import').disabled = true;
  try {
    const result = await send('BACKUP', { payload: { op: 'import', archive: importArchive } });
    status('数据已合并。' + result.dictionary + ' 请刷新设置页查看导入的配置。');
    importArchive = null; $('#confirm-import').hidden = true; await listSessions();
  } catch (error) { status(error.message, true); }
  finally { $('#confirm-import').disabled = false; }
};
async function listSessions() {
  try {
    const sessions = await send('SESSION', { payload: { op: 'list' } });
    const root = $('#session-list'); root.replaceChildren();
    for (const item of sessions.sort((a,b) => b.updatedAt - a.updatedAt)) {
      const row = document.createElement('div'); row.className = 'session-item';
      const label = document.createElement('b'); label.textContent = (item.sourceKey ? '冲突副本 · ' + item.sourceKey : item.key) + ' · ' + new Date(item.updatedAt).toLocaleString();
      const preview = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('pre');
      summary.textContent = '查看保存的内容'; text.textContent = JSON.stringify(item.data, null, 2); preview.append(summary, text);
      const remove = document.createElement('button'); remove.textContent = '删除此记录';
      remove.onclick = async () => { if (!confirm('删除此记录？建议先导出备份。')) return; try { await send('SESSION', { payload: { op: 'remove', key: item.key } }); await listSessions(); } catch (error) { status(error.message, true); } };
      row.append(label, preview, remove); root.append(row);
    }
    if (!sessions.length) root.textContent = '尚无保存的帖子会话。';
  } catch (error) { status(error.message, true); }
}
$('#refresh-sessions').onclick = listSessions;
listSessions();
