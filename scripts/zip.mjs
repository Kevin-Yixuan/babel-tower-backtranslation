// 零依赖 ZIP 读写：只实现发布包需要的最小子集（deflate / store + 中央目录）。
// 自己实现而不是调用外部 zip 命令，是为了让 Windows / Linux 上产出的包结构完全一致，
// 也避免 CI 镜像里没有 zip 可执行文件时构建失败。

import fs from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const MAX_EOCD_SEARCH = 65557;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value) {
  const year = Math.max(1980, value.getUTCFullYear());
  return {
    time: ((value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2)) & 0xffff,
    date: (((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate()) & 0xffff
  };
}

// entries: [{ name: 'posix/path', data: Buffer }]
export function createZipFile({ entries, output }) {
  const stamped = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
    : new Date();
  const { time, date } = dosDateTime(stamped);
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (buffer) => {
    chunks.push(buffer);
    offset += buffer.length;
  };

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !Buffer.isBuffer(entry.data)) {
      throw new Error('ZIP 条目必须是 { name, data: Buffer }');
    }
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const method = stored ? 0 : 8;
    const payload = stored ? entry.data : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    push(local);
    push(name);
    push(payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localOffset, 42);
    central.push({ header, name });
  }

  const centralOffset = offset;
  for (const item of central) {
    push(item.header);
    push(item.name);
  }
  const centralSize = offset - centralOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  push(eocd);

  fs.writeFileSync(output, Buffer.concat(chunks));
  return { path: output, entries: central.length, bytes: fs.statSync(output).size };
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  throw new Error('不是有效的 ZIP：找不到结尾记录');
}

// 返回 [{ name, size, compressedSize, method, crc }]，name 为 posix 相对路径。
export function readZipEntries(path) {
  const buffer = fs.readFileSync(path);
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  if (count === 0xffff) throw new Error('暂不支持 Zip64 存档');
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP 中央目录损坏于第 ${index + 1} 项`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const entry = {
      name: buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: buffer.readUInt16LE(cursor + 10),
      crc: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      size: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42)
    };
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff) {
      throw new Error(`暂不支持 Zip64 条目：${entry.name}`);
    }
    entries.push(entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// 读出单个条目的原始内容（按方法解压），用于校验包内 JSON。
export function readZipEntryData(path, entry) {
  const buffer = fs.readFileSync(path);
  const base = entry.localOffset;
  if (buffer.readUInt32LE(base) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP 本地头损坏：${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(base + 26);
  const extraLength = buffer.readUInt16LE(base + 28);
  const method = buffer.readUInt16LE(base + 8);
  const start = base + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  const data = method === 0 ? raw : inflateRawSync(raw);
  if (data.length !== entry.size) {
    throw new Error(`ZIP 条目长度不符：${entry.name}`);
  }
  if (crc32(data) !== entry.crc) {
    throw new Error(`ZIP 条目 CRC 不符：${entry.name}`);
  }
  return data;
}
