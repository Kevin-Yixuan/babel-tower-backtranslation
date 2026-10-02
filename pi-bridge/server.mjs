import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPi } from './process.mjs';

const host = '127.0.0.1';
const port = 4097;
const token = process.env.BABEL_PI_TOKEN || randomBytes(24).toString('hex');
const windowsCandidates = ['@earendil-works', '@mariozechner'].map(scope => join(process.env.APPDATA || '', 'npm', 'node_modules', scope, 'pi-coding-agent', 'dist', 'cli.js'));
const piCommand = process.env.BABEL_PI_COMMAND || (process.platform === 'win32' ? windowsCandidates.find(existsSync) || 'pi' : 'pi');
const executable = piCommand.endsWith('.js') ? process.execPath : piCommand;
const prefix = piCommand.endsWith('.js') ? [piCommand] : [];
const piReady = spawnSync(executable, [...prefix, '--version'], { encoding: 'utf8', timeout: 3000 });

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': response.req.headers.origin || 'null', 'Vary': 'Origin' });
  response.end(JSON.stringify(data));
}

http.createServer(async (request, response) => {
  const origin = request.headers.origin || '';
  if (origin && !/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return json(response, 403, { error: 'Extension origin required' });
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': origin || 'null', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return response.end();
  }
  if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: 'Wrong bridge token' });
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ready: piReady.status === 0, version: piReady.stdout?.trim() || '', error: piReady.error?.message || piReady.stderr?.trim() || '' });
  if (request.method !== 'POST' || request.url !== '/chat') return json(response, 404, { error: 'Not found' });
  let body = '';
  try {
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 90000) throw new Error('Request too large');
    }
    const data = JSON.parse(body);
    if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw new Error('Prompt required');
    if (data.prompt.length > 80000) throw new Error('Prompt too long');
    const model = typeof data.model === 'string' && /^[\w./:@+-]{1,120}$/.test(data.model) ? data.model : '';
    if (piReady.status !== 0) throw new Error('Pi CLI unavailable');
    const answer = await runPi({ executable, prefix, prompt: data.prompt, model });
    return json(response, 200, { answer });
  } catch (error) {
    return json(response, error.code === 'PI_TIMEOUT' ? 504 : error.code?.startsWith('PI_') ? 502 : 400, { error: error.message });
  }
}).listen(port, host, () => {
  process.stdout.write(`Pi bridge: http://${host}:${port}\nToken: ${token}\n`);
});
