// 构建社群预览版发布包：ZIP + SHA-256 + 机器可读构建报告。
//
// 用法：
//   node scripts/build-package.mjs [--root .] [--out dist]
//                                  [--previous 0.2.2] [--skip-remote-check]
//                                  [--version-gate fail|warn]
//
// 只写 --out 目录，不改动仓库里任何源文件。包内 update-marker.json 由本脚本生成，
// 因此仓库里的那份永远不会被改写。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { assertReleaseVersion, compareVersion, latestReleaseVersion, tagOf } from './version.mjs';
import { createZipFile } from './zip.mjs';
import {
  INSTALL_DOC_CANDIDATES,
  MARKER_FILE,
  ROOT_FILES,
  RUNTIME_DIRS,
  checksumName,
  denyReason,
  manifestReferencedFiles,
  packageDirName,
  zipName
} from './package-spec.mjs';

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    out: 'dist',
    previous: null,
    skipRemoteCheck: false,
    versionGate: 'fail'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--root') options.root = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--previous') options.previous = value();
    else if (arg === '--skip-remote-check') options.skipRemoteCheck = true;
    else if (arg === '--version-gate') options.versionGate = value();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['fail', 'warn'].includes(options.versionGate)) {
    throw new Error('--version-gate 只接受 fail 或 warn');
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function remoteTags(root) {
  try {
    const output = execFileSync('git', ['ls-remote', '--tags', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output
      .split('\n')
      .map((line) => line.split('\t')[1])
      .filter(Boolean)
      .map((ref) => ref.replace('refs/tags/', ''));
  } catch {
    return null;
  }
}

// 递归收集目录内的文件，命中黑名单的直接跳过（词典数据、测试截图等）。
function collectDir(baseDir, relativeDir, collected, warnings) {
  const absolute = path.join(baseDir, relativeDir);
  if (!fs.existsSync(absolute)) {
    throw new Error(`缺少运行目录：${relativeDir}`);
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectDir(baseDir, relative, collected, warnings);
      continue;
    }
    if (!entry.isFile()) continue;
    const reason = denyReason(relative);
    if (reason) {
      warnings.push(`跳过 ${relative}（${reason}）`);
      continue;
    }
    collected.set(relative, path.join(baseDir, relative));
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const warnings = [];

  const manifestPath = path.join(options.root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 manifest.json：${manifestPath}`);
  const manifest = readJson(manifestPath);
  assertReleaseVersion(manifest.version);
  if (manifest.manifest_version !== 3) {
    throw new Error(`manifest_version 必须是 3，当前为 ${manifest.manifest_version}`);
  }

  // 版本必须严格递增，否则更新脚本会拒绝、用户也会装到旧包。
  let previous = options.previous;
  if (previous === null && !options.skipRemoteCheck) {
    const tags = remoteTags(options.root);
    if (tags === null) {
      warnings.push('无法读取远端 tag，跳过递增性检查（离线或没有 origin）');
    } else {
      previous = latestReleaseVersion(tags);
    }
  }
  if (previous) {
    const delta = compareVersion(manifest.version, previous);
    const message = `包内版本 ${manifest.version} 与已发布的最新版本 ${previous} 的关系：${delta > 0 ? '更新' : delta === 0 ? '相同' : '更旧'}`;
    if (delta <= 0) {
      if (options.versionGate === 'fail') {
        throw new Error(`${message}。发布版本必须严格递增，请把 manifest.json 的版本号提高。`);
      }
      warnings.push(`${message}（本次为 warn 模式，不阻断）`);
    } else {
      console.log(message);
    }
  }

  // 收集运行文件：根目录白名单 + 三个运行目录。
  const collected = new Map();
  for (const name of ROOT_FILES) {
    const absolute = path.join(options.root, name);
    if (!fs.existsSync(absolute)) {
      throw new Error(`缺少发布必需文件：${name}`);
    }
    collected.set(name, absolute);
  }
  const installDoc = INSTALL_DOC_CANDIDATES.find((name) => fs.existsSync(path.join(options.root, name)));
  if (!installDoc) {
    throw new Error(`缺少通用安装说明，需要 ${INSTALL_DOC_CANDIDATES.join(' 或 ')}`);
  }
  for (const dir of RUNTIME_DIRS) {
    collectDir(options.root, dir, collected, warnings);
  }

  // manifest 引用的文件必须在包里。
  for (const ref of manifestReferencedFiles(manifest)) {
    if (!collected.has(ref)) {
      throw new Error(`manifest 引用的文件缺失：${ref}`);
    }
  }

  // 完成标记：与 manifest 同版本且 ready:true。仓库里那份只校验、不改写。
  const markerSource = path.join(options.root, MARKER_FILE);
  if (fs.existsSync(markerSource)) {
    const marker = readJson(markerSource);
    if (marker.ready !== true || compareVersion(String(marker.version ?? ''), manifest.version) !== 0) {
      throw new Error(
        `${MARKER_FILE} 与 manifest 不一致（标记 ${JSON.stringify(marker)}，manifest ${manifest.version}）。` +
          '请让两者版本相同且 ready:true。'
      );
    }
  }
  const marker = JSON.stringify({ version: manifest.version, ready: true });

  // 落盘到 stage：ZIP 第一层只有一个扩展目录。
  const outDir = options.out;
  const stageRoot = path.join(outDir, '.stage');
  const payloadDir = path.join(stageRoot, packageDirName(manifest.version));
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(payloadDir, { recursive: true });

  for (const [relative, source] of collected) {
    const target = path.join(payloadDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(payloadDir, MARKER_FILE), `${marker}\n`, 'utf8');

  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else entries.push({ name: relative, data: fs.readFileSync(path.join(dir, entry.name)) });
    }
  };
  walk(payloadDir, packageDirName(manifest.version));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  fs.mkdirSync(outDir, { recursive: true });
  const zipFile = path.join(outDir, zipName(manifest.version));
  const written = createZipFile({ entries, output: zipFile });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
  const checksumFile = path.join(outDir, checksumName(manifest.version));
  fs.writeFileSync(checksumFile, `${sha256}  ${zipName(manifest.version)}\n`, 'utf8');

  const report = {
    version: manifest.version,
    tag: tagOf(manifest.version),
    directory: packageDirName(manifest.version),
    zip: zipName(manifest.version),
    checksumFile: checksumName(manifest.version),
    sha256,
    files: entries.length,
    zipBytes: written.bytes,
    previousVersion: previous,
    installDoc,
    warnings
  };
  fs.writeFileSync(path.join(outDir, 'package-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  for (const line of warnings) console.log(`WARN ${line}`);
  console.log(
    `已生成 ${zipName(manifest.version)}：${entries.length} 个文件，${written.bytes} 字节，SHA-256 ${sha256.slice(0, 16)}…`
  );
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`构建失败：${error.message}`);
  process.exit(1);
}
