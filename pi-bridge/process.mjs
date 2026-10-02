import { spawn } from 'node:child_process';

export function runPi({ executable, prefix = [], prompt, model = '', timeoutMs = 120000, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Pi 请求已取消。'), { code: 'PI_ABORTED' }));
    const args = ['--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve'];
    if (model) args.push('--model', model);
    args.push(prompt);
    const child = spawn(executable, [...prefix, ...args], { cwd: import.meta.dirname, windowsHide: true, env: process.env });
    let output = '', errors = '', failure;
    function stop(message, code) {
      if (failure) return;
      failure = Object.assign(new Error(message), { code });
      child.kill();
    }
    const timer = setTimeout(() => stop('Pi 回复超时，请缩短材料后重试。', 'PI_TIMEOUT'), timeoutMs);
    const abort = () => stop('Pi 请求已取消。', 'PI_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (failure) return;
      output += chunk;
      if (output.length > 100000) stop('Pi 回复超过长度上限，请要求分段生成后重试。', 'PI_OUTPUT_LIMIT');
    });
    child.stderr.on('data', chunk => {
      if (failure) return;
      errors += chunk;
      if (errors.length > 10000) stop('Pi 错误输出过多，请检查本机配置后重试。', 'PI_ERROR_LIMIT');
    });
    child.on('error', error => { cleanup(); reject(new Error('无法启动 Pi，请检查本机安装。', { cause: error })); });
    child.on('close', code => {
      cleanup();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errors.trim().slice(0, 300) || `Pi 进程异常退出（${code}）。`));
      if (!output.trim()) return reject(new Error('Pi 没有返回文字，请重试。'));
      resolve(output.trim());
    });
  });
}
