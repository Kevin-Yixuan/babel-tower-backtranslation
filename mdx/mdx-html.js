// Entry HTML handling: tokenize, sanitize, and extract 释义 / 词性 / 例句.
// No DOM: this has to run inside an MV3 service worker as well as in Node tests.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'span', 'div', 'b', 'strong', 'i', 'em', 'u', 'small', 'sup', 'sub',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th'
]);
const SAFE_ATTRIBUTES = new Set(['class', 'title', 'href', 'lang']);
const SAFE_URL = /^(?:#|entry:\/\/|sound:\/\/|https?:\/\/|mailto:|\/|\.{1,2}\/)/i;
const DANGEROUS_URL = /^\s*(?:javascript|data|vbscript|file):/i;

// ---------------------------------------------------------------- tokenizing

export function tokenizeHtml(html) {
  const tokens = [];
  let i = 0;
  const source = String(html || '');
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      if (i < source.length) tokens.push({ type: 'text', text: source.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', text: source.slice(i, lt) });
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      const stop = end < 0 ? source.length : end + 3;
      tokens.push({ type: 'comment', text: source.slice(lt, stop) });
      i = stop;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    const gt = findTagEnd(source, lt);
    if (gt < 0) { i = source.length; break; }
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;
    const closing = raw.startsWith('/');
    const nameMatch = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const selfClosing = /\/\s*$/.test(raw) || ['br', 'img', 'input', 'hr', 'meta', 'link', 'source'].includes(name);
    tokens.push({ type: 'tag', name, closing, selfClosing, attrs: parseAttributes(raw) });
  }
  return tokens;
}

function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '>') return i;
  }
  return -1;
}

function parseAttributes(raw) {
  const attrs = {};
  for (const match of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- tree build

export function buildTree(tokens) {
  const root = { type: 'root', name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col']);
  for (const token of tokens) {
    if (token.type === 'text') {
      stack[stack.length - 1].children.push({ type: 'text', text: token.text, parent: stack[stack.length - 1] });
      continue;
    }
    if (token.type !== 'tag') continue;
    if (token.closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === token.name) { stack.length = i; break; }
      }
      continue;
    }
    const node = { type: 'element', name: token.name, attrs: token.attrs || {}, children: [], parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (!token.selfClosing && !VOID.has(token.name)) stack.push(node);
  }
  return root;
}

export function parseFragment(html) {
  return buildTree(tokenizeHtml(html));
}

export function classesOf(node) {
  return String(node?.attrs?.class || '').split(/\s+/).filter(Boolean);
}

export function hasClass(node, name) {
  return classesOf(node).includes(name);
}

export function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  let out = '';
  for (const child of node.children || []) out += textOf(child);
  return out;
}

export function normalizeText(value) {
  return decodeEntities(textOf({ type: 'element', children: [{ type: 'text', text: String(value ?? '') }] }))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function plainText(node) {
  return normalizeText(textOf(node));
}

export function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) if (child.type === 'element') walk(child, visit);
}

export function findAll(node, predicate) {
  const out = [];
  walk(node, item => { if (item.type === 'element' && predicate(item)) out.push(item); });
  return out;
}

export function findFirst(node, predicate) {
  let found = null;
  walk(node, item => { if (!found && item.type === 'element' && predicate(item)) found = item; });
  return found;
}

// ---------------------------------------------------------------- sanitizing

/** Count media references without rendering anything - used by the compact import mode. */
export function countMedia(root) {
  const media = { images: 0, audio: 0 };
  walk(root, node => {
    if (node.type !== 'element') return;
    if (node.name === 'img') media.images++;
    else if (node.name === 'source' || node.name === 'audio' || node.name === 'video') media.audio++;
    else if (/sound:\/\/|\.(?:mp3|spx|wav|ogg|m4a)\b/i.test(node.attrs?.href || '')) media.audio++;
  });
  return media;
}

/**
 * Rebuild the entry as a safe subset: no script/style/link/form/iframe, no event handlers,
 * no javascript:/data: URLs. Media references are reported but rendered as a visible note
 * when the companion .mdd resource file is missing.
 * @param {Object} root a tree from parseFragment (reused so entries are parsed once)
 */
export function sanitizeEntry(root, { hasResourceFile = false, maxLength = 12000 } = {}) {
  const media = { images: 0, audio: 0 };
  const parts = [];
  const emit = node => {
    for (const child of node.children || []) {
      if (child.type === 'text') { parts.push(escapeText(child.text)); continue; }
      if (child.type !== 'element') continue;
      const name = child.name;
      if (['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'base'].includes(name)) continue;
      if (name === 'img') {
        media.images++;
        parts.push(`<span class="mdx-missing-media">[图片资源不可用：未提供 ${hasResourceFile ? '对应' : ''}.mdd 资源文件]</span>`);
        continue;
      }
      if (name === 'source' || name === 'audio' || name === 'video') { media.audio++; continue; }
      const href = child.attrs?.href || '';
      if (name === 'a') {
        if (/sound:\/\/|\.(?:mp3|spx|wav|ogg|m4a)\b/i.test(href)) {
          media.audio++;
          parts.push(`<span class="mdx-missing-media">[音频不可用：未提供 .mdd 资源文件]</span>`);
          continue;
        }
        if (!href || DANGEROUS_URL.test(href)) { emitChildren(child); continue; }
        const safeHref = SAFE_URL.test(href) ? href : '#';
        const label = escapeText(plainText(child));
        if (!label) { emitChildren(child); continue; }
        // Policy: remote http(s) links survive, but are only contacted when the user clicks
        // them (new tab, no opener). Nothing in an entry auto-loads remote content: images,
        // styles and event handlers are stripped above regardless.
        const external = /^https?:/i.test(safeHref);
        const externalAttrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
        parts.push(`<a href="${escapeAttribute(safeHref)}" title="${escapeAttribute(label)}"${externalAttrs}>${label}</a>`);
        continue;
      }
      if (!ALLOWED_TAGS.has(name)) { emitChildren(child); continue; }
      const attrs = [];
      for (const [key, value] of Object.entries(child.attrs || {})) {
        if (/^on/i.test(key)) continue;
        if (key === 'src') { media.images++; continue; }
        if (!SAFE_ATTRIBUTES.has(key)) continue;
        if (key === 'href' && (DANGEROUS_URL.test(value) || !SAFE_URL.test(value))) continue;
        if (key === 'style') continue;
        attrs.push(` ${key}="${escapeAttribute(value)}"`);
      }
      parts.push(`<${name}${attrs.join('')}>${renderChildren(child)}</${name}>`);
    }
  };
  const emitChildren = child => { for (const grand of child.children || []) emit({ type: 'root', children: [grand] }); };
  const renderChildren = node => {
    const saved = parts.length;
    emit(node);
    return parts.splice(saved).join('');
  };
  // Remove empty / decorative spans that only carry switch-language chrome.
  emit(root);
  let out = parts.join('').replace(/\s+/g, ' ');
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
  return { html: out, media };
}

/** Convenience wrapper when the caller only has the raw HTML string. */
export function sanitizeEntryHtml(html, options = {}) {
  return sanitizeEntry(parseFragment(html), options);
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}
function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- extraction

const REDIRECT = /^\s*@@@LINK=(.+?)\s*$/;

/** True when the raw record is an internal redirect instead of a real entry. */
export function redirectTarget(rawHtml) {
  const match = REDIRECT.exec(String(rawHtml || '').trim());
  return match ? match[1].trim() : null;
}

const SENSE_CLASSES = ['Sense', 'Subsense', 'sense', 'subsense'];
// exaGroup is a container that repeats the individual examples inside it, so it is excluded.
const EXAMPLE_CLASSES = ['exa', 'EXAMPLE', 'cexa1', 'cexa2', 'ColloExa', 'GramExa'];
const POS_CLASSES = ['lm5pp_POS', 'pos', 'POS'];

// LDOCE5++ prints the part of speech once per section, inside the entry's Head / Run-On block
// and *outside* the individual Sense nodes (checked against the real 193 MB dictionary:
// "dictionary" has one lm5pp_POS "noun" above all of its senses). Word-family boxes and
// related-word popups also carry POS markup but describe *other* entries, so only Head /
// Run-On markers inside the same div.dictionary scope are inherited.
const POS_NOISE = [
  [/phrasal\s+verb\s*phr\s*v$/i, 'phrasal verb'],
  [/adjective\s*adj$/i, 'adjective'],
  [/adverb\s*adv$/i, 'adverb'],
  [/noun\s*n$/i, 'noun'],
  [/verb\s*v$/i, 'verb'],
  [/conjunction\s*conj$/i, 'conjunction'],
  [/preposition\s*prep$/i, 'preposition'],
  [/pronoun\s*pron$/i, 'pronoun']
];

/** Strip the EN label + abbreviation doubling some LDOCE POS texts ship with ("adjectiveadj"). */
export function cleanPos(text) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of POS_NOISE) {
    if (pattern.test(value)) { value = value.replace(pattern, replacement); break; }
  }
  return value.length > 200 ? value.slice(0, 200) : value;
}

function ancestorWithClass(node, name) {
  let current = node?.parent;
  while (current && current.type === 'element') {
    if (hasClass(current, name)) return current;
    current = current.parent;
  }
  return null;
}

function hasAncestor(node, predicate) {
  let current = node?.parent;
  while (current && current.type === 'element') {
    if (predicate(current)) return true;
    current = current.parent;
  }
  return false;
}

/** POS markers that govern a whole section (inside Head / Run-On), in document order. */
function collectSectionPos(byClass) {
  const out = [];
  for (const name of POS_CLASSES) {
    for (const item of byClass.get(name) || []) {
      if (!hasAncestor(item.node, candidate => hasClass(candidate, 'Head') || hasClass(candidate, 'RunOn'))) continue;
      out.push({
        i: item.i,
        scope: ancestorWithClass(item.node, 'dictionary'),
        text: cleanPos(plainText(item.node))
      });
    }
  }
  return out.sort((a, b) => a.i - b.i);
}

/** Nearest preceding section POS sharing the sense's div.dictionary scope; '' when none. */
function inheritedSectionPos(candidates, senseItem) {
  const scope = ancestorWithClass(senseItem.node, 'dictionary');
  let text = '';
  for (const candidate of candidates) {
    if (candidate.i >= senseItem.i) break;
    if (scope && candidate.scope !== scope) continue;
    if (candidate.text) text = candidate.text;
  }
  return text;
}

/**
 * Extract a compact, display-ready entry: 词性、释义（中/英）、例句.
 * Keeps the useful text and drops the repeated switch-language chrome.
 */
export function extractEntry(rawHtml, {
  hasResourceFile = false, maxSenses = 12, maxExamples = 4, maxSafeHtml = 12000, keepHtml = true
} = {}) {
  const html = String(rawHtml || '').trim();
  const redirect = redirectTarget(html);
  if (redirect) return { redirect, senses: [], text: '', safeHtml: '', media: { images: 0, audio: 0 } };

  // One indexed pass: every element gets a pre-order index and is grouped by class, so each
  // field lookup is a range scan instead of a fresh walk over the whole entry.
  const indexed = indexEntry(html);
  const { root, byClass } = indexed;

  const headword = firstTextIn(byClass, ['HWD', 'hwd', 'headword']);
  const pronunciation = firstTextIn(byClass, ['PRON', 'pron']);

  const sectionPos = collectSectionPos(byClass);
  const senses = [];
  for (const node of outermost(ofClasses(byClass, SENSE_CLASSES))) {
    const ownPos = cleanPos(firstTextIn(byClass, POS_CLASSES, node));
    const signpost = firstTextIn(byClass, ['SIGNPOST', 'signpost'], node);
    const grammar = firstTextIn(byClass, ['GRAM', 'gram'], node);
    const defEn = firstTextIn(byClass, ['DEF', 'def'], node);
    const defZh = firstTextIn(byClass, ['cn_txt'], node);
    const examples = [];
    for (const example of ofClasses(byClass, EXAMPLE_CLASSES, node).sort((a, b) => a.i - b.i)) {
      const text = plainText(example.node);
      if (text.length < 3 || text.length > 300) continue;
      if (!examples.includes(text)) examples.push(text);
      if (examples.length >= maxExamples) break;
    }
    // Inheriting the section POS must not resurrect contentless markup (e.g. an etymology
    // line): the sense still needs its own POS or its own definition/example content.
    if (!ownPos && !defEn && !defZh && !examples.length) continue;
    const pos = ownPos || inheritedSectionPos(sectionPos, node);
    senses.push({ pos, signpost, grammar, defEn, defZh, examples });
    if (senses.length >= maxSenses) break;
  }

  // Fallback for dictionaries that do not use the LDOCE class names.
  if (!senses.length) {
    for (const { node } of ofClasses(byClass, ['def', 'DEF', 'cn_txt', 'ddef']).slice(0, maxSenses)) {
      const text = plainText(node);
      if (text) senses.push({ pos: '', signpost: '', grammar: '', defEn: text, defZh: '', examples: [] });
    }
  }

  // Compact imports skip the sanitized rendering: parsing once keeps big dictionaries fast.
  const rendered = keepHtml ? sanitizeEntry(root, { hasResourceFile, maxLength: maxSafeHtml }) : null;
  return {
    redirect: null,
    headword,
    pronunciation,
    senses,
    text: buildPlainText(headword, pronunciation, senses),
    safeHtml: rendered ? rendered.html : '',
    media: rendered ? rendered.media : indexed.media
  };
}

/**
 * Parse once and index every element by class.
 * Each entry stores { node, i, end } where [i, end) is the element's pre-order subtree range.
 */
function indexEntry(html) {
  const root = parseFragment(html);
  const byClass = new Map();
  const media = { images: 0, audio: 0 };
  let counter = 0;
  const visit = node => {
    const index = counter++;
    if (node.type === 'element') {
      for (const name of classesOf(node)) {
        if (!byClass.has(name)) byClass.set(name, []);
        byClass.get(name).push({ node, i: index });
      }
      if (node.name === 'img') media.images++;
      else if (node.name === 'source' || node.name === 'audio' || node.name === 'video') media.audio++;
      else if (/sound:\/\/|\.(?:mp3|spx|wav|ogg|m4a)\b/i.test(node.attrs?.href || '')) media.audio++;
    }
    for (const child of node.children || []) visit(child);
    if (node.type === 'element') node.end = counter;
  };
  visit(root);
  root.i = 0;
  root.end = counter;
  // Subtree ranges are only known after the walk, so copy them onto the index entries.
  for (const list of byClass.values()) for (const item of list) item.end = item.node.end ?? item.i + 1;
  return { root, byClass, media };
}

/** All elements carrying any of `names`, optionally restricted to a subtree range. */
function ofClasses(byClass, names, scope) {
  const out = [];
  for (const name of names) {
    const list = byClass.get(name);
    if (!list) continue;
    for (const item of list) {
      if (scope && (item.i < scope.i || item.i >= (scope.end ?? Infinity))) continue;
      out.push(item);
    }
  }
  return out;
}

/** Drop candidates nested inside another candidate, so senses are not double counted. */
function outermost(items) {
  const sorted = [...items].sort((a, b) => a.i - b.i || (b.end ?? 0) - (a.end ?? 0));
  const out = [];
  let limit = -1;
  for (const item of sorted) {
    if (item.i < limit) continue;
    out.push(item);
    limit = item.end ?? item.i + 1;
  }
  return out;
}

/** First element with one of `names`; `scope` limits it to that element's subtree. */
function firstTextIn(byClass, names, scope) {
  const start = scope ? scope.i : -Infinity;
  const end = scope ? (scope.end ?? Infinity) : Infinity;
  let best = null;
  for (const name of names) {
    const list = byClass.get(name);
    if (!list) continue;
    for (const item of list) {
      if (item.i < start) continue;
      if (item.i >= end) break;
      if (!best || item.i < best.i) best = item;
      break;
    }
  }
  const text = best ? plainText(best.node) : '';
  return text.length > 200 ? text.slice(0, 200) : text;
}

function buildPlainText(headword, pronunciation, senses) {
  const lines = [];
  if (headword) lines.push(headword);
  if (pronunciation) lines.push(`/${pronunciation}/`);
  senses.forEach((sense, index) => {
    const head = [sense.pos, sense.signpost, sense.grammar].filter(Boolean).join(' · ');
    const body = [sense.defZh, sense.defEn].filter(Boolean).join(' ');
    lines.push(`${index + 1}. ${[head, body].filter(Boolean).join(' — ')}`);
    for (const example of sense.examples) lines.push(`  例：${example}`);
  });
  return lines.join('\n').trim();
}
