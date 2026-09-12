const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paths = {
  shuffle: '<path d="m3 5 3 0c4 0 5 14 9 14h6m-4-4 4 4-4 4M3 19h3c2 0 3-3 4-5m3-5c1-3 2-4 4-4h4m-4-4 4 4-4 4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2M12 15v2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  sliders: '<path d="M5 3v8m0 4v6M12 3v3m0 4v11M19 3v11m0 4v3M2 11h6m1-5h6m1 8h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="3.5"/>',
  ruler: '<path d="m3 16 13-13 5 5L8 21Zm3-3 2 2m1-5 2 2m1-5 2 2m1-5 2 2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.grid}</svg>`;
$$('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });

const state = { catalog: { dimensions: [], keywords: [] }, selected: [], mode: 'coordinated', countPerDimension: 'random', locked: {}, result: null,
  history: [], favorites: [], view: 'draw', recordKind: 'favorites', format: 'text', busy: false,
  editing: null, conflictSelection: new Set(), detail: null, framing: 'overview', focusDimension: 'style', spacing: 'balanced', measuring: false };
const dim = id => state.catalog.dimensions.find(d => d.id === id);
const groups = items => state.catalog.dimensions.map(d => ({ ...d, items: items.filter(k => k.dimension === d.id) })).filter(g => g.items.length);
const idsByDimension = items => Object.fromEntries(groups(items).map(g => [g.id, g.items.map(k => k.id)]));
// Avoid leading spaces that rich-text editors may serialize as HTML whitespace entities.
const textOf = record => record.text.replace(/^ {2}(?=\S)/gm, '');
const modeName = mode => mode === 'coordinated' ? '协调模式' : '自由模式';
const date = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function showError(selector, message) { $(selector).textContent = message; $(selector).hidden = !message; }
function on(selector, event, action) {
  $(selector).addEventListener(event, e => {
    try { Promise.resolve(action(e)).catch(error => showError('#global-error', error.message)); }
    catch (error) { showError('#global-error', error.message); }
  });
}
async function api(path, method = 'GET', body) {
  let response;
  try { response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) }); }
  catch (error) { throw Error(error.name === 'TimeoutError' ? '请求超时；操作可能已完成，请刷新词库或记录确认后再试。' : '无法连接本地服务，请确认终端中的服务仍在运行，然后刷新页面。'); }
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message ?? '请求失败，请重试。');
  return data;
}

async function refreshCatalog() {
  state.catalog = await api('/api/catalog');
  if (state.catalog.apiVersion !== 2) throw Error('服务版本需要更新。请关闭旧服务窗口，重新双击桌面的「启动灵感采样.bat」，再刷新页面。');
  state.locked = Object.fromEntries(Object.entries(state.locked).filter(([dimension, ids]) => ids.every(id => state.catalog.keywords.some(k => k.id === id && k.dimension === dimension))));
  $('#keyword-count').textContent = state.catalog.keywords.length;
  $('#dimension-options').innerHTML = state.catalog.dimensions.map(d => `<label class="dimension-choice"><input type="checkbox" value="${d.id}" ${state.selected.includes(d.id) ? 'checked' : ''}><span>${d.name}</span></label>`).join('');
  const previousFilter = $('#library-dimension').value;
  const options = state.catalog.dimensions.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  $('#library-dimension').innerHTML = '<option value="">全部维度</option>' + options;
  $('#library-dimension').value = previousFilter;
  $('#edit-dimension').innerHTML = options;
  renderLibrary(); updateDrawControls();
}
async function refreshRecords() {
  [state.history, state.favorites] = await Promise.all([api('/api/history'), api('/api/favorites')]);
  renderRecords(); updateFavoriteButton();
}
async function switchView(view) {
  state.view = view;
  $$('main > section[id^="view-"]').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  $$('[data-view]').forEach(button => { if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  showError('#global-error', '');
  if (view === 'library') await refreshCatalog();
  if (view === 'records') await refreshRecords();
}

function updateDrawControls() {
  const lockedCount = state.selected.filter(d => state.locked[d]).length;
  $('#selected-count').textContent = `${state.selected.length} / 8`;
  $('#draw-button').disabled = state.busy || !state.selected.length || lockedCount === state.selected.length;
  $('#draw-button-label').textContent = state.busy ? '正在组合…' : lockedCount ? '重抽未锁定维度' : '抽取一组灵感';
  $('#lock-hint').textContent = !state.selected.length ? '至少选择一个维度' : lockedCount === state.selected.length ? '全部已锁定，解锁后可继续抽取' : lockedCount ? `锁定 ${lockedCount} 个维度 · 保留整组词条` : state.countPerDimension === 'random' ? '每个维度随机抽取 2–3 条' : `每个维度抽取 ${state.countPerDimension} 条`;
  $$('#dimension-options input, input[name="mode"], #draw-count button').forEach(input => { input.disabled = state.busy; });
  $$('#draw-count button').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.count === String(state.countPerDimension))); if (button.dataset.count === '1') button.hidden = state.countPerDimension !== 1; });
  $('#count-caption').textContent = state.countPerDimension === 'random' ? '各维度独立随机' : '锁定组保持原来的词条数';
  $$('[data-reroll], [data-lock]').forEach(button => { button.disabled = state.busy || !state.selected.includes(button.dataset.reroll ?? button.dataset.lock) || (button.hasAttribute('data-reroll') && Boolean(state.locked[button.dataset.reroll])); });
  if (state.result) {
    const count = groups(state.result.items).length;
    const sameDimensions = count === state.selected.length && state.result.items.every(k => state.selected.includes(k.dimension));
    $('#result-meta').textContent = state.mode !== state.result.mode || !sameDimensions || (state.result.countPerDimension ?? 1) !== state.countPerDimension ? '设置已更改 · 下次抽取生效' : `${modeName(state.result.mode)} · ${count} 个维度 / ${state.result.items.length} 条`;
  }
}
function updateFavoriteButton() {
  const button = $('#favorite-current');
  const saved = Boolean(state.result && state.favorites.some(r => r.id === state.result.id));
  button.disabled = !state.result || state.busy;
  button.classList.toggle('is-favorite', saved);
  button.setAttribute('aria-pressed', String(saved));
  button.innerHTML = `${icon('star')}<span>${saved ? '已收藏' : '收藏组合'}</span>`;
}
function renderDraw() {
  if (state.result) {
    $('#result-grid').innerHTML = groups(state.result.items).map(group => {
      const locked = Boolean(state.locked[group.id]);
      const index = state.catalog.dimensions.findIndex(d => d.id === group.id) + 1;
      return `<article class="result-card ${locked ? 'locked' : ''}" data-dimension="${group.id}"><div class="card-top"><div class="card-category"><span class="category-number">${String(index).padStart(2, '0')}</span><span class="category-name">${group.name}</span><span class="en">${group.en}</span><span class="category-caption"><span class="term-count">${group.items.length} 条线索</span>${locked ? '<span class="locked-label">整组已锁定</span>' : ''}</span></div><div class="card-actions"><button class="icon-button" type="button" data-lock="${group.id}" aria-pressed="${locked}" aria-label="${locked ? '解锁' : '锁定'}${group.name}" title="${locked ? '解锁' : '锁定'}${group.name}整组词条">${icon(locked ? 'lock' : 'unlock')}</button><button class="icon-button" type="button" data-reroll="${group.id}" aria-label="重抽${group.name}" title="重抽${group.name}整组词条">${icon('refresh')}</button></div></div><div class="keyword-stack">${group.items.map(k => `<section class="keyword-term"><h3>${escape(k.name)}</h3><p>${escape(k.description)}</p></section>`).join('')}</div></article>`;
    }).join('');
    $('#dimension-index').innerHTML = groups(state.result.items).map(group => `<button type="button" data-focus="${group.id}" aria-label="聚焦${group.name}" aria-pressed="false"><span>${String(state.catalog.dimensions.findIndex(d => d.id === group.id) + 1).padStart(2, '0')}</span><small>${group.name}</small></button>`).join('');
  }
  $('#copy-text').disabled = !state.result;
  $('#copy-output').disabled = !state.result;
  updateFavoriteButton(); updateDrawControls(); renderOutput(); renderFrame();
}
function renderFrame() {
  const available = groups(state.result?.items ?? []);
  if (!available.some(group => group.id === state.focusDimension)) state.focusDimension = available[0]?.id ?? 'style';
  $('#viewfinder').dataset.framing = state.framing;
  $('#viewfinder').dataset.spacing = state.spacing;
  $('#viewfinder').dataset.measure = String(state.measuring);
  $$('.result-card').forEach(card => { card.hidden = state.framing === 'focus' && card.dataset.dimension !== state.focusDimension; });
  $$('[data-focus]').forEach(button => { button.setAttribute('aria-pressed', String(state.framing === 'focus' && button.dataset.focus === state.focusDimension)); });
  $$('[data-framing]').filter(button => button.tagName === 'BUTTON').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.framing === state.framing)); button.disabled = !state.result; });
  $$('[data-spacing]').filter(button => button.tagName === 'BUTTON').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.spacing === state.spacing)); });
  $('#measure-toggle').setAttribute('aria-pressed', String(state.measuring));
  $('#measure-readout').hidden = !state.measuring;
  const focused = available.find(group => group.id === state.focusDimension);
  $('#frame-caption').textContent = state.framing === 'overview' ? `全览 / ${available.length} 个维度` : `取景 ${String(available.indexOf(focused) + 1).padStart(2, '0')} / ${available.length} · ${focused?.name ?? ''}`;
  $('#sample-id').textContent = state.result ? `SAMPLE ${state.result.id.slice(0, 8).toUpperCase()}` : 'SAMPLE —';
  renderMeasurement();
}
function renderMeasurement() {
  if (!state.measuring || !state.result) return;
  const gridStyle = getComputedStyle($('#result-grid'));
  const card = $('.result-card:not([hidden])');
  const gap = Math.round(parseFloat(gridStyle.columnGap));
  const padding = card ? Math.round(parseFloat(getComputedStyle(card).paddingLeft)) : 0;
  const frame = Math.round(parseFloat(getComputedStyle($('#viewfinder')).paddingLeft));
  $('#measure-readout').textContent = `框内留白 ${frame} px　／　卡片内边距 ${padding} px${state.framing === 'overview' ? `　／　卡片间距 ${gap} px` : ''}`;
}
function renderOutput() {
  $('#format-text').setAttribute('aria-pressed', String(state.format === 'text'));
  $('#format-json').setAttribute('aria-pressed', String(state.format === 'json'));
  $('#output-preview').textContent = !state.result ? '抽取后，可在这里查看和复制完整结果。' : state.format === 'text' ? textOf(state.result) : JSON.stringify(state.result, null, 2);
}
function drawInput(target) {
  const old = (state.result?.items ?? []).filter(k => state.selected.includes(k.dimension));
  const valid = old.filter(k => state.catalog.keywords.some(live => live.id === k.id && live.dimension === k.dimension));
  const current = idsByDimension(valid);
  if (target && (old.length !== valid.length || state.selected.some(d => !current[d]))) throw Error('当前组合包含失效词条或新增维度，请先整组抽取，再进行单项重抽。');
  const locked = target ? Object.fromEntries(Object.entries(current).filter(([dimension]) => dimension !== target)) : { ...state.locked };
  return { dimensions: [...state.selected], mode: state.mode, countPerDimension: state.countPerDimension, locked, current };
}
async function performDraw(input = drawInput(), { tool = false } = {}) {
  if (state.busy) throw Error('正在执行抽取，请稍后重试。');
  state.busy = true; updateDrawControls(); updateFavoriteButton(); showError('#draw-error', ''); showError('#global-error', '');
  try {
    const record = await api('/api/draw', 'POST', input);
    if (tool) {
      state.selected = [...new Set(record.items.map(k => k.dimension))]; state.mode = record.mode; state.countPerDimension = record.countPerDimension;
      state.locked = Object.fromEntries(Object.entries(input.locked ?? {}).map(([d, ids]) => [d, Array.isArray(ids) ? ids : [ids]]));
      $$('#dimension-options input').forEach(node => { node.checked = state.selected.includes(node.value); });
      $$('input[name="mode"]').forEach(node => { node.checked = node.value === state.mode; });
    }
    state.result = record; state.history = [record, ...state.history.filter(r => r.id !== record.id)].slice(0, 100);
    $('#draw-warnings').textContent = record.warnings.join(' '); $('#draw-warnings').hidden = !record.warnings.length;
    renderDraw(); renderRecords();
    if (tool) await switchView('draw');
    return record;
  } catch (error) { showError('#draw-error', error.message); throw error; }
  finally { state.busy = false; updateDrawControls(); updateFavoriteButton(); }
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('已复制，可以交给 agent 了'); }
  catch { $('#copy-fallback').value = value; if (!$('#copy-dialog').open) $('#copy-dialog').showModal(); $('#copy-fallback').focus(); $('#copy-fallback').select(); }
}
async function toggleFavorite(record) {
  const existing = state.favorites.some(r => r.id === record.id);
  if (existing) { await api(`/api/favorites/${record.id}`, 'DELETE'); state.favorites = state.favorites.filter(r => r.id !== record.id); }
  else { const saved = await api('/api/favorites', 'POST', { recordId: record.id }); state.favorites.unshift(saved); }
  renderRecords(); updateFavoriteButton(); toast(existing ? '已取消收藏' : '组合已收藏，内容快照会独立保存');
}

function relations(keyword) { return state.catalog.keywords.filter(k => k.id !== keyword.id && (keyword.conflicts.includes(k.id) || k.conflicts.includes(keyword.id))); }
function renderLibrary() {
  const query = $('#library-search').value.trim().toLocaleLowerCase();
  const dimension = $('#library-dimension').value;
  const items = state.catalog.keywords.filter(k => (!dimension || k.dimension === dimension) && `${k.name} ${k.description}`.toLocaleLowerCase().includes(query));
  $('#library-visible-count').textContent = `${items.length} 条词条`;
  $('#library-list').innerHTML = items.length ? items.map(k => {
    const related = relations(k);
    return `<article class="library-row"><span class="dimension-tag">${dim(k.dimension).name}</span><div><h3>${escape(k.name)}</h3><p>${escape(k.description)}</p>${related.length ? `<span class="conflict-hint">与 ${related.length} 条词条互斥</span>` : ''}</div><div class="row-actions"><button type="button" class="icon-button" data-edit="${k.id}" aria-label="编辑${escape(k.name)}" title="编辑词条">${icon('edit')}</button><button type="button" class="icon-button danger" data-delete="${k.id}" aria-label="删除${escape(k.name)}" title="删除词条">${icon('trash')}</button></div></article>`;
  }).join('') : `<div class="empty-state">${icon('search')}<h3>还没有匹配的词条</h3><p>试试其他关键词，或新增一条设计灵感。</p></div>`;
}
async function openEditor(id) {
  await refreshCatalog();
  const keyword = id ? state.catalog.keywords.find(k => k.id === id) : null;
  if (id && !keyword) throw Error('词条已被删除，请选择其他词条。');
  state.editing = keyword;
  state.conflictSelection = new Set(keyword ? relations(keyword).map(k => k.id) : []);
  $('#editor-title').textContent = keyword ? '编辑词条' : '新增词条';
  $('#edit-dimension').value = keyword?.dimension ?? ($('#library-dimension').value || 'style');
  $('#edit-name').value = keyword?.name ?? ''; $('#edit-description').value = keyword?.description ?? ''; $('#conflict-search').value = '';
  showError('#editor-error', ''); renderConflicts(); $('#editor-dialog').showModal(); $('#edit-name').focus();
}
function renderConflicts() {
  const query = $('#conflict-search').value.trim().toLocaleLowerCase();
  const options = state.catalog.keywords.filter(k => k.id !== state.editing?.id && `${k.name} ${dim(k.dimension).name}`.toLocaleLowerCase().includes(query));
  $('#conflict-count').textContent = `${state.conflictSelection.size} 项`;
  $('#conflict-options').innerHTML = options.length ? options.map(k => `<label class="conflict-option"><input type="checkbox" value="${k.id}" ${state.conflictSelection.has(k.id) ? 'checked' : ''}><span>${escape(k.name)}</span><small>${dim(k.dimension).name}</small></label>`).join('') : '<p class="muted">没有匹配的词条。</p>';
}
async function saveKeyword(event) {
  event.preventDefault();
  const button = $('#save-keyword'); button.disabled = true; button.textContent = '保存中…'; showError('#editor-error', '');
  try {
    const body = { dimension: $('#edit-dimension').value, name: $('#edit-name').value, description: $('#edit-description').value, conflicts: [...state.conflictSelection] };
    await api(state.editing ? `/api/keywords/${state.editing.id}` : '/api/keywords', state.editing ? 'PATCH' : 'POST', body);
    $('#editor-dialog').close(); toast('词条已保存'); await refreshCatalog();
  } catch (error) { if ($('#editor-dialog').open) showError('#editor-error', error.message); else showError('#global-error', error.message); }
  finally { button.disabled = false; button.textContent = '保存词条'; }
}

function renderRecords() {
  $('#favorites-count').textContent = state.favorites.length; $('#history-count').textContent = state.history.length;
  $('#show-favorites').setAttribute('aria-pressed', String(state.recordKind === 'favorites')); $('#show-history').setAttribute('aria-pressed', String(state.recordKind === 'history'));
  const items = state[state.recordKind];
  $('#records-list').innerHTML = items.length ? items.map(record => {
    const saved = state.favorites.some(r => r.id === record.id);
    return `<article class="record-card"><div class="record-top"><time datetime="${escape(record.createdAt)}">${date(record.createdAt)}</time><span class="mode-badge">${modeName(record.mode)}</span></div><div class="record-chips">${record.items.map(k => `<span>${escape(k.name)}</span>`).join('')}</div><div class="record-actions"><button class="button" type="button" data-detail="${record.id}">查看快照</button><button class="button" type="button" data-copy-record="${record.id}">${icon('copy')}复制文本</button><button class="icon-button" type="button" data-favorite="${record.id}" aria-label="${saved ? '取消收藏' : '收藏此组合'}" aria-pressed="${saved}">${icon('star')}</button></div></article>`;
  }).join('') : `<div class="empty-state">${icon(state.recordKind === 'favorites' ? 'star' : 'grid')}<h3>${state.recordKind === 'favorites' ? '为喜欢的组合留一个位置' : '从第一组灵感开始'}</h3><p>${state.recordKind === 'favorites' ? '在抽取结果或历史中点击收藏，喜欢的方向就会留在这里。' : '成功抽取的组合会自动出现在这里，最多保留最近 100 组。'}</p></div>`;
}
function recordById(id) { return [...state.favorites, ...state.history].find(r => r.id === id); }
function openRecord(record) {
  state.detail = record;
  $('#record-title').textContent = `${modeName(record.mode)} · ${groups(record.items).length} 个维度 / ${record.items.length} 条`;
  $('#record-detail').innerHTML = `<p class="muted">${date(record.createdAt)} · 保存时的内容快照</p>` + groups(record.items).map(group => `<section class="record-detail-item"><span class="dimension-tag">${group.name} · ${group.items.length} 条</span>${group.items.map(k => `<div class="keyword-term"><h3>${escape(k.name)}</h3><p>${escape(k.description)}</p></div>`).join('')}</section>`).join('');
  $('#record-dialog').showModal();
}

on('.main-nav', 'click', event => { const button = event.target.closest('[data-view]'); if (button) return switchView(button.dataset.view); });
on('.brand', 'click', event => { event.preventDefault(); return switchView('draw'); });
on('#dimension-options', 'change', () => {
  state.selected = $$('#dimension-options input:checked').map(node => node.value);
  state.locked = Object.fromEntries(Object.entries(state.locked).filter(([key]) => state.selected.includes(key)));
  renderDraw();
});
on('.mode-field', 'change', () => { state.mode = $('input[name="mode"]:checked').value; updateDrawControls(); });
on('#draw-count', 'click', event => { const button = event.target.closest('[data-count]'); if (!button || button.disabled) return; state.countPerDimension = button.dataset.count === 'random' ? 'random' : Number(button.dataset.count); updateDrawControls(); });
on('#view-mode', 'click', event => { const button = event.target.closest('button[data-framing]'); if (!button || button.disabled) return; state.framing = button.dataset.framing; renderFrame(); });
on('#dimension-index', 'click', event => { const button = event.target.closest('[data-focus]'); if (!button) return; state.focusDimension = button.dataset.focus; state.framing = 'focus'; renderFrame(); });
on('#spacing-mode', 'click', event => { const button = event.target.closest('button[data-spacing]'); if (!button) return; state.spacing = button.dataset.spacing; renderFrame(); });
on('#measure-toggle', 'click', () => { state.measuring = !state.measuring; renderFrame(); });
window.addEventListener('resize', renderMeasurement);
on('#draw-button', 'click', () => performDraw().catch(() => {}));
on('#result-grid', 'click', event => {
  const button = event.target.closest('[data-lock], [data-reroll]'); if (!button || button.disabled) return;
  if (button.dataset.lock) {
    const dimension = button.dataset.lock;
    if (state.locked[dimension]) delete state.locked[dimension]; else state.locked[dimension] = state.result.items.filter(k => k.dimension === dimension).map(k => k.id);
    renderDraw(); $(`[data-lock="${dimension}"]`).focus();
  } else return performDraw(drawInput(button.dataset.reroll)).then(() => $(`[data-reroll="${button.dataset.reroll}"]`)?.focus()).catch(() => {});
});
on('#favorite-current', 'click', async () => { $('#favorite-current').disabled = true; try { await toggleFavorite(state.result); } finally { updateFavoriteButton(); } });
on('#copy-text', 'click', () => copy(textOf(state.result)));
on('#copy-output', 'click', () => copy($('#output-preview').textContent));
for (const format of ['text', 'json']) on(`#format-${format}`, 'click', () => { state.format = format; renderOutput(); });
on('#library-search', 'input', renderLibrary); on('#library-dimension', 'change', renderLibrary);
on('#refresh-library', 'click', async () => { await refreshCatalog(); toast('词库已刷新'); });
on('#add-keyword', 'click', () => openEditor());
on('#library-list', 'click', async event => {
  const edit = event.target.closest('[data-edit]'); if (edit) return openEditor(edit.dataset.edit);
  const remove = event.target.closest('[data-delete]'); if (!remove) return;
  const keyword = state.catalog.keywords.find(k => k.id === remove.dataset.delete);
  if (confirm(`删除「${keyword.name}」？已有历史和收藏中的内容快照会保留。`)) {
    await api(`/api/keywords/${keyword.id}`, 'DELETE');
    if (state.locked[keyword.dimension]?.includes(keyword.id)) delete state.locked[keyword.dimension];
    await refreshCatalog(); renderDraw(); toast('词条已删除，互斥引用已清理');
  }
});
on('#editor-form', 'submit', saveKeyword);
on('#conflict-search', 'input', renderConflicts);
on('#conflict-options', 'change', event => { const input = event.target; if (input.checked) state.conflictSelection.add(input.value); else state.conflictSelection.delete(input.value); $('#conflict-count').textContent = `${state.conflictSelection.size} 项`; });
on('#refresh-records', 'click', async () => { await refreshRecords(); toast('记录已刷新'); });
for (const kind of ['favorites', 'history']) on(`#show-${kind}`, 'click', () => { state.recordKind = kind; renderRecords(); });
on('#records-list', 'click', async event => {
  const button = event.target.closest('[data-detail], [data-copy-record], [data-favorite]'); if (!button) return;
  const record = recordById(button.dataset.detail ?? button.dataset.copyRecord ?? button.dataset.favorite);
  if (button.dataset.detail) return openRecord(record);
  if (button.dataset.copyRecord) return copy(textOf(record));
  button.disabled = true; try { await toggleFavorite(record); } finally { button.disabled = false; }
});
on('#copy-record-text', 'click', () => copy(textOf(state.detail)));
on('#copy-record-json', 'click', () => copy(JSON.stringify(state.detail, null, 2)));
$$('[data-close]').forEach(button => { button.addEventListener('click', () => $(`#${button.dataset.close}`).close()); });

// Optional browser-agent entry points; HTTP remains available in every supported browser.
async function registerBrowserTools() {
  if (!document.modelContext?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const idMap = { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true }] } };
  const definitions = [
    { name: 'read_design_catalog', description: '读取形意词库的八维术语及显式互斥关系。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => api('/api/catalog') },
    { name: 'draw_design_inspiration', description: '每维度抽取 2–3 条设计灵感，保存到本地历史并更新当前网页结果。锁定维度会保留整组。', inputSchema: { type: 'object', properties: { dimensions: { type: 'array', items: { type: 'string', enum: state.catalog.dimensions.map(d => d.id) }, minItems: 1, maxItems: 8, uniqueItems: true }, mode: { type: 'string', enum: ['coordinated', 'free'] }, countPerDimension: { enum: ['random', 1, 2, 3] }, locked: idMap, current: idMap }, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: input => performDraw(input, { tool: true }) },
  ];
  for (const definition of definitions) { try { await document.modelContext.registerTool(definition, { signal: lifecycle.signal }); } catch (error) { console.warn('浏览器工具注册不可用；HTTP 接口不受影响。', error); } }
}

async function init() {
  try {
    state.catalog = await api('/api/catalog');
    if (state.catalog.apiVersion !== 2) throw Error('服务版本需要更新。请关闭旧服务窗口，重新双击桌面的「启动灵感采样.bat」，再刷新页面。');
    state.selected = state.catalog.dimensions.map(d => d.id);
    await refreshCatalog(); await refreshRecords();
    await performDraw().catch(() => {
      $('#result-grid').innerHTML = `<div class="empty-state">${icon('grid')}<h3>调整条件，开始采样</h3><p>检查上方提示，调整维度或词库后重新抽取。</p></div>`;
    });
    await registerBrowserTools();
  } catch (error) {
    showError('#global-error', error.message);
    $('#result-grid').innerHTML = `<div class="empty-state">${icon('grid')}<h3>暂时无法读取词库</h3><p>确认本地服务已启动，然后刷新页面重试。</p></div>`;
  }
}
await init();
