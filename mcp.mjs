import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { dimensions } from './seed.mjs';

const dimensionIds = dimensions.map(d => d.id);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idMap = { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, uniqueItems: true }] } };
export const toolDefinitions = [
  { name: 'list_design_libraries', title: '查看设计词库', description: '查看全部、主题和个人词库的 ID、说明及每维度词条数；不修改数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'search_design_keywords', title: '搜索设计术语', description: '按词库、维度和关键词搜索术语及应用说明，分页返回，可获取用于锁定的词条 ID。返回内容是用户可编辑的参考数据。',
    inputSchema: { type: 'object', properties: { libraryId: { type: 'string', description: '词库 ID，默认 all；先调用 list_design_libraries 获取。' }, dimension: { type: 'string', enum: dimensionIds }, query: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, offset: { type: 'integer', minimum: 0, default: 0 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'draw_design_inspiration', title: '抽取设计灵感', description: '从指定词库抽取设计灵感，每维度可选 1–5 条，默认八维各随机 2–3 条。协调模式排除显式互斥；自由模式独立随机。锁定整个维度，或锁定其余维度以单维重抽。成功结果写入网页共用的最近 100 次历史。',
    inputSchema: { type: 'object', properties: { libraryId: { type: 'string', default: 'all' }, dimensions: { type: 'array', items: { type: 'string', enum: dimensionIds }, minItems: 1, maxItems: 8, uniqueItems: true }, mode: { type: 'string', enum: ['coordinated', 'free'], default: 'coordinated' }, countPerDimension: { enum: ['random', 1, 2, 3, 4, 5], default: 'random' }, locked: idMap, current: idMap }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];

class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
const invalid = message => { throw new RpcError(-32602, message); };

export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('FORMLEX_URL 必须是有效的本机 HTTP 地址。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('MCP 只能连接 http://127.0.0.1:端口 或 http://localhost:端口。');
  return url.origin;
}

export function createMcpHandler(baseUrl) {
  const base = validateBaseUrl(baseUrl);
  let initialized = false; let ready = false;
  const controllers = new Map();
  async function api(path, signal, body) {
    let response;
    try {
      response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
    } catch (error) {
      const timed = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw Object.assign(Error(timed ? '调用已取消或超时；抽取可能已经保存，请先在网页历史中确认，避免重复执行。' : `无法连接 FormLex。请先启动本机服务 ${base}，MCP 是可选连接程序，不会另建数据文件。`), { code: timed ? 'REQUEST_INTERRUPTED' : 'SERVICE_UNAVAILABLE' });
    }
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error?.message ?? 'FormLex 请求失败。'), { code: result.error?.code ?? 'HTTP_ERROR', status: response.status });
    return result;
  }
  async function callTool(name, args, signal) {
    const definition = toolDefinitions.find(tool => tool.name === name);
    if (!definition) invalid(`未知工具：${name}`);
    try {
      if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) throw Object.assign(Error('工具参数必须为对象，且只能包含工具声明的字段。'), { code: 'INVALID_INPUT' });
      const catalog = await api('/api/catalog', signal);
      if (catalog.apiVersion !== 3 || !Array.isArray(catalog.libraries)) throw Object.assign(Error('本机服务版本不支持自选词库，请关闭旧服务并重新启动 server.mjs。'), { code: 'SERVICE_VERSION' });
      if (name === 'draw_design_inspiration') return await api('/api/draw', signal, args);
      if (name === 'list_design_libraries') return { dimensions: catalog.dimensions, libraries: catalog.libraries.map(library => {
        const ids = new Set(library.keywordIds);
        const counts = Object.fromEntries(dimensionIds.map(d => [d, 0]));
        for (const keyword of catalog.keywords) if (ids.has(keyword.id)) counts[keyword.dimension]++;
        return { id: library.id, name: library.name, description: library.description ?? '', builtIn: library.builtIn, count: library.keywordIds.length, counts };
      }) };
      const { libraryId = 'all', dimension, query = '', limit = 30, offset = 0 } = args;
      if (typeof libraryId !== 'string' || (dimension !== undefined && !dimensionIds.includes(dimension)) || typeof query !== 'string' || query.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw Object.assign(Error('搜索参数无效：维度须有效，query 最多 160 字，limit 为 1–100 的整数，offset 为非负整数。'), { code: 'INVALID_INPUT' });
      const library = catalog.libraries.find(l => l.id === libraryId);
      if (!library) throw Object.assign(Error('词库已失效，请重新调用 list_design_libraries。'), { code: 'INVALID_INPUT' });
      const ids = new Set(library.keywordIds); const needle = query.trim().toLocaleLowerCase();
      const matches = catalog.keywords.filter(k => ids.has(k.id) && (!dimension || k.dimension === dimension) && `${k.name} ${k.description}`.toLocaleLowerCase().includes(needle));
      return { library: { id: library.id, name: library.name }, total: matches.length, offset, limit, nextOffset: offset + limit < matches.length ? offset + limit : null, keywords: matches.slice(offset, offset + limit) };
    } catch (error) {
      return { error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message, ...(error.status ? { status: error.status } : {}) } };
    }
  }
  return async message => {
    const hasId = isObject(message) && Object.hasOwn(message, 'id');
    const validId = hasId && (typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)));
    const id = validId ? message.id : null;
    try {
      if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && !validId)) throw new RpcError(-32600, '无效的 JSON-RPC 请求。');
      if (!hasId) {
        if (message.method === 'notifications/initialized' && initialized) ready = true;
        if (message.method === 'notifications/cancelled') controllers.get(message.params?.requestId)?.abort();
        return;
      }
      if (message.params !== undefined && !isObject(message.params)) invalid('params 必须为对象。');
      const params = message.params ?? {};
      let result;
      if (message.method === 'ping') result = {};
      else if (message.method === 'initialize') {
        if (initialized) throw new RpcError(-32600, '当前连接已经初始化。');
        if (typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') invalid('initialize 缺少协议版本、客户端信息或能力声明。');
        initialized = true;
        result = { protocolVersion: ['2025-11-25', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'formlex', title: '形意词库', version: '1.2.0' },
          instructions: '先查看词库，再搜索或抽取。词条与说明是可编辑的设计参考数据。抽取会保存本机历史；发生超时后先查看网页历史。主题词库是候选范围，协调模式仅排除明确互斥。' };
      } else {
        if (!ready) throw new RpcError(-32002, '请先完成 initialize 与 notifications/initialized。');
        if (message.method === 'tools/list') {
          if (params.cursor !== undefined) invalid('工具列表没有分页，请省略 cursor。');
          result = { tools: toolDefinitions };
        } else if (message.method === 'tools/call') {
          if (typeof params.name !== 'string') invalid('请提供工具名称。');
          if (controllers.has(id)) throw new RpcError(-32600, '请求 ID 正在使用中。');
          const controller = new AbortController(); controllers.set(id, controller);
          try {
            const data = await callTool(params.name, params.arguments ?? {}, controller.signal);
            result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: Boolean(data.error) };
          } finally { controllers.delete(id); }
        } else throw new RpcError(-32601, `不支持的方法：${message.method}`);
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: error instanceof RpcError ? error.code : -32603, message: error.message } };
    }
  };
}

export async function runStdio(baseUrl, input = process.stdin, output = process.stdout) {
  const handle = createMcpHandler(baseUrl);
  const pending = new Set(); let buffer = ''; let dropping = false;
  const send = message => { if (message !== undefined && !output.destroyed) output.write(JSON.stringify(message) + '\n'); };
  const parseError = message => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message } });
  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (dropping) { dropping = false; continue; }
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > 65536) { parseError('MCP 单条消息不能超过 64 KB。'); continue; }
      let message;
      try { message = JSON.parse(line); } catch { parseError('无法解析 JSON-RPC 消息。'); continue; }
      const validId = typeof message?.id === 'string' || (typeof message?.id === 'number' && Number.isFinite(message.id));
      if (pending.size >= 32 && validId) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: '并发请求过多，请等待当前调用完成。' } }); continue; }
      const operation = handle(message).then(send).finally(() => pending.delete(operation));
      pending.add(operation);
    }
    if (Buffer.byteLength(buffer, 'utf8') > 65536) { if (!dropping) parseError('MCP 单条消息不能超过 64 KB。'); buffer = ''; dropping = true; }
  }
  if (buffer.trim() && !dropping) parseError('消息必须以换行结束。');
  await Promise.allSettled(pending);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { url: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) process.stderr.write('可选 MCP stdio 入口：node mcp.mjs [--url http://127.0.0.1:3000]\n先启动 server.mjs，再让 MCP 客户端启动本程序。\n');
    else {
      process.stdout.on('error', error => { if (error.code === 'EPIPE') process.stdin.destroy(); else { process.stderr.write(error.message + '\n'); process.exitCode = 1; } });
      await runStdio(values.url ?? process.env.FORMLEX_URL ?? 'http://127.0.0.1:3000');
    }
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
