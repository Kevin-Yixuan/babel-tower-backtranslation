import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPi } from './process.mjs';
import { createPiServer } from './http.mjs';

const host = '127.0.0.1';
const port = 4097;
const token = process.env.BABEL_PI_TOKEN || randomBytes(24).toString('hex');
const windowsCandidates = ['@earendil-works', '@mariozechner'].map(scope => join(process.env.APPDATA || '', 'npm', 'node_modules', scope, 'pi-coding-agent', 'dist', 'cli.js'));
const piCommand = process.env.BABEL_PI_COMMAND || (process.platform === 'win32' ? windowsCandidates.find(existsSync) || 'pi' : 'pi');
const executable = piCommand.endsWith('.js') ? process.execPath : piCommand;
const prefix = piCommand.endsWith('.js') ? [piCommand] : [];
const piReady = spawnSync(executable, [...prefix, '--version'], { encoding: 'utf8', timeout: 3000 });

createPiServer({
  token,
  health: { ready: piReady.status === 0, version: piReady.stdout?.trim() || '', error: piReady.error?.message || piReady.stderr?.trim() || '' },
  run: options => runPi({ executable, prefix, ...options })
}).listen(port, host, () => {
  process.stdout.write(`Pi bridge: http://${host}:${port}\nToken: ${token}\n`);
});
