import test from 'node:test';
import assert from 'node:assert/strict';
import { runPi } from '../pi-bridge/process.mjs';

const run = (code, extra = {}) => runPi({ executable: process.execPath, prefix: ['-e', code, '--'], prompt: 'fixture prompt', timeoutMs: 3000, ...extra });

test('Pi 子进程正常返回 Unicode，危险功能关闭且模型参数保留', async () => {
  const answer = await run('process.stdout.write(JSON.stringify(process.argv.slice(1)))', { model: 'provider/model' });
  const args = JSON.parse(answer);
  assert(args.includes('--no-tools'));
  assert(args.includes('--no-context-files'));
  assert(args.includes('--no-extensions'));
  assert.equal(args[args.indexOf('--model') + 1], 'provider/model');
  assert.equal(args.at(-1), 'fixture prompt');
  const unicode = await run('const b=Buffer.from("中文回复"); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),20)');
  assert.equal(unicode, '中文回复');
});

test('Pi 超时终止后给出明确错误，下一次请求仍正常', async () => {
  await assert.rejects(run('setInterval(()=>{},1000)', { timeoutMs: 200 }), { code: 'PI_TIMEOUT' });
  assert.equal(await run('process.stdout.write("恢复")'), '恢复');
});

test('Pi 输出与错误输出超限不能当成完整答案', async () => {
  await assert.rejects(run('process.stdout.write("x".repeat(110000)); setInterval(()=>{},1000)'), { code: 'PI_OUTPUT_LIMIT' });
  await assert.rejects(run('process.stderr.write("x".repeat(11000)); setInterval(()=>{},1000)'), { code: 'PI_ERROR_LIMIT' });
});

test('Pi 空输出、异常退出和无法启动都明确失败', async () => {
  await assert.rejects(run(''), /没有返回文字/);
  await assert.rejects(run('process.stderr.write("fixture error");process.exitCode=1'), /fixture error/);
  await assert.rejects(runPi({ executable: 'nonexistent-pi-fixture-command', prompt: 'test', timeoutMs: 500 }), /无法启动 Pi/);
});
