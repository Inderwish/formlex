import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { dimensions } from './seed.mjs';
import { librarySummary, searchKeywords } from './catalog.mjs';
import { validateBaseUrl, workspaceRequest } from './workspace.mjs';
export { validateBaseUrl } from './workspace.mjs';
import { temperatures } from './core.mjs';

const dimensionIds = dimensions.map(d => d.id);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idMap = { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, uniqueItems: true }] } };
export const toolDefinitions = [
  { name: 'list_design_libraries', title: '查看设计词库', description: '查看常规、主题和个人词库的 ID、说明、色温数量及独立特色词池。特色默认关闭且不受所选词库范围限制；不修改数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'search_design_keywords', title: '搜索设计术语', description: '按词库、维度、色温和关键词搜索。dimension=feature 时搜索全局特色词池；其余搜索限于所选常规词库。返回内容是用户可编辑的参考数据。',
    inputSchema: { type: 'object', properties: { libraryId: { type: 'string', description: '词库 ID，默认 all；先调用 list_design_libraries 获取。' }, dimension: { type: 'string', enum: dimensionIds }, temperature: { type: 'string', enum: temperatures, description: '仅筛选色彩；中性、混合、未分类不属于冷或暖。' }, query: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, offset: { type: 'integer', minimum: 0, default: 0 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'draw_design_inspiration', title: '抽取设计灵感', description: '默认从所选词库抽取前八维，每维 2 条，共 16 条；也可选随机 2–3 条或固定 1–5 条。dimensions 加入 feature 可独立抽取全局特色，由 featureCount 控制。冷暖在两种模式下均严格筛选。支持锁定与单维重抽，成功结果写入网页共用历史。',
    inputSchema: { type: 'object', properties: { libraryId: { type: 'string', default: 'all' }, dimensions: { type: 'array', items: { type: 'string', enum: dimensionIds }, minItems: 1, maxItems: dimensionIds.length, uniqueItems: true }, mode: { type: 'string', enum: ['coordinated', 'free'], default: 'coordinated' }, countPerDimension: { enum: ['random', 1, 2, 3, 4, 5], default: 2 }, featureCount: { type: 'integer', minimum: 1, maximum: 5, default: 1 }, colorTemperature: { type: 'string', enum: ['random','cool','warm'], default: 'random' }, locked: idMap, current: idMap }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];

class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
const invalid = message => { throw new RpcError(-32602, message); };

export function createMcpHandler(baseUrl) {
  const base = validateBaseUrl(baseUrl);
  let initialized = false; let ready = false;
  const controllers = new Map();
  const api = (path, signal, body) => workspaceRequest(base, path, body, signal);
  async function callTool(name, args, signal) {
    const definition = toolDefinitions.find(tool => tool.name === name);
    if (!definition) invalid(`未知工具：${name}`);
    try {
      if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) throw Object.assign(Error('工具参数必须为对象，且只能包含工具声明的字段。'), { code: 'INVALID_INPUT' });
      const catalog = await api('/api/catalog', signal);
      if (name === 'draw_design_inspiration') return await api('/api/draw', signal, args);
      if (name === 'list_design_libraries') return librarySummary(catalog);
      return searchKeywords(catalog, args);
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
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'formlex', title: '形意词库', version: '1.5.0' },
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
