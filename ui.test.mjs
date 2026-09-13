import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';
import { atomicWrite } from './core.mjs';
import { buildDesignPrompt, buildKeywordText, reconstructionLevels } from './public/design-rules.mjs';
import { listLibraries } from './libraries.mjs';

// Optional browser regression check: uses a test environment's Playwright and Edge.
let chromium;
try { ({ chromium } = createRequire(process.env.FORMLEX_TEST_RUNTIME || import.meta.url)('playwright')); } catch { /* Native API tests need no browser dependency. */ }

test('冷蓝工作台：阅读、编排、检视、色迹与原有操作', { timeout: 50000, skip: !chromium && '浏览器验证需要测试环境提供 Playwright；普通启动与 API 测试不需要。' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'formlex-ui-'));
  let fail = false, browser, page;
  const app = createApp({ dataFile: join(directory, 'state.json'), write: (file, state) => { if (fail) throw Error('模拟写入失败'); atomicWrite(file, state); } });
  app.store.transact(state => state.libraries.push({id:'test-personal',name:'冷暖混合自选',keywordIds:listLibraries(state).find(l=>l.id==='classical').keywordIds}));
  app.store.transact(state => state.favorites.push({id:'old-record',createdAt:'2026-01-01T00:00:00Z',mode:'free',items:[structuredClone(state.keywords[0])],text:'旧版灵感快照',warnings:[]}));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const errors = [];
  const screenshot = async name => { if (process.env.FORMLEX_PREVIEWS === '1') await page.screenshot({path:resolve('preview',name)}); };
  try {
    browser = await chromium.launch({channel:process.env.FORMLEX_BROWSER || 'msedge',headless:true,timeout:15000});
    const context = await browser.newContext({viewport:{width:1440,height:1120},reducedMotion:'reduce'});
    await context.addInitScript(() => {
      window.formlexTools = {};
      Object.defineProperty(document, 'modelContext', { value: { registerTool: async tool => { window.formlexTools[tool.name] = tool; } } });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { if (window.clipboardDenied) throw Error('无剪贴板权限'); window.copied = value; } } });
    });
    page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
    await page.goto(base, {timeout:10000}); await page.locator('.result-card').first().waitFor();
    assert.equal(await page.locator('.result-card').count(),8);
    assert.equal(await page.locator('[data-library-category="established"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#library-categories button').count(),3);
    assert.ok(app.store.state.history[0].items.every(k=>k.origin==='established'));
    assert.equal(await page.locator('#feature-enabled').isChecked(),false);
    const dimensions = (await (await fetch(base+'/api/catalog',{signal:AbortSignal.timeout(5000)})).json()).dimensions;
    assert.equal(await page.locator('#format-prompt').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#output-preview').textContent(),buildDesignPrompt(app.store.state.history[0],dimensions));
    await page.locator('#format-json').click();
    const record = () => page.locator('#output-preview').textContent().then(JSON.parse);
    const order = () => page.locator('.result-card').evaluateAll(cards => cards.map(c => c.dataset.dimension));
    const draw = async (selector = '#draw-button') => {
      const id = (await record()).id;
      await page.locator(selector).click();
      await page.waitForFunction(old => { try { return JSON.parse(document.querySelector('#output-preview').textContent).id !== old; } catch { return false; } }, id);
      return record();
    };
    let current = await record();
    const storageBefore = await page.evaluate(()=>JSON.stringify(localStorage));
    const firstStyle = current.items.filter(k=>k.dimension==='style')[0];
    const secondStyle = current.items.filter(k=>k.dimension==='style')[1];
    const task = '离线掌机菜单。<b>品牌蓝 #1246A0</b>，保留键盘操作。';
    const draft = { task, dimensionPriorities:{style:'dominant',shape:'emphasis'}, keywordPriorities:{[firstStyle.id]:'normal'} };
    await page.locator('[data-dimension-priority="style"]').selectOption('dominant');
    await page.locator('[data-dimension-priority="shape"]').selectOption('emphasis');
    await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).selectOption('normal');
    await page.locator('#brief-task').fill(task);
    assert.equal(await page.locator(`[data-keyword-priority="${secondStyle.id}"]`).inputValue(),'inherit');
    assert.match(await page.locator(`[data-keyword-priority="${secondStyle.id}"]`).locator('..').textContent(),/生效：主导/);
    assert.match(await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).locator('..').textContent(),/生效：普通 · 单独/);
    await page.locator('#copy-text').click();
    assert.equal(await page.evaluate(()=>window.copied),buildDesignPrompt(current,dimensions,draft));
    assert.deepEqual(await record(),current);assert.deepEqual(app.store.state.history[0],current);
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage)),storageBefore);
    await page.locator('#format-prompt').click();
    assert.equal(await page.locator('#output-preview').textContent(),buildDesignPrompt(current,dimensions,draft));
    assert.equal(await page.locator('#output-preview b').count(),0,'任务文本不能成为 HTML');
    await page.evaluate(()=>{window.clipboardDenied=true;});await page.locator('#copy-output').click();await page.locator('#copy-dialog').waitFor();
    assert.equal(await page.locator('#copy-fallback').inputValue(),buildDesignPrompt(current,dimensions,draft));
    await page.keyboard.press('Escape');await page.evaluate(()=>{window.clipboardDenied=false;});
    await page.locator('#format-text').click();assert.equal(await page.locator('#output-preview').textContent(),buildKeywordText(current,dimensions));
    await page.locator('#format-json').click();
    await page.locator('#favorite-current').click();await page.waitForFunction(()=>document.querySelector('#favorite-current').getAttribute('aria-pressed')==='true');
    assert.deepEqual(app.store.state.favorites.find(r=>r.id===current.id),current);
    await page.locator('[data-view="records"]').click();await page.locator(`[data-copy-record="${current.id}"]`).click();
    assert.equal(await page.evaluate(()=>window.copied),buildDesignPrompt(current,dimensions));
    await page.locator(`[data-detail="${current.id}"]`).click();await page.locator('#copy-record-text').click();assert.equal(await page.evaluate(()=>window.copied),buildDesignPrompt(current,dimensions));
    await page.locator('#copy-record-raw').click();assert.equal(await page.evaluate(()=>window.copied),buildKeywordText(current,dimensions));
    await page.keyboard.press('Escape');await page.locator('[data-view="draw"]').click();
    await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).selectOption('inherit');
    assert.match(await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).locator('..').textContent(),/生效：主导/);
    await page.locator('[data-dimension-priority="style"]').selectOption('normal');
    assert.match(await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).locator('..').textContent(),/生效：普通/);
    // Native selects remain keyboard operable without redrawing the focused control.
    await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    assert.equal(await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).inputValue(),'normal');
    const selectedBeforeReroll = current.items.find(k=>k.dimension==='color');
    await page.locator('[data-dimension-priority="color"]').selectOption('dominant');
    await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).selectOption('emphasis');
    await page.locator(`[data-keyword-priority="${selectedBeforeReroll.id}"]`).selectOption('normal');
    current = await draw('[data-reroll="color"]');
    assert.equal(await page.locator(`[data-keyword-priority="${firstStyle.id}"]`).inputValue(),'emphasis');
    assert.equal(await page.locator(`[data-keyword-priority="${selectedBeforeReroll.id}"]`).count(),0);
    for(const k of current.items.filter(k=>k.dimension==='color')) {
      assert.equal(await page.locator(`[data-keyword-priority="${k.id}"]`).inputValue(),'inherit');
      assert.match(await page.locator(`[data-keyword-priority="${k.id}"]`).locator('..').textContent(),/生效：主导/);
    }
    await page.locator('#priority-reset').click();await page.locator('#brief-task').fill('');
    assert.ok((await page.locator('[data-dimension-priority]').evaluateAll(nodes=>nodes.map(n=>n.value))).every(v=>v==='normal'));
    assert.ok((await page.locator('[data-keyword-priority]').evaluateAll(nodes=>nodes.map(n=>n.value))).every(v=>v==='inherit'));
    const chosen = current.items.at(-1);
    await page.locator(`[data-inspect="${chosen.id}"]`).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#reader-title').textContent(), chosen.name);
    assert.equal(await page.locator('#reader-description').textContent(), chosen.description);
    assert.ok(await page.locator('#reader-references a').count()>0);
    assert.match(await page.locator('#reader-references').textContent(),/前端应用与误用建议由 FormLex/);
    await page.locator('#toast').waitFor({state:'hidden'});await page.evaluate(()=>scrollTo(0,0));await screenshot('desktop.png');
    await page.locator('#curate-toggle').click();
    await page.locator('[data-dimension="style"][data-move="1"]').click();
    assert.deepEqual((await order()).slice(0,2),['color','style']); assert.deepEqual(await record(),current);
    assert.equal(await page.locator('[data-dimension="color"][data-move="-1"]').isDisabled(),true);
    await page.locator('[data-dimension="style"][data-move="-1"]').click(); await page.locator('#curate-toggle').click();
    await page.locator('#feature-enabled').check(); await page.locator('#feature-count').selectOption('3');
    await page.locator('[data-library-category="original"]').click(); await page.locator('[data-temperature="cool"]').click(); await page.locator('[data-count="2"]').click();
    current = await draw(); assert.equal(current.items.length,19); assert.ok(current.items.filter(k=>k.dimension==='color').every(k=>k.temperature==='cool'));
    assert.deepEqual(current,app.store.state.history[0]);
    await page.locator('[data-lock="feature"]').click();
    const fixedFeature = current.items.filter(k=>k.dimension==='feature');
    await page.locator('[data-library-category="personal"]').click();current=await draw();assert.deepEqual(current.items.filter(k=>k.dimension==='feature'),fixedFeature);
    const other=current.items.filter(k=>k.dimension!=='color');current=await draw('[data-reroll="color"]');assert.deepEqual(current.items.filter(k=>k.dimension!=='color'),other);
    await page.locator('[data-lock="color"]').click();await page.locator('[data-temperature="warm"]').click();await page.locator('#draw-button').click();await page.locator('#draw-error').waitFor();
    assert.match(await page.locator('#draw-error').textContent(),/不属于暖色调/);assert.deepEqual(await record(),current);
    await page.locator('[data-lock="color"]').click();await page.locator('[data-temperature="cool"]').click();
    await page.locator('#feature-enabled').uncheck();assert.equal(await page.locator('[data-lock="feature"]').getAttribute('aria-pressed'),'false');assert.deepEqual(await record(),current);
    current=await draw();assert.ok(current.items.every(k=>k.dimension!=='feature'));
    await page.locator('#inspection-toggle').click();assert.equal(await page.locator('[data-reroll="style"]').isDisabled(),true);
    const pending=await page.evaluate(()=>window.formlexTools.draw_design_inspiration.execute({libraryId:'digital',dimensions:['color','feature'],colorTemperature:'cool',featureCount:1,countPerDimension:2,mode:'free'}));
    assert.deepEqual(await record(),current);assert.deepEqual(app.store.state.history[0],pending);assert.match(await page.locator('#inspection-status').textContent(),/1 组抽取已保存/);
    await page.locator('#copy-text').click();assert.equal(await page.evaluate(()=>window.copied),buildDesignPrompt(current,dimensions));
    await page.locator('#inspection-toggle').click();assert.deepEqual(await record(),pending);assert.equal(await page.locator('#feature-count').inputValue(),'1');
    assert.equal(await page.locator('[data-library-category="established"]').getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('#scope-notice').textContent(),/当前结果和锁定保持/);
    await page.locator('#favorite-current').click();await page.waitForFunction(()=>document.querySelector('#favorite-current').getAttribute('aria-pressed')==='true');
    await page.evaluate(()=>{window.clipboardDenied=true;});await page.locator('#copy-output').click();await page.locator('#copy-dialog').waitFor();assert.deepEqual(JSON.parse(await page.locator('#copy-fallback').inputValue()),pending);await page.keyboard.press('Escape');
    await page.evaluate(()=>{window.clipboardDenied=false;});
    await page.locator('.surface-settings summary').click();
    await page.locator('#texture-strength').fill('0');assert.equal(await page.locator('#texture-value').textContent(),'0%');
    await page.locator('#texture-strength').fill('28');assert.equal(await page.locator('#texture-value').textContent(),'28%');
    const ink = () => page.locator('#color-trail').evaluate(canvas => { const d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;for(let i=3;i<d.length;i+=4)if(d[i])return true;return false; });
    await page.locator('#trail-preset').selectOption('orbit');await page.locator('#trail-preview').click();
    await page.waitForFunction(()=>{const c=document.querySelector('#color-trail');return c.getContext('2d').getImageData(Math.floor(c.width/2),0,1,1).data.length===4;});
    await page.waitForTimeout(80);assert.equal(await ink(),true);await page.waitForTimeout(1200);assert.equal(await ink(),true,'reduced motion keeps a static preset');
    await page.locator('#trail-clear').click();assert.equal(await ink(),false);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('#trail-surface').scrollIntoViewIfNeeded();const area=await page.locator('#trail-surface').boundingBox();
    await page.mouse.move(area.x+20,area.y+40);await page.mouse.move(area.x+120,area.y+85,{steps:16});await page.waitForTimeout(40);assert.equal(await ink(),true);
    await page.waitForTimeout(1250);assert.equal(await ink(),false,'trail expires without another pointer event');
    await page.locator('#trail-enabled').uncheck();await page.mouse.move(area.x+30,area.y+30);await page.mouse.move(area.x+170,area.y+90,{steps:15});assert.equal(await ink(),false);
    await page.locator('#trail-enabled').check();await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('[data-view="library"]').click();await page.locator('#library-dimension').selectOption('feature');assert.match(await page.locator('#library-visible-count').textContent(),/150 条独立特色/);
    await page.locator('#library-search').fill('追逐鼠标');await page.locator('[data-edit="feature-01"]').click();await page.locator('#editor-dialog').waitFor();
    await page.locator('#edit-name').fill('色迹样本');fail=true;await page.locator('#save-keyword').click();await page.locator('#editor-error').waitFor();assert.match(await page.locator('#editor-error').textContent(),/保存失败/);fail=false;
    await page.keyboard.press('Escape');await page.locator('[data-view="records"]').click();await page.locator('[data-detail="old-record"]').click();await page.locator('#record-dialog').waitFor();assert.match(await page.locator('#record-detail').textContent(),/克制现代主义/);await page.keyboard.press('Escape');
    await page.locator('[data-view="draw"]').click();await page.locator('[data-library-category="original"]').click();await page.locator('[data-count="2"]').click();current=await draw();
    fail=true;await page.locator('#draw-button').click();await page.locator('#draw-error').waitFor();assert.deepEqual(await record(),current);fail=false;
    for(const d of dimensions.filter(d=>d.id!=='feature')) await page.locator(`#dimension-options input[value="${d.id}"]`).check();
    await draw();await page.locator('[data-dimension-priority="material"]').selectOption('dominant');await page.locator('[data-dimension-priority="feature"]').selectOption('emphasis');
    await page.locator('#brief-task').fill('构建离线掌机菜单。全部线索都要实际落地，材质主导视觉，特色重点表现；支持键盘操作。');
    await page.locator('#format-prompt').click();await page.locator('.surface-settings summary').click();
    await page.locator('#toast').waitFor({state:'hidden'});await page.evaluate(()=>scrollTo(0,0));
    await page.locator('.output-panel').scrollIntoViewIfNeeded();await screenshot('prompt.png');
    await page.locator('[data-focus="feature"]').click();await page.locator('#specimen-reader').scrollIntoViewIfNeeded();await screenshot('focus.png');
    await page.locator('#manage-libraries').click();await page.locator('#collection-dialog').waitFor();assert.equal(await page.locator('#collection-dimension option[value="feature"]').count(),0);await screenshot('collections.png');await page.keyboard.press('Escape');
    for(const width of [390,320,760,1024]){
      await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px horizontal overflow`);
      if(width===390){await page.evaluate(()=>scrollTo(0,document.querySelector('.results-toolbar').getBoundingClientRect().top+scrollY-16));await screenshot('mobile-focus.png');}
    }
    await page.locator('[data-framing="overview"]').click();await page.locator('#curate-toggle').click();await page.locator('[data-dimension="style"][data-move="1"]').click();
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('全部线索都要实际落地')),false);
    await page.setViewportSize({width:390,height:844});await page.reload({timeout:10000});await page.locator('.result-card').first().waitFor();assert.equal(await page.locator('#controls-drawer').getAttribute('open'),null);
    assert.deepEqual((await order()).slice(0,2),['color','style']);assert.equal(await page.locator('#draw-button').isVisible(),true);
    assert.equal(await page.locator('#brief-task').inputValue(),'');
    assert.ok((await page.locator('[data-dimension-priority]').evaluateAll(nodes=>nodes.map(n=>n.value))).every(v=>v==='normal'));
    assert.ok((await page.locator('[data-keyword-priority]').evaluateAll(nodes=>nodes.map(n=>n.value))).every(v=>v==='inherit'));
    await page.locator('#controls-drawer>summary').click();assert.equal(await page.locator('#feature-enabled').isChecked(),true);assert.equal(await page.locator('[data-temperature="cool"]').getAttribute('aria-pressed'),'true');
    await page.locator('.surface-settings summary').click();assert.equal(await page.locator('#texture-strength').inputValue(),'28');
    // Touch strokes are confined to the explicit drawing surface.
    await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('#trail-surface').scrollIntoViewIfNeeded();
    // Use a real touch sequence via Chromium so capture and touch-action are exercised.
    const session=await context.newCDPSession(page);const box=await page.locator('#trail-surface').boundingBox();
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+20,y:box.y+35}]});
    for(let i=1;i<=8;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+20+i*12,y:box.y+35+i*3}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(40);assert.equal(await ink(),true);await session.detach();
    assert.deepEqual(errors,[]);
  } catch(error) {
    if(page) { console.error(await page.locator('#global-error').textContent()); console.error(await page.locator('#draw-error').textContent()); }
    throw error;
  } finally {
    await browser?.close();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});rmSync(directory,{recursive:true,force:true,maxRetries:3});
  }
});
test('逐维词库选择记忆与覆盖、失效提示；复制强度仅含执行指令', {timeout:35000,skip:!chromium}, async()=>{
  const directory=mkdtempSync(join(tmpdir(),'formlex-scope-ui-'));
  const app=createApp({dataFile:join(directory,'state.json')});let browser;
  app.store.transact(s=>s.libraries.push({id:'one',name:'仅一个风格',keywordIds:['style-21']}));
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  try {
    browser=await chromium.launch({channel:'msedge',headless:true,timeout:15000});
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(5000);
    await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});});
    await page.goto(`http://127.0.0.1:${app.server.address().port}`,{timeout:10000});await page.locator('.result-card').first().waitFor();
    assert.equal(await page.locator('[data-dimension-library]').count(),8);
    const prior=structuredClone(app.store.state.history[0]);
    await page.locator('[data-dimension-library="layout"]').selectOption('original');
    await page.locator('[data-dimension-library="style"]').selectOption('established');
    await page.locator('[data-library-category="original"]').click();
    assert.deepEqual(app.store.state.history[0],prior);
    assert.equal(await page.locator('[data-dimension-library="style"]').inputValue(),'established');
    await page.locator('#draw-button').click();await page.waitForFunction(()=>document.querySelector('#result-meta').textContent.includes('按维度混合词库'));
    const mixed=app.store.state.history[0];
    assert.ok(mixed.items.filter(k=>k.dimension==='style').every(k=>k.origin==='established'));
    assert.ok(mixed.items.filter(k=>k.dimension==='layout').every(k=>k.origin==='original'));
    assert.match(await page.locator('.result-card[data-dimension="style"] .category-caption').textContent(),/已有术语/);
    for(const level of reconstructionLevels){
      await page.locator(`[data-reconstruction="${level.id}"]`).click();await page.locator('#copy-text').click();
      const prompt=await page.evaluate(()=>window.copied);
      assert.ok(prompt.includes(`## 重构要求 · ${level.name}\n\n${level.rule}`));assert.doesNotMatch(prompt,/重构强度是可选|每档强度|用户已经选择|## 重构强度/);
      assert.match(await page.locator('#toast').textContent(),new RegExp(`包含「${level.name}」重构要求`));
      for(const other of reconstructionLevels.filter(l=>l.id!==level.id)) assert.ok(!prompt.includes(other.rule));
    }
    if(process.env.FORMLEX_PREVIEWS==='1'){
      await page.setViewportSize({width:390,height:1000});
      await page.locator('.brief-scope').screenshot({path:resolve('preview/reconstruction-mobile.png')});
      await page.setViewportSize({width:1440,height:1000});
    }
    await page.locator('#reconstruction-clear').click();await page.locator('#copy-text').click();assert.ok(!(await page.evaluate(()=>window.copied)).includes('## 重构要求'));
    await page.locator('#brief-preserve').fill('保留错误正文');await page.locator('#copy-text').click();assert.match(await page.evaluate(()=>window.copied),/必须保留：保留错误正文/);
    await page.locator('[data-dimension-library="style"]').selectOption('one');await page.locator('#draw-button').click();await page.locator('#draw-error').waitFor();
    assert.match(await page.locator('#draw-error').textContent(),/只有 1 条候选/);assert.deepEqual(app.store.state.history[0],mixed);
    await page.reload({timeout:10000});await page.locator('#draw-error').waitFor();
    assert.equal(await page.locator('[data-dimension-library="style"]').inputValue(),'one');assert.equal(await page.locator('#brief-preserve').inputValue(),'');
    app.store.transact(s=>{s.libraries=[];});await page.reload({timeout:10000});await page.locator('#draw-error').waitFor();
    assert.match(await page.locator('[data-dimension-library="style"]').textContent(),/词库已失效/);
    await page.setViewportSize({width:320,height:900});if(!await page.locator('#controls-drawer').evaluate(n=>n.open)) await page.locator('#controls-drawer>summary').click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('[data-dimension-library="layout"]').focus();assert.equal(await page.locator('[data-dimension-library="layout"]').evaluate(n=>n===document.activeElement),true);
    await page.locator('#reset-dimension-libraries').click();assert.ok((await page.locator('[data-dimension-library]').evaluateAll(ns=>ns.map(n=>n.value))).every(v=>v===''));
  } finally {await browser?.close();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});
process.on('exit',code=>{if(code===0)console.log('DONE');});
