// Builds a small but structurally real MDX v2 file so reader/indexer/lookup can be tested
// without shipping the 193 MB dictionary. Mirrors the layout verified against LDOCE5++.
import { deflateSync } from 'node:zlib';
import { ripemd128 } from '../mdx/ripemd128.js';
import { fastEncrypt } from '../mdx/mdx-format.js';

const HEADER_ATTRS = {
  GeneratedByEngineVersion: '2.0',
  RequiredEngineVersion: '2.0',
  Format: 'Html',
  KeyCaseSensitive: 'No',
  StripKey: 'Yes',
  Encrypted: '2',
  RegisterBy: 'EMail',
  Description: 'Test dictionary',
  Title: 'Fixture Dictionary',
  Encoding: 'UTF-8',
  CreationDate: '2026-1-1',
  Compact: 'Yes',
  Compat: 'Yes',
  Left2Right: 'Yes',
  DataSourceFormat: '106',
  StyleSheet: ''
};

function adler32(bytes) {
  let a = 1, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function u32be(value) {
  return Buffer.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
function u32le(value) {
  return Buffer.from([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}
function u64be(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}
function u16be(value) {
  return Buffer.from([(value >> 8) & 255, value & 255]);
}

/** One compressed block: [4B comp type][4B adler32 of plaintext][deflate data] */
function makeBlock(plain, { encrypt = false, key = null } = {}) {
  let body = deflateSync(plain);
  if (encrypt) body = Buffer.from(fastEncrypt(body, key));
  const checksum = u32be(adler32(plain));
  return { bytes: Buffer.concat([u32le(2), checksum, body]), checksum };
}

export function buildMdx(entries, { encrypted = 2, title = 'Fixture Dictionary', engine = '2.0' } = {}) {
  const attrs = {
    ...HEADER_ATTRS, Encrypted: String(encrypted), Title: title,
    GeneratedByEngineVersion: engine, RequiredEngineVersion: engine
  };
  const headerText = Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ') + '/>\r\n\x00';
  const headerBytes = Buffer.from(headerText, 'utf16le');

  // --- records: one block holding every entry, each null terminated ----------
  const recordParts = [];
  const recordOffsets = [];
  let cursor = 0;
  for (const entry of entries) {
    recordOffsets.push(cursor);
    const part = Buffer.from(`${entry.html}\0`, 'utf8');
    recordParts.push(part);
    cursor += part.length;
  }
  const recordPlain = Buffer.concat(recordParts);
  const recordBlock = makeBlock(recordPlain);

  // --- keywords: one block, [8B record offset][word]\0 -----------------------
  const keywordParts = [];
  entries.forEach((entry, index) => {
    keywordParts.push(u64be(recordOffsets[index]), Buffer.from(`${entry.word}\0`, 'utf8'));
  });
  const keywordPlain = Buffer.concat(keywordParts);
  const keywordBlock = makeBlock(keywordPlain);

  // --- keyword index ---------------------------------------------------------
  const firstWord = entries[0].word;
  const lastWord = entries[entries.length - 1].word;
  const indexPlain = Buffer.concat([
    u64be(entries.length),
    u16be(Buffer.byteLength(firstWord, 'utf8')), Buffer.from(firstWord, 'utf8'), Buffer.from([0]),
    u16be(Buffer.byteLength(lastWord, 'utf8')), Buffer.from(lastWord, 'utf8'), Buffer.from([0]),
    u64be(keywordBlock.bytes.length), u64be(keywordPlain.length)
  ]);
  const indexKey = ripemd128(Buffer.concat([u32be(adler32(indexPlain)), Buffer.from([0x95, 0x36, 0x00, 0x00])]));
  const indexBlock = makeBlock(indexPlain, { encrypt: (encrypted & 2) !== 0, key: indexKey });

  // --- assemble --------------------------------------------------------------
  const keySectionHeader = Buffer.concat([
    u64be(1), u64be(entries.length),
    u64be(indexPlain.length), u64be(indexBlock.bytes.length),
    u64be(keywordBlock.bytes.length)
  ]);
  const keySectionChecksum = u32be(adler32(keySectionHeader));
  const recordIndex = Buffer.concat([u64be(recordBlock.bytes.length), u64be(recordPlain.length)]);
  const recordHeader = Buffer.concat([
    u64be(1), u64be(entries.length), u64be(recordIndex.length), u64be(recordBlock.bytes.length)
  ]);

  return Buffer.concat([
    u32be(headerBytes.length), headerBytes, u32le(adler32(headerBytes)),
    keySectionHeader, keySectionChecksum, indexBlock.bytes, keywordBlock.bytes,
    recordHeader, recordIndex, recordBlock.bytes
  ]);
}

/** Wrap bytes as something that behaves like a picked File for blobRandomAccess. */
export function asFile(bytes, name = 'fixture.mdx') {
  const blob = new Blob([bytes]);
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

export function entryHtml(word, { pos = 'n.', defZh = '测试释义', defEn = 'test definition', examples = ['an example sentence'] } = {}) {
  return `<link href="style.css" rel="stylesheet"/><script src="x.js"></script>
<span class="HWD">${word}</span><span class="PRON">test</span>
<span class="Sense"><span class="lm5pp_POS">${pos}</span><span class="DEF">${defEn}</span>
<span class="cn_txt">${defZh}</span>${examples.map(example => `<span class="exa">${example}</span>`).join('')}</span>
<a class="speaker" href="sound://${encodeURIComponent(word)}.spx">发音</a><img src="${word}.png"/>`;
}
