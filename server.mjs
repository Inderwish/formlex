import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { AppError, object, openStore, draw, dimensions, mutateKeyword, mutateLibrary } from './core.mjs';
import { listLibraries } from './libraries.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, '请使用 Content-Type: application/json。', 'CONTENT_TYPE');
  const chunks = []; let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 65536) { req.resume(); throw new AppError(413, '请求内容不能超过 64 KB。', 'BODY_TOO_LARGE'); }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, '请求不是有效的 JSON。'); }
  if (!object(body)) throw new AppError(400, '请求内容必须为 JSON 对象。');
  return body;
}

export function createApp({ dataFile = join(root, 'data', 'state.json'), write } = {}) {
  const store = openStore(dataFile, write);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
    try {
      const port = server.address().port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new AppError(403, '仅接受本机地址访问。', 'HOST_FORBIDDEN');
      const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
      const method = req.method;
      if (!['GET', 'HEAD'].includes(method)) {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '浏览器写操作必须来自当前页面。', 'ORIGIN_FORBIDDEN');
      }
      if (assets.has(pathname) && ['GET', 'HEAD'].includes(method)) {
        const [file, contentType] = assets.get(pathname);
        const content = readFileSync(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': contentType }); res.end(method === 'HEAD' ? undefined : content); return;
      }
      if (pathname === '/api/catalog' && method === 'GET') return json(200, { apiVersion: 4, dimensions, keywords: store.state.keywords, libraries: listLibraries(store.state), featurePool: { source: 'global', dimension: 'feature', count: store.state.keywords.filter(k => k.dimension === 'feature').length } });
      if (pathname === '/api/libraries' && method === 'GET') return json(200, listLibraries(store.state));
      if (pathname === '/api/libraries' && method === 'POST') {
        const body = await readBody(req);
        return json(201, store.transact(state => mutateLibrary(state, method, undefined, body)));
      }
      const libraryPath = /^\/api\/libraries\/([a-zA-Z0-9-]+)$/.exec(pathname);
      if (libraryPath && ['PATCH', 'DELETE'].includes(method)) {
        const body = method === 'PATCH' ? await readBody(req) : undefined;
        return json(200, store.transact(state => mutateLibrary(state, method, libraryPath[1], body)));
      }
      if (pathname === '/api/history' && method === 'GET') return json(200, store.state.history);
      if (pathname === '/api/favorites' && method === 'GET') return json(200, store.state.favorites);
      if (pathname === '/api/draw' && method === 'POST') {
        const body = await readBody(req);
        const result = store.transact(state => {
          const record = draw(state.keywords, body, 50000, state.libraries);
          state.history.unshift(record); state.history = state.history.slice(0, 100);
          return record;
        });
        return json(201, result);
      }
      if (pathname === '/api/keywords' && method === 'POST') {
        const body = await readBody(req);
        return json(201, store.transact(state => mutateKeyword(state, method, undefined, body)));
      }
      const keywordPath = /^\/api\/keywords\/([a-zA-Z0-9-]+)$/.exec(pathname);
      if (keywordPath && ['PATCH', 'DELETE'].includes(method)) {
        const body = method === 'PATCH' ? await readBody(req) : undefined;
        return json(200, store.transact(state => mutateKeyword(state, method, keywordPath[1], body)));
      }
      if (pathname === '/api/favorites' && method === 'POST') {
        const body = await readBody(req);
        if (typeof body.recordId !== 'string') throw new AppError(400, '请提供抽取记录的 recordId。');
        const existing = store.state.favorites.find(r => r.id === body.recordId);
        if (existing) return json(200, existing);
        return json(201, store.transact(state => {
          const record = state.history.find(r => r.id === body.recordId);
          if (!record) throw new AppError(404, '记录已不在最近 100 次历史中，无法收藏。', 'NOT_FOUND');
          const snapshot = structuredClone(record);
          state.favorites.unshift(snapshot); return snapshot;
        }));
      }
      const favoritePath = /^\/api\/favorites\/([a-zA-Z0-9-]+)$/.exec(pathname);
      if (favoritePath && method === 'DELETE') {
        return json(200, store.transact(state => {
          const index = state.favorites.findIndex(r => r.id === favoritePath[1]);
          if (index < 0) throw new AppError(404, '收藏不存在，请刷新后重试。', 'NOT_FOUND');
          state.favorites.splice(index, 1); return { deleted: favoritePath[1] };
        }));
      }
      throw new AppError(404, '未找到该页面或接口。', 'NOT_FOUND');
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      if (!res.headersSent) json(error.status ?? 500, { error: { code: error.code ?? 'INTERNAL_ERROR', message: error.status ? error.message : '服务暂时无法完成请求，请查看终端后重试。' } });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { port: { type: 'string' }, 'data-file': { type: 'string' }, open: { type: 'boolean', default: false } } });
    const port = Number(values.port ?? process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 必须是 1–65535 之间的整数。');
    const dataFile = values['data-file'] ?? process.env.DATA_FILE;
    const { server } = createApp({ dataFile: dataFile ? resolve(dataFile) : undefined });
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请通过 PORT 指定其他端口。` : error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`形意词库 FormLex 已启动：${url}\n按 Ctrl+C 关闭。`);
      if (values.open && process.platform === 'win32') {
        execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeout: 5000, windowsHide: true }, error => {
          if (error) console.error(`无法自动打开浏览器，请手动访问 ${url}`);
        });
      }
    });
    const stop = () => { server.close(() => { console.log('DONE'); process.exitCode = 0; }); server.closeAllConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
