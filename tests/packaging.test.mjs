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
import { createZipFile, readZipEntries, readZipEntryData } from '../scripts/zip.mjs';
import { ROOT_FILES, RUNTIME_DIRS } from '../scripts/package-spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const buildScript = path.join(repoRoot, 'scripts', 'build-package.mjs');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-package.mjs');

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
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
    action: { default_title: '巴别塔（回译）', default_popup: 'popup.html' }
  };
}

function writeFixture(root, { version = '0.3.0', marker = null, extras = [] } = {}) {
  fs.mkdirSync(root, { recursive: true });
  for (const name of ROOT_FILES) {
    if (name === 'manifest.json') continue;
    fs.writeFileSync(path.join(root, name), `/* fixture ${name} */\n`, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(minimalManifest(version), null, 2)}\n`, 'utf8');
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
  if (marker !== null) {
    fs.writeFileSync(path.join(root, 'update-marker.json'), marker, 'utf8');
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

test('构建出的包只有一个顶层目录，版本与标记一致', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture);
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.equal(built.status, 0, built.stderr);

  const report = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json'), 'utf8'));
  assert.equal(report.version, '0.3.0');
  assert.equal(report.tag, 'v0.3.0');
  assert.equal(report.zip, 'babel-tower-backtranslation-0.3.0.zip');

  const zipPath = path.join(out, report.zip);
  const entries = readZipEntries(zipPath);
  const topLevel = new Set(entries.map((item) => item.name.split('/')[0]));
  assert.deepEqual([...topLevel], ['babel-tower-backtranslation-0.3.0']);
  assert.equal(entries.filter((item) => item.name.endsWith('manifest.json')).length, 1);
  assert.ok(entries.some((item) => item.name === 'babel-tower-backtranslation-0.3.0/manifest.json'));

  const markerEntry = entries.find((item) => item.name.endsWith('/update-marker.json'));
  const marker = JSON.parse(readZipEntryData(zipPath, markerEntry).toString('utf8'));
  assert.deepEqual(marker, { version: '0.3.0', ready: true });

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

test('完成标记与 manifest 不一致时构建失败', () => {
  const fixture = tempDir('bx-fixture-');
  const out = tempDir('bx-out-');
  writeFixture(fixture, { marker: '{"version":"0.2.9","ready":true}' });
  const built = runNode([buildScript, '--root', fixture, '--out', out, '--previous', '0.2.2', '--skip-remote-check'], repoRoot);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /不一致/);
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
