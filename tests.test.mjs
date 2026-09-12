import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { draw as drawMany, conflicts, openStore, atomicWrite, validateState, mutateKeyword } from './core.mjs';
import { keywords, dimensions } from './seed.mjs';
import { createApp } from './server.mjs';

const draw = (all, input, maxNodes) => drawMany(all, input && typeof input === 'object' && !Array.isArray(input) ? { countPerDimension: 1, ...input } : input, maxNodes);
const key = (id, dimension, exclusions = []) => ({ id, dimension, name: id, description: `${id} 的设计说明`, conflicts: exclusions });
const expectCode = (action, code) => assert.throws(action, error => error.code === code);
function temp(t) { const directory = mkdtempSync(join(tmpdir(), 'design-seed-test-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return join(directory, 'state.json'); }
async function listen(app) { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); return `http://127.0.0.1:${app.server.address().port}`; }
async function close(app) { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); }
async function request(base, path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}

test('400 条种子词条完整、ID 唯一、互斥引用有效', () => {
  assert.equal(keywords.length, 400); assert.equal(new Set(keywords.map(k => k.id)).size, 400);
  for (const d of dimensions) assert.equal(keywords.filter(k => k.dimension === d.id).length, 50);
  validateState({ version: 1, keywords, history: [], favorites: [] });
  assert.match(keywords.find(k => k.id === 'material-01').description, /晴天.*雨天.*雪天.*风天/);
});

test('真实词库抽取涵盖所选维度，协调结果没有显式冲突', () => {
  for (let i = 0; i < 80; i++) {
    const result = draw(keywords, {});
    assert.equal(result.items.length, 8);
    assert.equal(new Set(result.items.map(k => k.dimension)).size, 8);
    for (let j = 0; j < result.items.length; j++) for (const other of result.items.slice(j + 1)) assert.equal(conflicts(result.items[j], other), false);
  }
});

test('锁定及单项重抽，存在替代项时不会重复当前词条', () => {
  const initial = draw(keywords, { mode: 'free' });
  const current = Object.fromEntries(initial.items.map(k => [k.dimension, k.id]));
  const locked = Object.fromEntries(Object.entries(current).filter(([d]) => d !== 'style'));
  const next = draw(keywords, { mode: 'free', current, locked });
  assert.notEqual(next.items.find(k => k.dimension === 'style').id, current.style);
  for (const [d, id] of Object.entries(locked)) assert.equal(next.items.find(k => k.dimension === d).id, id);
  const fullyChanged = draw(keywords, { mode: 'free', current });
  assert.ok(fullyChanged.items.every(k => k.id !== current[k.dimension]));
});

test('对称解释单方向互斥，自由模式允许冲突，协调模式拒绝锁定冲突', () => {
  const all = [key('s', 'style', ['c']), key('c', 'color'), key('l', 'layout')];
  assert.ok(conflicts(all[1], all[0]));
  expectCode(() => draw(all, { dimensions: ['style', 'color'], mode: 'coordinated' }), 'NO_COMBINATION');
  assert.equal(draw(all, { dimensions: ['style', 'color'], mode: 'free' }).items.length, 2);
  expectCode(() => draw(all, { dimensions: ['style', 'color', 'layout'], locked: { style: 's', color: 'c' } }), 'LOCK_CONFLICT');
});

test('有界回溯绕开死路，并最大化可同时替换的维度数量', () => {
  const all = [key('s0', 'style'), key('s1', 'style', ['c1']), key('c0', 'color'), key('c1', 'color')];
  const result = draw(all, { dimensions: ['style', 'color'], current: { style: 's0', color: 'c0' } });
  assert.equal(result.items.filter(k => k.id.endsWith('1')).length, 1);
  assert.equal(result.warnings.length, 1);
  const one = draw([key('only', 'style')], { dimensions: ['style'], current: { style: 'only' } });
  assert.equal(one.items[0].id, 'only'); assert.equal(one.warnings.length, 1);
  expectCode(() => draw(all, { dimensions: ['style', 'color'] }, 1), 'SEARCH_LIMIT');
});

test('空词库、旧 ID、无效维度、全锁定和非对象输入可解释地失败', () => {
  expectCode(() => draw([], { dimensions: ['style'] }), 'EMPTY_DIMENSION');
  for (const input of [null, [], { dimensions: [] }, { dimensions: ['missing'] }, { dimensions: ['style', 'style'] },
    { dimensions: ['style'], current: { style: 'gone' } }, { dimensions: ['style'], locked: { style: 'style-01' } },
    { dimensions: ['style'], locked: { color: 'color-01' } }, { mode: 'anything' }]) expectCode(() => draw(keywords, input), 'INVALID_INPUT');
});

test('事务保存失败保留原始内存及磁盘；损坏文件不被重置', t => {
  const file = temp(t); let fail = false;
  const store = openStore(file, (target, state) => { if (fail) throw Error('模拟磁盘只读'); atomicWrite(target, state); });
  const before = readFileSync(file, 'utf8'); fail = true;
  expectCode(() => store.transact(state => { state.keywords.pop(); }), 'SAVE_FAILED');
  assert.equal(store.state.keywords.length, 400); assert.equal(readFileSync(file, 'utf8'), before);
  for (const corrupt of ['{ broken', JSON.stringify({ version: 1, keywords: [], history: [{}], favorites: [] })]) {
    writeFileSync(file, corrupt, 'utf8'); assert.throws(() => openStore(file), /原文件已保留/); assert.equal(readFileSync(file, 'utf8'), corrupt);
  }
});

test('HTTP 全流程：编辑、并发写、互斥双向解除、历史快照、收藏与重启', { timeout: 30000 }, async t => {
  const file = temp(t); let app = createApp({ dataFile: file }); t.after(() => close(app)); let base = await listen(app);
  const catalog = await request(base, '/api/catalog'); assert.equal(catalog.status, 200); assert.equal(catalog.body.keywords.length, 400);
  const created = await request(base, '/api/keywords', 'POST', { name: '测试风格', description: '编辑前说明', dimension: 'style', conflicts: ['color-01'] });
  assert.equal(created.status, 201); const id = created.body.id;
  const record = await request(base, '/api/draw', 'POST', { dimensions: ['style', 'color'], mode: 'free', locked: { style: id } });
  assert.equal(record.status, 201); const snapshot = structuredClone(record.body);
  assert.equal((await request(base, '/api/favorites', 'POST', { recordId: snapshot.id })).status, 201);
  assert.equal((await request(base, '/api/favorites', 'POST', { recordId: snapshot.id })).status, 200);
  // Updating the opposite end must remove incoming conflict edges as shown by the editor.
  assert.equal((await request(base, '/api/keywords/color-01', 'PATCH', { conflicts: [] })).status, 200);
  assert.deepEqual((await request(base, '/api/catalog')).body.keywords.find(k => k.id === id).conflicts, []);
  await request(base, `/api/keywords/${id}`, 'PATCH', { name: '修改后标题', description: '修改后说明', conflicts: ['color-02'] });
  const added = await Promise.all(Array.from({ length: 4 }, (_, i) => request(base, '/api/keywords', 'POST', { name: `并发 ${i}`, description: '同时写入不会丢失', dimension: 'type' })));
  assert.ok(added.every(r => r.status === 201));
  assert.equal((await request(base, '/api/catalog')).body.keywords.length, 405);
  await request(base, `/api/keywords/${id}`, 'DELETE');
  assert.ok((await request(base, '/api/catalog')).body.keywords.every(k => !k.conflicts.includes(id)));
  const stale = await request(base, '/api/draw', 'POST', { dimensions: ['style'], current: { style: id } }); assert.equal(stale.status, 400);
  assert.equal((await request(base, '/api/history')).body.length, 1);
  assert.deepEqual((await request(base, '/api/history')).body[0], snapshot);
  assert.deepEqual((await request(base, '/api/favorites')).body[0], snapshot);
  for (let i = 0; i < 101; i++) assert.equal((await request(base, '/api/draw', 'POST', { dimensions: ['color'], mode: 'free' })).status, 201);
  assert.equal((await request(base, '/api/history')).body.length, 100);
  assert.deepEqual((await request(base, '/api/favorites')).body[0], snapshot);
  await close(app); app = createApp({ dataFile: file }); base = await listen(app);
  assert.equal((await request(base, '/api/catalog')).body.keywords.length, 404);
  assert.equal((await request(base, '/api/history')).body.length, 100);
  assert.deepEqual((await request(base, '/api/favorites')).body[0], snapshot);
  assert.equal((await request(base, `/api/favorites/${snapshot.id}`, 'DELETE')).status, 200);
  assert.equal((await request(base, '/api/favorites')).body.length, 0);
});

test('HTTP 边界：参数、同源、请求大小、静态资源和保存失败', { timeout: 15000 }, async t => {
  let fail = false;
  const app = createApp({ dataFile: temp(t), write: (file, state) => { if (fail) throw Error('模拟写失败'); atomicWrite(file, state); } });
  t.after(() => close(app)); const base = await listen(app);
  const html = await fetch(base, { signal: AbortSignal.timeout(5000) }); assert.equal(html.status, 200); assert.match(await html.text(), /灵感抽取/);
  for (const path of ['/app.js', '/style.css', '/favicon.svg']) assert.equal((await fetch(base + path, { signal: AbortSignal.timeout(5000) })).status, 200);
  assert.equal((await request(base, '/api/draw', 'POST', {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request(base, '/api/draw', 'POST', {}, { Origin: base })).status, 201);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/api/catalog', { headers: { Host: 'evil.example:3000' }, timeout: 5000 }, res => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(Error('HTTP timeout'))); req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request(base, '/api/draw', 'POST', { dimensions: [] })).status, 400);
  assert.equal((await request(base, '/api/draw', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(base, '/api/draw', 'POST', { text: 'a'.repeat(70000) })).status, 413);
  assert.equal((await fetch(base + '/api/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid', signal: AbortSignal.timeout(5000) })).status, 400);
  assert.equal((await request(base, '/data/state.json')).status, 404);
  const count = app.store.state.history.length; fail = true;
  const failed = await request(base, '/api/draw', 'POST', {}); assert.equal(failed.status, 500); assert.equal(failed.body.error.code, 'SAVE_FAILED');
  assert.equal(app.store.state.history.length, count);
});

test('多词抽取默认每维度 2–3 条、不重复，协调模式同时检查维度内及维度间冲突', () => {
  const observed = new Set();
  for (let i = 0; i < 60; i++) {
    const result = drawMany(keywords, {});
    assert.ok(result.items.length >= 16 && result.items.length <= 24);
    assert.equal(new Set(result.items.map(k => k.id)).size, result.items.length);
    for (const d of dimensions) { const count = result.items.filter(k => k.dimension === d.id).length; assert.ok(count === 2 || count === 3); observed.add(count); }
    for (let j = 0; j < result.items.length; j++) for (const other of result.items.slice(j + 1)) assert.equal(conflicts(result.items[j], other), false);
    assert.match(result.text, /风格\n•/);
  }
  assert.deepEqual([...observed].sort(), [2, 3]);
  for (const count of [2, 3]) assert.equal(drawMany(keywords, { countPerDimension: count }).items.length, count * 8);
});

test('整组锁定保留顺序和全部内容，单维重抽不改变其余维度，优先换成新词', () => {
  const initial = drawMany(keywords, { countPerDimension: 3, mode: 'free' });
  const current = Object.fromEntries(dimensions.map(d => [d.id, initial.items.filter(k => k.dimension === d.id).map(k => k.id)]));
  const locked = Object.fromEntries(Object.entries(current).filter(([d]) => d !== 'color'));
  const result = drawMany(keywords, { countPerDimension: 2, mode: 'free', current, locked });
  assert.equal(result.items.length, 23);
  for (const [d, ids] of Object.entries(locked)) assert.deepEqual(result.items.filter(k => k.dimension === d).map(k => k.id), ids);
  assert.ok(result.items.filter(k => k.dimension === 'color').every(k => !current.color.includes(k.id)));
  const renewed = drawMany(keywords, { current, countPerDimension: 3 });
  assert.ok(renewed.items.every(k => !current[k.dimension].includes(k.id)));
});

test('同维互斥、候选不足、数组输入与旧单条接口兼容', () => {
  const all = [key('s0','style',['s1']),key('s1','style'),key('s2','style'),key('c0','color'),key('c1','color')];
  const coherent = drawMany(all,{dimensions:['style'],countPerDimension:2});
  assert.equal(conflicts(...coherent.items),false);
  expectCode(() => drawMany(all,{dimensions:['style'],countPerDimension:3}), 'NO_COMBINATION');
  assert.equal(drawMany(all,{dimensions:['style'],countPerDimension:3,mode:'free'}).items.length,3);
  expectCode(() => drawMany([key('s','style')],{dimensions:['style']}), 'INSUFFICIENT_CANDIDATES');
  expectCode(() => drawMany(all,{dimensions:['style','color'],locked:{style:['s0','s1']}}), 'LOCK_CONFLICT');
  for (const input of [{countPerDimension:4},{countPerDimension:'2'},{locked:{style:[]}},{current:{style:['s0','s0']}},{current:{style:['gone']}},{locked:{style:['s0','s1','s2','s3']}}]) expectCode(() => drawMany(all,input),'INVALID_INPUT');
  const legacy = drawMany(keywords,{dimensions:['style','color'],countPerDimension:1,locked:{style:'style-02'},current:{color:'color-03'}});
  assert.equal(legacy.items.length,2); assert.equal(legacy.items[0].id,'style-02');
});

test('旧数据一次性升级：保留改词、删词、收藏历史，备份原文件，重启不复活已删除的新词', t => {
  const file = temp(t);
  const originalIds = new Set(keywords.filter(k => Number(k.id.split('-')[1]) <= 20).map(k => k.id));
  const oldKeywords = structuredClone(keywords.filter(k => originalIds.has(k.id) && k.id !== 'style-02'));
  for (const k of oldKeywords) k.conflicts = k.conflicts.filter(id => originalIds.has(id) && id !== 'style-02');
  const edited = oldKeywords.find(k => k.id === 'style-01'); edited.name = '我自己的设计风格'; edited.description = '用户编辑内容'; edited.conflicts = [];
  oldKeywords.push(key('custom-owned','style'));
  const oldRecord = draw(oldKeywords,{mode:'free'}); delete oldRecord.countPerDimension;
  const original = JSON.stringify({version:1,keywords:oldKeywords,history:[oldRecord],favorites:[oldRecord]});
  writeFileSync(file,original,'utf8');
  const store = openStore(file);
  assert.equal(store.state.version,2); assert.equal(store.state.seedRevision,2); assert.equal(store.state.keywords.length,400);
  assert.equal(readFileSync(file+'.before-v2.bak','utf8'),original);
  assert.ok(!store.state.keywords.some(k => k.id === 'style-02'));
  assert.deepEqual(store.state.keywords.find(k => k.id === 'style-01'),edited);
  assert.deepEqual(store.state.history,[oldRecord]); assert.deepEqual(store.state.favorites,[oldRecord]);
  store.transact(state => { mutateKeyword(state,'DELETE','color-50'); mutateKeyword(state,'PATCH','style-50',{name:'新增术语也可自行修改'}); state.history.unshift(drawMany(state.keywords,{})); });
  const again = openStore(file);
  assert.ok(!again.state.keywords.some(k => k.id === 'color-50'));
  assert.equal(again.state.keywords.find(k => k.id === 'style-50').name,'新增术语也可自行修改');
  assert.equal(again.state.history.length,2); assert.deepEqual(again.state.favorites,[oldRecord]);
  assert.equal(readFileSync(file+'.before-v2.bak','utf8'),original);
});

test('升级写入失败不覆盖原数据', t => {
  const file = temp(t); const original = JSON.stringify({version:1,keywords:[],history:[],favorites:[]});
  writeFileSync(file,original,'utf8');
  assert.throws(() => openStore(file, () => { throw Error('模拟磁盘错误'); }), /原数据已保留/);
  assert.equal(readFileSync(file,'utf8'),original);
  assert.equal(readFileSync(file+'.before-v2.bak','utf8'),original);
});

process.on('exit', code => { if (code === 0) console.log('DONE'); });
