// Dictionary panel controller. Mounts into any container element:
//   import { mountDictionaryPanel } from './mdx/dictionary-panel.js';
//   mountDictionaryPanel(document.querySelector('#dictionary-root'));
// Keeps its own state; never touches the rest of the extension.
import { importDictionary, MODES } from './mdx-indexer.js';
import { lookup, neighboursOf, status, suggest } from './mdx-lookup.js';
import { clearAll, countWords, deleteDatabase, loadStaging, sweepStaging } from './mdx-db.js';

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

export function mountDictionaryPanel(container, options = {}) {
  const { onStatusChange } = options;
  const state = { controller: null, importing: false, current: null };

  const statusLine = el('p', { class: 'mdx-status', role: 'status', 'aria-live': 'polite' });
  const errorLine = el('p', { class: 'mdx-error', role: 'alert', hidden: true });
  const fileInput = el('input', { type: 'file', accept: '.mdx', class: 'mdx-file' });
  const modeSelect = el('select', { class: 'mdx-mode' }, [
    el('option', { value: 'compact', text: `精简导入（释义、词性、例句，约 ${estimateHint('compact')}）` }),
    el('option', { value: 'full', text: `完整导入（含清洗后的原文排版，体积较大）` })
  ]);
  const progress = el('div', { class: 'mdx-progress', hidden: true }, [
    el('div', { class: 'mdx-progress-track' }, [el('div', { class: 'mdx-progress-bar' })]),
    el('span', { class: 'mdx-progress-text', text: '' })
  ]);
  const progressBar = progress.querySelector('.mdx-progress-bar');
  const progressText = progress.querySelector('.mdx-progress-text');
  const importButton = el('button', { class: 'mdx-primary', text: '导入并建索引' });
  const cancelButton = el('button', { class: 'mdx-secondary', text: '取消导入', hidden: true });
  const clearButton = el('button', { class: 'mdx-secondary', text: '删除本地索引' });

  const searchInput = el('input', { type: 'search', placeholder: '查词（本地离线）', class: 'mdx-search' });
  const searchButton = el('button', { class: 'mdx-primary', text: '查询' });
  const suggestions = el('div', { class: 'mdx-suggestions' });
  const result = el('div', { class: 'mdx-result' });
  const navBar = el('div', { class: 'mdx-nav', hidden: true }, [
    el('button', { class: 'mdx-secondary', text: '← 上一个词条', onclick: () => step(-1) }),
    el('button', { class: 'mdx-secondary', text: '下一个词条 →', onclick: () => step(1) })
  ]);

  function setStatus(text, isError = false) {
    errorLine.hidden = !isError;
    if (isError) { errorLine.textContent = text; statusLine.textContent = ''; }
    else { statusLine.textContent = text; }
    onStatusChange?.(text, isError);
  }

  function setProgress(done, total, message) {
    progress.hidden = false;
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `${message} ${percent}%`;
  }

  async function refresh() {
    // The status line is derived from the *ready* meta + active store count only, so a
    // half-written staging import can never be reported as 已导入 or as "索引未改变".
    try {
      // Age-gated cleanup of staging leftovers (crashed/closed browser); never touches a
      // live import in another tab - that keeps a fresh heartbeat.
      await sweepStaging().catch(() => {});
      const [state_, count, staging] = await Promise.all([
        status(), countWords(), loadStaging().catch(() => null)
      ]);
      const meta = state_.meta || {};
      const stagingNote = staging ? '（正在导入新的词典文件，原词库仍可查询。）' : '';
      if (state_.ready && count > 0) {
        const duplicates = meta.duplicateHeadwords ? `，${meta.duplicateHeadwords.toLocaleString()} 个重复词头另建条目` : '';
        const duration = meta.durationMs ? `，耗时 ${(meta.durationMs / 1000).toFixed(1)} 秒` : '';
        setStatus(`已导入《${meta.title || meta.fileName || '本地词典'}》：${count.toLocaleString()} 个条目，其中 ${(meta.realEntries || 0).toLocaleString()} 个词条、${(meta.redirectEntries || 0).toLocaleString()} 个跳转${duplicates}${duration}。${meta.hasResourceFile ? '' : '未提供 .mdd 资源文件，图片与发音不可用。'}${stagingNote}`);
      } else if (state_.ready) {
        setStatus('本地词典索引是空的，请重新导入一个 .mdx 文件。', true);
      } else if (staging) {
        setStatus('词典正在导入，尚未完成，暂时没有可查询的本地词典。');
      } else if (count > 0) {
        setStatus('本地索引尚未完成，无法查询；请重新导入词典。', true);
      } else {
        setStatus('还没有本地词典索引。选择一个 .mdx 文件后导入。');
      }
    } catch {
      setStatus('读取本地索引失败。', true);
    }
  }

  async function runImport() {
    const file = fileInput.files?.[0];
    if (!file) { setStatus('先选择一个 .mdx 文件。', true); return; }
    if (state.importing) return;
    const prior = await status().catch(() => ({ ready: false, meta: null }));
    const hadIndex = Boolean(prior.ready);
    state.importing = true;
    state.controller = new AbortController();
    importButton.disabled = true;
    fileInput.disabled = true;
    modeSelect.disabled = true;
    cancelButton.hidden = false;
    setStatus('');
    let finalMessage = null;
    let finalIsError = false;
    try {
      await importDictionary({
        file,
        mode: modeSelect.value,
        signal: state.controller.signal,
        onProgress: event => setProgress(event.done, event.total, event.message)
      });
    } catch (error) {
      if (error?.reason === 'cancelled') {
        finalMessage = hadIndex
          ? '已取消导入。原有词典未受影响，仍可查询。'
          : '已取消导入，本地还没有词典索引。';
      } else {
        finalMessage = `${error?.message || '导入失败。'}${hadIndex ? '（原有词典未受影响，仍可查询。）' : ''}`;
        finalIsError = true;
      }
    } finally {
      state.importing = false;
      importButton.disabled = false;
      fileInput.disabled = false;
      modeSelect.disabled = false;
      cancelButton.hidden = true;
      progress.hidden = true;
      // On success refresh() reports the new ready index; on cancel/failure it reports the
      // untouched old one - then the cancel/failure message is shown on top of that state.
      await refresh();
      if (finalMessage) setStatus(finalMessage, finalIsError);
    }
  }

  async function step(direction) {
    if (!state.current) return;
    const around = await neighboursOf(state.current, 1);
    const target = direction < 0 ? around.previous.at(-1) : around.next[0];
    if (!target) { setStatus('已经是词典的边界了。'); return; }
    await show(target.word);
  }

  async function show(word) {
    const outcome = await lookup(word);
    result.replaceChildren();
    navBar.hidden = true;
    if (!outcome.found) {
      result.append(el('p', { class: 'mdx-empty', text: outcome.message }));
      if (outcome.suggestions?.length) {
        result.append(el('p', { class: 'mdx-muted', text: '要不要查：' }), renderChips(outcome.suggestions));
      }
      return;
    }
    state.current = outcome.row.word;
    navBar.hidden = false;
    if (outcome.hops?.length) {
      result.append(el('p', {
        class: 'mdx-hop',
        text: `已跳转：${outcome.hops.map(hop => `${hop.from} → ${hop.to}`).join('，')}`
      }));
    }
    result.append(renderEntry(outcome.row));
    if (outcome.notice) result.append(el('p', { class: 'mdx-notice', text: outcome.notice }));
  }

  function renderChips(words) {
    return el('div', { class: 'mdx-suggestions' }, words.map(word => el('button', {
      class: 'mdx-chip', text: word, onclick: () => { searchInput.value = word; show(word); }
    })));
  }

  function renderEntry(row) {
    const box = el('article', { class: 'mdx-entry' });
    box.append(el('h3', { class: 'mdx-headword', text: row.headword || row.display || row.word }));
    if (row.pronunciation) box.append(el('span', { class: 'mdx-pron', text: `/${row.pronunciation}/` }));
    for (const sense of row.senses || []) {
      const item = el('div', { class: 'mdx-sense' });
      const tags = [sense.pos, sense.signpost, sense.grammar].filter(Boolean);
      if (tags.length) item.append(el('span', { class: 'mdx-pos', text: tags.join(' · ') }));
      if (sense.defZh) item.append(el('p', { class: 'mdx-def', text: sense.defZh }));
      if (sense.defEn) item.append(el('p', { class: 'mdx-def-en', text: sense.defEn }));
      for (const example of sense.examples || []) item.append(el('p', { class: 'mdx-example', text: example }));
      box.append(item);
    }
    if (!row.senses?.length && row.text) box.append(el('p', { class: 'mdx-def', text: row.text }));
    if (row.html) {
      // Already passed through the allowlist sanitizer in mdx-html.js.
      const original = el('div', { class: 'mdx-original' });
      original.innerHTML = row.html;
      // Internal entry:// links navigate inside the dictionary; remote links open on click only.
      original.addEventListener('click', event => {
        const anchor = event.target?.closest?.('a');
        const href = anchor?.getAttribute?.('href') || '';
        if (!href.startsWith('entry://')) return;
        event.preventDefault();
        show(decodeURIComponent(href.slice('entry://'.length)));
      });
      box.append(original);
    }
    return box;
  }

  searchButton.onclick = () => { const word = searchInput.value.trim(); if (word) show(word); };
  searchInput.onkeydown = event => { if (event.key === 'Enter') searchButton.click(); };
  searchInput.oninput = async () => {
    const prefix = searchInput.value.trim();
    suggestions.replaceChildren();
    if (prefix.length < 2) return;
    const list = await suggest(prefix, 8);
    suggestions.append(...list.map(item => el('button', {
      class: 'mdx-chip', text: item.word, onclick: () => { searchInput.value = item.word; show(item.word); }
    })));
  };
  importButton.onclick = runImport;
  cancelButton.onclick = () => state.controller?.abort();
  clearButton.onclick = async () => {
    await clearAll().catch(() => {});
    await deleteDatabase().catch(() => {});
    result.replaceChildren();
    setStatus('本地索引已删除。');
  };

  container.replaceChildren(
    el('section', { class: 'mdx-panel' }, [
      el('div', { class: 'mdx-block' }, [
        el('h2', { text: '本地 MDX 词典' }),
        el('p', { class: 'mdx-muted', text: '词典文件只在本机解析，不上传、不打包。导入后完全离线查词；释义中的外部链接只在你点击时才会打开，图片与发音需要配套的 .mdd 文件。' }),
        fileInput, modeSelect,
        el('div', { class: 'mdx-actions' }, [importButton, cancelButton, clearButton]),
        progress
      ]),
      el('div', { class: 'mdx-block' }, [
        el('div', { class: 'mdx-search-row' }, [searchInput, searchButton]),
        suggestions, navBar, result
      ]),
      statusLine, errorLine
    ])
  );

  refresh(); // also sweeps staging leftovers from a crashed/closed import (age-gated)
  return { refresh, show, state };
}

function estimateHint(mode) {
  return mode === 'compact' ? '每条 1 KB 以内' : '每条数 KB';
}

export { MODES };
