// Writing assistant uses the current sidebar lifecycle; reply insertion stays in reply.js.
(() => {
  const BX = window.BX;
  const { state, esc, send } = BX;
  let sessionId = '', messages = [], prompt = '', selected = {}, loading = 0;
  const key = () => 'x:' + (window.BXContext.key(state.post?.url || '') || 'scratch');
  async function restore() {
    const seq = ++loading;
    sessionId = key(); messages = []; prompt = ''; selected = {};
    try {
      const rows = await send('LIST_AGENT_SESSIONS');
      if (seq !== loading) return;
      messages = rows.find(x => x.id === sessionId)?.messages || [];
      if (state.mode === 'agent') BX.refresh();
    } catch (error) { if (seq === loading) { state.error = error.message; BX.refresh(); } }
  }
  function render(body) {
    const answer = [...messages].reverse().find(m => m.role === 'assistant')?.content || '';
    body.innerHTML = `<section class="bx-section"><h2>写作 Agent</h2>
      <p class="bx-subtle">发送指令、已勾选材料和本会话历史。结果需由你采纳，不会自动发布。</p>
      <div class="bx-actions"><button id="bx-agent-desk">全屏 Markdown 写作台 ↗</button><button id="bx-agent-settings">设置运行时</button></div>
      ${[['post','当前帖子'],['selection','划选文字'],['draft','回复草稿']].map(([id,label])=>`<label><input type="checkbox" data-agent-context="${id}" ${selected[id]?'checked':''}>${label}</label>`).join(' ')}
      <div class="bx-agent-thread">${messages.slice(-10).map(m=>`<article><b>${m.role==='assistant'?'Agent':'你'}</b><pre style="white-space:pre-wrap;font:inherit">${esc(m.content)}</pre></article>`).join('')}</div>
      <textarea id="bx-agent-prompt" placeholder="整理观点、改写或继续讨论…">${esc(prompt)}</textarea>
      <div class="bx-actions"><button id="bx-agent-send" ${state.busy || !prompt.trim()?'disabled':''}>发送</button><button id="bx-agent-reset" ${state.busy?'disabled':''}>新会话</button></div>
      ${answer?'<div class="bx-actions"><button id="bx-agent-use">采用为回复草稿</button><button id="bx-agent-document">存为 Markdown 文稿</button></div>':''}${BX.statusHTML()}</section>`;
    body.querySelector('#bx-agent-prompt').oninput = e => { prompt=e.target.value; body.querySelector('#bx-agent-send').disabled=state.busy || !prompt.trim(); };
    body.querySelectorAll('[data-agent-context]').forEach(el=>el.onchange=()=>{selected[el.dataset.agentContext]=el.checked;});
    body.querySelector('#bx-agent-settings').onclick=()=>send('OPEN_SETTINGS');
    body.querySelector('#bx-agent-desk').onclick=()=>send('OPEN_WRITE_DESK');
    body.querySelector('#bx-cancel-request')?.addEventListener('click',BX.cancel);
    body.querySelector('#bx-agent-send').onclick=()=>BX.busy(async seq=>{
      const context=[];
      if(selected.post) context.push({label:'当前帖子',content:state.post?.text||''});
      if(selected.selection) context.push({label:'划选文字',content:state.selected});
      if(selected.draft) context.push({label:'回复草稿',content:state.draft});
      const instruction=prompt, id=sessionId;
      const result=await send('AGENT_CHAT',{payload:{sessionId:id,message:instruction,context}});
      if(seq!==state.reqSeq || id!==sessionId) return;
      messages=result.session.messages;
      if(prompt===instruction) prompt='';
    });
    body.querySelector('#bx-agent-reset').onclick=()=>BX.busy(async seq=>{
      if(!confirm('清除本会话记录？回复草稿保持不变。')) return;
      await send('RESET_AGENT_SESSION',{sessionId});
      if(seq===state.reqSeq) {messages=[];prompt='';}
    });
    body.querySelector('#bx-agent-use')?.addEventListener('click',()=>{
      if(state.draft && !confirm('用 Agent 结果替换当前回复草稿？'))return;
      state.draft=answer; state.reply={...(state.reply||{}),origin:'ai',result:null}; state.draftPostUrl=state.post?.url||''; BX.open('write');
    });
    body.querySelector('#bx-agent-document')?.addEventListener('click',()=>BX.busy(async()=>{
      const doc=await send('SAVE_DOCUMENT',{payload:{title:'来自 X 的 Agent 文稿',content:answer}});
      await send('OPEN_WRITE_DESK',{id:doc.id});
    }));
  }
  BX.register({id:'agent',label:'Agent',order:25,init:restore,onPost:restore,render});
})();
