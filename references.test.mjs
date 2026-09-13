import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { keywords, previousSeed, dimensions, defaultDimensions, seedRevision } from './seed.mjs';
import { termNotes, sources } from './term-references.mjs';
import classification from './term-classification.json' with { type: 'json' };
import { draw, openStore, mutateKeyword, atomicWrite } from './core.mjs';
import { createCatalog, librarySummary, searchKeywords } from './catalog.mjs';
import { createApp } from './server.mjs';
import { buildDesignPrompt } from './public/design-rules.mjs';
import { runCli } from './cli.mjs';
import { createMcpHandler } from './mcp.mjs';

const catalog = createCatalog({ keywords });
const find = id => keywords.find(k => k.id === id);
const grouped = record => Object.fromEntries(dimensions.map(d => [d.id, record.items.filter(k => k.dimension === d.id).map(k => k.id)]).filter(([,ids]) => ids.length));
const code = (action, value) => assert.throws(action, error => error.code === value);
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'formlex-references-')); t.after(() => rmSync(dir,{recursive:true,force:true,maxRetries:3})); return join(dir,'state.json'); }

test('逐 ID 分类覆盖且不重叠；出处为具体页面，正文区分定义和应用，原创说明不扩写', () => {
  const ids = [...Object.keys(termNotes), ...classification.original, ...classification.unverified];
  assert.equal(new Set(ids).size, keywords.length); assert.equal(ids.length, keywords.length);
  const before = new Map(previousSeed.map(k => [k.id, k]));
  for (const k of keywords) {
    assert.ok(['established','original','unverified'].includes(k.origin));
    assert.ok(k.classificationReason);
    if (k.origin !== 'established') { assert.equal(k.description, before.get(k.id).description); assert.deepEqual(k.references, []); continue; }
    assert.ok(k.references.length > 0, k.id);
    assert.ok(k.description.length <= 220, k.id);
    if (k.dimension === 'color') { assert.ok(k.description.length >= 30 && k.description.length <= 50, k.id); assert.ok(k.description.includes('建议：')); }
    else { assert.ok(k.description.startsWith('概念：'), k.id); assert.match(k.description,/前端应用（FormLex）：/); }
    for (const ref of k.references) { assert.ok(ref.institution && ref.title); assert.equal(new URL(ref.url).protocol,'https:'); assert.ok(new URL(ref.url).pathname.split('/').filter(Boolean).length >= 2); }
    assert.ok(!k.description.includes('https://'));
  }
  for (const [,title,url] of Object.values(sources)) { assert.ok(title); assert.ok(url.startsWith('https://')); }
});

test('新默认已有术语八维各二条；两类隔离，旧范围隐藏但可解析', () => {
  assert.deepEqual(librarySummary(catalog).libraries.map(l=>l.id), ['established','original']);
  for (const d of defaultDimensions) assert.ok(keywords.filter(k=>k.dimension===d.id&&k.origin==='established').length >= 5);
  for (const libraryId of ['established','original']) for (const mode of ['free','coordinated']) {
    const record = draw(keywords,{libraryId,mode});
    assert.equal(record.items.length,16); assert.ok(record.items.every(k=>k.origin===libraryId));
    for (const ids of Object.values(grouped(record))) assert.equal(ids.length,2);
  }
  const initial = draw(keywords,{}); assert.equal(initial.library.id,'established');
  assert.ok(initial.items.every(k=>k.origin==='established'));
  assert.equal(searchKeywords(catalog,{}).library.id,'established');
  for (const library of catalog.libraries.filter(l=>l.legacy)) {
    const record = draw(keywords,{libraryId:library.id,mode:'free'});
    assert.ok(record.items.every(k=>library.keywordIds.includes(k.id)));
    assert.ok(searchKeywords(catalog,{libraryId:library.id}).total>0);
  }
});

test('独立特色、锁定及重抽；严格色温和个人范围不足不跨类别补词', () => {
  const first = draw(keywords,{dimensions:['style','color','feature'],mode:'free',featureCount:5});
  const current = grouped(first);
  const next = draw(keywords,{dimensions:['style','color','feature'],mode:'free',featureCount:1,current,locked:{color:current.color,feature:current.feature}});
  assert.deepEqual(next.items.filter(k=>k.dimension!=='style'),first.items.filter(k=>k.dimension!=='style'));
  assert.ok(next.items.filter(k=>k.dimension==='style').every(k=>!current.style.includes(k.id)));
  for(const libraryId of ['established','original']) for(const featureCount of [1,2,3,4,5]) {
    const r=draw(keywords,{libraryId,dimensions:['feature'],featureCount});
    assert.equal(r.items.length,featureCount);assert.equal(r.featureSource,'global');
    assert.ok(r.items.every(k=>k.dimension==='feature'));
  }
  for(const mode of ['coordinated','free']) for(const colorTemperature of ['cool','warm']) {
    for(const libraryId of ['established','original']) {
      const eligible=catalog.libraries.find(l=>l.id===libraryId).keywordIds;
      const pool=keywords.filter(k=>eligible.includes(k.id)&&k.dimension==='color'&&k.temperature===colorTemperature);
      if(pool.length<2) code(()=>draw(keywords,{libraryId,dimensions:['color'],mode,colorTemperature}), 'INSUFFICIENT_CANDIDATES');
      else assert.ok(draw(keywords,{libraryId,dimensions:['color'],mode,colorTemperature}).items.every(k=>k.temperature===colorTemperature));
    }
  }
  code(()=>draw(keywords,{dimensions:['color','feature'],colorTemperature:'cool',locked:{color:['color-22']}}),'LOCK_TEMPERATURE_CONFLICT');
  code(()=>draw(keywords,{dimensions:['style','feature'],locked:{style:['style-03']}}),'LOCK_OUTSIDE_LIBRARY');
  const libraries=[{id:'mix',name:'我的混合',keywordIds:['style-21','style-03','color-03']}];
  const mixed=draw(keywords,{libraryId:'mix',dimensions:['style'],mode:'free'},50000,libraries);
  assert.deepEqual(new Set(mixed.items.map(k=>k.origin)),new Set(['established','original']));
  code(()=>draw(keywords,{libraryId:'mix',dimensions:['color'],colorTemperature:'warm'},50000,libraries),'INSUFFICIENT_CANDIDATES');
});

test('v4 到 v5 备份迁移：仅未改写正文升级，用户改删、色温、关系和旧快照稳定', t => {
  const file=temp(t);const old=structuredClone(previousSeed).filter(k=>k.id!=='style-24');
  for(const k of old) k.conflicts=k.conflicts.filter(id=>id!=='style-24');
  old.find(k=>k.id==='style-21').conflicts=['style-03'];
  old.find(k=>k.id==='style-25').description='我的说明，必须保留。';
  old.find(k=>k.id==='style-26').name='用户自定名称';
  old.find(k=>k.id==='color-01').temperature='warm';
  old.push({id:'custom-word',dimension:'style',name:find('style-21').name,description:'同名也不套用资料',conflicts:[]});
  const snapshot=draw(old,{libraryId:'all',mode:'free'});
  const libraries=[{id:'mine',name:'混合收藏',keywordIds:['style-21','style-03','custom-word']}];
  const original=JSON.stringify({version:2,seedRevision:4,keywords:old,libraries,history:[snapshot],favorites:[snapshot]});
  writeFileSync(file,original,'utf8');const store=openStore(file);
  assert.equal(readFileSync(file+'.before-v5.bak','utf8'),original);assert.equal(store.state.seedRevision,seedRevision);
  assert.equal(store.state.keywords.find(k=>k.id==='style-21').description,find('style-21').description);
  assert.deepEqual(store.state.keywords.find(k=>k.id==='style-21').conflicts,['style-03']);
  for(const id of ['style-25','style-26','custom-word']) {
    const k=store.state.keywords.find(k=>k.id===id);assert.equal(k.origin,'custom');assert.deepEqual(k.references,[]);
    assert.equal(k.name,old.find(x=>x.id===id).name);assert.equal(k.description,old.find(x=>x.id===id).description);
  }
  assert.equal(store.state.keywords.find(k=>k.id==='color-01').temperature,'warm');
  assert.deepEqual(store.state.history,[snapshot]);assert.deepEqual(store.state.favorites,[snapshot]);assert.deepEqual(store.state.libraries,libraries);
  const again=openStore(file);assert.deepEqual(again.state,store.state);assert.ok(!again.state.keywords.some(k=>k.id==='style-24'));
  const edited=store.transact(s=>mutateKeyword(s,'PATCH','style-21',{description:'新的自定义说明'}));
  assert.equal(edited.origin,'custom');assert.deepEqual(edited.references,[]);
  assert.ok(!createCatalog(store.state).libraries.find(l=>l.id==='established').keywordIds.includes('style-21'));
  assert.deepEqual(openStore(file).state.favorites,[snapshot]);
});

test('迁移保存失败保留原文件与备份；原始说明不变，重新启动可重试', t => {
  const file=temp(t);const text=JSON.stringify({version:2,seedRevision:4,keywords:previousSeed,libraries:[],history:[],favorites:[]});
  writeFileSync(file,text,'utf8');assert.throws(()=>openStore(file,()=>{throw Error('磁盘已满');}),/原数据已保留/);
  assert.equal(readFileSync(file,'utf8'),text);assert.equal(readFileSync(file+'.before-v5.bak','utf8'),text);
  assert.equal(openStore(file).state.seedRevision,5);
});

test('网页/API/CLI/MCP 返回同正文，复制包含全部资料而不含来源或查询步骤', {timeout:15000}, async t => {
  const file=temp(t);const app=createApp({dataFile:file});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();}));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(base+'/api/catalog',{signal:AbortSignal.timeout(5000)});const http=await response.json();
  assert.deepEqual(http.keywords,keywords);
  const args={query:'光学尺寸',dimension:'type',limit:2};
  // runCli reads parameter files; use its documented file entrance for equality.
  const input=join(file,'..','search.json');writeFileSync(input,JSON.stringify(args),'utf8');
  const offline=await runCli(['search','--input',input]);
  const handle=createMcpHandler(base);
  await handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}});
  await handle({jsonrpc:'2.0',method:'notifications/initialized'});
  const result=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'search_design_keywords',arguments:args}});
  assert.deepEqual(result.result.structuredContent,offline.result);
  const drawResponse=await fetch(base+'/api/draw',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  assert.equal(drawResponse.status,201);const record=await drawResponse.json();assert.equal(record.library.id,'established');assert.equal(record.items.length,16);
  const prompt=buildDesignPrompt(record,dimensions,{task:'实际任务',preserve:'保留错误正文',keywordPriorities:{[record.items[0].id]:'dominant'}});
  for(const k of record.items){assert.ok(prompt.includes(k.description),k.id);assert.ok(!prompt.includes(k.id));for(const ref of k.references)assert.ok(!prompt.includes(ref.url));}
  assert.doesNotMatch(prompt,/libraryId|featureCount|去插件|调用插件|重构强度/);
  const history=await (await fetch(base+'/api/history',{signal:AbortSignal.timeout(5000)})).json();
  assert.deepEqual(history[0],record);assert.ok(!JSON.stringify(record).includes('保留错误正文'));
});
