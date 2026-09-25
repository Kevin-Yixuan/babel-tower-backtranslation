// 回译练习模块（integration 保留；id=practice，页签「回译」）。
// 由旧浮层面板「回译」页签原样迁移：先读中文再独立写英文、三层反馈、原文对照。
// 四项新任务未覆盖此功能——任何子 Agent 不要改本文件。
(() => {
  const BX = window.BX;
  const { state, esc, send, statusHTML, feedbackHTML, util, register, busy: withBusy } = BX;
  const { ensureMaterialLimit } = util;

  function renderPractice(container) {
    const source = state.selected || state.post?.text || '';
    container.innerHTML = `<section class="bx-section"><div class="bx-kicker">从 X 语料开始</div><h2>先读中文，再独立写英文</h2><p class="bx-subtle">参考原文会在提交后出现。意思正确的不同写法可以保留。</p>${!state.practice ? `<div class="bx-result bx-quiet"><p>${source ? esc(source.slice(0, 340)) : '请先打开一条英文帖子，或选中要练习的段落。'}</p></div><button class="bx-primary bx-wide" id="bx-create-practice" ${!source ? 'disabled' : ''}>生成中文练习</button>` : `<div class="bx-prompt"><small>${esc(state.practice.context)}</small><p>${esc(state.practice.chinese)}</p><span>练习目标：${esc(state.practice.focus)}</span></div><label class="bx-label" for="bx-answer">你的英文</label><textarea id="bx-answer" placeholder="先自己写，再检查……">${esc(state.practiceAnswer)}</textarea><button class="bx-primary bx-wide" id="bx-check-practice" ${!state.practiceAnswer.trim() ? 'disabled' : ''}>检查我的表达</button>${state.practiceFeedback ? feedbackHTML(state.practiceFeedback) : ''}${state.practiceFeedback ? `<details class="bx-reference"><summary>查看英文原文</summary><p>${esc(source)}</p></details><label class="bx-label" for="bx-revision">自己改一次</label><textarea id="bx-revision">${esc(state.revision || state.practiceAnswer)}</textarea><button id="bx-check-revision" class="bx-wide">检查修改</button>${state.revisionFeedback ? feedbackHTML(state.revisionFeedback) : ''}` : ''}`}${statusHTML()}</section>`;
    const create = container.querySelector('#bx-create-practice');
    if (create) create.onclick = () => withBusy(async seq => {
      ensureMaterialLimit(source, '选段/帖子内容');
      const result = await send('AI', { task: 'PREPARE_PRACTICE', payload: { source, context: state.post?.author || '' } });
      if (seq !== state.reqSeq) return;
      if (!result.chinese) throw new Error('练习题生成不完整，请重试。');
      state.practice = result;
    });
    const answer = container.querySelector('#bx-answer');
    if (answer) answer.oninput = () => { state.practiceAnswer = answer.value; container.querySelector('#bx-check-practice').disabled = !answer.value.trim(); };
    const check = container.querySelector('#bx-check-practice');
    if (check) check.onclick = () => withBusy(async seq => {
      const snapshot = { text: state.practiceAnswer, postUrl: state.post?.url || '' };
      ensureMaterialLimit(snapshot.text, '你的作答');
      const feedback = await send('AI', { task: 'CHECK_PRACTICE', payload: { text: snapshot.text, meaning: state.practice.chinese, source, context: state.practice.context, target: '英语' } });
      if (seq !== state.reqSeq) return; // 已取消或已切换对象
      if (state.practiceAnswer !== snapshot.text || (state.post?.url || '') !== snapshot.postUrl) { state.notice = '作答或对象已变化，本次反馈已忽略。'; return; }
      state.practiceFeedback = feedback;
      state.revision = state.practiceAnswer;
      // 练习作答是用户亲手写的英文 → 学习记忆候选（协议 §5，origin 恒为 user）。
      BX.emit('user-draft', { text: snapshot.text, origin: 'user', context: 'practice', url: snapshot.postUrl, at: Date.now() });
    });
    const revision = container.querySelector('#bx-revision');
    if (revision) revision.oninput = () => { state.revision = revision.value; };
    const checkRevision = container.querySelector('#bx-check-revision');
    if (checkRevision) checkRevision.onclick = () => withBusy(async seq => {
      const snapshot = { text: state.revision, postUrl: state.post?.url || '' };
      ensureMaterialLimit(snapshot.text, '你的作答');
      const feedback = await send('AI', { task: 'CHECK_PRACTICE', payload: { text: snapshot.text, meaning: state.practice.chinese, source, context: state.practice.context, target: '英语' } });
      if (seq !== state.reqSeq) return;
      if (state.revision !== snapshot.text || (state.post?.url || '') !== snapshot.postUrl) { state.notice = '作答或对象已变化，本次反馈已忽略。'; return; }
      state.revisionFeedback = feedback;
      BX.emit('user-draft', { text: snapshot.text, origin: 'user', context: 'practice', url: snapshot.postUrl, at: Date.now() });
    });
  }

  register({
    id: 'practice',
    label: '回译',
    order: 30,
    render(container) { renderPractice(container); },
    onPost() {
      // 切帖：旧 openArticle 中属于练习的复位。
      state.practice = null; state.practiceAnswer = ''; state.practiceFeedback = null;
      state.revision = ''; state.revisionFeedback = null;
    }
  });
})();
