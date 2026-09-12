import { parseArgs } from 'node:util';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { keywords } from './seed.mjs';
import { AppError, object, draw } from './core.mjs';
import { createCatalog, librarySummary, searchKeywords } from './catalog.mjs';
import { workspaceRequest, validateBaseUrl } from './workspace.mjs';

function readInput(file) {
  if (file === undefined) return {};
  let fd;
  try {
    fd = openSync(file, 'r');
    if (!fstatSync(fd).isFile()) throw Error('参数路径必须是普通文件。');
    const bytes = Buffer.alloc(65537); let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size > 65536) throw Error('参数文件不能超过 64 KB。');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) { throw new AppError(400, `无法读取 UTF-8 JSON 参数文件：${error.message}`); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function runCli(argv) {
  let source = 'builtin';
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      source: { type: 'string' }, input: { type: 'string' }, url: { type: 'string' }, help: { type: 'boolean' },
    } });
    source = values.source ?? 'builtin';
    if (!['builtin', 'workspace'].includes(source)) throw new AppError(400, 'source 必须是 builtin 或 workspace。');
    if (values.help) return { source, historySaved: false, result: { usage: 'node cli.mjs <libraries|search|draw> [--source builtin|workspace] [--input 参数.json] [--url http://127.0.0.1:3000]', defaults: { source: 'builtin', dimensions: '原八维', mode: 'coordinated', countPerDimension: 'random (2–3)', colorTemperature: 'random', feature: false }, note: 'builtin 离线且不保存历史；workspace 需先启动工作台，抽取保存共享历史。--input 为 UTF-8 JSON 对象，最大 64 KB。' } };
    const command = positionals[0];
    if (positionals.length !== 1 || !['libraries', 'search', 'draw'].includes(command)) throw new AppError(400, '请指定 libraries、search 或 draw，使用 --help 查看用法。');
    if (source === 'builtin' && values.url !== undefined) throw new AppError(400, '指定 --url 时必须显式使用 --source workspace；builtin 始终离线。');
    const input = readInput(values.input);
    if (!object(input)) throw new AppError(400, '参数必须为 JSON 对象。');
    if (command === 'libraries' && Object.keys(input).length) throw new AppError(400, 'libraries 不接受查询参数。');
    const base = source === 'workspace' ? validateBaseUrl(values.url ?? 'http://127.0.0.1:3000') : undefined;
    const catalog = source === 'builtin' ? createCatalog({ keywords }) : await workspaceRequest(base, '/api/catalog');
    const result = command === 'libraries' ? librarySummary(catalog)
      : command === 'search' ? searchKeywords(catalog, input)
      : source === 'builtin' ? draw(keywords, input) : await workspaceRequest(base, '/api/draw', input);
    return { source, historySaved: source === 'workspace' && command === 'draw', result };
  } catch (error) {
    return { source, historySaved: error.historySaved === null ? null : false,
      error: { code: error.code?.startsWith('ERR_PARSE_ARGS') ? 'INVALID_INPUT' : error.code ?? 'INTERNAL_ERROR', message: error.message, ...(error.status ? { status: error.status } : {}) } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = await runCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exitCode = output.error ? 1 : 0;
}
