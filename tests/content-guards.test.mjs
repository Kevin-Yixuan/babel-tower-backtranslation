import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
// 侧栏化后内容脚本拆分为骨架 + 各模块：行为断言改为在“全部内容脚本”并集上搜索。
const CONTENT_SCRIPTS = [
  'content.js',
  'sidebar/sidebar.js',
  'modules/reading/reading.js',
  'modules/reply/reply.js',
  'modules/practice/practice.js',
  'modules/growth/growth.js',
  'modules/discovery/discovery.js'
];
const readContent = () => CONTENT_SCRIPTS.map(read).join('\n');
const readReply = () => ['sidebar/sidebar.js', 'modules/reply/reply.js'].map(read).join('\n');

test('length logic is owned by integration in shared.js (merged final state)', () => {
  const shared = read('shared.js');
  // integration owns the 20k limits — exactly once, with writing's verbatim message text
  assert(shared.includes('export function assertTextLimit'), 'assertTextLimit 归 integration（合并后必须存在）');
  assert(shared.includes('export function assertTextLimit(value, label, max = MAX_REFERENCE_CHARS)'));
  assert(shared.includes("`${label}共 ${text.length} 字符，超过上限 ${max} 字符。请分段处理；插件不会自动截断。`"));
  assert.equal((shared.match(/export const MAX_REFERENCE_CHARS = 20000/g) || []).length, 1, 'MAX_REFERENCE_CHARS 只能定义一次');
  assert.equal((shared.match(/export const MAX_DRAFT_CHARS = 20000/g) || []).length, 1, 'MAX_DRAFT_CHARS 只能定义一次');
  // writing-side helpers must never appear
  assert(!shared.includes('assertLength'), '不应引入 assertLength');
  assert(!shared.includes('MAX_WRITE_LEN'), '不应在 shared.js 另定义写作上限');
});

test('promptFor uses assertTextLimit for context/source/text (no silent clean truncate)', () => {
  const bg = read('background.js');
  assert(bg.includes("assertTextLimit(payload?.context, '参考材料', MAX_REFERENCE_CHARS)"));
  assert(bg.includes("assertTextLimit(payload?.source, '参考材料', MAX_REFERENCE_CHARS)"));
  assert(bg.includes("assertTextLimit(payload?.text, '你的输入', MAX_DRAFT_CHARS)"));
  assert(!bg.includes('clean(payload?.context, 2200)'), '旧 2200 截断必须移除');
  assert(!bg.includes('clean(payload?.source, 2500)'), '旧 2500 截断必须移除');
  assert(bg.includes("'CHECK_WRITING'") && bg.includes("'LEARN_EXPRESSIONS'"));
});

test('FEEDBACK_SCHEMA is layered: meaningNote + grammarNote + points.kind unchanged', () => {
  const bg = read('background.js');
  assert(bg.includes("meaningNote: { type: 'string' }"));
  assert(bg.includes("grammarNote: { type: 'string' }"));
  assert(bg.includes("enum: ['fix', 'polish', 'keep']"), 'points[].kind 语义保持 fix/polish/keep');
});

test('content scripts capture full X material (no 2500/350 silent slice)', () => {
  const content = readContent();
  assert(!/getTweetText[\s\S]{0,160}slice\(0, 2500\)/.test(content), '帖子取文不得 slice 2500');
  assert(!/innerText\?\.trim\(\)\.slice\(0, 2500\)/.test(content), '文章取文不得 slice 2500');
  assert(!/toString\(\)\.trim\(\)\.slice\(0, 350\)/.test(content), '选段不得 slice 350');
  assert(content.includes('ensureMaterialLimit'), '发送前有统一超限检查');
  assert(content.includes('当前没有自动分段'), '超限提示说明没有自动分段');
});

test('reply module binds insert target: freeze + revalidate, no first-editor fallback', () => {
  const reply = readReply();
  assert(reply.includes('resolveInsertTarget'));
  assert(reply.includes('state.binding'));
  assert(reply.includes('visibleInPage'), '确认时校验可见性');
  assert(!reply.includes('return state.editor?.isConnected ? state.editor : document.querySelector'), '旧“回退到页面第一个框”已移除');
  assert(reply.includes('无法确定对应的发帖框') || reply.includes('无法确定'), '目标不确定时明确拒绝');
  assert(reply.includes('range.collapse(false)'), '非空追加到末尾');
  assert(!/publish|Post button.*click/i.test(reply), '不得自动点击发布');
});

test('content scripts guard in-flight model results with seq + snapshot + candidate', () => {
  const content = readContent();
  assert(content.includes('state.reqSeq'), '请求序号');
  assert(content.includes('seq !== state.reqSeq'), '取消/切帖后丢弃旧响应');
  assert(content.includes('state.draftCandidate'), '候选草稿区');
  assert(content.includes('snapshot.idea !== state.idea') || content.includes('state.idea !== snapshot.idea'), '输入变化不覆盖');
  assert(content.includes('compositionstart') && content.includes('compositionend'), 'IME 组合态延迟渲染');
});

test('layered feedback renderer produces three separate blocks', () => {
  const shell = read('sidebar/sidebar.js');
  assert(shell.includes('bx-layer-meaning'));
  assert(shell.includes('bx-layer-grammar'));
  assert(shell.includes('bx-layer-polish'));
  assert(shell.includes('意思是否传达'));
  assert(shell.includes('语法问题'));
  assert(shell.includes('表达润色'));
});

test('write mode textareas stay editable and errors preserve input', () => {
  const reply = readReply();
  assert(reply.includes('id="bx-idea"'));
  assert(reply.includes('id="bx-draft"'));
  assert(!/<textarea[^>]*maxlength/.test(reply), '面板输入不设 maxlength');
  assert(reply.includes('state.error = error.message') || read('sidebar/sidebar.js').includes('state.error = error.message'));
  assert(!reply.includes("state.idea = ''"), '失败不得清空想法');
});
