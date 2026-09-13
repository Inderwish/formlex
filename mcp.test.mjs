import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';
import { atomicWrite } from './core.mjs';
import { createMcpHandler, validateBaseUrl } from './mcp.mjs';

const initialize = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'formlex-tests', version: '1' } };
test('MCP 生命周期、协议协商与本机地址限制', async () => {
  for (const value of ['https://127.0.0.1:3000', 'http://example.com', 'http://127.0.0.1/path', 'http://user:pass@localhost:3000', 'http://localhost:3000?x=1']) assert.throws(() => validateBaseUrl(value));
  const handle = createMcpHandler('http://127.0.0.1:1');
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).error.code, -32002);
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })).error.code, -32602);
  const initialized = await handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { ...initialize, protocolVersion: 'future-version' } });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).result.tools.length, 3);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing' } })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, -32600);
  const unavailable = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'draw_design_inspiration', arguments: {} } });
  assert.equal(unavailable.result.isError, true); assert.equal(unavailable.result.structuredContent.error.code, 'SERVICE_UNAVAILABLE');
});

test('真实 stdio MCP：查询、自选范围、抽取、锁定、历史一致、错误与关闭', { timeout: 25000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'formlex-mcp-test-'));
  let fail = false;
  const app = createApp({ dataFile: join(directory, 'state.json'), write: (file, state) => { if (fail) throw Error('模拟保存失败'); atomicWrite(file, state); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp.mjs', import.meta.url)), '--url', base], { stdio: ['pipe','pipe','pipe'], windowsHide: true, timeout: 20000 });
  let buffer = ''; let stderr = ''; let nextId = 0;
  const waiting = new Map(); const unsolicited = []; const protocolFailures = [];
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    buffer += data; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { protocolFailures.push(line); continue; }
      const handler = waiting.get(message.id);
      if (handler) { waiting.delete(message.id); handler(message); } else unsolicited.push(message);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { waiting.delete(id); reject(Error(`MCP 超时：${method}; ${stderr}`)); }, 6000);
    waiting.set(id, message => { clearTimeout(timeout); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  const call = async (name, args = {}) => (await send('tools/call', { name, arguments: args })).result;
  const http = async (path, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok); return response.json();
  };
  try {
    assert.equal((await send('initialize', initialize)).result.serverInfo.name, 'formlex');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const tools = (await send('tools/list')).result.tools;
    assert.equal(tools.length, 3); assert.equal(tools.find(t => t.name === 'draw_design_inspiration').annotations.readOnlyHint, false);
    const libraries = await call('list_design_libraries');
    assert.equal(libraries.structuredContent.libraries[0].count, 1274);
    assert.equal(libraries.structuredContent.featurePool.count, 150);
    assert.equal(libraries.structuredContent.featurePool.source, 'global');
    for (const library of libraries.structuredContent.libraries.filter(l => !['all','foundation'].includes(l.id))) {
      assert.ok(library.temperatureCounts.cool >= 5); assert.ok(library.temperatureCounts.warm >= 5);
      assert.ok(!Object.hasOwn(library.counts, 'feature'));
    }
    assert.equal(libraries.structuredContent.libraries.find(l => l.id === 'digital').counts.style, 10);
    const page = await call('search_design_keywords', { libraryId: 'classical', dimension: 'style', limit: 2 });
    assert.equal(page.structuredContent.total, 10); assert.equal(page.structuredContent.nextOffset, 2);
    const next = await call('search_design_keywords', { libraryId: 'classical', dimension: 'style', limit: 2, offset: 2 });
    assert.notEqual(next.structuredContent.keywords[0].id, page.structuredContent.keywords[0].id);
    const found = await call('search_design_keywords', { query: '哥特' }); assert.ok(found.structuredContent.total >= 2);
    const selected = await http('/api/libraries', { name: 'MCP 自选', keywordIds: ['style-51','style-52','style-53','color-51','color-54','color-55'] });
    const args = { libraryId: selected.id, dimensions: ['style','color'], mode: 'free', countPerDimension: 2 };
    const drawn = await call('draw_design_inspiration', args);
    assert.equal(drawn.isError, false); assert.deepEqual(JSON.parse(drawn.content[0].text), drawn.structuredContent);
    const record = drawn.structuredContent; assert.equal(record.library.name, 'MCP 自选');
    assert.ok(record.items.every(k => selected.keywordIds.includes(k.id)));
    assert.deepEqual((await http('/api/history'))[0], record);
    const locked = { style: record.items.filter(k => k.dimension === 'style').map(k => k.id) };
    const rerolled = await call('draw_design_inspiration', { ...args, locked, current: { style: locked.style, color: record.items.filter(k => k.dimension === 'color').map(k => k.id) } });
    assert.deepEqual(rerolled.structuredContent.items.filter(k => k.dimension === 'style'), record.items.filter(k => k.dimension === 'style'));
    const five = await call('draw_design_inspiration', { libraryId: 'classical', dimensions: ['style','color'], mode: 'free', countPerDimension: 5 });
    assert.equal(five.isError, false); assert.equal(five.structuredContent.items.length, 10);
    const fiveStyle = five.structuredContent.items.filter(k => k.dimension === 'style');
    const one = await call('draw_design_inspiration', { libraryId: 'classical', dimensions: ['style','color'], mode: 'free', countPerDimension: 1, locked: { style: fiveStyle.map(k => k.id) } });
    assert.equal(one.structuredContent.items.length, 6); assert.deepEqual(one.structuredContent.items.filter(k => k.dimension === 'style'), fiveStyle);
    const featureSearch = await call('search_design_keywords', {libraryId:selected.id,dimension:'feature',query:'鼠标',limit:100});
    assert.equal(featureSearch.isError,false);assert.equal(featureSearch.structuredContent.source,'global');assert.equal(featureSearch.structuredContent.library,null);
    assert.ok(featureSearch.structuredContent.keywords.some(k=>k.id==='feature-01'));
    for (const temperature of ['cool','warm','neutral','mixed','unspecified']) {
      const found = await call('search_design_keywords',{temperature,limit:100});
      assert.ok(found.structuredContent.keywords.every(k=>k.dimension==='color' && k.temperature===temperature));
    }
    const cold = await call('search_design_keywords',{libraryId:'digital',dimension:'color',temperature:'cool'});
    assert.ok(cold.structuredContent.total>=5);
    const defaultDraw=await call('draw_design_inspiration',{featureCount:5});
    assert.equal(defaultDraw.structuredContent.items.length,16);
    assert.equal(defaultDraw.structuredContent.countPerDimension,2);
    assert.ok(defaultDraw.structuredContent.items.every(k=>k.dimension!=='feature'));
    for (const featureCount of [1,2,3,4,5]) {
      const f = await call('draw_design_inspiration',{libraryId:selected.id,dimensions:['feature'],countPerDimension:5,featureCount});
      assert.equal(f.isError,false);assert.equal(f.structuredContent.items.length,featureCount);assert.equal(f.structuredContent.featureSource,'global');
    }
    const signature=await call('draw_design_inspiration',{libraryId:'digital',dimensions:['color','feature'],featureCount:3,colorTemperature:'cool',mode:'free',countPerDimension:5});
    assert.equal(signature.isError,false);assert.equal(signature.structuredContent.items.length,8);
    assert.equal(signature.structuredContent.colorTemperature,'cool');
    assert.deepEqual((await http('/api/history'))[0],signature.structuredContent);
    assert.ok(signature.structuredContent.items.filter(k=>k.dimension==='color').every(k=>k.temperature==='cool'));
    const featureLock=signature.structuredContent.items.filter(k=>k.dimension==='feature');
    const switched=await call('draw_design_inspiration',{libraryId:'classical',dimensions:['color','feature'],featureCount:1,colorTemperature:'warm',countPerDimension:5,locked:{feature:featureLock.map(k=>k.id)}});
    assert.deepEqual(switched.structuredContent.items.filter(k=>k.dimension==='feature'),featureLock);
    const beforeErrors = (await http('/api/history')).length;
    for (const invalidArgs of [{ ...args, locked: { style: ['style-01'] } }, { libraryId: 'missing' }, { countPerDimension: 9 }, {featureCount:6}, {colorTemperature:'neutral'}, { unsupported: true }, {dimensions:['color','feature'],colorTemperature:'warm',locked:{color:[cold.structuredContent.keywords[0].id]}}]) assert.equal((await call('draw_design_inspiration', invalidArgs)).isError, true);
    for(const search of [{temperature:'random'},{dimension:'feature',temperature:'cool'}])assert.equal((await call('search_design_keywords',search)).isError,true);
    assert.equal((await call('search_design_keywords', { limit: 101 })).isError, true);
    fail = true; const failed = await call('draw_design_inspiration', args); fail = false;
    assert.equal(failed.isError, true); assert.equal(failed.structuredContent.error.code, 'SAVE_FAILED');
    assert.equal((await http('/api/history')).length, beforeErrors);
    child.stdin.write('not-json\n' + 'x'.repeat(70000) + '\n');
    await send('ping');
    assert.equal(unsolicited.filter(m => m.error?.code === -32700).length, 2);
    assert.deepEqual(protocolFailures, []); assert.equal(stderr, '');
  } finally {
    const exited = once(child, 'exit'); child.stdin.end();
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 2000); })]); }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0); assert.equal(buffer, '');
});

process.on('exit', code => { if (code === 0) console.log('DONE'); });
