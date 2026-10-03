import { markdownFilename, markdownTitle, renderMarkdown } from './markdown.js';

const $ = selector => document.querySelector(selector);
// Small windows keep the editor usable; drawers never recreate the document or chat.
const shell = $('.app-shell');
function setPane(pane, open) {
  shell.classList.toggle(`${pane}-open`, open);
  document.querySelector(`[data-pane="${pane}"]`).setAttribute('aria-expanded', String(open));
}
document.querySelectorAll('[data-pane]').forEach(button => {
  button.onclick = () => {
    const pane = button.dataset.pane;
    const open = !shell.classList.contains(`${pane}-open`);
    if (matchMedia('(max-width:760px)').matches) setPane(pane === 'agent' ? 'library' : 'agent', false);
    setPane(pane, open);
  };
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing) return;
  for (const pane of ['library', 'agent']) {
    if (!shell.classList.contains(`${pane}-open`)) continue;
    setPane(pane, false);
    document.querySelector(`[data-pane="${pane}"]`).focus();
  }
});
new ResizeObserver(() => {
  shell.style.setProperty('--desk-top-height', `${$('.topbar').getBoundingClientRect().height}px`);
}).observe($('.topbar'));
const send = (action, payload = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ action, ...payload }, response => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!response?.ok) return reject(new Error(response?.error || '操作失败，请重试。'));
    resolve(response.data);
  });
});
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

const state = {
  document: null,
  documents: [],
  folders: ['我的文章', '参考文章'],
  agentSessionId: crypto.randomUUID(),
  agentMessages: [],
  lastAnswer: '',
  lastSelection: { start: 0, end: 0 },
  busy: false,
  saveTimer: 0,
  toastTimer: 0
};

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
}

function setSaveState(text) {
  $('#save-state').textContent = text;
  $('#retry-save').hidden = text !== '保存失败';
}

function currentContent() {
  return $('#markdown-editor').value;
}

function currentTitle() {
  return $('#doc-title').value.trim() || markdownTitle(currentContent()) || '未命名文稿';
}

function updateEditorMeta() {
  const content = currentContent();
  $('#markdown-preview').innerHTML = renderMarkdown(content, { allowImages: $('#load-images').checked });
  $('#word-count').textContent = `${content.replace(/\s/g, '').length} 字`;
  $('#document-context-detail').textContent = `全文 · ${content.length} 字${content.length > 20000 ? '（超过发送上限 20000，请改选短段落）' : ''}`;
  updateContextCount();
}

function updateSelectionMeta() {
  const editor = $('#markdown-editor');
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
  $('#selection-context-detail').textContent = selected ? `${selected.length} 字 · ${selected.slice(0, 24)}` : '未选择文字；勾选后请在编辑器中选取';
  updateContextCount();
}

function updateContextCount() {
  let count = 0;
  if ($('#context-document').checked && currentContent().trim()) count += 1;
  if ($('#context-selection').checked && $('#markdown-editor').selectionEnd > $('#markdown-editor').selectionStart) count += 1;
  if ($('#context-notes').checked && $('#context-notes-text').value.trim()) count += 1;
  $('#context-count').textContent = `${count} 条上下文`;
}

function scheduleSave() {
  setSaveState('保存中…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrent().catch(error => toast(error.message, true)), 650);
}

let saveQueue = Promise.resolve();
function saveCurrent() {
  const result = saveQueue.then(persistCurrent);
  saveQueue = result.catch(() => {});
  return result;
}

async function persistCurrent() {
  if (!state.document) return;
  clearTimeout(state.saveTimer);
  const payload = { id: state.document.id, expectedRevision: state.document.revision || 0, title: currentTitle(), content: currentContent(), folder: state.document.folder, kind: state.document.kind, sourceUrl: state.document.sourceUrl };
  setSaveState('保存中…');
  let saved;
  try { saved = await send('SAVE_DOCUMENT', { payload }); }
  catch (error) {
    if (state.document?.id === payload.id) setSaveState('保存失败');
    throw error;
  }
  // A late save must not overwrite edits made during storage I/O or another document.
  if (state.document?.id === payload.id) {
    const unchanged = currentTitle() === payload.title && currentContent() === payload.content;
    state.document = saved;
    if (saved.id !== payload.id) {
      if (currentTitle() === payload.title) $('#doc-title').value = saved.title;
      history.replaceState(null, '', `?doc=${encodeURIComponent(saved.id)}`);
      state.agentSessionId = `doc:${saved.id}`;
      state.agentMessages = [];
      state.lastAnswer = '';
      renderAgentThread();
      toast('另一窗口已修改这份文稿，你的内容已另存冲突副本。');
    }
    if (unchanged) setSaveState('已保存');
  }
  await loadDocumentList(false);
}

async function loadDocumentList(render = true) {
  state.documents = await send('LIST_DOCUMENTS');
  if (render) renderDocumentList(); else renderDocumentList();
}

function renderDocumentList() {
  const list = $('#document-list');
  const query = $('#library-search').value.trim().toLowerCase();
  const rows = state.documents.filter(item => !query || `${item.title} ${item.excerpt} ${item.folder}`.toLowerCase().includes(query));
  const folders = [...new Set([...state.folders, ...rows.map(item => item.folder || (item.kind === 'reference' ? '参考文章' : '我的文章'))])];
  list.innerHTML = folders.map(folder => {
    const items = rows.filter(item => (item.folder || (item.kind === 'reference' ? '参考文章' : '我的文章')) === folder);
    if (query && !items.length) return '';
    return `<details class="folder-group" open><summary>▸ ${escapeHTML(folder)} <small>${items.length}</small></summary>${items.map(document => `<button class="document-card ${document.id === state.document?.id ? 'active' : ''}" data-document-id="${escapeHTML(document.id)}"><b>${document.kind === 'reference' ? '▤ ' : '✎ '}${escapeHTML(document.title)}</b><span>${escapeHTML(document.excerpt || '空白文稿')}</span><small>${new Date(document.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric' })} · ${document.size || 0} 字符</small></button>`).join('')}</details>`;
  }).join('') || '<div class="library-empty">没有找到文稿。</div>';
  list.querySelectorAll('[data-document-id]').forEach(button => button.onclick = () => openDocument(button.dataset.documentId));
}

async function loadAgentForDocument(documentId) {
  state.agentSessionId = `doc:${documentId}`;
  state.agentMessages = [];
  state.lastAnswer = '';
  state.lastSelection = { start: 0, end: 0 };
  try {
    const sessions = await send('LIST_AGENT_SESSIONS');
    const session = sessions.find(item => item.id === state.agentSessionId);
    if (session) state.agentMessages = session.messages || [];
  } catch { /* 文稿仍可离线编辑。 */ }
  renderAgentThread();
}

async function openDocument(id) {
  if (state.document?.id === id) return true;
  if (state.busy) { toast('请等待本轮 Agent 完成后切换文稿。', true); return false; }
  if (state.document) await saveCurrent();
  const document = await send('GET_DOCUMENT', { id });
  if (!document) { toast('这份文稿已不存在，已打开最近文稿。', true); return false; }
  state.document = document;
  $('#doc-title').value = document.title;
  $('#markdown-editor').value = document.content;
  updateEditorMeta();
  updateSelectionMeta();
  renderDocumentList();
  await loadAgentForDocument(document.id);
  history.replaceState(null, '', `?doc=${encodeURIComponent(document.id)}`);
  $('#markdown-editor').focus();
  return true;
}

async function createDocument(template = '', kind = 'draft') {
  if (state.busy) return toast('请等待本轮 Agent 完成后新建文稿。', true);
  if (state.document) await saveCurrent();
  const document = await send('SAVE_DOCUMENT', { payload: { title: kind === 'reference' ? '新参考文章' : template ? '快速笔记' : '未命名文稿', content: template, kind, folder: kind === 'reference' ? '参考文章' : '我的文章' } });
  state.document = document;
  $('#doc-title').value = document.title;
  $('#markdown-editor').value = document.content;
  updateEditorMeta();
  updateSelectionMeta();
  await loadAgentForDocument(document.id);
  await loadDocumentList();
  history.replaceState(null, '', `?doc=${encodeURIComponent(document.id)}`);
  $('#markdown-editor').focus();
}

async function deleteCurrentDocument() {
  if (!state.document || state.busy) return;
  if (!window.confirm(`删除“${currentTitle()}”？此操作只删除插件本地文稿。`)) return;
  clearTimeout(state.saveTimer);
  await send('DELETE_DOCUMENT', { id: state.document.id });
  state.document = null;
  const remaining = await send('LIST_DOCUMENTS');
  state.documents = remaining;
  if (remaining[0]) await openDocument(remaining[0].id); else await createDocument('# 新文稿\n\n');
  toast('文稿已删除。');
}

function setView(view) {
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#editor-layout').className = `editor-layout view-${view}`;
}

async function refreshAgentStatus() {
  const card = $('#agent-runtime');
  card.classList.remove('ready');
  card.querySelector('b').textContent = '正在检测…';
  card.querySelector('small').textContent = '连接开源模型运行时';
  const result = await send('AGENT_STATUS');
  card.classList.toggle('ready', result.ready);
  card.querySelector('b').textContent = result.label;
  card.querySelector('small').textContent = result.detail;
  $('#agent-hint').textContent = result.ready ? '结果返回后可插入、替换或追加' : '运行时未就绪；可在插件设置中切换或配置';
}

function agentContext() {
  const editor = $('#markdown-editor');
  const items = [];
  if ($('#context-document').checked && editor.value.trim()) items.push({ label: `当前文稿：${currentTitle()}`, content: editor.value });
  if ($('#context-selection').checked) {
    const selection = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
    if (selection) items.push({ label: '当前选区', content: selection });
  }
  if ($('#context-notes').checked && $('#context-notes-text').value.trim()) items.push({ label: '临时要求', content: $('#context-notes-text').value.trim() });
  return items;
}

function renderAgentThread() {
  const thread = $('#agent-thread');
  if (!state.agentMessages.length) {
    thread.innerHTML = '<div class="thread-empty"><b>先写，再让 Agent 进入。</b><span>发送指令、勾选材料及本会话历史，不会发布任何内容。</span></div>';
    $('#agent-output-actions').hidden = true;
    return;
  }
  thread.innerHTML = state.agentMessages.slice(-10).map(message => `<article class="thread-message ${message.role}"><small>${message.role === 'assistant' ? 'Agent' : '你'}${message.contextLabels?.length ? ` · ${message.contextLabels.map(escapeHTML).join(' / ')}` : ''}</small>${escapeHTML(message.content)}</article>`).join('');
  thread.scrollTop = thread.scrollHeight;
  state.lastAnswer = [...state.agentMessages].reverse().find(message => message.role === 'assistant')?.content || '';
  $('#agent-output-actions').hidden = !state.lastAnswer;
}

async function askAgent() {
  const prompt = $('#agent-prompt').value.trim();
  const sourceDocument = state.document?.id;
  if (!prompt || state.busy) return;
  const editor = $('#markdown-editor');
  state.lastSelection = { start: editor.selectionStart, end: editor.selectionEnd };
  state.busy = true;
  $('#agent-send').disabled = true;
  $('#agent-send').textContent = '写作中…';
  $('#agent-hint').textContent = 'Agent 正在处理已勾选的上下文';
  try {
    const result = await send('AGENT_CHAT', { payload: { sessionId: state.agentSessionId, message: prompt, context: agentContext() } });
    if (state.document?.id !== sourceDocument) return;
    state.agentSessionId = result.session.id;
    state.agentMessages = result.session.messages || [];
    if ($('#agent-prompt').value.trim() === prompt) $('#agent-prompt').value = '';
    renderAgentThread();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    $('#agent-send').textContent = '发送';
    $('#agent-send').disabled = !$('#agent-prompt').value.trim();
    $('#agent-hint').textContent = '结果返回后可插入、替换或追加';
  }
}

function applyAgentAnswer(mode) {
  if (!state.lastAnswer) return;
  const editor = $('#markdown-editor');
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  let insertion = state.lastAnswer;
  if (mode === 'replace-selection' && end <= start) {
    toast('先在编辑器里选中要替换的文字。', true);
    editor.focus();
    return;
  }
  if (mode === 'append') {
    start = editor.value.length; end = start;
    insertion = `${editor.value.trim() ? '\n\n' : ''}${state.lastAnswer}\n`;
  }
  editor.focus();
  editor.setSelectionRange(start, end);
  const inserted = document.execCommand('insertText', false, insertion);
  if (!inserted) editor.setRangeText(insertion, start, end, 'end');
  updateEditorMeta();
  updateSelectionMeta();
  scheduleSave();
  toast(mode === 'replace-selection' ? '已替换当前选区，可按 Ctrl+Z 撤销。' : mode === 'cursor' ? '已插入光标位置，可按 Ctrl+Z 撤销。' : '已追加到文末，可按 Ctrl+Z 撤销。');
}

async function resetAgent() {
  if (state.busy) return;
  if (state.agentMessages.length && !window.confirm('开始新的 Agent 会话？当前文稿不会受影响。')) return;
  await send('RESET_AGENT_SESSION', { sessionId: state.agentSessionId });
  state.agentMessages = [];
  state.lastAnswer = '';
  renderAgentThread();
}

$('#markdown-editor').addEventListener('input', () => { updateEditorMeta(); updateSelectionMeta(); scheduleSave(); });
$('#markdown-editor').addEventListener('select', updateSelectionMeta);
$('#markdown-editor').addEventListener('keyup', updateSelectionMeta);
$('#markdown-editor').addEventListener('mouseup', updateSelectionMeta);
$('#doc-title').addEventListener('input', scheduleSave);
$('#new-document').onclick = () => createDocument();
$('#quick-note').onclick = () => createDocument('# 快速笔记\n\n');
$('#new-reference').onclick = async () => {
  try {
    const content = await navigator.clipboard.readText();
    if (!content.trim()) return toast('剪贴板没有文章文字。', true);
    await createDocument(content, 'reference');
    toast('参考文章已保存，可以移动到文件夹。');
  } catch (error) { toast(`读取剪贴板失败：${error.message}`, true); }
};
$('#new-folder').onclick = async () => {
  const name = window.prompt('文件夹名称（可用 / 建立层级）')?.trim();
  if (!name || name.length > 100 || name.includes('..')) return;
  state.folders = [...new Set([...state.folders, name])];
  await chrome.storage.local.set({ documentFolders: state.folders });
  renderDocumentList();
};
$('#move-document').onclick = async () => {
  if (!state.document) return;
  const folder = window.prompt('移动到哪个文件夹？', state.document.folder || '我的文章')?.trim();
  if (!folder || folder.length > 100 || folder.includes('..')) return;
  state.document.folder = folder;
  state.folders = [...new Set([...state.folders, folder])];
  await chrome.storage.local.set({ documentFolders: state.folders });
  await saveCurrent();
  renderDocumentList();
};
$('#library-search').addEventListener('input', renderDocumentList);
$('#load-images').onchange = updateEditorMeta;
$('#retry-save').onclick = () => saveCurrent().catch(error => toast(error.message, true));
document.addEventListener('keydown', event => {
  if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  saveCurrent().catch(error => toast(error.message, true));
});
$('#delete-document').onclick = deleteCurrentDocument;
$('#copy-markdown').onclick = async () => {
  try { await navigator.clipboard.writeText(currentContent()); toast('Markdown 已复制。'); }
  catch { toast('复制失败，请在编辑区手动全选。', true); }
};
$('#download-markdown').onclick = () => {
  const url = URL.createObjectURL(new Blob([currentContent()], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = markdownFilename(currentTitle());
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('已开始下载当前编辑内容。');
};
$('#copy-rich-x').onclick = async () => {
  try {
    const html = `<article>${renderMarkdown(currentContent(), { allowImages: true })}</article>`;
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([currentContent()], { type: 'text/plain' })
    })]);
    window.open('https://x.com/compose/articles', '_blank', 'noopener');
    toast('已复制富文本；在 X 文章编辑器中粘贴并检查排版。');
  } catch (error) { toast(`复制排版失败：${error.message}`, true); }
};
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
['#context-document', '#context-selection', '#context-notes'].forEach(selector => $(selector).onchange = () => {
  if (selector === '#context-notes') $('#context-notes-text').hidden = !$('#context-notes').checked;
  updateContextCount();
});
$('#context-notes-text').addEventListener('input', updateContextCount);
document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => {
  if (button.dataset.context === 'selection') {
    const editor = $('#markdown-editor');
    if (editor.selectionEnd <= editor.selectionStart) return toast('先在编辑器里选中要改写的文字。', true);
    $('#context-selection').checked = true;
  }
  if (button.dataset.context === 'document') $('#context-document').checked = true;
  updateContextCount();
  $('#agent-prompt').value = button.dataset.prompt;
  $('#agent-send').disabled = false;
  $('#agent-prompt').focus();
});
$('#agent-prompt').addEventListener('input', () => { $('#agent-send').disabled = !$('#agent-prompt').value.trim() || state.busy; });
$('#agent-prompt').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); askAgent(); }
});
$('#agent-send').onclick = askAgent;
$('#agent-reset').onclick = resetAgent;
$('#agent-refresh').onclick = () => refreshAgentStatus().catch(error => toast(error.message, true));
document.querySelectorAll('[data-apply]').forEach(button => button.onclick = () => applyAgentAnswer(button.dataset.apply));
window.addEventListener('beforeunload', () => { if (state.document) saveCurrent().catch(() => {}); });
chrome.runtime.onMessage?.addListener((message, sender, respond) => {
  if (message?.action !== 'WRITE_DESK_OPEN_DOC') return false;
  openDocument(message.id).then(ok => respond({ ok })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

try {
  state.folders = [...new Set([...state.folders, ...((await chrome.storage.local.get('documentFolders')).documentFolders || [])])];
  await loadDocumentList();
  const requested = new URLSearchParams(location.search).get('doc');
  let opened = false;
  if (requested) opened = await openDocument(requested);
  if (!opened && state.documents[0]) opened = await openDocument(state.documents[0].id);
  if (!opened) await createDocument('# 新文稿\n\n从一个明确判断开始。');
  await refreshAgentStatus();
  document.body.dataset.ready = '1';
} catch (error) {
  document.body.dataset.ready = 'error';
  $('#markdown-editor').disabled = true;
  $('#markdown-editor').placeholder = '文稿没有成功加载，请刷新页面重试。';
  $('#markdown-preview').innerHTML = '<p>文稿没有成功加载。请刷新页面；若仍失败，请检查扩展存储权限。</p>';
  setSaveState('加载失败');
  toast(error.message, true);
}
