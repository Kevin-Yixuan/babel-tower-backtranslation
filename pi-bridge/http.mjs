import http from 'node:http';

const failure = (status, message) => Object.assign(new Error(message), { status });
function json(response, status, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': response.req.headers.origin || 'null', Vary: 'Origin' });
  response.end(JSON.stringify(data));
}

export function createPiServer({ token, health, run }) {
  let active = false;
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (origin && !/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return json(response, 403, { error: '请从浏览器扩展连接本机桥接。' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': origin || 'null', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      return response.end();
    }
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: 'Pi 桥接令牌不正确，请重新填写启动窗口显示的令牌。' });
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, health);
    if (request.method !== 'POST' || request.url !== '/chat') return json(response, 404, { error: '桥接地址不存在。' });
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    response.on('close', disconnected);
    try {
      // Streaming UTF-8 decoding preserves a character split between TCP chunks.
      request.setEncoding('utf8');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 90000) throw failure(413, '请求过长，请缩短材料后重试。');
      }
      let data;
      try { data = JSON.parse(body); } catch { throw failure(400, '请求格式不正确，请重新发送。'); }
      if (!data || typeof data.prompt !== 'string' || !data.prompt.trim()) throw failure(400, '请提供写作指令。');
      if (data.prompt.length > 80000) throw failure(413, '指令过长，请拆分材料后重试。');
      if (data.model && (typeof data.model !== 'string' || !/^[\w./:@+-]{1,120}$/.test(data.model))) throw failure(400, '模型名称无效，请检查设置。');
      if (!health.ready) throw failure(503, 'Pi 尚未就绪，请安装并配置 Pi 后重启桥接服务。');
      if (active) throw failure(429, 'Pi 正在处理另一请求，请等待完成后重试。');
      if (controller.signal.aborted) return;
      active = true;
      try {
        const answer = await run({ prompt: data.prompt, model: data.model || '', signal: controller.signal });
        json(response, 200, { answer });
      } finally { active = false; }
    } catch (error) {
      const status = error.status || (error.code === 'PI_TIMEOUT' ? 504 : 502);
      json(response, status, { error: error.message });
    } finally { response.off('close', disconnected); }
  });
}
