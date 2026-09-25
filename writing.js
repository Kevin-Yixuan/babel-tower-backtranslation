// 长度上限由 background（assertTextLimit，20,000）强制；此处只做展示与提交前提示，不裁剪用户输入。
// 当前没有自动分段：超限请自行拆分后分次提交（UI 与后台都会明确报错）。
const MAX_WRITE_LEN = 20000;
const MAX_CONTEXT_LEN = 2200;
const MAX_WRITING_DRAFTS = 20;

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const send = (action, payload = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ action, ...payload }, response => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!response?.ok) return reject(new Error(response?.error || '操作失败，请重试。'));
    resolve(response.data);
  });
});

const STORAGE_KEY = 'writingDrafts';
let drafts = [];
let currentId = '';
let saveTimer = null;
let statusTimer = null;
let busy = false;
let workSeq = 0; // 在途请求序号：取消/切稿/清空后旧响应一律丢弃

function newDraft() {
  return { id: crypto.randomUUID(), title: '', body: '', reference: '', authoredByUser: false, feedback: null, learned: null, updatedAt: new Date().toISOString() };
}
const current = () => drafts.find(draft => draft.id === currentId) || drafts[0];

function status(message, isError = false) {
  const el = $('#w-status');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.toggle('show', Boolean(message));
  clearTimeout(statusTimer);
  if (message) statusTimer = setTimeout(() => el.classList.remove('show'), isError ? 7000 : 4200);
}
function saveState(text, dirty = false) {
  const el = $('#w-save-state');
  el.textContent = text;
  el.classList.toggle('dirty', dirty);
  el.classList.toggle('error', text.includes('失败'));
}
function updateCounts() {
  const body = $('#w-body').value.length;
  const ref = $('#w-reference').value.length;
  $('#w-body-count').textContent = `${body.toLocaleString('zh-CN')} / ${MAX_WRITE_LEN.toLocaleString('zh-CN')}`;
  $('#w-ref-count').textContent = `${ref.toLocaleString('zh-CN')} / ${MAX_WRITE_LEN.toLocaleString('zh-CN')}`;
  $('#w-body-count').classList.toggle('over', body > MAX_WRITE_LEN);
  $('#w-ref-count').classList.toggle('over', ref > MAX_WRITE_LEN);
  // 超限不禁用按钮：点击时抛出含实际长度与上限的明确错误，避免“点了没反应”。
  $('#w-check').disabled = !$('#w-body').value.trim() || busy;
  $('#w-learn').disabled = !$('#w-reference').value.trim() || busy;
  $('#w-new').disabled = busy;
  if (body > MAX_WRITE_LEN || ref > MAX_WRITE_LEN) {
    const over = body > MAX_WRITE_LEN ? `正文 ${body}` : `参考材料 ${ref}`;
    status(`${over} 字符，超过上限 ${MAX_WRITE_LEN} 字符。当前没有自动分段，请拆分后分次提交；插件不会静默截断。`, true);
  }
}
function renderList() {
  $('#w-draft-count').textContent = `${drafts.length}/${MAX_WRITING_DRAFTS}`;
  $('#w-draft-list').innerHTML = drafts.map(draft => `<li><button type="button" data-draft="${esc(draft.id)}" class="${draft.id === currentId ? 'active' : ''}"><b>${esc(draft.title || '未命名草稿')}</b><small>${new Date(draft.updatedAt).toLocaleString('zh-CN')} · ${draft.body.length.toLocaleString('zh-CN')} 字符</small></button><button type="button" class="w-del" data-del-draft="${esc(draft.id)}" aria-label="删除此草稿" title="删除此草稿">×</button></li>`).join('');
  $('#w-draft-list').querySelectorAll('[data-draft]').forEach(button => {
    button.onclick = () => { flushSave(); currentId = button.dataset.draft; fillForm(); renderList(); };
  });
  $('#w-draft-list').querySelectorAll('[data-del-draft]').forEach(button => {
    button.onclick = async () => {
      const id = button.dataset.delDraft;
      const draft = drafts.find(item => item.id === id);
      if (!draft) return;
      const label = draft.title || draft.body.slice(0, 20) || '未命名草稿';
      if (!window.confirm(`确定删除草稿「${label}」？删除后无法恢复（可先导出备份）。`)) return;
      flushSave();
      drafts = drafts.filter(item => item.id !== id);
      if (currentId === id) {
        if (!drafts.length) drafts = [newDraft()];
        currentId = drafts[0].id;
        fillForm();
      }
      await persist();
      status('已删除 1 篇草稿。');
    };
  });
}
function fillForm() {
  const draft = current();
  $('#w-title').value = draft?.title || '';
  $('#w-body').value = draft?.body || '';
  $('#w-authored').checked = draft?.authoredByUser === true;
  $('#w-reference').value = draft?.reference || '';
  renderFeedback(draft?.feedback);
  renderLearned(draft?.learned);
  updateCounts();
}
function readFormInto(draft) {
  draft.title = $('#w-title').value;
  draft.body = $('#w-body').value;
  draft.authoredByUser = $('#w-authored').checked;
  draft.reference = $('#w-reference').value;
}
// 内容版本指纹：用于校验在途结果只能挂回“同一内容版本”的草稿。
const formVersion = () => JSON.stringify({ t: $('#w-title').value, b: $('#w-body').value, r: $('#w-reference').value });
const versionOf = draft => JSON.stringify({ t: draft.title || '', b: draft.body || '', r: draft.reference || '' });

async function persist({ silent = true } = {}) {
  const draft = current();
  if (!draft) return;
  readFormInto(draft);
  draft.updatedAt = new Date().toISOString();
  // 审计 W04：绝不 slice/静默丢弃任何草稿；满 20 篇由“新建”入口阻止，旧数据载入也不裁剪。
  drafts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: drafts });
    saveState(`已自动保存 · ${new Date().toLocaleTimeString('zh-CN')}`, false);
    if (!silent) status('草稿已保存。');
    renderList();
  } catch (error) {
    saveState('保存失败', true);
    status(`保存失败：${error.message}。请勿关闭页面，先删除部分草稿或检查浏览器存储后重试。`, true);
  }
}
function scheduleSave() {
  saveState('未保存的修改…', true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(), 700);
}
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  persist({ silent: true });
}
window.addEventListener('beforeunload', () => { if (saveTimer) { clearTimeout(saveTimer); persist({ silent: true }); } });
// 关闭标签页时 chrome.storage 写入可能被中断，页面隐藏时也落一次盘。
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

function renderLearned(expressions) {
  const box = $('#w-learn-results');
  if (!Array.isArray(expressions) || !expressions.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="w-label" style="margin-bottom:8px">可复用表达（点击存入收藏）</div>` + expressions.map((item, index) => `<article class="w-expr"><div><span class="w-tag">${item.kind === 'word' ? '词语' : item.kind === 'structure' ? '结构' : '句式'}</span><p>${esc(item.text)}</p><small>${esc(item.note)}</small></div><button type="button" data-save-expr="${index}">收藏</button></article>`).join('');
  box.querySelectorAll('[data-save-expr]').forEach(button => {
    button.onclick = async () => {
      const item = expressions[Number(button.dataset.saveExpr)];
      try {
        await send('SAVE_CARD', { payload: { text: item.text, note: item.note, kind: item.kind, author: '', url: '' } });
        status('已存入收藏，可在插件弹窗「收藏」里查看。');
        button.disabled = true;
        button.textContent = '已收藏';
      } catch (error) { status(error.message, true); }
    };
  });
}

function feedbackHTML(data) {
  const points = Array.isArray(data.points) ? data.points.slice(0, 3) : [];
  const meaningNote = data.meaningNote || data.summary || '';
  const grammarNote = data.grammarNote || '';
  return `<div class="w-feedback">
    <div class="w-layer"><div class="w-layer-title"><span class="w-layer-index">1</span>意思是否传达</div><p>${data.meaningOk ? '✅ 意思已传达' : '⚠️ 意思需要核对'}${meaningNote ? `：${esc(meaningNote)}` : ''}</p></div>
    <div class="w-layer"><div class="w-layer-title"><span class="w-layer-index">2</span>语法问题</div><p>${data.grammarOk ? '✅ 语法成立' : '⚠️ 语法需要修改'}${grammarNote ? `：${esc(grammarNote)}` : ''}</p></div>
    <div class="w-layer"><div class="w-layer-title"><span class="w-layer-index">3</span>表达润色</div>${points.length ? points.map(item => `<div class="w-point"><span class="w-kind ${esc(item.kind)}">${item.kind === 'fix' ? '需要修正' : item.kind === 'polish' ? '可以优化' : '值得保留'}</span><b>${esc(item.span)}</b><p>${esc(item.reason)}</p><small>${esc(item.direction)}</small></div>`).join('') : '<p>没有需要润色的点。</p>'}</div>
    ${data.summary ? `<p class="w-summary">总评：${esc(data.summary)}</p>` : ''}
  </div>`;
}
function renderFeedback(feedback) {
  const block = $('#w-feedback-block');
  if (!feedback) { block.hidden = true; $('#w-feedback').innerHTML = ''; return; }
  block.hidden = false;
  $('#w-feedback').innerHTML = feedbackHTML(feedback);
}

function assertLocalLimit(value, label) {
  if (value.length > MAX_WRITE_LEN) throw new Error(`${label}共 ${value.length} 字符，超过上限 ${MAX_WRITE_LEN} 字符。当前没有自动分段，请拆分后分次提交；插件不会静默截断。`);
}

// 把在途结果写回“发起请求时的那篇草稿 + 那个内容版本”；切稿/清空/改文后一律忽略。
function applyAsyncResult(draftId, version, mutate, display) {
  const draft = drafts.find(item => item.id === draftId);
  if (!draft) { status('草稿已不存在，本次结果已忽略。', true); return false; }
  const live = draftId === currentId ? formVersion() : versionOf(draft);
  if (live !== version) { status('内容已变化，本次结果已忽略，不会挂到新内容上。', true); return false; }
  mutate(draft);
  if (draftId === currentId && display) display(draft);
  persist();
  return true;
}

async function withBusy(button, work) {
  if (busy || button.disabled) return;
  busy = true;
  const seq = ++workSeq;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  $('#w-cancel').hidden = false;
  saveState('处理中，草稿已暂存…', true);
  flushSave();
  try { await work(seq); } catch (error) { if (seq === workSeq) status(error.message, true); }
  // 只有仍是“当前这趟请求”时才恢复 UI；被取消/被新请求取代的旧 promise 不得干扰新状态。
  if (seq === workSeq) {
    busy = false;
    button.textContent = previous;
    $('#w-cancel').hidden = true;
  }
  updateCounts();
}
function cancelWork() {
  workSeq += 1;
  busy = false;
  $('#w-cancel').hidden = true;
  document.querySelectorAll('#w-check, #w-learn, #w-new').forEach(button => { button.textContent = button.id === 'w-learn' ? '学习这篇文章的表达' : button.id === 'w-check' ? '分层反馈：检查我的写作' : '新建草稿'; });
  updateCounts();
  status('已取消；晚到的结果会被忽略，不会覆盖你的内容。');
}

function bind() {
  for (const id of ['#w-title', '#w-reference']) {
    $(id).addEventListener('input', () => { updateCounts(); scheduleSave(); });
  }
  $('#w-body').addEventListener('input', () => {
    $('#w-authored').checked = false;
    updateCounts(); scheduleSave();
  });
  $('#w-authored').addEventListener('change', scheduleSave);
  $('#w-cancel').onclick = cancelWork;
  $('#w-new').onclick = async () => {
    // 审计 W04：满 20 篇阻止新建，提示导出/删除；不静默删旧稿。
    if (drafts.length >= MAX_WRITING_DRAFTS) {
      status(`已达到 ${MAX_WRITING_DRAFTS} 篇上限，未新建。请先导出备份、再删除不需要的草稿，旧内容不会被自动丢弃。`, true);
      return;
    }
    flushSave();
    const draft = newDraft();
    drafts.unshift(draft);
    currentId = draft.id;
    fillForm();
    renderList();
    await persist();
    $('#w-body').focus();
    status('已新建空白草稿。');
  };
  $('#w-export').onclick = () => {
    flushSave();
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), drafts }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'backwrite-x-writing-drafts.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('已导出全部草稿为 JSON 备份。');
  };
  $('#w-clear').onclick = async () => {
    if (!window.confirm('确定清空当前草稿的标题、正文与参考文章？')) return;
    if (!window.confirm('再次确认：清空后本稿内容无法恢复（其他草稿不受影响）。')) return;
    workSeq += 1; // 使在途结果因版本变化/序号失效而忽略
    $('#w-title').value = '';
    $('#w-body').value = '';
    $('#w-authored').checked = false;
    $('#w-reference').value = '';
    const draft = current();
    if (draft) { draft.feedback = null; draft.learned = null; }
    renderFeedback(null);
    renderLearned(null);
    updateCounts();
    await persist();
    status('已清空当前草稿；未返回的旧请求结果将被忽略。');
  };
  $('#w-learn').onclick = () => withBusy($('#w-learn'), async seq => {
    const reference = $('#w-reference').value.trim();
    assertLocalLimit(reference, '参考材料');
    if (!reference) throw new Error('请先粘贴参考文章。');
    const context = $('#w-title').value.trim().slice(0, MAX_CONTEXT_LEN);
    const draftId = currentId;
    const version = formVersion();
    const result = await send('AI', { task: 'LEARN_EXPRESSIONS', payload: { source: reference, context } });
    if (seq !== workSeq) return; // 已取消
    const applied = applyAsyncResult(draftId, version, draft => { draft.learned = result.expressions || []; }, draft => renderLearned(draft.learned));
    if (applied) status(`已总结 ${(result.expressions || []).length} 条可复用表达，并已保存到本稿。`);
  });
  $('#w-check').onclick = () => withBusy($('#w-check'), async seq => {
    const text = $('#w-body').value.trim();
    assertLocalLimit(text, '正文');
    if (!text) throw new Error('请先写下英文草稿。');
    const reference = $('#w-reference').value.trim();
    assertLocalLimit(reference, '参考材料');
    const title = $('#w-title').value.trim();
    const draftId = currentId;
    const version = formVersion();
    const feedback = await send('AI', {
      task: 'CHECK_WRITING',
      payload: { text, source: reference, context: title.slice(0, MAX_CONTEXT_LEN), meaning: title, target: '英语' }
    });
    if (seq !== workSeq) return;
    const applied = applyAsyncResult(draftId, version, draft => { draft.feedback = feedback; }, draft => renderFeedback(draft.feedback));
    if (applied) status('已生成分层反馈并保存到本稿。');
  });
}

async function init() {
  bind();
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    drafts = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY].filter(Boolean) : [];
  } catch { drafts = []; }
  if (!drafts.length) drafts = [newDraft()];
  drafts.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  // 审计 W04：载入超过 20 篇的旧数据不裁剪、不覆盖，只提示用户处理。
  if (drafts.length > MAX_WRITING_DRAFTS) {
    status(`存储中有 ${drafts.length} 篇草稿（超过 ${MAX_WRITING_DRAFTS} 篇上限）。为避免数据丢失，本页不会自动删除；请先导出备份，再删除到 ${MAX_WRITING_DRAFTS} 篇以内。`, true);
  }
  currentId = drafts[0].id;
  fillForm();
  renderList();
  saveState('已恢复上次内容');
}

init().catch(error => status(error.message, true));
