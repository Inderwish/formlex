import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { draw as drawMany, conflicts, openStore, atomicWrite, validateState, mutateKeyword, mutateLibrary } from './core.mjs';
import { keywords, dimensions } from './seed.mjs';
import { extraEntries } from './seed-extra.mjs';
import { listLibraries, themes } from './libraries.mjs';
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

test('1200 条种子词条完整、ID 唯一、互斥引用有效', () => {
  assert.equal(keywords.length, 1200); assert.equal(new Set(keywords.map(k => k.id)).size, 1200);
  for (const d of dimensions) assert.equal(keywords.filter(k => k.dimension === d.id).length, 150);
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
  assert.equal(store.state.keywords.length, 1200); assert.equal(readFileSync(file, 'utf8'), before);
  for (const corrupt of ['{ broken', JSON.stringify({ version: 1, keywords: [], history: [{}], favorites: [] })]) {
    writeFileSync(file, corrupt, 'utf8'); assert.throws(() => openStore(file), /原文件已保留/); assert.equal(readFileSync(file, 'utf8'), corrupt);
  }
});

test('HTTP 全流程：编辑、并发写、互斥双向解除、历史快照、收藏与重启', { timeout: 30000 }, async t => {
  const file = temp(t); let app = createApp({ dataFile: file }); t.after(() => close(app)); let base = await listen(app);
  const catalog = await request(base, '/api/catalog'); assert.equal(catalog.status, 200); assert.equal(catalog.body.keywords.length, 1200);
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
  assert.equal((await request(base, '/api/catalog')).body.keywords.length, 1205);
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
  assert.equal((await request(base, '/api/catalog')).body.keywords.length, 1204);
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
  for (const input of [{countPerDimension:6},{countPerDimension:'2'},{locked:{style:[]}},{current:{style:['s0','s0']}},{current:{style:['gone']}},{locked:{style:['s0','s1','s2','s3','s4','s5']}}]) expectCode(() => drawMany(all,input),'INVALID_INPUT');
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
  assert.equal(store.state.version,2); assert.equal(store.state.seedRevision,3); assert.equal(store.state.keywords.length,1200);
  assert.equal(readFileSync(file+'.before-v3.bak','utf8'),original);
  assert.ok(!store.state.keywords.some(k => k.id === 'style-02'));
  assert.deepEqual(store.state.keywords.find(k => k.id === 'style-01'),edited);
  assert.deepEqual(store.state.history,[oldRecord]); assert.deepEqual(store.state.favorites,[oldRecord]);
  store.transact(state => { mutateKeyword(state,'DELETE','color-50'); mutateKeyword(state,'PATCH','style-50',{name:'新增术语也可自行修改'}); state.history.unshift(drawMany(state.keywords,{})); });
  const again = openStore(file);
  assert.ok(!again.state.keywords.some(k => k.id === 'color-50'));
  assert.equal(again.state.keywords.find(k => k.id === 'style-50').name,'新增术语也可自行修改');
  assert.equal(again.state.history.length,2); assert.deepEqual(again.state.favorites,[oldRecord]);
  assert.equal(readFileSync(file+'.before-v3.bak','utf8'),original);
});

test('升级写入失败不覆盖原数据', t => {
  const file = temp(t); const original = JSON.stringify({version:1,keywords:[],history:[],favorites:[]});
  writeFileSync(file,original,'utf8');
  assert.throws(() => openStore(file, () => { throw Error('模拟磁盘错误'); }), /原数据已保留/);
  assert.equal(readFileSync(file,'utf8'),original);
  assert.equal(readFileSync(file+'.before-v3.bak','utf8'),original);
});

test('主题词库分配完整且每维度术语不重名，全部新增说明独立完整', () => {
  const libraries = listLibraries({ keywords });
  assert.equal(libraries.length, 12); assert.equal(libraries[0].keywordIds.length, 1200); assert.equal(libraries[1].keywordIds.length, 400);
  for (const dimension of dimensions) {
    const terms = keywords.filter(k => k.dimension === dimension.id);
    assert.equal(new Set(terms.map(k => k.name)).size, 150);
    assert.equal(extraEntries[dimension.id].length, 100);
    assert.ok(extraEntries[dimension.id].every(row => row.length === 2 && row[1].length >= 20));
  }
  for (const theme of themes) {
    const library = libraries.find(l => l.id === theme.id);
    assert.equal(library.keywordIds.length, 80);
    for (const d of dimensions) assert.equal(keywords.filter(k => k.dimension === d.id && library.keywordIds.includes(k.id)).length, 10);
    for (const mode of ['free', 'coordinated']) {
      const record = drawMany(keywords, { libraryId: theme.id, mode, countPerDimension: 3 });
      assert.equal(record.items.length, 24);
      assert.ok(record.items.every(k => library.keywordIds.includes(k.id)));
      if (mode === 'coordinated') for (const a of record.items) for (const b of record.items) if (a !== b) assert.equal(conflicts(a, b), false);
    }
  }
});

test('个人词库候选范围、锁定、失效词库与空范围均可解释', () => {
  const state = { keywords: structuredClone(keywords), libraries: [] };
  const library = mutateLibrary(state, 'POST', undefined, { name: '古典片段', keywordIds: ['style-51','style-52','style-53','color-51','color-54','color-55'] });
  const input = { dimensions: ['style','color'], libraryId: library.id, mode: 'free', countPerDimension: 2 };
  const first = drawMany(state.keywords, input, 50000, state.libraries);
  assert.ok(first.items.every(k => library.keywordIds.includes(k.id)));
  const locked = { style: first.items.filter(k => k.dimension === 'style').map(k => k.id) };
  const second = drawMany(state.keywords, { ...input, locked }, 50000, state.libraries);
  assert.deepEqual(second.items.filter(k => k.dimension === 'style'), first.items.filter(k => k.dimension === 'style'));
  expectCode(() => drawMany(state.keywords, { ...input, locked: { style: ['style-01'] } }, 50000, state.libraries), 'LOCK_OUTSIDE_LIBRARY');
  for (const libraryId of ['gone', null, [], 1]) expectCode(() => drawMany(keywords, { libraryId }), 'INVALID_INPUT');
  expectCode(() => drawMany(keywords, { unsupported: true }), 'INVALID_INPUT');
  const snapshot = structuredClone(first);
  mutateLibrary(state, 'PATCH', library.id, { name: '更名后', keywordIds: [] });
  expectCode(() => drawMany(state.keywords, input, 50000, state.libraries), 'EMPTY_DIMENSION');
  assert.deepEqual(first, snapshot); assert.equal(first.library.name, '古典片段');
  mutateLibrary(state, 'DELETE', library.id);
  expectCode(() => drawMany(state.keywords, input, 50000, state.libraries), 'INVALID_INPUT');
  for (const body of [{ name: '', keywordIds: [] }, { name: '错误', keywordIds: ['gone'] }, { name: '错误', keywordIds: ['style-01','style-01'] }, { id: 'owned', name: '错误', keywordIds: [] }]) expectCode(() => mutateLibrary(state, 'POST', undefined, body), 'INVALID_INPUT');
  expectCode(() => mutateLibrary(state, 'DELETE', 'classical'), 'NOT_FOUND');
});

test('400 条词库升级保留改删、手工约束、记录与个人词库，新增范围只合并一次', t => {
  const file = temp(t);
  const old = structuredClone(keywords.filter(k => Number(k.id.split('-')[1]) <= 50 && k.id !== 'color-21'));
  old.push(key('my-private-word', 'style'));
  const ids = new Set(old.map(k => k.id));
  for (const keyword of old) keyword.conflicts = keyword.conflicts.filter(id => ids.has(id));
  old.find(k => k.id === 'style-50').name = '我的个人修改';
  old.find(k => k.id === 'motion-01').conflicts = [];
  const record = draw(old, { mode: 'free' }); delete record.library;
  const original = JSON.stringify({ version: 2, seedRevision: 2, keywords: old, libraries: [{ id: 'my-library', name: '我的选择', keywordIds: ['my-private-word','style-50'] }], history: [record], favorites: [record] });
  writeFileSync(file, original, 'utf8');
  const store = openStore(file);
  assert.equal(store.state.keywords.length, 1200); assert.equal(store.state.seedRevision, 3);
  assert.equal(readFileSync(file + '.before-v3.bak', 'utf8'), original);
  assert.ok(!store.state.keywords.some(k => k.id === 'color-21'));
  assert.equal(store.state.keywords.find(k => k.id === 'style-50').name, '我的个人修改');
  assert.ok(!store.state.keywords.find(k => k.id === 'motion-01').conflicts.includes('motion-02'));
  assert.deepEqual(store.state.history, [record]); assert.deepEqual(store.state.favorites, [record]);
  store.transact(state => { mutateKeyword(state, 'DELETE', 'style-51'); mutateKeyword(state, 'DELETE', 'my-private-word'); });
  const reopened = openStore(file);
  assert.ok(!reopened.state.keywords.some(k => ['style-51','my-private-word'].includes(k.id)));
  assert.deepEqual(reopened.state.libraries[0].keywordIds, ['style-50']);
  assert.equal(readFileSync(file + '.before-v3.bak', 'utf8'), original);
});

test('个人词库 HTTP 编辑与抽取共享历史，重启保存，删除词条清理引用', { timeout: 20000 }, async t => {
  const file = temp(t); let fail = false;
  let app = createApp({ dataFile: file, write: (path, state) => { if (fail) throw Error('磁盘失败'); atomicWrite(path, state); } });
  t.after(() => close(app)); let base = await listen(app);
  const catalog = (await request(base, '/api/catalog')).body; assert.equal(catalog.apiVersion, 3); assert.equal(catalog.libraries.length, 12);
  const created = await request(base, '/api/libraries', 'POST', { name: '窄范围', keywordIds: ['style-51','style-52','style-53'] });
  assert.equal(created.status, 201); const id = created.body.id;
  const drawn = await request(base, '/api/draw', 'POST', { libraryId: id, dimensions: ['style'], countPerDimension: 2 });
  assert.equal(drawn.status, 201); assert.equal(drawn.body.library.name, '窄范围');
  await request(base, '/api/favorites', 'POST', { recordId: drawn.body.id });
  const before = readFileSync(file, 'utf8'); fail = true;
  assert.equal((await request(base, `/api/libraries/${id}`, 'PATCH', { name: '不应保存' })).status, 500);
  assert.equal(readFileSync(file, 'utf8'), before); fail = false;
  assert.equal((await request(base, `/api/libraries/${id}`, 'PATCH', { name: '外站修改' }, { Origin: 'https://example.com' })).status, 403);
  await request(base, `/api/libraries/${id}`, 'PATCH', { name: '已更名' });
  await request(base, '/api/keywords/style-51', 'DELETE');
  await close(app); app = createApp({ dataFile: file }); base = await listen(app);
  const library = (await request(base, '/api/libraries')).body.find(l => l.id === id);
  assert.equal(library.name, '已更名'); assert.deepEqual(library.keywordIds, ['style-52','style-53']);
  assert.deepEqual((await request(base, '/api/favorites')).body[0], drawn.body);
  await request(base, `/api/libraries/${id}`, 'DELETE');
  assert.equal((await request(base, '/api/draw', 'POST', { libraryId: id })).status, 400);
  assert.deepEqual((await request(base, '/api/history')).body[0], drawn.body);
});

test('固定数量 1–5、五词锁定与单维重抽、数量校验及五词快照重启', { timeout: 20000 }, async t => {
  for (const mode of ['free', 'coordinated']) for (let countPerDimension = 1; countPerDimension <= 5; countPerDimension++) {
    const record = drawMany(keywords, { mode, countPerDimension });
    for (const d of dimensions) assert.equal(record.items.filter(k => k.dimension === d.id).length, countPerDimension);
    assert.equal(new Set(record.items.map(k => k.id)).size, 8 * countPerDimension);
  }
  for (const countPerDimension of [0, 6, -1, 1.5, '5']) expectCode(() => drawMany(keywords, { countPerDimension }), 'INVALID_INPUT');
  const initial = drawMany(keywords, { libraryId: 'classical', countPerDimension: 5, mode: 'free' });
  const current = Object.fromEntries(dimensions.map(d => [d.id, initial.items.filter(k => k.dimension === d.id).map(k => k.id)]));
  const locked = Object.fromEntries(Object.entries(current).filter(([d]) => d !== 'color'));
  const next = drawMany(keywords, { libraryId: 'classical', countPerDimension: 1, mode: 'free', current, locked });
  assert.equal(next.items.filter(k => k.dimension === 'color').length, 1);
  for (const d of dimensions.filter(d => d.id !== 'color')) assert.deepEqual(next.items.filter(k => k.dimension === d.id), initial.items.filter(k => k.dimension === d.id));
  expectCode(() => drawMany(keywords, { current: { style: ['style-51','style-52','style-53','style-54','style-55','style-56'] } }), 'INVALID_INPUT');
  const file = temp(t); let app = createApp({ dataFile: file }); t.after(() => close(app)); let base = await listen(app);
  const record = await request(base, '/api/draw', 'POST', { countPerDimension: 5, libraryId: 'classical', dimensions: ['style','color'] });
  assert.equal(record.status, 201); assert.equal(record.body.items.length, 10);
  await request(base, '/api/favorites', 'POST', { recordId: record.body.id });
  await close(app); app = createApp({ dataFile: file }); base = await listen(app);
  assert.deepEqual((await request(base, '/api/history')).body[0], record.body);
  assert.deepEqual((await request(base, '/api/favorites')).body[0], record.body);
});

process.on('exit', code => { if (code === 0) console.log('DONE'); });
