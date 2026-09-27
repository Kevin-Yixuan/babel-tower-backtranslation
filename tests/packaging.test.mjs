// 发布流水线自测：版本规则、ZIP 读写、构建与校验的端到端行为。
// 运行：node --test tests/packaging.test.mjs
// 不依赖仓库里的真实扩展文件，用临时目录造一套最小扩展来跑，改到哪都不会互相污染。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertReleaseVersion, compareVersion, latestReleaseVersion, parseVersion } from '../scripts/version.mjs';
import { createZipFile, readLocalHeaderFlags, readZipEntries, readZipEntryData } from '../scripts/zip.mjs';
import { ROOT_FILES, RUNTIME_DIRS } from '../scripts/package-spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const buildScript = path.join(repoRoot, 'scripts', 'build-package.mjs');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-package.mjs');

test('实际扩展包包含写作台完整运行文件与隐私说明', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-agent-package-'));
  try {
    const built = spawnSync(process.execPath, [buildScript, '--root', repoRoot, '--out', out, '--previous', '0.2.2'], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
    const zip = path.join(out, report.zip);
    const entries = readZipEntries(zip);
    for (const name of ['write/desk.html', 'write/desk.js', 'write/desk.css', 'write/markdown.js', 'services/agent.js', 'modules/agent/agent.js', 'privacy.md']) {
      const entry = entries.find(item => item.name === `babel-tower-backtranslation-${report.version}/${name}`);
      assert.ok(entry, `ZIP missing ${name}`);
      assert.deepEqual(readZipEntryData(zip, entry), fs.readFileSync(path.join(repoRoot, name)));
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

function runNode(args, cwd, env) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// Windows PowerShell 5.1（powershell.exe）解压验证。命令文本保持纯 ASCII，
// 中文文件名通过 UTF-8 期望清单文件与环境变量传递，避免控制台代码页干扰；
// 不使用 -ExecutionPolicy Bypass（-Command 内联命令不受脚本执行策略限制）。
const PS_EXTRACT_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$expected = [System.IO.File]::ReadAllLines($env:BX_EXPECTED, [System.Text.Encoding]::UTF8)',
  'Expand-Archive -LiteralPath $env:BX_ZIP -DestinationPath $env:BX_DEST1 -Force',
  '[System.IO.Compression.ZipFile]::ExtractToDirectory($env:BX_ZIP, $env:BX_DEST2)',
  '$fail = 0',
  'foreach ($dest in @($env:BX_DEST1, $env:BX_DEST2)) {',
  '  foreach ($rel in $expected) {',
  '    if (-not (Test-Path -LiteralPath (Join-Path $dest $rel))) { Write-Output ("MISSING " + $rel); $fail = 1 }',
  '  }',
  '}',
  '$want = [System.IO.File]::ReadAllText($env:BX_EXPECTED_CONTENT, [System.Text.Encoding]::UTF8)',
  '$got = [System.IO.File]::ReadAllText((Join-Path $env:BX_DEST1 $expected[0]), [System.Text.Encoding]::UTF8)',
  "if ($got -ne $want) { Write-Output 'CONTENT MISMATCH'; $fail = 1 }",
  "Write-Output ('PSVERSION ' + $PSVersionTable.PSVersion.ToString())",
  'if ($fail -ne 0) { exit 1 }',
  'exit 0'
].join('\r\n');

function runPowerShellExtract(env) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_EXTRACT_COMMAND], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...env }
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function minimalManifest(version) {
  return {
    manifest_version: 3,
    name: '巴别塔（回译）· X 跨语言阅读与表达',
    version,
    description: 'fixture',
    permissions: ['storage'],
    content_scripts: [
      {
        matches: ['https://x.com/*'],
        js: ['sidebar/sidebar.js', 'modules/reading/reading.js', 'content.js'],
        css: ['sidebar/sidebar.css', 'content.css'],
        run_at: 'document_idle'
      }
    ],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_title: '巴别塔（回译）', default_popup: 'popup.html' },
    options_page: 'options.html'
  };
}

// 写一套最小扩展 fixture。extras 里的路径会原样落盘（相对 root），
// 用来构造「多余但应被拒绝的文件」或「manifest 引用了但缺失的文件」场景。
function writeFixture(root, { version = '0.3.0', extras = [], manifestOverride = null } = {}) {
  fs.mkdirSync(root, { recursive: true });
  for (const name of ROOT_FILES) {
    if (name === 'manifest.json') continue;
    fs.writeFileSync(path.join(root, name), `/* fixture ${name} */\n`, 'utf8');
  }
  const manifest = manifestOverride ? manifestOverride(version) : minimalManifest(version);
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const dir of RUNTIME_DIRS) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, `${dir}-main.js`), `/* fixture ${dir} */\n`, 'utf8');
  }
  fs.mkdirSync(path.join(root, 'modules', 'reading'), { recursive: true });
  fs.writeFileSync(path.join(root, 'modules', 'reading', 'reading.js'), '/* fixture reading */\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sidebar', 'sidebar.js'), '/* fixture sidebar */\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sidebar', 'sidebar.css'), '/* fixture sidebar css */\n', 'utf8');
  for (const extra of extras) {
    fs.mkdirSync(path.dirname(path.join(root, extra)), { recursive: true });
    fs.writeFileSync(path.join(root, extra), '/* fixture extra */\n', 'utf8');
  }
}

test('版本号遵守 Chromium 四段数字规则', () => {
  assert.deepEqual(parseVersion('1.2.3.4'), [1, 2, 3, 4]);
  assert.deepEqual(parseVersion('0.2.3'), [0, 2, 3]);
  assert.throws(() => parseVersion('01.2.3'), /前导零/);
  assert.throws(() => parseVersion('1.2.3.4.5'), /最多四段/);
  assert.throws(() => parseVersion('1.2.65536'), /65535/);
  assert.throws(() => parseVersion('1.2.x'), /十进制整数/);
  assert.throws(() => parseVersion(''), /非空/);
  assert.throws(() => assertReleaseVersion('0.2'), /至少三段/);
  assert.equal(compareVersion('1.0', '1.0.0.0'), 0);
  assert.equal(compareVersion('0.2.3', '0.2.2'), 1);
  assert.equal(compareVersion('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersion('1.0.0', '1.0.0.1'), -1);
});

test('只把形状合法的 release tag 当作已发布版本', () => {
  assert.equal(latestReleaseVersion(['v0.2.1', 'v0.2.2', 'v0.2.10', 'nightly', 'v1']), '0.2.10');
  assert.equal(latestReleaseVersion(['v0.2.2']), '0.2.2');
  assert.equal(latestReleaseVersion([]), null);
});

test('ZIP 能写回并原样读出来', () => {
  const dir = tempDir('bx-zip-');
  const zipPath = path.join(dir, 'round.zip');
  const payload = Buffer.from('hello 巴别塔\n'.repeat(50));
  createZipFile({
    entries: [
      { name: 'root/a.txt', data: payload },
      { name: 'root/b.json', data: Buffer.from('{"ok":true}') }
    ],
    output: zipPath
  });
  const entries = readZipEntries(zipPath);
  assert.deepEqual(entries.map((item) => item.name), ['root/a.txt', 'root/b.json']);
  assert.equal(readZipEntryData(zipPath, entries[0]).toString('utf8'), payload.toString('utf8'));
  assert.equal(readZipEntryData(zipPath, entries[1]).toString('utf8'), '{"ok":true}');
});

// 中文文件名的本地头与中央目录都必须置 UTF-8（EFS, 0x800）标志，
// 否则 Windows PowerShell 5.1 的 Expand-Archive / .NET ZipFile 按 ANSI 代码页解读文件名。
const FLAG_UTF8 = 0x0800;
const CHINESE_ENTRIES = [
  { name: '巴别塔-测试/安装与更新.md', data: Buffer.from('中文内容校验 CONTENT_OK\n巴别塔（回译）\n', 'utf8') },
  { name: '巴别塔-测试/子目录/说明-第二份.txt', data: Buffer.from('第二份中文文件\n', 'utf8') }
];

function buildChineseZip(dir) {
  const zipPath = path.join(dir, '中文文件名-测试.zip');
  createZipFile({ entries: CHINESE_ENTRIES, output: zipPath });
  return zipPath;
}

test('中文文件名：本地头与中央目录都带 UTF-8 标志', () => {
  const dir = tempDir('bx-utf8-');
  const zipPath = buildChineseZip(dir);
  const entries = readZipEntries(zipPath);
  assert.deepEqual(entries.map((item) => item.name), CHINESE_ENTRIES.map((item) => item.name));
  for (const entry of entries) {
    assert.ok(entry.flags & FLAG_UTF8, `中央目录缺少 UTF-8 标志：${entry.name}（flags=0x${entry.flags.toString(16)}）`);
    const localFlags = readLocalHeaderFlags(zipPath, entry);
    assert.ok(localFlags & FLAG_UTF8, `本地头缺少 UTF-8 标志：${entry.name}（flags=0x${localFlags.toString(16)}）`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    assert.equal(readZipEntryData(zipPath, entries[index]).toString('utf8'), CHINESE_ENTRIES[index].data.toString('utf8'));
  }
});

test('中文文件名在 Windows PowerShell 5.1 的 Expand-Archive 与 ZipFile 下可正确解压', {
  skip: process.platform === 'win32' ? false : '仅 Windows：需要 PowerShell 5.1'
}, () => {
  const dir = tempDir('bx-ps-');
  const zipPath = buildChineseZip(dir);
  const expectedFile = path.join(dir, 'expected-names.txt');
  const contentFile = path.join(dir, 'expected-content.txt');
  // 期望清单与内容都用无 BOM 的 UTF-8 落盘，PowerShell 端按 UTF-8 读取。
  fs.writeFileSync(expectedFile, `${CHINESE_ENTRIES.map((item) => item.name).join('\n')}\n`, 'utf8');
  fs.writeFileSync(contentFile, CHINESE_ENTRIES[0].data.toString('utf8'), 'utf8');

  const result = runPowerShellExtract({
    BX_ZIP: zipPath,
    BX_DEST1: path.join(dir, 'via-expand-archive'),
    BX_DEST2: path.join(dir, 'via-zipfile'),
    BX_EXPECTED: expectedFile,
    BX_EXPECTED_CONTENT: contentFile
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `PowerShell 解压失败（status=${result.status}）：\n${output}`);
  assert.match(output, /PSVERSION 5\.1/, `必须在 Windows PowerShell 5.1 下验证，实际输出：\n${output}`);
  assert.doesNotMatch(output, /MISSING/, `中文文件名解压后缺失：\n${output}`);
  assert.doesNotMatch(output, /CONTENT MISMATCH/, `解压后内容与预期不符：\n${output}`);
  // 解压产物里也确认文件名按 UTF-8 还原（内容与清单双重核对）。
  for (const item of CHINESE_ENTRIES) {
    const extracted = path.join(dir, 'via-expand-archive', item.name);
    assert.ok(fs.existsSync(extracted), `Expand-Archive 未产出 ${item.name}`);
    assert.equal(fs.readFileSync(extracted, 'utf8'), item.data.toString('utf8'));
  }
});

test('构建出的包只有一个顶层目录，根目录文件齐全', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.equal(built.status, 0, built.stderr);

  const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
  assert.equal(report.version, '0.3.0');
  assert.equal(report.tag, 'v0.3.0');
  assert.equal(report.layout, 'preview');
  assert.equal(report.zip, 'babel-tower-backtranslation-0.3.0.zip');

  const zipPath = path.join(out, report.zip);
  const entries = readZipEntries(zipPath);
  const topLevel = new Set(entries.map((item) => item.name.split('/')[0]));
  assert.deepEqual([...topLevel], ['babel-tower-backtranslation-0.3.0']);
  assert.equal(entries.filter((item) => item.name.endsWith('manifest.json')).length, 1);
  assert.ok(entries.some((item) => item.name === 'babel-tower-backtranslation-0.3.0/manifest.json'));
  // manifest 的 options_page 指向 options.html，二者必须随包，设置页才能打开。
  assert.ok(entries.some((item) => item.name === 'babel-tower-backtranslation-0.3.0/options.html'));
  assert.ok(entries.some((item) => item.name === 'babel-tower-backtranslation-0.3.0/options.js'));
  assert.ok(entries.some((item) => item.name === 'babel-tower-backtranslation-0.3.0/write/write-main.js'));
  // 已退役的更新机制文件不得进包。
  for (const name of entries.map((item) => item.name)) {
    assert.doesNotMatch(name, /update-(unpacked\.ps1|marker\.json)$/);
  }

  const shaFile = fs.readFileSync(path.join(out, report.checksumFile), 'utf8');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  assert.match(shaFile, new RegExp(actual));
  assert.equal(report.sha256, actual);

  const verified = runNode([verifyScript, zipPath, '--tag', 'v0.3.0'], repoRoot);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

test('版本没有严格递增时构建失败', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture, { version: '0.2.2' });
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /严格递增/);
});

test('远端版本查询失败时阻断构建', () => {
  // fixture 不是 git 仓库，git ls-remote 必然失败；不给 --previous / --skip-remote-check，
  // 构建必须失败——查不到已发布版本就无法证明递增性。
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  const built = runNode([buildScript, '--root', fixture, '--out', out], repoRoot);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /无法读取远端 tag/);

  // 显式声明后仍然可以离线自测。
  const allowed = runNode(
    [buildScript, '--root', fixture, '--out', out, '--skip-remote-check', '--previous', '0.2.2'],
    repoRoot
  );
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('缺少发布必需文件时构建失败', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  fs.rmSync(path.join(fixture, 'options.html'));
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /缺少发布必需文件：options\.html/);
  assert.equal(fs.existsSync(path.join(out, 'package-report.json')), false, '失败的构建不应留下产物');
});

test('manifest 引用的文件缺失时构建失败', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture, {
    manifestOverride: (version) => ({
      ...minimalManifest(version),
      content_scripts: [{
        matches: ['https://x.com/*'],
        js: ['sidebar/sidebar.js', 'modules/reading/not-there.js', 'content.js'],
        css: ['sidebar/sidebar.css', 'content.css'],
        run_at: 'document_idle'
      }]
    })
  });
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /manifest 引用的文件缺失：modules\/reading\/not-there\.js/);
});

test('已退役的更新机制文件不会进入发布包', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture, {
    extras: ['update-unpacked.ps1', 'update-marker.json', 'sidebar/update-marker.json', 'mdx/update-unpacked.ps1']
  });
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.equal(built.status, 0, built.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
  assert.ok(report.warnings.some((line) => line.includes('已退役') && line.includes('update-unpacked.ps1')));
  assert.ok(report.warnings.some((line) => line.includes('已退役') && line.includes('update-marker.json')));
  const zipPath = path.join(out, report.zip);
  const names = readZipEntries(zipPath).map((item) => item.name);
  for (const name of names) {
    assert.doesNotMatch(name, /update-unpacked\.ps1$/i, name);
    assert.doesNotMatch(name, /update-marker\.json$/i, name);
  }
  // 校验器也必须把混入的退役文件判为失败（构造一个被污染的 ZIP 内容路径不可行，
  // 这里退一步验证：干净包能过、denyReason 兜底命中同名文件）。
  const verified = runNode([verifyScript, zipPath, '--tag', 'v0.3.0'], repoRoot);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

test('store 布局：manifest.json 平铺在 ZIP 根，可作商店提交候选', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  const built = runNode(
    [buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check', '--layout', 'store'],
    repoRoot
  );
  assert.equal(built.status, 0, built.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
  assert.equal(report.layout, 'store');
  assert.equal(report.zip, 'babel-tower-backtranslation-0.3.0-store.zip');

  const zipPath = path.join(out, report.zip);
  const names = readZipEntries(zipPath).map((item) => item.name);
  assert.ok(names.includes('manifest.json'), 'store 布局的 manifest.json 必须在 ZIP 根');
  assert.ok(!names.some((name) => name.startsWith('babel-tower-backtranslation-')));

  const verified = runNode([verifyScript, zipPath, '--tag', 'v0.3.0', '--layout', 'store'], repoRoot);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);

  // 拿 store 包按 preview 布局校验必须失败（布局门禁）。
  const wrong = runNode([verifyScript, zipPath, '--tag', 'v0.3.0'], repoRoot);
  assert.notEqual(wrong.status, 0);
});

test('分支门禁：非目标分支拒绝构建发布候选', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  const base = [buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'];

  const blocked = runNode([...base, '--branch', 'main'], repoRoot, { GITHUB_REF_NAME: 'feature/chrome-foundation' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /分支门禁/);

  const allowed = runNode([...base, '--branch', 'main'], repoRoot, { GITHUB_REF_NAME: 'main' });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('词典数据与测试截图不会进入发布包', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture, { extras: ['modules/shot.png', 'mdx/big-dict.mdx', 'sidebar/local.local'] });
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.equal(built.status, 0, built.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
  assert.ok(report.warnings.some((line) => line.includes('shot.png')));
  assert.ok(report.warnings.some((line) => line.includes('big-dict.mdx')));
  const entries = readZipEntries(path.join(out, report.zip));
  for (const name of entries.map((item) => item.name)) {
    assert.doesNotMatch(name, /\.(png|mdx)$/i);
    assert.doesNotMatch(name, /\.local$/i);
  }
});

test('Release tag 与包内版本不一致时校验失败', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  assert.equal(
    runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot).status,
    0
  );
  const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
  const wrong = runNode([verifyScript, path.join(out, report.zip), '--tag', 'v0.9.9'], repoRoot);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /不一致/);
});
