import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';
import { atomicWrite } from './core.mjs';

// Optional browser regression check: uses a test environment's Playwright and Edge.
let chromium;
try { ({ chromium } = createRequire(process.env.FORMLEX_TEST_RUNTIME || import.meta.url)('playwright')); } catch { /* Native API tests need no browser dependency. */ }

test('冷蓝工作台：阅读、编排、检视、色迹与原有操作', { timeout: 50000, skip: !chromium && '浏览器验证需要测试环境提供 Playwright；普通启动与 API 测试不需要。' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'formlex-ui-'));
  let fail = false, browser, page;
  const app = createApp({ dataFile: join(directory, 'state.json'), write: (file, state) => { if (fail) throw Error('模拟写入失败'); atomicWrite(file, state); } });
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
    assert.equal(await page.locator('#feature-enabled').isChecked(),false);
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
    const chosen = current.items.at(-1);
    await page.locator(`[data-inspect="${chosen.id}"]`).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#reader-title').textContent(), chosen.name);
    assert.equal(await page.locator('#reader-description').textContent(), chosen.description);
    await page.locator('#curate-toggle').click();
    await page.locator('[data-dimension="style"][data-move="1"]').click();
    assert.deepEqual((await order()).slice(0,2),['color','style']); assert.deepEqual(await record(),current);
    assert.equal(await page.locator('[data-dimension="color"][data-move="-1"]').isDisabled(),true);
    await page.locator('[data-dimension="style"][data-move="-1"]').click(); await page.locator('#curate-toggle').click();
    await page.locator('#feature-enabled').check(); await page.locator('#feature-count').selectOption('3');
    await page.locator('#draw-library').selectOption('digital'); await page.locator('[data-temperature="cool"]').click(); await page.locator('[data-count="2"]').click();
    current = await draw(); assert.equal(current.items.length,19); assert.ok(current.items.filter(k=>k.dimension==='color').every(k=>k.temperature==='cool'));
    assert.deepEqual(current,app.store.state.history[0]);
    await page.locator('[data-lock="feature"]').click();
    const fixedFeature = current.items.filter(k=>k.dimension==='feature');
    await page.locator('#draw-library').selectOption('classical');current=await draw();assert.deepEqual(current.items.filter(k=>k.dimension==='feature'),fixedFeature);
    const other=current.items.filter(k=>k.dimension!=='color');current=await draw('[data-reroll="color"]');assert.deepEqual(current.items.filter(k=>k.dimension!=='color'),other);
    await page.locator('[data-lock="color"]').click();await page.locator('[data-temperature="warm"]').click();await page.locator('#draw-button').click();await page.locator('#draw-error').waitFor();
    assert.match(await page.locator('#draw-error').textContent(),/不属于暖色调/);assert.deepEqual(await record(),current);
    await page.locator('[data-lock="color"]').click();await page.locator('[data-temperature="cool"]').click();
    await page.locator('#feature-enabled').uncheck();assert.equal(await page.locator('[data-lock="feature"]').getAttribute('aria-pressed'),'false');assert.deepEqual(await record(),current);
    current=await draw();assert.ok(current.items.every(k=>k.dimension!=='feature'));
    await page.locator('#inspection-toggle').click();assert.equal(await page.locator('[data-reroll="style"]').isDisabled(),true);
    const pending=await page.evaluate(()=>window.formlexTools.draw_design_inspiration.execute({libraryId:'digital',dimensions:['color','feature'],colorTemperature:'cool',featureCount:1,countPerDimension:2,mode:'free'}));
    assert.deepEqual(await record(),current);assert.deepEqual(app.store.state.history[0],pending);assert.match(await page.locator('#inspection-status').textContent(),/1 组抽取已保存/);
    await page.locator('#copy-text').click();assert.equal(await page.evaluate(()=>window.copied),current.text.replace(/^ {2}(?=\S)/gm,''));
    await page.locator('#inspection-toggle').click();assert.deepEqual(await record(),pending);assert.equal(await page.locator('#feature-count').inputValue(),'1');
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
    await page.locator('[data-view="draw"]').click();await page.locator('#draw-library').selectOption('digital');await page.locator('[data-count="2"]').click();current=await draw();
    fail=true;await page.locator('#draw-button').click();await page.locator('#draw-error').waitFor();assert.deepEqual(await record(),current);fail=false;
    await draw();await page.locator('#format-text').click();await page.locator('.surface-settings summary').click();
    await page.locator('#toast').waitFor({state:'hidden'});await page.evaluate(()=>scrollTo(0,0));await screenshot('desktop.png');
    await page.locator('[data-focus="feature"]').click();await page.locator('#specimen-reader').scrollIntoViewIfNeeded();await screenshot('focus.png');
    await page.locator('#manage-libraries').click();await page.locator('#collection-dialog').waitFor();assert.equal(await page.locator('#collection-dimension option[value="feature"]').count(),0);await screenshot('collections.png');await page.keyboard.press('Escape');
    for(const width of [390,320,760,1024]){
      await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px horizontal overflow`);
      if(width===390){await page.evaluate(()=>scrollTo(0,document.querySelector('.results-toolbar').getBoundingClientRect().top+scrollY-16));await screenshot('mobile-focus.png');}
    }
    await page.locator('[data-framing="overview"]').click();await page.locator('#curate-toggle').click();await page.locator('[data-dimension="style"][data-move="1"]').click();
    await page.setViewportSize({width:390,height:844});await page.reload({timeout:10000});await page.locator('.result-card').first().waitFor();assert.equal(await page.locator('#controls-drawer').getAttribute('open'),null);
    assert.deepEqual((await order()).slice(0,2),['color','style']);assert.equal(await page.locator('#draw-button').isVisible(),true);
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
process.on('exit',code=>{if(code===0)console.log('DONE');});
