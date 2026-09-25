// Local MDX (MDict v2) reader. Read-only random access; nothing is uploaded, nothing is cached
// outside the caller's own storage. Supports:
//   * zlib-compressed key blocks and record blocks
//   * keyword-index encryption (Encrypted="2"), decrypted via RIPEMD-128 of the block checksum
// Reports the real reason and refuses to continue when a file is encrypted in a way that needs
// a registration code, or uses an unsupported compression / engine version.
import { ripemd128 } from './ripemd128.js';
import {
  MdxError, adler32, concatBytes, decompressBlock, fastDecrypt, inflate, parseBlockHeader
} from './mdx-format.js';

const KEY_SECTION_HEADER_SIZE = 44; // 5 x 8 bytes + 4 byte checksum
const RECORD_SECTION_HEADER_SIZE = 32;

/**
 * @typedef {Object} RandomAccess
 * @property {number} size
 * @property {(offset:number, length:number) => Promise<Uint8Array>} read
 */

/** Random access over a browser File/Blob. */
export function blobRandomAccess(file) {
  return {
    size: file.size,
    name: file.name || '',
    async read(offset, length) {
      const slice = file.slice(offset, offset + length);
      return new Uint8Array(await slice.arrayBuffer());
    }
  };
}

function parseHeaderAttributes(text) {
  const attrs = {};
  for (const match of text.matchAll(/(\w+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export class MdxReader {
  constructor(randomAccess) {
    if (!randomAccess || typeof randomAccess.read !== 'function') {
      throw new MdxError('缺少可读的词典文件。', 'no-source');
    }
    this.ra = randomAccess;
    this.meta = null;
    this.keyBlocks = [];
    this.recordBlocks = [];
    this.recordBlocksStart = 0;
    this.totalRecordDecompressed = 0;
  }

  async open() {
    const { ra } = this;
    if (!ra.size || ra.size < 64) throw new MdxError('文件太小，不是有效的 MDX 词典。', 'not-mdx');

    // --- header ---------------------------------------------------------
    const first4 = await ra.read(0, 4);
    const candidates = [be32(first4), le32(first4)];
    let headerLength = 0;
    for (const candidate of candidates) {
      if (candidate < 16 || candidate + 8 > ra.size) continue;
      const text = await ra.read(4, candidate);
      const stored = await ra.read(4 + candidate, 4);
      if (le32(stored) === adler32(text)) { headerLength = candidate; break; }
    }
    if (!headerLength) {
      throw new MdxError('无法识别文件头：这不是 MDX 词典，或文件已损坏/被截断。', 'not-mdx');
    }
    const headerText = utf16le(await ra.read(4, headerLength));
    const attrs = parseHeaderAttributes(headerText);
    if (!attrs.GeneratedByEngineVersion && !attrs.RequiredEngineVersion) {
      throw new MdxError('文件头里没有 MDX 词典信息。请确认选择的是 .mdx 文件，而不是 .eubak 配置备份或其它格式。', 'not-mdx');
    }

    const engineVersion = Number(attrs.RequiredEngineVersion || attrs.GeneratedByEngineVersion || 2);
    if (engineVersion >= 3) {
      throw new MdxError(
        `这是 MDX 3.0 词典（RequiredEngineVersion=${attrs.RequiredEngineVersion}），当前实现只解析 2.0 格式。`,
        'unsupported-version'
      );
    }

    const encrypted = Number(attrs.Encrypted || 0);
    this.meta = {
      name: ra.name || '',
      title: attrs.Title || '',
      description: decodeEntities(attrs.Description || '').replace(/<br\s*\/?>/gi, ' ').trim(),
      engineVersion,
      encoding: normalizeEncodingName(attrs.Encoding),
      format: attrs.Format || 'Html',
      encrypted,
      keyIndexEncrypted: (encrypted & 2) !== 0,
      keywordHeaderEncrypted: (encrypted & 1) !== 0,
      stripKey: String(attrs.StripKey || 'No').toLowerCase() === 'yes',
      // Actual values are filled in below.
      numEntries: 0,
      numKeyBlocks: 0,
      numRecordBlocks: 0,
      recordBytes: 0,
      fileSize: ra.size
    };

    // --- keyword section ------------------------------------------------
    const keySection = 4 + headerLength + 4;
    if ((encrypted & 1) !== 0) {
      throw new MdxError(
        '该词典的关键词区头信息被 Salsa20/8 加密（Encrypted 最低位为 1），需要词典作者的注册码与注册邮箱/设备 ID 才能解开。当前实现不做绕过。',
        'encrypted-keyword-header'
      );
    }
    const keyHead = await ra.read(keySection, KEY_SECTION_HEADER_SIZE);
    if (keyHead.length < KEY_SECTION_HEADER_SIZE) throw new MdxError('关键词区被截断，文件不完整。', 'corrupt');

    this.meta.numKeyBlocks = Number(be64(keyHead, 0));
    this.meta.numEntries = Number(be64(keyHead, 8));
    const keyIndexDecompLen = Number(be64(keyHead, 16));
    const keyIndexCompLen = Number(be64(keyHead, 24));
    const keyBlocksLen = Number(be64(keyHead, 32));

    const keyIndexOffset = keySection + KEY_SECTION_HEADER_SIZE;
    const keyBlocksOffset = keyIndexOffset + keyIndexCompLen;
    const recordSectionOffset = keyBlocksOffset + keyBlocksLen;
    if (recordSectionOffset > ra.size) {
      throw new MdxError('关键词区长度超出文件大小，文件可能被截断或损坏。', 'corrupt');
    }

    const keyIndexRaw = await ra.read(keyIndexOffset, keyIndexCompLen);
    this.keyBlocks = await this.#decodeKeyIndex(keyIndexRaw, keyIndexDecompLen, keyIndexCompLen);
    this.keyBlocksOffset = keyBlocksOffset;
    if (this.keyBlocks.length !== this.meta.numKeyBlocks) {
      throw new MdxError(
        `关键词索引条目数（${this.keyBlocks.length}）与文件声明的块数（${this.meta.numKeyBlocks}）不一致，文件可能损坏。`,
        'corrupt'
      );
    }

    // --- record section -------------------------------------------------
    const recordHead = await ra.read(recordSectionOffset, RECORD_SECTION_HEADER_SIZE);
    if (recordHead.length < RECORD_SECTION_HEADER_SIZE) throw new MdxError('释义区被截断，文件不完整。', 'corrupt');
    const numRecordBlocks = Number(be64(recordHead, 0));
    const numRecordEntries = Number(be64(recordHead, 8));
    const recordIndexLen = Number(be64(recordHead, 16));
    const recordBlocksLen = Number(be64(recordHead, 24));
    if (numRecordEntries !== this.meta.numEntries) {
      throw new MdxError(
        `词条数不一致：关键词区记录 ${this.meta.numEntries} 条，释义区记录 ${numRecordEntries} 条。文件可能损坏。`,
        'corrupt'
      );
    }
    if (recordIndexLen !== numRecordBlocks * 16) {
      throw new MdxError(
        `释义索引长度 ${recordIndexLen} 与块数 ${numRecordBlocks} 不匹配（应为 ${numRecordBlocks * 16}），文件可能损坏。`,
        'corrupt'
      );
    }
    this.meta.numRecordBlocks = numRecordBlocks;
    this.meta.recordBytes = recordBlocksLen;

    const recordIndexRaw = await ra.read(recordSectionOffset + RECORD_SECTION_HEADER_SIZE, recordIndexLen);
    if (recordIndexRaw.length < recordIndexLen) throw new MdxError('释义索引被截断，文件不完整。', 'corrupt');
    let compRunning = 0;
    let decompRunning = 0;
    this.recordBlocks = [];
    for (let i = 0; i < numRecordBlocks; i++) {
      const compSize = Number(be64(recordIndexRaw, i * 16));
      const decompSize = Number(be64(recordIndexRaw, i * 16 + 8));
      // compOffset = where the block lives in the file; decompStart = where it starts
      // inside the concatenated decompressed record stream referenced by headwords.
      this.recordBlocks.push({ index: i, compOffset: compRunning, decompStart: decompRunning, compSize, decompSize });
      compRunning += compSize;
      decompRunning += decompSize;
    }
    this.totalRecordDecompressed = decompRunning;
    this.meta.recordDecompressedBytes = decompRunning;
    this.recordBlocksStart = recordSectionOffset + RECORD_SECTION_HEADER_SIZE + recordIndexLen;
    if (this.recordBlocksStart + recordBlocksLen > ra.size + 16) {
      throw new MdxError('释义区长度超出文件大小，文件可能被截断或损坏。', 'corrupt');
    }
    return this;
  }

  async #decodeKeyIndex(raw, decompLen, compLen) {
    if (raw.length < 8) throw new MdxError('关键词索引为空。', 'corrupt');
    const { compression, encryption } = parseBlockHeader(raw.subarray(0, 4));
    if (encryption > 1) {
      throw new MdxError('关键词索引使用了 Salsa20 加密，需要注册码。', 'encrypted-keyword-header');
    }
    let body = raw.subarray(8, compLen);
    if (encryption === 1 || this.meta.keyIndexEncrypted) {
      const checksum = raw.subarray(4, 8);
      const key = ripemd128(concatBytes(checksum, new Uint8Array([0x95, 0x36, 0x00, 0x00])));
      body = fastDecrypt(body, key);
    }
    if (compression === 1) throw new MdxError('关键词索引使用 LZO 压缩，当前实现只支持 zlib。', 'unsupported-compression');
    if (compression !== 0 && compression !== 2) {
      throw new MdxError(`关键词索引使用了未知压缩方式（编号 ${compression}）。`, 'unsupported-compression');
    }
    const flat = compression === 2 ? await inflate(body) : body;
    if (decompLen && flat.length !== decompLen) {
      throw new MdxError(
        `关键词索引解压后长度 ${flat.length} 与声明的 ${decompLen} 不一致，可能遇到了不支持的加密或文件损坏。`,
        'decrypt-failed'
      );
    }
    const storedChecksum = be32(raw.subarray(4, 8));
    if (storedChecksum && adler32(flat) !== storedChecksum) {
      throw new MdxError('关键词索引校验失败，解密结果与文件记录不一致。', 'decrypt-failed');
    }
    return parseKeyIndex(flat, this.meta.numKeyBlocks, this.meta.encoding);
  }

  /** Yield headwords block by block: [{word, recordOffset}, ...]. */
  async *readKeywordBlocks({ signal } = {}) {
    let cursor = this.keyBlocksOffset;
    for (const block of this.keyBlocks) {
      if (signal?.aborted) return;
      const raw = await this.ra.read(cursor, block.compSize);
      const flat = await decompressBlock(raw, null);
      if (flat.length !== block.decompSize) {
        throw new MdxError(`关键词块解压后长度 ${flat.length} 与声明的 ${block.decompSize} 不一致。`, 'corrupt');
      }
      yield { block, keywords: parseKeywordBlock(flat, block.count, this.meta.encoding) };
      cursor += block.compSize;
    }
  }

  /** All record blocks in file order. Each `flat` is the decompressed concatenation slice. */
  async *readRecordBlocks({ signal } = {}) {
    let cursor = this.recordBlocksStart;
    for (const block of this.recordBlocks) {
      if (signal?.aborted) return;
      const raw = await this.ra.read(cursor, block.compSize);
      const flat = await decompressBlock(raw, null);
      if (flat.length !== block.decompSize) {
        throw new MdxError(`释义块 ${block.index} 解压后长度 ${flat.length} 与声明的 ${block.decompSize} 不一致。`, 'corrupt');
      }
      yield { block, flat };
      cursor += block.compSize;
    }
  }

  /**
   * Split one decompressed record block into its entries. Records are stored back to back,
   * each terminated by a null (1 byte for UTF-8, 2 for UTF-16). Offsets are absolute in the
   * concatenated decompressed stream, i.e. the values stored with each headword.
   */
  extractRecords(block, flat) {
    const wide = this.meta.encoding === 'utf-16le';
    const records = [];
    let p = 0;
    while (p < flat.length) {
      let end = p;
      if (wide) {
        while (end + 1 < flat.length && !(flat[end] === 0 && flat[end + 1] === 0)) end += 2;
      } else {
        while (end < flat.length && flat[end] !== 0) end++;
      }
      records.push({ offset: block.decompStart + p, text: decodeText(flat.subarray(p, end), this.meta.encoding) });
      p = end + (wide ? 2 : 1);
    }
    return records;
  }

  /** Read one entry: recordOffset is the offset into the concatenated decompressed records. */
  async readRecord(recordOffset) {
    const block = this.#recordBlockFor(recordOffset);
    const cursor = this.recordBlocksStart + block.compOffset;
    const raw = await this.ra.read(cursor, block.compSize);
    const flat = await decompressBlock(raw, null);
    const start = recordOffset - block.decompStart;
    if (start < 0 || start >= flat.length) return '';
    const terminatorLength = this.meta.encoding === 'utf-16le' ? 2 : 1;
    let end = start;
    if (terminatorLength === 1) {
      while (end < flat.length && flat[end] !== 0) end++;
    } else {
      while (end + 1 < flat.length && !(flat[end] === 0 && flat[end + 1] === 0)) end += 2;
    }
    return decodeText(flat.subarray(start, end), this.meta.encoding);
  }

  #recordBlockFor(recordOffset) {
    // Linear scan is fine for a few thousand blocks; binary search for larger files.
    let low = 0;
    let high = this.recordBlocks.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const block = this.recordBlocks[mid];
      if (recordOffset < block.decompStart) high = mid - 1;
      else if (recordOffset >= block.decompStart + block.decompSize) low = mid + 1;
      else return block;
    }
    return null;
  }
}

/**
 * The keyword index stores, per key block:
 *   8B entries | 2B first-key length | first key | terminator
 *              | 2B last-key length  | last key  | terminator
 *   8B compressed size | 8B decompressed size
 * Different producers write UTF-8 + 1-byte terminator or UTF-16LE + 2-byte terminator,
 * so both are attempted and the one that consumes the block exactly is used.
 */
function parseKeyIndex(flat, numBlocks, encoding) {
  const attempts = [];
  if (encoding !== 'utf-16le') attempts.push({ encoding: 'utf-8', terminator: 1 });
  attempts.push({ encoding: 'utf-16le', terminator: 2 });
  let best = null;
  for (const attempt of attempts) {
    const parsed = tryParseKeyIndex(flat, numBlocks, attempt);
    if (parsed.blocks.length === numBlocks && parsed.consumed === flat.length) return parsed.blocks;
    if (!best || parsed.blocks.length > best.blocks.length) best = parsed;
  }
  return best.blocks;
}

function tryParseKeyIndex(flat, numBlocks, { encoding, terminator }) {
  const blocks = [];
  let p = 0;
  for (let i = 0; i < numBlocks; i++) {
    if (p + 8 > flat.length) break;
    const count = Number(be64(flat, p)); p += 8;
    const firstKey = readIndexString(flat, p, encoding, terminator); p = firstKey.next;
    const lastKey = readIndexString(flat, p, encoding, terminator); p = lastKey.next;
    if (p + 16 > flat.length) break;
    const compSize = Number(be64(flat, p)); p += 8;
    const decompSize = Number(be64(flat, p)); p += 8;
    blocks.push({ index: i, count, firstKey: firstKey.value, lastKey: lastKey.value, compSize, decompSize });
  }
  return { blocks, consumed: p };
}

function readIndexString(flat, p, encoding, terminator) {
  if (p + 2 > flat.length) return { value: '', next: flat.length + 1 };
  const length = (flat[p] << 8) | flat[p + 1];
  const start = p + 2;
  const end = Math.min(start + length, flat.length);
  return { value: decodeText(flat.subarray(start, end), encoding), next: end + terminator };
}

function parseKeywordBlock(flat, count, encoding) {
  const keywords = [];
  const wide = encoding === 'utf-16le';
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 8 > flat.length) break;
    const recordOffset = Number(be64(flat, p));
    p += 8;
    let end = p;
    if (wide) {
      while (end + 1 < flat.length && !(flat[end] === 0 && flat[end + 1] === 0)) end += 2;
    } else {
      while (end < flat.length && flat[end] !== 0) end++;
    }
    keywords.push({ word: decodeText(flat.subarray(p, end), encoding), recordOffset });
    p = end + (wide ? 2 : 1);
    if (p > flat.length) break;
  }
  return keywords;
}

function normalizeEncodingName(value) {
  const name = String(value || 'UTF-8').toLowerCase().replace(/[-_]/g, '');
  if (name.includes('utf16')) return 'utf-16le';
  if (name.includes('gb') || name.includes('gbk') || name.includes('gb18030')) return 'gb18030';
  return 'utf-8';
}

function decodeText(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function utf16le(bytes) {
  let text = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  return text;
}

function be32(bytes) {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}
function le32(bytes) {
  return ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0]) >>> 0;
}
function be64(bytes, offset = 0) {
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}
