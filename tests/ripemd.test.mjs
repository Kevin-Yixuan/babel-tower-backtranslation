import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ripemd128Hex } from '../mdx/ripemd128.js';

const encoder = new TextEncoder();

// Full vector set from ISO/IEC 10118-3 (as shipped in the Linux kernel crypto testmgr).
// Includes multi-block inputs so padding across 64-byte blocks is covered.
const VECTORS = [
  ['', 'cdf26213a150dc3ecb610f18f6b38b46'],
  ['a', '86be7afa339d0fc7cfc785e72f578d33'],
  ['abc', 'c14a12199c66e4ba84636b0f69144c77'],
  ['message digest', '9e327b3d6e523062afc1132d7df9d1b8'],
  ['abcdefghijklmnopqrstuvwxyz', 'fd2aa607f71dc8f510714922b371834e'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd1e959eb179c911faea4624c60c5c702'],
  ['1234567890'.repeat(8), '3f45ef194732c2dbb2c4a2c769795fa3'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'a1aa0689d0fafa2ddc22e88b49133a06'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', 'd4ecc913e1df776bf48de9d55b1f2546'],
  ['abcdbcdecdefdefgefghfghighijhijk', '13fc13e8efff347de193ff46dbaccfd4']
];

test('ripemd128 matches the ISO/IEC 10118-3 test vectors', () => {
  for (const [input, expected] of VECTORS) {
    assert.equal(ripemd128Hex(encoder.encode(input)), expected, `input length ${input.length}`);
  }
});
