// 构建发布候选包：ZIP + SHA-256 + 机器可读构建报告。
//
// 用法：
//   node scripts/build-package.mjs [--root .] [--out dist]
//                                  [--previous 0.2.2] [--skip-remote-check]
//                                  [--version-gate fail|warn]
//                                  [--layout preview|store]
//                                  [--branch main]
//
// 只写 --out 目录，不改动仓库里任何源文件。
// --layout preview（默认）：ZIP 第一层是 babel-tower-backtranslation-<版本>/ 单一目录，
//   用于 GitHub Release 解压安装。
// --layout store：文件平铺在 ZIP 根（manifest.json 在第一层），用于 Chrome Web Store
//   提交候选包；产物名带 -store 后缀。
// 版本查询（git ls-remote --tags origin）失败时阻断构建；只有显式
// --skip-remote-check 或显式 --previous 才允许跳过远端查询。
// --branch <名>：分支门禁。当前分支（CI 里取 GITHUB_REF_NAME）必须等于指定值，
//   否则拒绝构建。发布候选（含商店候选）必须由通过必需检查并合并的 main 产出；
//   feature 分支的自测构建不带 --branch 或使用自己的分支名。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { assertReleaseVersion, compareVersion, latestReleaseVersion, tagOf } from './version.mjs';
import { createZipFile } from './zip.mjs';
import {
  INSTALL_DOC_CANDIDATES,
  LAYOUTS,
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
    versionGate: 'fail',
    layout: 'preview',
    branch: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--root') options.root = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--previous') options.previous = value();
    else if (arg === '--skip-remote-check') options.skipRemoteCheck = true;
    else if (arg === '--version-gate') options.versionGate = value();
    else if (arg === '--layout') options.layout = value();
    else if (arg === '--branch') options.branch = value();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['fail', 'warn'].includes(options.versionGate)) {
    throw new Error('--version-gate 只接受 fail 或 warn');
  }
  if (!LAYOUTS.includes(options.layout)) {
    throw new Error(`--layout 只接受 ${LAYOUTS.join(' 或 ')}`);
  }
  return options;
}

// 解析当前分支：CI 里 checkout 常是 detached HEAD，用 GITHUB_REF_NAME；本地用
// git symbolic-ref。两者都拿不到时返回 null（由调用方决定是否放行）。
function currentBranch(root) {
  const refName = process.env.GITHUB_REF_NAME;
  if (refName) return refName.replace(/^refs\/heads\//, '');
  try {
    const head = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return head || null;
  } catch {
    return null;
  }
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

  // 分支门禁：发布候选（含 Chrome Web Store 提交候选）只能来自通过必需检查并
  // 合并的 main。带 --branch 时，当前分支必须匹配，否则直接拒绝构建。
  if (options.branch) {
    const actual = currentBranch(options.root);
    if (actual !== options.branch) {
      throw new Error(
        `分支门禁：要求在 ${options.branch} 上构建发布候选，当前分支为 ${actual ?? '未知（detached HEAD 且无 GITHUB_REF_NAME）'}。` +
          'feature 分支只做自测构建，合并进 main 后由发布流水线产出候选包。'
      );
    }
  }

  // 版本必须严格递增，否则用户会装到旧包。
  // 远端 tag 查询失败（离线、没有 origin、网络错误）同样阻断构建——
  // 查不到已发布版本就无法证明递增性，候选包不允许在这种状态下产出。
  let previous = options.previous;
  if (previous === null && !options.skipRemoteCheck) {
    const tags = remoteTags(options.root);
    if (tags === null) {
      throw new Error(
        '无法读取远端 tag（git ls-remote --tags origin 失败），无法校验版本递增性，已阻断构建。' +
          '联网后重试；确实要离线自测时，显式传 --skip-remote-check 或 --previous <已发布版本>。'
      );
    }
    previous = latestReleaseVersion(tags);
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

  // 已退役的本地自动更新机制不再参与构建：不写 update-marker.json，也不再读取
  // 仓库里可能残留的同名文件。源码树里如果还有 update-unpacked.ps1 /
  // update-marker.json，这里给出显式警告（白名单收集本来就不会把它们打进 ZIP）。
  for (const retired of ['update-unpacked.ps1', 'update-marker.json']) {
    if (fs.existsSync(path.join(options.root, retired))) {
      warnings.push(`发现已退役的更新机制文件 ${retired}，不会进入发布包；请从源码树中移除`);
    }
  }

  // 落盘到 stage。
  // preview：ZIP 第一层只有一个扩展目录（babel-tower-backtranslation-<版本>/）。
  // store：文件平铺在 ZIP 根，manifest.json 直接位于第一层，供 Chrome Web Store 上传。
  const outDir = options.out;
  const stageRoot = path.join(outDir, '.stage');
  const payloadDir = options.layout === 'store'
    ? path.join(stageRoot, 'store')
    : path.join(stageRoot, packageDirName(manifest.version));
  const zipRoot = options.layout === 'store' ? '' : packageDirName(manifest.version);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(payloadDir, { recursive: true });

  for (const [relative, source] of collected) {
    const target = path.join(payloadDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else entries.push({ name: relative, data: fs.readFileSync(path.join(dir, entry.name)) });
    }
  };
  walk(payloadDir, zipRoot);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  fs.mkdirSync(outDir, { recursive: true });
  const zipFile = path.join(outDir, zipName(manifest.version, options.layout));
  const written = createZipFile({ entries, output: zipFile });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
  const checksumFile = path.join(outDir, checksumName(manifest.version, options.layout));
  fs.writeFileSync(checksumFile, `${sha256}  ${zipName(manifest.version, options.layout)}\n`, 'utf8');

  const report = {
    version: manifest.version,
    tag: tagOf(manifest.version),
    layout: options.layout,
    directory: zipRoot || '.',
    zip: zipName(manifest.version, options.layout),
    checksumFile: checksumName(manifest.version, options.layout),
    sha256,
    files: entries.length,
    zipBytes: written.bytes,
    previousVersion: previous,
    branch: options.branch,
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
