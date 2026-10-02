import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineMarkdown, markdownTitle, renderMarkdown } from '../write/markdown.js';

test('markdown renderer formats common writing structures', () => {
  const html = renderMarkdown('# 标题\n\n**判断** 与 `术语`\n\n- 第一条\n- 第二条\n\n> 引文');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>判断<\/strong>/);
  assert.match(html, /<ul><li>第一条<\/li><li>第二条<\/li><\/ul>/);
  assert.match(html, /<blockquote>引文<\/blockquote>/);
});

test('markdown renderer escapes raw HTML and rejects javascript links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[危险](javascript:alert(1))');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /&lt;img/);
});

test('inline markdown preserves safe links and title extraction', () => {
  assert.match(inlineMarkdown('[官网](https://example.com)'), /target="_blank"/);
  assert.equal(markdownTitle('前言\n# 文稿标题\n正文'), '文稿标题');
});

test('图片默认不加载，明确启用后保留安全地址与替代文字', () => {
  const markdown = '![图示](https://images.example.com/chart.png "说明")';
  const quiet = renderMarkdown(markdown);
  assert.doesNotMatch(quiet, /<img/);
  assert.match(quiet, /图片：图示/);
  const enabled = renderMarkdown(markdown, { allowImages: true });
  assert.match(enabled, /<img src="https:\/\/images.example.com\/chart.png"/);
  assert.match(enabled, /alt="图示"/);
  assert.match(enabled, /referrerpolicy="no-referrer"/);
});

test('图片拒绝危险或本地协议，替代文字不会成为 HTML', () => {
  for (const url of ['javascript:alert', 'data:text/html,test', 'file:///private.png', 'mailto:x@example.com', '/relative.png']) {
    assert.doesNotMatch(renderMarkdown(`![图示](${url})`, { allowImages: true }), /<img/);
  }
  const html = renderMarkdown('![<script>bad</script>](https://example.com/x.png)', { allowImages: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /alt="&lt;script&gt;/);
  assert.doesNotMatch(renderMarkdown('`![code](https://example.com/x.png)`', { allowImages: true }), /<img/);
});
