import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keywords, previousSeed, seedRevision } from './seed.mjs';
import v5Prose from './seed-v5-prose.json' with { type: 'json' };
import { draw, openStore } from './core.mjs';
import { createApp } from './server.mjs';
import { createMcpHandler } from './mcp.mjs';
import { runCli } from './cli.mjs';
import { once } from 'node:events';
const pick = id => keywords.find(k => k.id === id);
const error = (fn, code) => assert.throws(fn, e => e.code === code);

test('各维度独立范围、全局后备与特色；自由和协调均严格筛选', () => {
  const warm = keywords.filter(k=>k.dimension==='color' && k.temperature==='warm').slice(0,3);
  const personal = [{id:'palette',name:'我的暖色',keywordIds:warm.map(k=>k.id)}];
  for (const mode of ['free','coordinated']) {
    const r = draw(keywords,{libraryId:'original',dimensions:['style','color','layout','feature'],dimensionLibraries:{style:'established',color:'palette'},mode,colorTemperature:'warm',featureCount:4},50000,personal);
    assert.equal(r.items.length,10);
    assert.ok(r.items.filter(k=>k.dimension==='style').every(k=>k.origin==='established'));
    assert.ok(r.items.filter(k=>k.dimension==='layout').every(k=>k.origin==='original'));
    assert.ok(r.items.filter(k=>k.dimension==='color').every(k=>warm.some(w=>w.id===k.id) && k.temperature==='warm'));
    assert.equal(r.items.filter(k=>k.dimension==='feature').length,4);
    assert.equal(r.featureSource,'global');
    assert.deepEqual(r.dimensionLibraries,{style:{id:'established',name:'已有术语'},color:{id:'palette',name:'我的暖色'},layout:{id:'original',name:'原创灵感'}});
    const current=Object.fromEntries(['style','color','layout','feature'].map(d=>[d,r.items.filter(k=>k.dimension===d).map(k=>k.id)]));
    const next=draw(keywords,{libraryId:'original',dimensions:Object.keys(current),dimensionLibraries:{style:'established',color:'palette'},mode,current,locked:{color:current.color,layout:current.layout,feature:current.feature}},50000,personal);
    assert.deepEqual(next.items.filter(k=>k.dimension!=='style'),r.items.filter(k=>k.dimension!=='style'));
    assert.ok(next.items.filter(k=>k.dimension==='style').every(k=>!current.style.includes(k.id)));
  }
  error(()=>draw(keywords,{dimensions:['color'],dimensionLibraries:{color:'palette'},colorTemperature:'cool'},50000,personal),'INSUFFICIENT_CANDIDATES');
  error(()=>draw(keywords,{dimensions:['style','color'],dimensionLibraries:{style:'palette'}},50000,personal),'EMPTY_DIMENSION');
  error(()=>draw(keywords,{dimensions:['style','color'],dimensionLibraries:{style:'original'},locked:{style:['style-21']}}),'LOCK_OUTSIDE_LIBRARY');
  for (const dimensionLibraries of [null,[],{feature:'original'},{layout:'original'},{style:'deleted'},{style:2}]) {
    error(()=>draw(keywords,{dimensions:['style','feature'],dimensionLibraries}),'INVALID_INPUT');
  }
  assert.deepEqual(draw(keywords,{dimensions:['feature']}).dimensionLibraries,{});
});

test('跨词库互斥仍全组检查，自由模式可组合', () => {
  const sample=[{...pick('style-21'),conflicts:['color-03']},{...pick('color-03'),conflicts:[]}];
  const libraries=[{id:'a',name:'A',keywordIds:['style-21']},{id:'b',name:'B',keywordIds:['color-03']}];
  const input={dimensions:['style','color'],dimensionLibraries:{style:'a',color:'b'},countPerDimension:1};
  error(()=>draw(sample,input,50000,libraries),'NO_COMBINATION');
  assert.equal(draw(sample,{...input,mode:'free'},50000,libraries).items.length,2);
});

test('v5 专业长正文升级，改词改名、删除、色温、互斥和快照保留', t => {
  const dir=mkdtempSync(join(tmpdir(),'formlex-v5-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:3}));
  const file=join(dir,'state.json');
  const old=previousSeed.filter(k=>k.id!=='style-24').map(k=>({...structuredClone(k),...v5Prose[k.id],origin:v5Prose[k.id]?'established':'unverified',references:[],conflicts:k.conflicts.filter(id=>id!=='style-24')}));
  old.find(k=>k.id==='style-21').conflicts=['style-03'];
  old.find(k=>k.id==='style-25').description+='用户补充。';
  old.find(k=>k.id==='style-26').name='我的名称';
  old.find(k=>k.id==='color-01').temperature='warm';
  const snapshot=draw(old,{libraryId:'all',mode:'free',dimensions:['style'],countPerDimension:2});delete snapshot.dimensionLibraries;
  const libraries=[{id:'mine',name:'个人组合',keywordIds:['style-21','style-25']}];
  const before=JSON.stringify({version:2,seedRevision:5,keywords:old,libraries,history:[snapshot],favorites:[snapshot]});writeFileSync(file,before,'utf8');
  const store=openStore(file);
  assert.equal(readFileSync(file+`.before-v${seedRevision}.bak`,'utf8'),before);
  assert.equal(store.state.keywords.find(k=>k.id==='style-21').description,pick('style-21').description);
  assert.deepEqual(store.state.keywords.find(k=>k.id==='style-21').conflicts,['style-03']);
  assert.ok(!store.state.keywords.some(k=>k.id==='style-24'));
  for(const id of ['style-25','style-26']) {
    const next=store.state.keywords.find(k=>k.id===id), prior=old.find(k=>k.id===id);
    assert.equal(next.name,prior.name);assert.equal(next.description,prior.description);assert.equal(next.origin,'custom');assert.deepEqual(next.references,[]);
  }
  assert.equal(store.state.keywords.find(k=>k.id==='color-01').temperature,'warm');
  assert.deepEqual(store.state.libraries,libraries);assert.deepEqual(store.state.history,[snapshot]);assert.deepEqual(store.state.favorites,[snapshot]);
  assert.deepEqual(openStore(file).state,store.state);
});

test('逐维参数贯通 HTTP、离线 CLI 与可选 MCP；失败不保存记录', {timeout:15000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'formlex-scope-api-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:3}));
  const app=createApp({dataFile:join(dir,'state.json')});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();}));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const input={dimensions:['style','color','layout','feature'],dimensionLibraries:{style:'established',color:'original',layout:'original'},colorTemperature:'cool',featureCount:3,mode:'free'};
  const response=await fetch(base+'/api/draw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,201);const http=await response.json();assert.deepEqual(app.store.state.history[0],http);
  const inputFile=join(dir,'input.json');writeFileSync(inputFile,JSON.stringify(input),'utf8');
  const offline=await runCli(['draw','--input',inputFile]);assert.equal(offline.historySaved,false);
  assert.deepEqual(offline.result.dimensionLibraries,http.dimensionLibraries);
  assert.equal(app.store.state.history.length,1);
  const handle=createMcpHandler(base);
  await handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'scope-test',version:'1'}}});
  await handle({jsonrpc:'2.0',method:'notifications/initialized'});
  const result=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'draw_design_inspiration',arguments:input}});
  const mcp=result.result.structuredContent;
  assert.deepEqual(mcp.dimensionLibraries,http.dimensionLibraries);assert.deepEqual(app.store.state.history[0],mcp);
  assert.equal(app.store.state.history.length,2);
  for(const record of [http,offline.result,mcp]){
    assert.equal(record.items.length,9);assert.equal(record.featureSource,'global');
    assert.ok(record.items.filter(k=>k.dimension==='color').every(k=>k.origin==='original'&&k.temperature==='cool'));
    for(const k of record.items)assert.equal(k.description,pick(k.id).description);
  }
  const failed=await fetch(base+'/api/draw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,dimensionLibraries:{style:'deleted'}}),signal:AbortSignal.timeout(5000)});
  assert.equal(failed.status,400);assert.equal(app.store.state.history.length,2);
});
