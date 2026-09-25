import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPos, extractEntry, parseFragment, plainText, redirectTarget, sanitizeEntryHtml } from '../mdx/mdx-html.js';

const ENTRY = `<link href="LM5style.css" rel="stylesheet"/><script src="jquery.js"></script>
<span class="lm5ppbody"><div class="entry_content"><h1 class="pagetitle">sample</h1>
<div class="dictentry"><div class="ldoceEntry Entry">
<span class="HWD">sample</span><span class="PRON">saampfEl</span>
<span class="Sense"><span class="sensenum">1</span><span class="lm5pp_POS">n.</span>
<span class="SIGNPOST">a small amount</span><span class="DEF">a small part of something</span>
<span class="cn_txt">样本；样品</span>
<span class="exa">a free sample of shampoo</span><span class="exa">Please provide a sample.</span></span>
<span class="Sense"><span class="lm5pp_POS">v.</span><span class="DEF">to try a small amount</span>
<span class="cn_txt">品尝</span><span class="exa">sample the local food</span></span>
<a class="defRef" href="entry://taste">taste</a>
<a class="speaker" href="sound://sample.spx">发音</a>
<img src="sample.jpg" alt="pic"/>
</div></div></span>`;

test('redirect records are recognised and not treated as entries', () => {
  assert.equal(redirectTarget('@@@LINK=be a fly on the wall\r\n'), 'be a fly on the wall');
  assert.equal(redirectTarget('<span>real entry</span>'), null);
  const result = extractEntry('@@@LINK=other word');
  assert.equal(result.redirect, 'other word');
  assert.deepEqual(result.senses, []);
});

test('dangerous markup is removed by the sanitizer', () => {
  const dirty = '<div onclick="alert(1)">x</div><script>bad()</script><a href="javascript:alert(2)">y</a>'
    + '<iframe src="https://evil.test"></iframe><form><input value="z"></form>'
    + '<img src="a.png"><a href="sound://a.spx">play</a>';
  const { html, media } = sanitizeEntryHtml(dirty, { hasResourceFile: false });
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /<form/i);
  assert.doesNotMatch(html, /<input/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /\[图片资源不可用/);
  assert.match(html, /\[音频不可用/);
  assert.equal(media.images, 1);
  assert.equal(media.audio, 1);
});

test('safe links and entry links survive sanitizing', () => {
  const { html } = sanitizeEntryHtml('<a href="entry://taste">taste</a><a href="https://example.com/x">site</a>', {});
  assert.match(html, /href="entry:\/\/taste"/);
  assert.match(html, /href="https:\/\/example.com\/x"/);
});

test('entry extraction keeps 词性、释义 和 例句', () => {
  const entry = extractEntry(ENTRY, { hasResourceFile: false });
  assert.equal(entry.redirect, null);
  assert.equal(entry.headword, 'sample');
  assert.equal(entry.pronunciation, 'saampfEl');
  assert.equal(entry.senses.length, 2);
  assert.deepEqual(entry.senses.map(sense => sense.pos), ['n.', 'v.']);
  assert.deepEqual(entry.senses.map(sense => sense.defZh), ['样本；样品', '品尝']);
  assert.equal(entry.senses[0].defEn, 'a small part of something');
  assert.deepEqual(entry.senses[0].examples, ['a free sample of shampoo', 'Please provide a sample.']);
  assert.match(entry.text, /1\. n\. · a small amount — 样本；样品 a small part of something/);
  assert.match(entry.text, /例：a free sample of shampoo/);
  assert.equal(entry.media.audio, 1, 'sound:// links are reported as missing audio');
  assert.equal(entry.media.images, 1, 'img is reported as missing image');
});

test('text-only fallback keeps working when class names are unknown', () => {
  const entry = extractEntry('<div><span class="def">释义文字</span><span class="ddef">another</span></div>', {});
  assert.ok(entry.senses.length >= 1);
  assert.match(entry.text, /释义文字/);
});

test('tokenizer handles unclosed tags and comments', () => {
  const root = parseFragment('<!-- c --><div><span>a<b>b</div>tail');
  assert.match(plainText(root), /ab/);
  assert.match(plainText(root), /tail/);
});

// ---- POS inheritance, verified against the real LDOCE5++ structure -------------------------
// Real entries print the part of speech once in the entry Head, *outside* the Sense nodes.

const headEntry = (body, pos = 'noun') => `<span class="lm5ppbody"><div class="entry_content"><div class="dictionary">
<div class="dictentry"><span class="dictlink"><div class="ldoceEntry Entry">
<span class="frequent Head"><span class="lm5pp_POS">${pos}</span><span class="HWD">kit</span></span>
${body}
</div></span></div></div></div></span>`;

test('词性 printed outside the senses in the entry Head is inherited by every sense', () => {
  const entry = extractEntry(headEntry(`
<div class="newline Sense"><span class="DEF">a set of tools</span><span class="cn_txt">工具箱</span><span class="exa">a first-aid kit</span></div>
<div class="newline Sense"><span class="DEF">a young animal</span><span class="cn_txt">幼崽</span></div>`));
  assert.deepEqual(entry.senses.map(sense => sense.pos), ['noun', 'noun']);
  assert.equal(entry.senses[0].defEn, 'a set of tools');
  assert.equal(entry.senses[0].defZh, '工具箱');
  assert.deepEqual(entry.senses[0].examples, ['a first-aid kit']);
});

test('each Head section only governs the senses that follow it (noun vs verb)', () => {
  const entry = extractEntry(headEntry(`
<div class="newline Sense"><span class="DEF">a river edge</span><span class="cn_txt">河岸</span></div>
<span class="Head"><span class="lm5pp_POS">verb</span></span>
<div class="newline Sense"><span class="DEF">to bank money</span><span class="cn_txt">存钱</span></div>`));
  assert.equal(entry.senses.length, 2);
  assert.deepEqual(entry.senses.map(sense => sense.pos), ['noun', 'verb']);
});

test('word-family and popup POS never leak into the entry senses', () => {
  const html = `<span class="lm5ppbody"><div class="entry_content"><div class="dictionary">
<div class="wordfams"><span class="LDOCE_word_family"><span class="pos">adjective</span></span></div>
<div class="dictentry"><div class="ldoceEntry Entry">
<div class="newline Sense"><span class="DEF">main def</span><span class="cn_txt">主要释义</span></div>
</div></div></div>
<div class="lm5pp_popup"><span class="lm5pp_popupitem"><a class="Head"><span class="lm5pp_POS">verb</span></a></span></div>
</div></span>`;
  const entry = extractEntry(html);
  assert.equal(entry.senses.length, 1);
  assert.equal(entry.senses[0].pos, '', 'no Head POS in scope, so nothing is inherited');
});

test('inherited POS does not resurrect contentless markup (etymology line)', () => {
  const html = `<div class="dictionary">
<div class="dictentry"><div class="ldoceEntry Entry">
<span class="Head"><span class="lm5pp_POS">noun</span></span>
<div class="newline Sense"><span class="DEF">a book of words</span><span class="cn_txt">词典</span></div>
</div></div>
<span class="etym"><div class="Sense">Old English dictionarium</div></span></div>`;
  const entry = extractEntry(html);
  assert.equal(entry.senses.length, 1, 'the etymology line has no def/example/own POS');
  assert.equal(entry.senses[0].pos, 'noun');
});

test('own POS inside the sense still wins, and doubled EN labels are cleaned', () => {
  assert.equal(cleanPos('adjectiveadj'), 'adjective');
  assert.equal(cleanPos('adverbadv'), 'adverb');
  assert.equal(cleanPos('phrasal verbphr v'), 'phrasal verb');
  assert.equal(cleanPos('noun'), 'noun');
  assert.equal(cleanPos('n.'), 'n.');
  const entry = extractEntry(headEntry(`
<span class="Head"><span class="lm5pp_POS">noun</span></span>
<div class="newline Sense Subentry"><span class="lm5pp_POS">phrasal verbphr v</span><span class="DEF">to give up</span><span class="cn_txt">放弃</span></div>`));
  assert.equal(entry.senses[0].pos, 'phrasal verb');
});

test('external links are click-to-open only, entry links stay internal', () => {
  const { html } = sanitizeEntryHtml(
    '<a href="https://example.com/x">site</a><a href="entry://apple">apple</a><a href="#top">top</a>', {}
  );
  assert.match(html, /href="https:\/\/example.com\/x"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.equal((html.match(/target="_blank"/g) || []).length, 1, 'only the remote link opens externally');
  assert.match(html, /href="entry:\/\/apple" title="apple"/);
  assert.doesNotMatch(html, /href="#top" title="top" target/);
});
