import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { runCli } from './cli.mjs';
import { createCatalog, librarySummary, searchKeywords } from './catalog.mjs';
import { createApp } from './server.mjs';
import { atomicWrite, conflicts } from './core.mjs';
import { keywords, defaultDimensions } from './seed.mjs';
import { createMcpHandler } from './mcp.mjs';
import { buildPlugin, pluginRoot } from './scripts/build-plugin.mjs';

const execute = promisify(execFile);
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'formlex 插件验证 '));
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 3 }));
  return path;
}
function inventory(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true }).filter(path => {
    const stat = lstatSync(join(root, path)); assert.equal(stat.isSymbolicLink(), false); return stat.isFile();
  }).sort().map(path => [path.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
}
function client(t) {
  const directory = mkdtempSync(join(tmpdir(), 'formlex 插件验证 '));
  const installed = join(directory, '任意目录', 'formlex');
  let before;
  t.after(() => {
    try { if (before) assert.deepEqual(inventory(installed), before, '运行插件不能写安装目录'); }
    finally { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
  });
  // Node 22 on Windows can corrupt CJK destination names in the native cpSync fast path.
  const copy = (source, destination) => {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) copy(join(source, entry.name), join(destination, entry.name));
      else copyFileSync(join(source, entry.name), join(destination, entry.name));
    }
  };
  copy(process.env.FORMLEX_TEST_PLUGIN_ROOT ?? pluginRoot, installed);
  before = inventory(installed);
  let serial = 0;
  return async (command, input, options = []) => {
    const args = [join(installed, 'runtime', 'cli.mjs'), command, ...options];
    if (input !== undefined) {
      const file = join(directory, `参数 ${++serial}.json`); writeFileSync(file, JSON.stringify(input), 'utf8');
      args.push('--input', file);
    }
    let stdout, stderr, exitCode = 0;
    try { ({ stdout, stderr } = await execute(process.execPath, args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 ** 20 })); }
    catch (error) {
      assert.equal(error.killed, false, error.message); assert.equal(error.code, 1, error.message);
      ({ stdout, stderr } = error); exitCode = error.code;
    }
    assert.equal(stderr, '');
    const output = JSON.parse(stdout);
    assert.equal(exitCode, output.error ? 1 : 0);
    return output;
  };
}
const grouped = record => Object.fromEntries([...new Set(record.items.map(k => k.dimension))].map(d => [d, record.items.filter(k => k.dimension === d).map(k => k.id)]));
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('插件生成一致、清单资源与 marketplace 路径完整，没有用户数据和自动 MCP', () => {
  buildPlugin({ check: true });
  const files = inventory(pluginRoot);
  assert.deepEqual(Object.keys(files).filter(path => /(^|\/)(data|history|favorites|cache|node_modules|\.git)(\/|\.)/.test(path)), []);
  const manifest = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'formlex'); assert.equal(manifest.version, '1.6.0');
  for (const field of ['mcpServers', 'apps', 'hooks']) assert.equal(Object.hasOwn(manifest, field), false);
  assert.equal(existsSync(join(pluginRoot, '.mcp.json')), false);
  for (const path of [manifest.skills, manifest.interface.logo, manifest.interface.composerIcon, ...manifest.interface.screenshots]) {
    assert.ok(path.startsWith('./')); assert.ok(existsSync(join(pluginRoot, path)));
    assert.ok(!relative(pluginRoot, resolve(pluginRoot, path)).startsWith('..'));
  }
  const marketplace = JSON.parse(readFileSync(new URL('./.agents/plugins/marketplace.json', import.meta.url), 'utf8'));
  const entry = marketplace.plugins.find(p => p.name === manifest.name);
  assert.equal(entry.source.path, './plugins/formlex'); assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  for (const path of Object.keys(files).filter(f => /\.(mjs|json|md|yaml|svg)$/.test(f))) {
    const text = readFileSync(join(pluginRoot, path), 'utf8');
    assert.doesNotMatch(text, /[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\/[^/]+\/|\[TODO:/i, path);
    if (path.endsWith('.mjs')) for (const match of text.matchAll(/from ['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('node:')) continue;
      assert.ok(match[1].startsWith('./'), `${path}: ${match[1]}`);
      assert.ok(existsSync(resolve(pluginRoot, 'runtime', match[1])));
    }
  }
  const skill = readFileSync(join(pluginRoot, 'skills/formlex-design/SKILL.md'), 'utf8');
  const reference = resolve(pluginRoot, 'skills/formlex-design', '../../docs/cli.md');
  assert.ok(isAbsolute(reference)); assert.ok(existsSync(reference));
  assert.match(skill, /name: formlex-design/);
  assert.match(skill, /只要灵感或方案时只给简报/);
});

test('builtin 调用不使用网络，查询只返回摘要或指定分页', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw Error('离线调用不应联网'); };
  try {
    const list = await runCli(['libraries']);
    assert.equal(list.source, 'builtin'); assert.equal(list.historySaved, false);
    assert.equal(list.result.libraries[0].count, 1274); assert.equal(list.result.featurePool.count, 150);
    assert.equal(list.result.keywords, undefined);
    assert.deepEqual(list.result, librarySummary(createCatalog({ keywords })));
    assert.ok((await runCli(['draw'])).result.items.length >= 16);
  } finally { globalThis.fetch = previous; }
});

test('隔离插件：默认八维、所有主题范围与严格冷暖、特色独立 1–5 条', { timeout: 45000 }, async t => {
  const cli = client(t);
  const initial = await cli('draw');
  assert.equal(initial.source, 'builtin'); assert.equal(initial.historySaved, false);
  assert.equal(initial.result.mode, 'coordinated'); assert.equal(initial.result.colorTemperature, 'random');
  assert.equal(initial.result.featureSource, null);
  for (const dimension of defaultDimensions) assert.equal(grouped(initial.result)[dimension.id].length, 2);
  assert.equal(initial.result.items.length, 16);
  assert.equal(initial.result.countPerDimension, 2);
  assert.equal(Object.keys(grouped(initial.result)).length, 8);
  for (const a of initial.result.items) for (const b of initial.result.items) if (a.id !== b.id) assert.equal(conflicts(a, b), false);
  const libraries = (await cli('libraries')).result.libraries;
  const catalog = createCatalog({ keywords });
  for (const library of libraries.filter(l => !['all', 'foundation'].includes(l.id))) {
    assert.ok(library.temperatureCounts.cool >= 5); assert.ok(library.temperatureCounts.warm >= 5);
    for (const colorTemperature of ['cool', 'warm']) {
      const result = await cli('draw', { libraryId: library.id, dimensions: ['color'], countPerDimension: 5, colorTemperature, mode: 'free' });
      assert.equal(result.error, undefined);
      assert.ok(result.result.items.every(k => k.temperature === colorTemperature && catalog.libraries.find(l => l.id === library.id).keywordIds.includes(k.id)));
    }
  }
  for (const featureCount of [1, 2, 3, 4, 5]) {
    const record = (await cli('draw', { libraryId: 'eastern', dimensions: ['feature'], featureCount, countPerDimension: 5 })).result;
    assert.equal(record.items.length, featureCount); assert.equal(record.featureSource, 'global');
  }
  for (const temperature of ['cool', 'warm', 'neutral', 'mixed', 'unspecified']) {
    const args = { temperature, limit: 8 };
    const result = (await cli('search', args)).result;
    assert.deepEqual(result, searchKeywords(catalog, args));
    assert.ok(result.keywords.every(k => k.temperature === temperature));
  }
  const search = (await cli('search', { dimension: 'feature', libraryId: 'classical', query: '鼠标', limit: 8 })).result;
  assert.equal(search.source, 'global'); assert.equal(search.library, null); assert.ok(search.total > 0);
});

test('隔离插件：锁定、单维重抽、显式冲突、无效参数及 UTF-8 文件', { timeout: 20000 }, async t => {
  const cli = client(t);
  const args = { dimensions: ['style', 'color', 'feature'], mode: 'free', countPerDimension: 2, featureCount: 3 };
  const first = (await cli('draw', args)).result;
  const current = grouped(first);
  const next = (await cli('draw', { ...args, current, locked: { style: current.style, feature: current.feature }, featureCount: 1 })).result;
  assert.deepEqual(next.items.filter(k => k.dimension !== 'color'), first.items.filter(k => k.dimension !== 'color'));
  assert.ok(grouped(next).color.every(id => !current.color.includes(id)));
  const cool = keywords.find(k => k.dimension === 'color' && k.temperature === 'cool');
  assert.equal((await cli('draw', { dimensions: ['color', 'shape'], colorTemperature: 'warm', locked: { color: [cool.id] } })).error.code, 'LOCK_TEMPERATURE_CONFLICT');
  const a = keywords.find(k => k.conflicts.length && k.dimension !== 'feature');
  const b = keywords.find(k => k.id === a.conflicts[0]);
  const locked = grouped({ items: [a, b] });
  const dimensions = [...new Set([a.dimension, b.dimension, 'feature'])];
  assert.equal((await cli('draw', { dimensions, locked })).error.code, 'LOCK_CONFLICT');
  assert.ok((await cli('draw', { dimensions, locked, mode: 'free' })).result);
  for (const input of [{ foo: 1 }, { countPerDimension: 6 }, { featureCount: 0 }, { colorTemperature: 'neutral' }, { current: { style: ['deleted-id'] } }, []]) assert.equal((await cli('draw', input)).error.code, 'INVALID_INPUT');
  assert.equal((await cli('libraries', { query: 'x' })).error.code, 'INVALID_INPUT');
  assert.equal((await cli('search', { dimension: 'feature', temperature: 'cool' })).error.code, 'INVALID_INPUT');
  assert.equal((await cli('draw', {}, ['--url', 'http://127.0.0.1:1'])).error.code, 'INVALID_INPUT');
  const directory = temporary(t); const inputFile = join(directory, '编码 参数.json');
  for (const invalid of [Buffer.from([0xff, 0xfe]), Buffer.from('{broken'), Buffer.alloc(65537, 32)]) {
    writeFileSync(inputFile, invalid);
    assert.equal((await runCli(['draw', '--input', inputFile])).error.code, 'INVALID_INPUT');
  }
  writeFileSync(inputFile, '\ufeff' + JSON.stringify({ query: '哥特', limit: 2 }), 'utf8');
  assert.ok((await runCli(['search', '--input', inputFile])).result.total > 0);
});

test('工作台 CLI：与 HTTP/MCP 同一词库、快照和历史，保存失败不返回成功', { timeout: 30000 }, async t => {
  const cli = client(t); const directory = temporary(t); let fail = false;
  const app = createApp({ dataFile: join(directory, 'state.json'), write: (file, state) => { if (fail) throw Error('模拟保存失败'); atomicWrite(file, state); } });
  const base = await listen(app.server);
  t.after(() => close(app.server));
  const options = ['--source', 'workspace', '--url', base];
  const http = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok); return response.json();
  };
  const personal = await http('/api/libraries', { name: '验证个人词库', keywordIds: ['style-01', 'style-02', 'style-03', 'color-01', 'color-02', 'color-03'] });
  const edited = await http('/api/keywords/style-01', { name: '修改后风格', description: '保留这条人工修改说明。' }, 'PATCH');
  assert.equal(edited.name, '修改后风格');
  const summary = (await cli('libraries', {}, options)).result;
  assert.ok(summary.libraries.some(l => l.id === personal.id));
  const args = { libraryId: personal.id, dimensions: ['style'], countPerDimension: 3, mode: 'free' };
  const response = await cli('draw', args, options);
  assert.equal(response.source, 'workspace'); assert.equal(response.historySaved, true);
  assert.ok(response.result.items.some(k => k.name === '修改后风格'));
  assert.deepEqual((await http('/api/history'))[0], response.result);
  const handle = createMcpHandler(base);
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' } } });
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const mcp = async (name, arguments_) => (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: arguments_ } })).result.structuredContent;
  assert.deepEqual(await mcp('list_design_libraries', {}), summary);
  const search = { libraryId: personal.id, query: '人工', limit: 2 };
  assert.deepEqual((await cli('search', search, options)).result, await mcp('search_design_keywords', search));
  const repeated = await mcp('draw_design_inspiration', args);
  assert.deepEqual(new Set(repeated.items.map(k => k.id)), new Set(response.result.items.map(k => k.id)));
  assert.deepEqual((await http('/api/history'))[0], repeated);
  const before = (await http('/api/history')).length;
  fail = true;
  const failed = await cli('draw', args, options);
  fail = false;
  assert.equal(failed.error.code, 'SAVE_FAILED'); assert.equal(failed.historySaved, false); assert.equal(failed.result, undefined);
  assert.equal((await http('/api/history')).length, before);
  await http('/api/keywords/style-01', { name: '再次改名' }, 'PATCH');
  assert.ok((await http('/api/history')).find(r => r.id === response.result.id).items.some(k => k.name === '修改后风格'));
  await http('/api/keywords/style-03', undefined, 'DELETE');
  assert.equal((await cli('draw', { ...args, current: { style: ['style-03'] } }, options)).error.code, 'INVALID_INPUT');
  assert.equal((await cli('draw', args, options)).error.code, 'INSUFFICIENT_CANDIDATES');
});

test('工作台不可用、不兼容及提交后断连均不回退，不确定保存状态如实返回', { timeout: 15000 }, async t => {
  const cli = client(t);
  const unavailable = await cli('draw', {}, ['--source', 'workspace', '--url', 'http://127.0.0.1:1']);
  assert.equal(unavailable.source, 'workspace'); assert.equal(unavailable.historySaved, false);
  assert.equal(unavailable.error.code, 'SERVICE_UNAVAILABLE'); assert.equal(unavailable.result, undefined);
  let compatible = false;
  const server = createServer((req, res) => {
    if (req.url === '/api/draw') { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(compatible ? createCatalog({ keywords }) : { apiVersion: 3, libraries: [] }));
  });
  const base = await listen(server); t.after(() => close(server));
  assert.equal((await cli('draw', {}, ['--source', 'workspace', '--url', base])).error.code, 'SERVICE_VERSION');
  compatible = true;
  const interrupted = await cli('draw', {}, ['--source', 'workspace', '--url', base]);
  assert.equal(interrupted.historySaved, null); assert.equal(interrupted.result, undefined);
});

process.on('exit', code => { if (code === 0) console.log('DONE'); });
