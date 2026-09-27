import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function host() {
  const calls = [];
  const listeners = {};
  let scanAgain;
  const textNode = { innerText: 'First post', textContent: 'First post', appendChild() {} };
  const link = { getAttribute: () => '/writer/status/111' };
  const article = {
    dataset: {},
    querySelector(selector) {
      if (selector === '[data-testid="tweetText"]') return textNode;
      if (selector === '.bx-entries') return {};
      if (selector === '[role="group"]') return textNode;
      return null;
    },
    querySelectorAll: () => [link]
  };
  const location = { href: 'https://x.com/writer/status/111' };
  const key = url => String(url).match(/\/status\/(\d+)/)?.[1] || '';
  const bx = {
    state: { post: null },
    util: { isEditor: () => false, postFrom: () => ({ url: 'https://x.com/writer/status/111', text: textNode.innerText, author: 'Writer' }) },
    notifyArticle() {}, notifyEditor() {}, applySettings() {}, openForPost() {},
    setPost(post, options) { calls.push({ post, options }); this.state.post = post; },
    element: { classList: { contains: () => false } },
    send: async () => ({}), awaitSettings() {}, refresh() {}
  };
  const window = { BX: bx, BXContext: { key, canonical: url => url }, addEventListener(name, fn) { listeners[name] = fn; } };
  const document = { body: {}, querySelectorAll: () => [article], addEventListener() {} };
  class MutationObserver { constructor(callback) { scanAgain = callback; } observe() {} }
  runInNewContext(source, { window, document, location, MutationObserver, chrome: { runtime: { onMessage: { addListener() {} } } }, setInterval() {}, setTimeout: fn => fn(), clearTimeout() {} });
  return { calls, listeners, location, textNode, selectPost: post => { bx.state.post = post; }, scan: () => scanAgain() };
}

test('rescanning the same post keeps its active session and requests', () => {
  const page = host();
  const initial = page.calls.length;
  page.scan();
  page.scan();
  assert.equal(page.calls.length, initial);
});

test('leaving a post route clears its previous context', () => {
  const page = host();
  page.location.href = 'https://x.com/home';
  page.listeners.popstate();
  assert.equal(page.calls.at(-1).post, null);
});

test('navigating between non-post routes clears a manually selected post', () => {
  const page = host();
  page.location.href = 'https://x.com/home';
  page.listeners.popstate();
  // Select a post on a timeline, then navigate to a long article route.
  page.selectPost({ url: 'https://x.com/writer/status/111', text: 'Selected on timeline' });
  page.location.href = 'https://x.com/explore';
  page.listeners.popstate();
  assert.equal(page.calls.at(-1).post, null);
});
