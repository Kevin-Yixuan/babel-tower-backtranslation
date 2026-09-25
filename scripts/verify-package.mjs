// 校验已构建的发布包：结构、版本一致性、SHA-256。
// 用法：node scripts/verify-package.mjs dist/babel-tower-backtranslation-0.2.3.zip --tag v0.2.3
//
// 校验项与 update-unpacked.ps1 的验收条件一一对应：ZIP 里只有一个 manifest.json、
// 根目录文件齐全、mdx/modules/sidebar 三个目录在、完成标记与 manifest 同版本且 ready:true。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { assertReleaseVersion, compareVersion, tagOf, versionOfTag } from './version.mjs';
import { readZipEntries, readZipEntryData } from './zip.mjs';
import {
  MARKER_FILE,
  ROOT_FILES,
  RUNTIME_DIRS,
  denyReason,
  manifestReferencedFiles,
  packageDirName
} from './package-spec.mjs';

function parseArgs(argv) {
  const options = { zip: null, sha: null, tag: null, expectVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--sha') options.sha = value();
    else if (arg === '--tag') options.tag = value();
    else if (arg === '--expect-version') options.expectVersion = value();
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else if (options.zip === null) options.zip = arg;
  }
  if (!options.zip) throw new Error('用法：node scripts/verify-package.mjs <zip> [--tag v0.2.3]');
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

  // 第一层必须只有一个扩展目录。
  const topLevel = new Set(names.map((name) => name.split('/')[0]));
  if (topLevel.size !== 1) {
    fail(`ZIP 第一层应有且只有一个扩展目录，实际有：${[...topLevel].join(', ')}`);
  }
  const root = [...topLevel][0];

  const manifests = names.filter((name) => name.split('/').pop() === 'manifest.json');
  if (manifests.length !== 1) fail(`ZIP 必须恰好包含一个 manifest.json，实际 ${manifests.length} 个`);

  const manifestName = `${root}/manifest.json`;
  const manifestEntry = entries.find((entry) => entry.name === manifestName);
  if (!manifestEntry) {
    fail(`扩展目录第一层缺少可直接加载的 manifest.json（期望 ${manifestName}）`);
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
    if (root !== packageDirName(version)) {
      fail(`ZIP 第一层目录名 ${root} 与版本号不一致，应为 ${packageDirName(version)}`);
    }
    if (path.basename(zipPath) !== `${packageDirName(version)}.zip`) {
      fail(`ZIP 文件名 ${path.basename(zipPath)} 与版本号不一致，应为 ${packageDirName(version)}.zip`);
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

  // 完成标记必须与 manifest 同版本且 ready:true。
  const markerEntry = entries.find((entry) => entry.name === `${root}/${MARKER_FILE}`);
  if (!markerEntry) {
    fail(`缺少 ${MARKER_FILE}，更新脚本会拒绝该包`);
  } else {
    try {
      const marker = JSON.parse(readEntry(zipPath, markerEntry));
      if (marker.ready !== true) fail(`${MARKER_FILE} 的 ready 必须为 true`);
      if (version && compareVersion(String(marker.version ?? ''), version) !== 0) {
        fail(`${MARKER_FILE} 版本 ${marker.version} 与 manifest 版本 ${version} 不一致`);
      }
      notes.push(`${MARKER_FILE}：version ${marker.version}，ready ${marker.ready}`);
    } catch (error) {
      fail(`${MARKER_FILE} 无法解析：${error.message}`);
    }
  }

  // 更新脚本要求的根目录文件与运行目录。
  for (const name of ROOT_FILES) {
    if (!names.includes(`${root}/${name}`)) fail(`缺少根目录文件：${name}`);
  }
  for (const dir of RUNTIME_DIRS) {
    if (!names.some((name) => name.startsWith(`${root}/${dir}/`))) fail(`缺少运行目录：${dir}`);
  }

  // manifest 引用的文件。
  for (const ref of manifestReferencedFiles(manifest)) {
    if (!names.includes(`${root}/${ref}`)) fail(`manifest 引用的文件不在包内：${ref}`);
  }

  // 不该出现的东西。
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.includes('..')) {
      fail(`非法条目路径：${name}`);
    }
    const relative = name.slice(root.length + 1);
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
    root,
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
    `包校验通过：${root}／版本 ${version}／${entries.length} 个文件／${report.zipBytes} 字节`
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
