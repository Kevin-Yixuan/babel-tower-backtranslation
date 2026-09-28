import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDocument, safeAgentEndpoint } from '../services/agent-data.js';
import { renderMarkdown } from '../write/markdown.js';

test('Pi endpoint accepts only the local bridge port', () => {
  assert.equal(safeAgentEndpoint('pi', 'http://127.0.0.1:4097'), 'http://127.0.0.1:4097');
  for (const url of ['https://example.com', 'http://127.0.0.1:4096', 'http://127.0.0.1:4097/other', 'http://user@127.0.0.1:4097']) {
    assert.throws(() => safeAgentEndpoint('pi', url));
  }
});

test('reference article keeps its folder and source while edited', () => {
  const first = normalizeDocument({ content: '# Source\n\nText', kind: 'reference', folder: '参考文章/AI', sourceUrl: 'https://x.com/a/status/123' });
  const edited = normalizeDocument({ id: first.id, content: '# Source\n\nRevised' }, first);
  assert.equal(edited.kind, 'reference');
  assert.equal(edited.folder, '参考文章/AI');
  assert.equal(edited.sourceUrl, first.sourceUrl);
});

test('rich article clipboard HTML preserves basic formatting without running HTML', () => {
  const html = renderMarkdown('# Title\n\n**Bold** and [link](https://x.com)\n\n- item\n\n<script>alert(1)</script>');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<li>item<\/li>/);
  assert.doesNotMatch(html, /<script>/);
});
