// Binary helpers shared by the MDX reader: checksums, decompression and the
// MDX "fast decrypt" stream cipher. Works unchanged in Chrome and in Node.

export function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate a zlib-wrapped deflate stream. Uses the platform stream API. */
export async function inflate(bytes) {
  try {
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const { inflateSync } = await import('node:zlib');
    return new Uint8Array(inflateSync(bytes));
  } catch {
    throw new MdxError(
      '数据块解压失败。文件可能已损坏，或使用了本实现不支持的加密 / 压缩方式。',
      'decompress-failed'
    );
  }
}

/**
 * MDX keyword-index stream cipher.
 * Verified against the real LDOCE5++ file: `swapFirst` is the correct order.
 *   plain[i] = swapNibble(cipher[i]) ^ prev ^ (i & 0xff) ^ key[i % 16],  prev starts at 0x36
 */
export function fastDecrypt(data, key) {
  const out = new Uint8Array(data);
  let previous = 0x36;
  for (let i = 0; i < out.length; i++) {
    let t = ((out[i] >> 4) | (out[i] << 4)) & 0xff;
    t ^= previous;
    t ^= i & 0xff;
    t ^= key[i % key.length];
    previous = out[i];
    out[i] = t & 0xff;
  }
  return out;
}

/**
 * Inverse of fastDecrypt: cipher[i] = swap(plain[i] ^ cipher[i-1] ^ i ^ key[i % 16]).
 * Only needed to build/verify MDX files (the test fixture); readers use fastDecrypt.
 */
export function fastEncrypt(data, key) {
  const out = new Uint8Array(data.length);
  let previous = 0x36;
  for (let i = 0; i < data.length; i++) {
    const mixed = (data[i] ^ previous ^ (i & 0xff) ^ key[i % key.length]) & 0xff;
    const cipher = ((mixed >> 4) | (mixed << 4)) & 0xff;
    out[i] = cipher;
    previous = cipher;
  }
  return out;
}

/**
 * A compressed/encrypted block starts with 4 bytes.
 * Low nibble = compression (0 none / 1 LZO / 2 zlib), high nibble = encryption method.
 */
export function parseBlockHeader(bytes) {
  const value = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  return { compression: value & 0xf, encryption: (value >> 4) & 0xf };
}

export const COMPRESSION = { NONE: 0, LZO: 1, ZLIB: 2 };

export class MdxError extends Error {
  constructor(message, reason = 'unknown') {
    super(message);
    this.name = 'MdxError';
    this.reason = reason;
  }
}

export async function decompressBlock(raw, key) {
  const { compression, encryption } = parseBlockHeader(raw.subarray(0, 4));
  if (encryption === 1) {
    if (!key) throw new MdxError('该数据块使用了 MDX 快速加密，但缺少解密密钥。', 'block-encrypted');
  } else if (encryption > 1) {
    throw new MdxError(`该数据块使用了不支持的加密方式（编号 ${encryption}，Salsa20 需要词典注册码）。`, 'block-encrypted');
  }
  let body = raw.subarray(8);
  if (encryption === 1) body = fastDecrypt(body, key);
  if (compression === COMPRESSION.NONE) return body.slice();
  if (compression === COMPRESSION.ZLIB) return inflate(body);
  if (compression === COMPRESSION.LZO) {
    throw new MdxError('该数据块使用 LZO 压缩，当前实现只支持 zlib 压缩的词典。', 'unsupported-compression');
  }
  throw new MdxError(`未知的压缩方式编号 ${compression}。`, 'unsupported-compression');
}

export function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
