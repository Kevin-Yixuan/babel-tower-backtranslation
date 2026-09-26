// 校验已构建的发布包：结构、版本一致性、SHA-256、布局。
// 用法：node scripts/verify-package.mjs dist/babel-tower-backtranslation-0.2.3.zip --tag v0.2.3
//       node scripts/verify-package.mjs dist/babel-tower-backtranslation-0.2.3-store.zip --layout store
//
// 校验项：ZIP 里恰好一个 manifest.json、根目录文件齐全、mdx/modules/services/sidebar
// 运行目录在、manifest 引用的文件都在、已退役的更新机制文件（update-unpacked.ps1、
// update-marker.json）不在包内、SHA-256 与校验文件一致。
// preview 布局要求第一层只有一个版本目录；store 布局要求 manifest.json 平铺在 ZIP 根。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { assertReleaseVersion, compareVersion, tagOf, versionOfTag } from './version.mjs';
import { readZipEntries, readZipEntryData } from './zip.mjs';
import {
  LAYOUTS,
  ROOT_FILES,
  RUNTIME_DIRS,
  RETIRED_UPDATE_FILES,
  denyReason,
  manifestReferencedFiles,
  packageDirName
} from './package-spec.mjs';

function parseArgs(argv) {
  const options = { zip: null, sha: null, tag: null, expectVersion: null, layout: 'preview' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--sha') options.sha = value();
    else if (arg === '--tag') options.tag = value();
    else if (arg === '--expect-version') options.expectVersion = value();
    else if (arg === '--layout') options.layout = value();
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else if (options.zip === null) options.zip = arg;
  }
  if (!options.zip) throw new Error('用法：node scripts/verify-package.mjs <zip> [--tag v0.2.3] [--layout preview|store]');
  if (!LAYOUTS.includes(options.layout)) {
    throw new Error(`--layout 只接受 ${LAYOUTS.join(' 或 ')}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const zipPath = path.resolve(options.zip);
  if (!fs.existsSync(zipPath)) throw new Error(`找不到 ZIP：${zipPath}`);

  const failures = [];
  const notes = [];
  const fail = (message) => failures.push(message);

  const entries = readZipEntries(zipPath);
  const names = entries.map((entry) => entry.name);
  if (entries.length === 0) fail('ZIP 里没有任何文件');

  // preview：第一层必须只有一个扩展目录，manifest.json 在该目录第一层。
  // store：文件平铺，manifest.json 必须直接位于 ZIP 根。
  const topLevel = new Set(names.map((name) => name.split('/')[0]));
  let root;
  if (options.layout === 'store') {
    root = '';
    if (!names.includes('manifest.json')) {
      fail('store 布局的 ZIP 根目录缺少 manifest.json（看起来用了 preview 的包装目录布局）');
    }
  } else {
    if (topLevel.size !== 1) {
      fail(`ZIP 第一层应有且只有一个扩展目录，实际有：${[...topLevel].join(', ')}`);
    }
    root = [...topLevel][0];
  }
  const relativeOf = (name) => (root ? name.slice(root.length + 1) : name);

  const manifests = names.filter((name) => name.split('/').pop() === 'manifest.json');
  if (manifests.length !== 1) fail(`ZIP 必须恰好包含一个 manifest.json，实际 ${manifests.length} 个`);

  const manifestName = root ? `${root}/manifest.json` : 'manifest.json';
  const manifestEntry = entries.find((entry) => entry.name === manifestName);
  if (!manifestEntry) {
    fail(`缺少可直接加载的 manifest.json（期望 ${manifestName}）`);
    throw new AggregateError(failures);
  }

  let manifest;
  try {
    manifest = JSON.parse(readEntry(zipPath, manifestEntry));
  } catch (error) {
    fail(`manifest.json 无法解析：${error.message}`);
    throw new AggregateError(failures);
  }

  let version = null;
  try {
    version = String(manifest.version);
    assertReleaseVersion(version);
  } catch (error) {
    fail(`包内版本号不合法：${error.message}`);
  }
  if (manifest.manifest_version !== 3) fail(`manifest_version 应为 3，实际 ${manifest.manifest_version}`);
  if (!/巴别塔/.test(String(manifest.name ?? ''))) fail(`扩展名不包含「巴别塔」：${manifest.name}`);

  if (version) {
    if (options.layout === 'preview' && root !== packageDirName(version)) {
      fail(`ZIP 第一层目录名 ${root} 与版本号不一致，应为 ${packageDirName(version)}`);
    }
    const expectedZip = options.layout === 'store'
      ? `${packageDirName(version)}-store.zip`
      : `${packageDirName(version)}.zip`;
    if (path.basename(zipPath) !== expectedZip) {
      fail(`ZIP 文件名 ${path.basename(zipPath)} 与版本号/布局不一致，应为 ${expectedZip}`);
    }
    if (options.tag && options.tag !== tagOf(version)) {
      fail(`Release tag ${options.tag} 与包内版本 ${version} 不一致，应为 ${tagOf(version)}`);
    }
    if (options.tag) {
      try {
        if (compareVersion(versionOfTag(options.tag), version) !== 0) {
          fail(`Release tag ${options.tag} 与包内版本 ${version} 不一致`);
        }
      } catch (error) {
        fail(`Release tag 形状不合法：${error.message}`);
      }
    }
    if (options.expectVersion && compareVersion(version, options.expectVersion) !== 0) {
      fail(`包内版本 ${version} 与期望版本 ${options.expectVersion} 不一致`);
    }
  }

  // 已退役的本地自动更新机制文件绝不能进包：它们从未随正式渠道发布，
  // 出现即说明退役不彻底（注意：这是「路径已移除」，不是原机制被修复后继续使用）。
  for (const retired of RETIRED_UPDATE_FILES) {
    if (names.some((name) => name === retired || name.endsWith(`/${retired}`))) {
      fail(`包内不应包含已退役的更新机制文件：${retired}`);
    }
  }

  // 根目录文件与运行目录。
  const at = (name) => (root ? `${root}/${name}` : name);
  for (const name of ROOT_FILES) {
    if (!names.includes(at(name))) fail(`缺少根目录文件：${name}`);
  }
  for (const dir of RUNTIME_DIRS) {
    if (!names.some((name) => name.startsWith(at(`${dir}/`)))) fail(`缺少运行目录：${dir}`);
  }

  // manifest 引用的文件。
  for (const ref of manifestReferencedFiles(manifest)) {
    if (!names.includes(at(ref))) fail(`manifest 引用的文件不在包内：${ref}`);
  }

  // 不该出现的东西。
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.includes('..')) {
      fail(`非法条目路径：${name}`);
    }
    const relative = relativeOf(name);
    const reason = denyReason(relative || name);
    if (reason) fail(`包内不应包含 ${name}（${reason}）`);
  }

  // SHA-256。
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  const shaPath = path.resolve(options.sha ?? `${zipPath}.sha256`);
  if (!fs.existsSync(shaPath)) {
    fail(`找不到校验文件：${shaPath}`);
  } else {
    const text = fs.readFileSync(shaPath, 'utf8');
    const match = text.match(/\b[a-f0-9]{64}\b/i);
    if (!match) {
      fail(`校验文件里没有 64 位 SHA-256：${shaPath}`);
    } else if (match[0].toLowerCase() !== actualSha) {
      fail(`SHA-256 不匹配：文件 ${match[0].toLowerCase()}，实际 ${actualSha}`);
    } else {
      notes.push(`SHA-256 一致：${actualSha}`);
    }
    if (!text.includes(path.basename(zipPath))) {
      fail(`校验文件里没有 ZIP 文件名：${path.basename(zipPath)}`);
    }
  }

  const report = {
    zip: path.basename(zipPath),
    layout: options.layout,
    root: root || '.',
    version,
    tag: version ? tagOf(version) : null,
    files: entries.length,
    zipBytes: fs.statSync(zipPath).size,
    sha256: actualSha,
    notes,
    failures
  };

  if (failures.length > 0) {
    for (const line of failures) console.error(`FAIL ${line}`);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  for (const line of notes) console.log(`OK ${line}`);
  console.log(
    `包校验通过：${root || '.'}／${options.layout} 布局／版本 ${version}／${entries.length} 个文件／${report.zipBytes} 字节`
  );
  console.log(JSON.stringify(report, null, 2));
}

function readEntry(zipPath, entry) {
  return readZipEntryData(zipPath, entry).toString('utf8');
}

try {
  main();
} catch (error) {
  if (error instanceof AggregateError) {
    for (const item of error.errors) console.error(`FAIL ${item}`);
    process.exit(1);
  }
  console.error(`校验失败：${error.message}`);
  process.exit(1);
}
