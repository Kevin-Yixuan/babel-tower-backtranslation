(() => {
  const BX = window.BX, state = BX.state;
  const fields = ['selected', 'dictionary', 'explanation', 'reading', 'practice', 'practiceAnswer', 'practiceFeedback',
    'revision', 'revisionFeedback', 'idea', 'draft', 'draftNote', 'replyFeedback', 'draftCandidate', 'draftPostUrl',
    'target', 'tone', 'reply', 'insertMode'];
  const defaults = Object.fromEntries(fields.filter(f => state[f] !== undefined).map(f => [f, structuredClone(state[f])]));
  const DEBOUNCE_MS = 400;
  const slots = new Map();
  let current = null, epoch = 0, restoring = false, baseline = null, pendingSwitch = null;
  let ready = Promise.resolve();

  function newSlot(key) {
    return { key, storageKey: key, revision: 0, signature: '', queue: Promise.resolve(), data: null,
      failed: false, dirty: false, timer: null };
  }
  function snapshot() {
    const data = {};
    for (const field of fields) if (state[field] !== undefined) data[field] = state[field];
    const copy = JSON.parse(JSON.stringify(data));
    if (copy.reading) {
      copy.reading.busy = false;
      copy.reading.units?.forEach(unit => { if (unit.status === 'queued') unit.status = 'pending'; });
    }
    return copy;
  }
  function sendSave(slot, data) {
    // 每槽独立队列：切帖后旧帖的保存继续走自己的队列，不会与新帖互相覆盖。
    slot.queue = slot.queue.catch(() => {}).then(async () => {
      const record = await BX.send('SESSION', { payload: { op: 'save', key: slot.storageKey, data, revision: slot.revision } });
      slot.revision = record.revision; slot.storageKey = record.key;
      slot.data = data; slot.failed = false;
      if (record.conflict) {
        // 冲突必须明确提示：无论冲突发生在当前帖还是切帖后才落盘的旧帖，都要让用户知道副本去向。
        const message = (current === slot ? '' : '上一帖') + '已另存冲突副本；可在设置中查看';
        state.saveStatus = message; state.notice = message;
        updateStatus(); BX.refresh();
      } else if (current === slot) {
        state.saveStatus = '已自动保存';
        updateStatus();
      }
    }).catch(error => {
      // 保存失败：保留最后一次内容与重试标记，明确提示；绝不静默丢草稿。
      slot.failed = true; slot.signature = ''; slot.data = data;
      const message = '保存失败：' + (error?.message || String(error));
      state.saveStatus = current === slot ? message : '上一帖' + message;
      updateStatus();
      if (current !== slot) { state.notice = state.saveStatus; BX.refresh(); }
    });
    return slot.queue;
  }
  function save(immediate = false) {
    // 恢复窗口内禁止整包入库：此时 state 还是默认值+半恢复状态，写库会覆盖已有记录。
    // 恢复期间的新输入由 onInput 标记 dirty，恢复结束后合并并立即保存。
    if (!current || restoring || state.sessionLoading) return Promise.resolve();
    const slot = current, data = snapshot(), signature = JSON.stringify(data);
    if (signature === slot.signature) {
      if (immediate && slot.timer) { clearTimeout(slot.timer); slot.timer = null; return sendSave(slot, slot.data); }
      return slot.queue;
    }
    slot.data = data; slot.signature = signature;
    state.saveStatus = '正在保存…';
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (immediate) { updateStatus(); return sendSave(slot, data); }
    slot.timer = setTimeout(() => { slot.timer = null; sendSave(slot, slot.data); }, DEBOUNCE_MS);
    updateStatus();
    return slot.queue;
  }
  function flushAll() {
    save(true);
    for (const slot of slots.values()) {
      if (slot === current) continue;
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; sendSave(slot, slot.data); }
      else if (slot.failed && slot.data) sendSave(slot, slot.data);
    }
  }
  function updateStatus() {
    const label = BX.element.querySelector('#bx-save-status');
    if (label) label.textContent = state.sessionLoading ? '正在恢复本帖内容…' : state.saveStatus || '';
  }
  function applyRecord(slot, record) {
    // baseline 记录本次访问重置后的字段值：与 baseline 不同的字段=恢复窗口内的新输入，旧记录不得覆盖。
    for (const field of fields) {
      if (!Object.hasOwn(record.data, field)) continue;
      if (slot.dirty && baseline && JSON.stringify(state[field]) !== JSON.stringify(baseline[field])) continue;
      state[field] = structuredClone(record.data[field]);
    }
    slot.revision = record.revision; slot.data = record.data;
  }
  function switchTo(post, apply) {
    const key = window.BXContext.key(post?.url || '');
    if (!key) {
      // 无稳定 ID（首页/外站/识别失败的链接）：不归属任何会话。
      // 恢复进行中 → 挂起等旧帖落盘后再脱离，避免旧记录覆盖新页面状态；
      // 否则立即落盘旧帖并脱离槽位，此后输入/模块清理绝不再写进上一帖的记录。
      if (restoring) { pendingSwitch = { post, apply }; return; }
      if (current) save(true);
      pendingSwitch = null;
      apply(post);
      current = null;
      updateStatus();
      return;
    }
    if (current?.key === key) {
      // 同帖（含查询参数/链接形态差异）：不重置、不重复恢复，只吸收正文变化。
      pendingSwitch = null;
      const priorText = state.post?.text;
      state.post = post?.text ? post : { ...post, text: state.post?.text || '', author: post?.author || state.post?.author || '' };
      if (state.post?.text !== priorText) BX.emit('source-updated', { post: state.post });
      return;
    }
    if (restoring) {
      // 旧帖恢复仍在进行：挂起本次切换，按“最近意图”执行，避免旧恢复覆盖新帖状态。
      pendingSwitch = { post, apply };
      return;
    }
    save(true); // 旧帖立即落盘（清掉防抖定时器）
    const ticket = ++epoch;
    restoring = true;
    // 上一帖的恢复错误与提示不得带到新帖；旧帖保存失败/冲突的提示是异步到达的，
    // 在此之后设置，仍然可见（带“上一帖”前缀）。
    state.error = '';
    state.notice = '';
    // 新帖没有记录时，目标语言默认值取自设置页（加载时捕获的默认值会盖掉设置）。
    const settingsTarget = typeof state.settings?.targetLanguage === 'string' && state.settings.targetLanguage.trim()
      ? state.settings.targetLanguage : '';
    for (const field of fields) {
      if (field === 'target' && settingsTarget) state.target = settingsTarget;
      else if (Object.hasOwn(defaults, field)) state[field] = structuredClone(defaults[field]);
      else delete state[field];
    }
    apply(post);
    current = slots.get(key) || newSlot(key);
    slots.set(key, current);
    const slot = current;
    slot.dirty = false;
    baseline = Object.fromEntries(fields.map(f => [f, state[f] === undefined ? undefined : structuredClone(state[f])]));
    state.sessionLoading = true;
    ready = (async () => {
      await slot.queue;
      const record = slot.data ? { data: slot.data, revision: slot.revision } : await BX.send('SESSION', { payload: { op: 'get', key } });
      if (ticket !== epoch) return;
      if (record?.data) applyRecord(slot, record);
      state.editor = null; state.binding = null; state.insertConfirm = false; state.busy = false;
      state.reqSeq++; state.saveStatus = record ? '已恢复本帖内容' : '';
    })().catch(error => { if (ticket === epoch) state.error = '恢复失败：' + error.message; })
      .finally(() => {
        if (ticket !== epoch) return;
        state.sessionLoading = false; restoring = false;
        const dirty = slot.dirty; slot.dirty = false;
        if (slot.failed || dirty) slot.signature = ''; // 未入库的新输入或上次失败：强制立即保存
        else slot.signature = JSON.stringify(snapshot());
        if (slot.signature === '') save(true);
        updateStatus();
        BX.emit('session-ready', {}); BX.refresh();
        if (pendingSwitch) { const next = pendingSwitch; pendingSwitch = null; switchTo(next.post, next.apply); }
      });
    BX.refresh();
  }
  const onInput = () => {
    if (current && (restoring || state.sessionLoading)) current.dirty = true;
    save();
  };
  BX.element.addEventListener('input', onInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
  window.addEventListener('pagehide', flushAll);
  window.BXSession = { switchTo, save, get ready() { return ready; }, get key() { return current?.key || ''; } };
})();
