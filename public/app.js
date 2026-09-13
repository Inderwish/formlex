import { priorities, priority, effectivePriority, retainKeywordPriorities, buildDesignPrompt, buildKeywordText, reconstructionLevels } from './design-rules.mjs';

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

const state = { catalog: { dimensions: [], keywords: [], libraries: [] }, selected: [], libraryId: 'established', libraryLimit: 80, collectionLimit: 80, collectionSelection: new Set(), collectionBusy: false, mode: 'coordinated', countPerDimension: 2, locked: {}, result: null,
  history: [], favorites: [], view: 'draw', recordKind: 'favorites', format: 'prompt', busy: false, featureCount: 1, colorTemperature: 'random',
  brief: { task: '', reconstruction: '', preserve: '', dimensionPriorities: {}, keywordPriorities: {} },
  editing: null, conflictSelection: new Set(), detail: null, framing: 'overview', focusDimension: 'style', spacing: 'balanced', measuring: false,
  boardOrder: [], curating: false, activeKeyword: null, inspecting: false, pendingDraw: null, pendingCount: 0 };
const dim = id => state.catalog.dimensions.find(d => d.id === id);
const groups = items => state.catalog.dimensions.map(d => ({ ...d, items: items.filter(k => k.dimension === d.id) })).filter(g => g.items.length);
const idsByDimension = items => Object.fromEntries(groups(items).map(g => [g.id, g.items.map(k => k.id)]));
const boardGroups = () => groups(state.result?.items ?? []).sort((a,b) => state.boardOrder.indexOf(a.id) - state.boardOrder.indexOf(b.id));
const textOf = record => buildKeywordText(record, state.catalog.dimensions);
const promptOf = record => buildDesignPrompt(record, state.catalog.dimensions);
const currentPrompt = () => buildDesignPrompt(state.result, state.catalog.dimensions, { ...state.brief, dimensionOrder: state.boardOrder });
const priorityOptions = () => priorities.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
// Draft requirements and priorities are intentionally separate from saved records and browser storage.
$('#brief-task').value = '';
$('#brief-preserve').value = '';
$('#reconstruction-options').innerHTML = reconstructionLevels.map(level => `<button type="button" data-reconstruction="${level.id}" aria-pressed="false"><strong>${level.name}</strong><span>${level.summary}</span></button>`).join('');
const modeName = mode => mode === 'coordinated' ? '协调模式' : '自由模式';
const temperatureName = value => ({ random: '随机（不限冷暖）', cool: '冷色调', warm: '暖色调', neutral: '中性', mixed: '混合', unspecified: '未分类' })[value ?? 'unspecified'];
const regularDimensions = () => state.catalog.dimensions.filter(d => d.id !== 'feature');
function rememberOptions() {
  try { for (const [key, value] of Object.entries({ featureEnabled: state.selected.includes('feature'), featureCount: state.featureCount, colorTemperature: state.colorTemperature })) localStorage.setItem(`formlex.${key}`, String(value)); }
  catch { /* Selections still work without local storage. */ }
}
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
  if (state.catalog.apiVersion !== 4 || !state.catalog.libraries.some(l => l.id === 'established')) throw Error('服务版本需要更新。请关闭旧服务窗口，重新双击桌面的「启动灵感采样.bat」，再刷新页面。');
  state.locked = Object.fromEntries(Object.entries(state.locked).filter(([dimension, ids]) => ids.every(id => state.catalog.keywords.some(k => k.id === id && k.dimension === dimension))));
  $('#keyword-count').textContent = state.catalog.keywords.length;
  renderLibraryChoices();
  const previousFilter = $('#library-dimension').value;
  const options = state.catalog.dimensions.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  $('#library-dimension').innerHTML = '<option value="">全部维度</option>' + options;
  $('#library-dimension').value = previousFilter;
  $('#edit-dimension').innerHTML = options;
  $('#collection-dimension').innerHTML = '<option value="">全部常规维度</option>' + regularDimensions().map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  renderLibrary(); updateDrawControls();
}

function poolKeywords(id = state.libraryId) {
  const library = state.catalog.libraries.find(l => l.id === id);
  const ids = new Set(library?.keywordIds ?? []);
  return state.catalog.keywords.filter(k => ids.has(k.id));
}
const originNames = { established: '已有术语 · 有出处', original: '原创灵感', unverified: '待核实', custom: '用户自定义' };
function referenceHTML(keyword) {
  const links = (keyword.references ?? []).filter(ref => {
    try { return new URL(ref.url).protocol === 'https:'; } catch { return false; }
  });
  return `<div class="reference-info"><span class="origin-label">${originNames[keyword.origin] ?? '旧版快照 · 未附资料'}</span><p>${escape(keyword.classificationReason ?? '保留记录当时的说明，不套用新版资料。')}</p>${links.length ? `<p>概念定义参考以下资料；前端应用与误用建议由 FormLex 整理。参考链接不进入完整提示词。</p><ul>${links.map(ref => `<li><a href="${escape(ref.url)}" target="_blank" rel="noopener noreferrer">${escape(ref.institution)} · ${escape(ref.title)} ↗</a></li>`).join('')}</ul>` : ''}</div>`;
}
function libraryOptions() {
  return '<option value="all">全部常规词条（含待核实与自定义）</option>' + state.catalog.libraries.filter(l => !l.legacy).map(l => `<option value="${l.id}">${escape(l.name)} · ${l.keywordIds.length} 条</option>`).join('') + '<option value="unverified">待核实</option><option value="custom">用户自定义</option>';
}
function renderLibraryChoices() {
  const current = state.catalog.libraries.find(l => l.id === state.libraryId);
  if (!current || current.legacy) {
    state.libraryId = 'established';
    $('#scope-notice').hidden = false;
    $('#scope-notice').textContent = '原词库范围已调整为「已有术语」。当前结果和锁定保持，后续抽取使用新范围；可在管理页查看所有词条。';
    try { localStorage.setItem('formlex.libraryId', state.libraryId); } catch { /* Memory selection remains usable. */ }
  }
  const previous = $('#library-source').value;
  const personal = state.catalog.libraries.filter(l => !l.builtIn);
  const category = personal.some(l => l.id === state.libraryId) ? 'personal' : state.libraryId;
  $$('#library-categories button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.libraryCategory === category)));
  $('#personal-library-field').hidden = category !== 'personal';
  $('#draw-library').innerHTML = personal.map(l => `<option value="${l.id}">${escape(l.name)} · ${l.keywordIds.length} 条</option>`).join('');
  $('#draw-library').value = state.libraryId;
  $('#library-source').innerHTML = libraryOptions();
  $('#library-source').value = [...$('#library-source').options].some(option => option.value === previous) ? previous : 'all';
  renderDimensions();
}
function renderDimensions() {
  const pool = poolKeywords();
  const library = state.catalog.libraries.find(l => l.id === state.libraryId);
  $('#pool-summary').textContent = `${pool.length} 条常规候选 · ${library?.description ?? '只从你挑选的词条中组合灵感。'}`;
  $('#feature-pool-count').textContent = `${state.catalog.featurePool?.count ?? 0} 条独立候选 · 不受常规分类或个人词库限制`;
  $('#dimension-options').innerHTML = regularDimensions().map(d => {
    const count = pool.filter(k => k.dimension === d.id && (d.id !== 'color' || state.colorTemperature === 'random' || k.temperature === state.colorTemperature)).length;
    return `<label class="dimension-choice" title="${d.name}有 ${count} 条候选"><input type="checkbox" value="${d.id}" ${state.selected.includes(d.id) ? 'checked' : ''}><span>${d.name}</span><small>${count}</small></label>`;
  }).join('');
}
function applyLibrary(id, keepNotice = false) {
  if (!state.catalog.libraries.some(l => l.id === id)) throw Error('所选词库已失效，请刷新词库。');
  if (!keepNotice) $('#scope-notice').hidden = true;
  state.libraryId = id;
  const available = new Set(poolKeywords().map(k => k.dimension));
  const featureEnabled = state.selected.includes('feature');
  state.selected = regularDimensions().filter(d => available.has(d.id) || state.locked[d.id]).map(d => d.id);
  if (featureEnabled) state.selected.push('feature');
  try { localStorage.setItem('formlex.libraryId', id); } catch { /* Saving the library itself is handled by the server. */ }
  renderLibraryChoices(); renderDraw();
}
async function openCollection() {
  await refreshCatalog();
  const library = state.catalog.libraries.find(l => l.id === state.libraryId);
  $('#collection-edit-select').innerHTML = '<option value="">新建个人词库</option>' + state.catalog.libraries.filter(l => !l.builtIn).map(l => `<option value="${l.id}">${escape(l.name)}</option>`).join('');
  $('#collection-edit-select').value = library.builtIn ? '' : library.id;
  $('#collection-name').value = library.builtIn ? '' : library.name;
  state.collectionSelection = new Set(library.id === 'all' ? [] : library.keywordIds);
  $('#collection-search').value = ''; $('#collection-dimension').value = ''; $('#collection-selected-only').checked = false;
  showError('#collection-error', ''); state.collectionLimit = 80; renderCollection(); $('#collection-options').scrollTop = 0;
  $('#collection-dialog').showModal(); $('#collection-name').focus();
}
function collectionMatches() {
  const query = $('#collection-search').value.trim().toLocaleLowerCase();
  const dimension = $('#collection-dimension').value;
  return state.catalog.keywords.filter(k => k.dimension !== 'feature' && (!dimension || k.dimension === dimension) && (!$('#collection-selected-only').checked || state.collectionSelection.has(k.id)) && `${k.name} ${k.description}`.toLocaleLowerCase().includes(query));
}
function renderCollection(keepList = false) {
  const selected = state.catalog.keywords.filter(k => state.collectionSelection.has(k.id));
  $('#collection-counts').innerHTML = `<strong>已选 ${selected.length} 条</strong>` + regularDimensions().map(d => `<span>${d.name} <b>${selected.filter(k => k.dimension === d.id).length}</b></span>`).join('');
  const matches = collectionMatches();
  $('#collection-add-filtered').textContent = `选入筛选结果（${matches.length}）`;
  if (!keepList) $('#collection-options').innerHTML = matches.length ? matches.slice(0, state.collectionLimit).map(k => `<label class="collection-option"><input type="checkbox" value="${k.id}" ${state.collectionSelection.has(k.id) ? 'checked' : ''}><span><strong>${escape(k.name)}</strong><small>${originNames[k.origin] ?? '待核实'} · ${escape(k.description)}</small></span><span class="dimension-tag">${dim(k.dimension).name}</span></label>`).join('') : '<p class="empty-state">没有匹配的词条，可更换关键词或维度。</p>';
  $('#collection-more').hidden = matches.length <= state.collectionLimit;
  $('#collection-delete').hidden = !$('#collection-edit-select').value;
}
async function saveCollection(copy = false) {
  if (state.collectionBusy || !$('#collection-form').reportValidity()) return;
  if (!state.collectionSelection.size) { showError('#collection-error', '请至少选择一条词条，再保存个人词库。'); return; }
  state.collectionBusy = true; showError('#collection-error', '');
  $$('#collection-form button, #collection-form input, #collection-form select').forEach(node => { node.disabled = true; });
  try {
    const id = copy ? '' : $('#collection-edit-select').value;
    const result = await api(id ? `/api/libraries/${id}` : '/api/libraries', id ? 'PATCH' : 'POST', { name: $('#collection-name').value, keywordIds: [...state.collectionSelection] });
    await refreshCatalog(); applyLibrary(result.id); $('#collection-dialog').close(); toast('个人词库已保存，下次抽取使用这份词库');
  } catch (error) { showError('#collection-error', error.message); }
  finally { state.collectionBusy = false; $$('#collection-form button, #collection-form input, #collection-form select').forEach(node => { node.disabled = false; }); }
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
  $('#selected-count').textContent = `${state.selected.filter(d => d !== 'feature').length} / 8`;
  $('#feature-enabled').checked = state.selected.includes('feature');
  $('#feature-count').value = String(state.featureCount);
  $('#feature-count').disabled = state.busy || !state.selected.includes('feature');
  $$('#color-temperature button').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.temperature === state.colorTemperature)); button.disabled = state.busy || !state.selected.includes('color'); });
  $('#draw-button').disabled = state.busy || !state.selected.length || lockedCount === state.selected.length;
  $('#draw-button-label').textContent = state.busy ? '正在组合…' : lockedCount ? '重抽未锁定维度' : '抽取一组灵感';
  $('#lock-hint').textContent = !state.selected.length ? '至少选择一个维度' : lockedCount === state.selected.length ? '全部已锁定，解锁后可继续抽取' : lockedCount ? `锁定 ${lockedCount} 个维度 · 保留整组词条` : state.countPerDimension === 'random' ? '常规维度随机 2–3 条' : `常规维度抽取 ${state.countPerDimension} 条`;
  $$('#dimension-options input, input[name="mode"], #draw-count button, #draw-library, #library-categories button, #manage-libraries, #feature-enabled').forEach(input => { input.disabled = state.busy; });
  $$('#draw-count button').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.count === String(state.countPerDimension))); });
  $('#count-caption').textContent = state.countPerDimension === 'random' ? '各维度独立随机' : '锁定组保持原来的词条数';
  $$('[data-reroll], [data-lock]').forEach(button => { button.disabled = state.busy || state.inspecting || !state.selected.includes(button.dataset.reroll ?? button.dataset.lock) || (button.hasAttribute('data-reroll') && Boolean(state.locked[button.dataset.reroll])); });
  $$('[data-dimension-priority], [data-keyword-priority]').forEach(select => { select.disabled = state.busy; });
  $('#priority-reset').disabled = state.busy || !state.result;
  const bounds = state.selected.map(d => {
    const fixed = state.locked[d]?.length;
    if (fixed) return [fixed, fixed];
    if (d === 'feature') return [state.featureCount, state.featureCount];
    if (state.countPerDimension !== 'random') return [state.countPerDimension, state.countPerDimension];
    const available = poolKeywords().filter(k => k.dimension === d && (d !== 'color' || state.colorTemperature === 'random' || k.temperature === state.colorTemperature)).length;
    return [2, available >= 3 ? 3 : 2];
  });
  const low = bounds.reduce((n,p) => n + p[0], 0), high = bounds.reduce((n,p) => n + p[1], 0);
  $('#route-dimensions').textContent = `${state.selected.length} 维`;
  $('#route-count').textContent = `预计 ${low === high ? low : `${low}–${high}`} 条`;
  $('#inspection-toggle').disabled = state.busy || !state.result;
  $('#inspection-toggle').textContent = state.inspecting ? '恢复显示' : '固定检视';
  $('#inspection-toggle').setAttribute('aria-pressed', String(state.inspecting));
  $('#inspection-status').hidden = !state.inspecting;
  $('#inspection-status').textContent = state.pendingCount ? `当前快照已固定；本页另有 ${state.pendingCount} 组抽取已保存到历史。恢复显示后接收其中最新一组。` : '当前快照已固定。只暂停本页结果显示，新的抽取仍可保存；HTTP / MCP 继续工作。';
  if (state.result) {
    const count = groups(state.result.items).length;
    const sameDimensions = count === state.selected.length && state.result.items.every(k => state.selected.includes(k.dimension));
    $('#result-meta').textContent = state.libraryId !== (state.result.library?.id ?? 'all') || state.mode !== state.result.mode || !sameDimensions || (state.result.countPerDimension ?? 1) !== state.countPerDimension || (state.result.colorTemperature ?? 'random') !== state.colorTemperature || (state.result.featureCount ?? 1) !== state.featureCount ? '设置已更改 · 下次抽取生效' : `${state.result.library?.name ?? '全部词库'} · ${modeName(state.result.mode)} · ${state.result.items.length} 条`;
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
function renderReader() {
  let items = state.result?.items ?? [];
  if (state.framing === 'focus') items = items.filter(k => k.dimension === state.focusDimension);
  const keyword = items.find(k => k.id === state.activeKeyword) ?? items[0];
  if (!keyword) return;
  state.activeKeyword = keyword.id;
  $('#reader-dimension').textContent = `${dim(keyword.dimension).name} / 资料`;
  $('#reader-title').textContent = keyword.name;
  $('#reader-description').textContent = keyword.description;
  $('#reader-references').innerHTML = referenceHTML(keyword);
  $$('[data-inspect]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.inspect === keyword.id)));
}
function renderDraw() {
  if (state.result) {
    $('#result-grid').innerHTML = boardGroups().map((group, position, list) => {
      const locked = Boolean(state.locked[group.id]);
      const index = state.catalog.dimensions.findIndex(d => d.id === group.id) + 1;
      return `<article class="result-card ${locked ? 'locked' : ''}" data-dimension="${group.id}"><div class="card-top"><div class="card-category"><span class="category-number">${String(index).padStart(2, '0')}</span><span class="category-name">${group.name}</span><span class="en">${group.en}</span><span class="category-caption"><span class="term-count">${group.items.length} 条线索${group.id === 'feature' ? ' · 独立特色池' : ''}</span>${locked ? '<span class="locked-label">已锁定</span>' : ''}</span></div><div class="card-actions"><button class="icon-button" type="button" data-lock="${group.id}" aria-pressed="${locked}" aria-label="${locked ? '解锁' : '锁定'}${group.name}" title="${locked ? '解锁' : '锁定'}${group.name}整组词条">${icon(locked ? 'lock' : 'unlock')}</button><button class="icon-button" type="button" data-reroll="${group.id}" aria-label="重抽${group.name}" title="重抽${group.name}整组词条">${icon('refresh')}</button></div></div><label class="dimension-priority-control">整组权重<select data-dimension-priority="${group.id}" aria-label="${group.name}维度权重">${priorityOptions()}</select></label><div class="keyword-stack">${group.items.map((k, i) => `<section class="keyword-term"><button type="button" class="term-slot" data-inspect="${k.id}" aria-pressed="false" aria-label="阅读${escape(k.name)}"><span aria-hidden="true">${String(i + 1).padStart(2,'0')}</span><strong class="term-name">${escape(k.name)}</strong><small aria-hidden="true">↗</small></button><div class="term-priority-control"><span class="effective-priority">生效：普通</span><select data-keyword-priority="${k.id}" aria-label="${escape(k.name)}词条权重"><option value="inherit">跟随维度</option>${priorityOptions()}</select></div><p>${escape(k.description)}</p></section>`).join('')}</div><div class="curation-actions"><button type="button" data-dimension="${group.id}" data-move="-1" ${position === 0 ? 'disabled' : ''} aria-label="前移${group.name}">← 前移</button><button type="button" data-dimension="${group.id}" data-move="1" ${position === list.length - 1 ? 'disabled' : ''} aria-label="后移${group.name}">后移 →</button></div></article>`;
    }).join('');
    $('#dimension-index').innerHTML = boardGroups().map(group => `<button type="button" data-focus="${group.id}" aria-label="聚焦${group.name}" aria-pressed="false"><span>${String(state.catalog.dimensions.findIndex(d => d.id === group.id) + 1).padStart(2, '0')}</span><small>${group.name}</small></button>`).join('');
  }
  $('#copy-text').disabled = !state.result;
  $('#copy-output').disabled = !state.result;
  updateFavoriteButton(); updateDrawControls(); renderPriorities(); renderOutput(); renderFrame();
}
function renderPriorities() {
  const counts = Object.fromEntries(priorities.map(p => [p.id, 0]));
  for (const keyword of state.result?.items ?? []) {
    const effective = effectivePriority(keyword, state.brief);
    counts[effective]++;
    const select = $(`[data-keyword-priority="${keyword.id}"]`);
    if (!select) continue;
    const override = Object.hasOwn(state.brief.keywordPriorities, keyword.id);
    select.value = override ? state.brief.keywordPriorities[keyword.id] : 'inherit';
    select.querySelector('option[value="inherit"]').textContent = `跟随维度 · ${priority(state.brief.dimensionPriorities[keyword.dimension]).name}`;
    const term = select.closest('.keyword-term');
    term.dataset.priority = effective;
    term.querySelector('.effective-priority').textContent = `生效：${priority(effective).name}${override ? ' · 单独' : ''}`;
  }
  $$('[data-dimension-priority]').forEach(select => {
    select.value = priority(state.brief.dimensionPriorities[select.dataset.dimensionPriority]).id;
    select.closest('.result-card').dataset.priority = select.value;
  });
  $('#priority-summary').textContent = state.result ? `${state.result.items.length} 条全部必选 · ${priorities.map(p => `${p.name} ${counts[p.id]}`).join(' / ')}` : '抽取后设置设计投入，全部词条都需要落实。';
}
function renderFrame() {
  const available = boardGroups();
  if (!available.some(group => group.id === state.focusDimension)) state.focusDimension = available[0]?.id ?? 'style';
  $('#viewfinder').dataset.framing = state.framing;
  $('#viewfinder').dataset.spacing = state.spacing;
  $('#viewfinder').dataset.measure = String(state.measuring);
  $('#viewfinder').dataset.curating = String(state.curating);
  $('#curate-toggle').setAttribute('aria-pressed', String(state.curating));
  $('#curate-toggle').disabled = !state.result;
  $$('.result-card').forEach(card => { card.hidden = state.framing === 'focus' && card.dataset.dimension !== state.focusDimension; });
  $$('[data-focus]').forEach(button => { button.setAttribute('aria-pressed', String(state.framing === 'focus' && button.dataset.focus === state.focusDimension)); });
  $$('[data-framing]').filter(button => button.tagName === 'BUTTON').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.framing === state.framing)); button.disabled = !state.result; });
  $$('[data-spacing]').filter(button => button.tagName === 'BUTTON').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.spacing === state.spacing)); });
  $('#measure-toggle').setAttribute('aria-pressed', String(state.measuring));
  $('#measure-readout').hidden = !state.measuring;
  const focused = available.find(group => group.id === state.focusDimension);
  $('#frame-caption').textContent = state.framing === 'overview' ? `${state.curating ? '编排' : '展板'} / ${available.length} 个维度` : `取景 ${String(available.indexOf(focused) + 1).padStart(2, '0')} / ${available.length} · ${focused?.name ?? ''}`;
  $('#sample-id').textContent = state.result ? `SAMPLE ${state.result.id.slice(0, 8).toUpperCase()}` : 'SAMPLE —';
  renderMeasurement(); renderReader();
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
  for (const format of ['prompt', 'text', 'json']) $(`#format-${format}`).setAttribute('aria-pressed', String(state.format === format));
  $('#output-preview').textContent = !state.result ? '抽取后，可在这里查看和复制完整设计提示词。' : state.format === 'prompt' ? currentPrompt() : state.format === 'text' ? textOf(state.result) : JSON.stringify(state.result, null, 2);
  $('#copy-output').setAttribute('aria-label', `复制${state.format === 'prompt' ? '完整提示词' : state.format === 'text' ? '纯词条' : '原始 JSON'}`);
}
function drawInput(target) {
  const old = (state.result?.items ?? []).filter(k => state.selected.includes(k.dimension));
  const valid = old.filter(k => state.catalog.keywords.some(live => live.id === k.id && live.dimension === k.dimension));
  const current = idsByDimension(valid);
  if (target && (old.length !== valid.length || state.selected.some(d => !current[d]))) throw Error('当前组合包含失效词条或新增维度，请先整组抽取，再进行单项重抽。');
  const locked = target ? Object.fromEntries(Object.entries(current).filter(([dimension]) => dimension !== target)) : { ...state.locked };
  return { dimensions: [...state.selected], libraryId: state.libraryId, mode: state.mode, countPerDimension: state.countPerDimension, featureCount: state.featureCount, colorTemperature: state.colorTemperature, locked, current };
}
function acceptDraw(record, input, tool) {
  if (tool) {
    state.libraryId = record.library?.id ?? 'all';
    state.selected = [...new Set(record.items.map(k => k.dimension))]; state.mode = record.mode; state.countPerDimension = record.countPerDimension;
    state.featureCount = record.featureCount ?? 1; state.colorTemperature = record.colorTemperature ?? 'random'; rememberOptions();
    state.locked = Object.fromEntries(Object.entries(input.locked ?? {}).map(([d, ids]) => [d, Array.isArray(ids) ? ids : [ids]]));
    $$('input[name="mode"]').forEach(node => { node.checked = node.value === state.mode; });
    renderLibraryChoices();
  }
  state.brief.keywordPriorities = retainKeywordPriorities(state.brief.keywordPriorities, record.items);
  state.result = record;
  $('#draw-warnings').textContent = record.warnings.join(' '); $('#draw-warnings').hidden = !record.warnings.length;
  renderDraw();
}
async function performDraw(input = drawInput(), { tool = false } = {}) {
  if (state.busy) throw Error('正在执行抽取，请稍后重试。');
  state.busy = true; updateDrawControls(); updateFavoriteButton(); showError('#draw-error', ''); showError('#global-error', '');
  try {
    const record = await api('/api/draw', 'POST', input);
    state.history = [record, ...state.history.filter(r => r.id !== record.id)].slice(0, 100);
    if (state.inspecting && state.result) { state.pendingDraw = { record, input, tool }; state.pendingCount++; }
    else acceptDraw(record, input, tool);
    renderRecords();
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
  const feature = dimension === 'feature';
  $('#library-source').disabled = feature;
  $('#library-temperature').disabled = dimension !== 'color';
  const temperature = dimension === 'color' ? $('#library-temperature').value : '';
  const sourceId = $('#library-source').value;
  const source = feature ? state.catalog.keywords.filter(k => k.dimension === 'feature') : ['custom', 'unverified'].includes(sourceId) ? state.catalog.keywords.filter(k => k.dimension !== 'feature' && k.origin === sourceId) : poolKeywords(sourceId);
  const items = source.filter(k => (!dimension || k.dimension === dimension) && (!temperature || (k.temperature ?? 'unspecified') === temperature) && `${k.name} ${k.description}`.toLocaleLowerCase().includes(query));
  $('#library-visible-count').textContent = `${items.length} 条${feature ? '独立特色' : '常规词条'}`;
  $('#library-more').hidden = items.length <= state.libraryLimit;
  $('#library-list').innerHTML = items.length ? items.slice(0, state.libraryLimit).map(k => {
    const related = relations(k);
    return `<article class="library-row"><span class="dimension-tag">${dim(k.dimension).name}</span><div><h3>${escape(k.name)}</h3><p>${escape(k.description)}</p><details class="term-sources"><summary>资料与出处 · ${originNames[k.origin] ?? '待核实'}</summary>${referenceHTML(k)}</details>${k.dimension === 'color' ? `<span class="temperature-tag">${temperatureName(k.temperature)}</span>` : ''}${related.length ? `<span class="conflict-hint">与 ${related.length} 条词条互斥</span>` : ''}</div><div class="row-actions"><button type="button" class="icon-button" data-edit="${k.id}" aria-label="编辑${escape(k.name)}" title="编辑词条">${icon('edit')}</button><button type="button" class="icon-button danger" data-delete="${k.id}" aria-label="删除${escape(k.name)}" title="删除词条">${icon('trash')}</button></div></article>`;
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
  $('#edit-temperature').value = keyword?.temperature ?? 'unspecified';
  $('#edit-temperature-field').hidden = $('#edit-dimension').value !== 'color';
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
    if (body.dimension === 'color') body.temperature = $('#edit-temperature').value;
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
    return `<article class="record-card"><div class="record-top"><time datetime="${escape(record.createdAt)}">${date(record.createdAt)}</time><span class="mode-badge">${modeName(record.mode)}</span></div><div class="record-chips">${record.items.map(k => `<span>${escape(k.name)}</span>`).join('')}</div><div class="record-actions"><button class="button" type="button" data-detail="${record.id}">查看快照</button><button class="button" type="button" data-copy-record="${record.id}">${icon('copy')}复制完整提示词</button><button class="icon-button" type="button" data-favorite="${record.id}" aria-label="${saved ? '取消收藏' : '收藏此组合'}" aria-pressed="${saved}">${icon('star')}</button></div></article>`;
  }).join('') : `<div class="empty-state">${icon(state.recordKind === 'favorites' ? 'star' : 'grid')}<h3>${state.recordKind === 'favorites' ? '为喜欢的组合留一个位置' : '从第一组灵感开始'}</h3><p>${state.recordKind === 'favorites' ? '在抽取结果或历史中点击收藏，喜欢的方向就会留在这里。' : '成功抽取的组合会自动出现在这里，最多保留最近 100 组。'}</p></div>`;
}
function recordById(id) { return [...state.favorites, ...state.history].find(r => r.id === id); }
function openRecord(record) {
  state.detail = record;
  $('#record-title').textContent = `${modeName(record.mode)} · ${groups(record.items).length} 个维度 / ${record.items.length} 条`;
  $('#record-detail').innerHTML = `<p class="muted">${date(record.createdAt)} · ${escape(record.library?.name ?? '全部词库')}${record.colorTemperature ? ` · 色彩：${temperatureName(record.colorTemperature)}` : ''}${record.featureSource === 'global' ? ` · 独立特色池（数量设置 ${record.featureCount ?? 1} 条）` : ''} · 保存时的内容快照</p><p class="control-caption">复制完整提示词时按全部普通生成，不包含编辑页临时任务或权重。</p>` + groups(record.items).map(group => `<section class="record-detail-item"><span class="dimension-tag">${group.name} · ${group.items.length} 条</span>${group.items.map(k => `<div class="keyword-term"><h3>${escape(k.name)}</h3><p>${escape(k.description)}</p><details class="term-sources"><summary>资料与出处</summary>${referenceHTML(k)}</details></div>`).join('')}</section>`).join('');
  $('#record-dialog').showModal();
}

on('.main-nav', 'click', event => { const button = event.target.closest('[data-view]'); if (button) return switchView(button.dataset.view); });
on('.brand', 'click', event => { event.preventDefault(); return switchView('draw'); });
on('#dimension-options', 'change', () => {
  state.selected = [...$$('#dimension-options input:checked').map(node => node.value), ...(state.selected.includes('feature') ? ['feature'] : [])];
  state.locked = Object.fromEntries(Object.entries(state.locked).filter(([key]) => state.selected.includes(key)));
  renderDraw();
});
on('#feature-enabled', 'change', () => {
  state.selected = state.selected.filter(d => d !== 'feature');
  if ($('#feature-enabled').checked) state.selected.push('feature'); else delete state.locked.feature;
  rememberOptions(); renderDraw();
});
on('#feature-count', 'change', () => { state.featureCount = Number($('#feature-count').value); rememberOptions(); updateDrawControls(); });
on('#color-temperature', 'click', event => { const button = event.target.closest('[data-temperature]'); if (!button || button.disabled) return; state.colorTemperature = button.dataset.temperature; rememberOptions(); renderDimensions(); updateDrawControls(); });
on('.mode-field', 'change', () => { state.mode = $('input[name="mode"]:checked').value; updateDrawControls(); });
on('#draw-count', 'click', event => { const button = event.target.closest('[data-count]'); if (!button || button.disabled) return; state.countPerDimension = button.dataset.count === 'random' ? 'random' : Number(button.dataset.count); try { localStorage.setItem('formlex.countPerDimension', String(state.countPerDimension)); } catch { /* The current selection still works without local storage. */ } updateDrawControls(); });
on('#view-mode', 'click', event => { const button = event.target.closest('button[data-framing]'); if (!button || button.disabled) return; state.framing = button.dataset.framing; renderFrame(); });
on('#dimension-index', 'click', event => { const button = event.target.closest('[data-focus]'); if (!button) return; state.focusDimension = button.dataset.focus; state.framing = 'focus'; renderFrame(); });
on('#spacing-mode', 'click', event => { const button = event.target.closest('button[data-spacing]'); if (!button) return; state.spacing = button.dataset.spacing; renderFrame(); });
on('#measure-toggle', 'click', () => { state.measuring = !state.measuring; renderFrame(); });
on('#curate-toggle', 'click', () => { state.curating = !state.curating; renderFrame(); });
on('#inspection-toggle', 'click', () => {
  state.inspecting = !state.inspecting;
  if (!state.inspecting && state.pendingDraw) {
    const { record, input, tool } = state.pendingDraw;
    acceptDraw(record, input, tool);
    state.pendingDraw = null; state.pendingCount = 0;
  }
  updateDrawControls();
});
window.addEventListener('resize', renderMeasurement);
on('#draw-button', 'click', () => performDraw().catch(() => {}));
on('#result-grid', 'click', event => {
  const term = event.target.closest('[data-inspect]');
  if (term) {
    state.activeKeyword = term.dataset.inspect; renderReader();
    const reader = $('#specimen-reader'), bounds = reader.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > innerHeight) reader.scrollIntoView({block:'nearest',behavior:'instant'});
    return;
  }
  const move = event.target.closest('[data-move]');
  if (move && !move.disabled) {
    const order = boardGroups().map(g => g.id), index = order.indexOf(move.dataset.dimension), next = index + Number(move.dataset.move);
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    state.boardOrder = [...order, ...state.boardOrder.filter(d => !order.includes(d))];
    try { localStorage.setItem('formlex.boardOrder', JSON.stringify(state.boardOrder)); } catch { /* Ordering remains usable. */ }
    renderDraw();
    const buttons = $$(`[data-move][data-dimension="${move.dataset.dimension}"]`);
    (buttons.find(b => b.dataset.move === move.dataset.move && !b.disabled) ?? buttons.find(b => !b.disabled))?.focus();
    return;
  }
  const button = event.target.closest('[data-lock], [data-reroll]'); if (!button || button.disabled) return;
  if (button.dataset.lock) {
    const dimension = button.dataset.lock;
    if (state.locked[dimension]) delete state.locked[dimension]; else state.locked[dimension] = state.result.items.filter(k => k.dimension === dimension).map(k => k.id);
    renderDraw(); $(`[data-lock="${dimension}"]`).focus();
  } else return performDraw(drawInput(button.dataset.reroll)).then(() => $(`[data-reroll="${button.dataset.reroll}"]`)?.focus()).catch(() => {});
});
on('#favorite-current', 'click', async () => { $('#favorite-current').disabled = true; try { await toggleFavorite(state.result); } finally { updateFavoriteButton(); } });
on('#copy-text', 'click', () => copy(currentPrompt()));
on('#copy-output', 'click', () => copy($('#output-preview').textContent));
for (const format of ['prompt', 'text', 'json']) on(`#format-${format}`, 'click', () => { state.format = format; renderOutput(); });
on('#brief-task', 'input', () => { state.brief.task = $('#brief-task').value; renderOutput(); });
on('#brief-preserve', 'input', () => { state.brief.preserve = $('#brief-preserve').value; renderOutput(); });
function setReconstruction(value) {
  state.brief.reconstruction = value;
  $$('[data-reconstruction]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.reconstruction === value)));
  $('#reconstruction-clear').disabled = !value;
  $('#reconstruction-hint').textContent = reconstructionLevels.find(level => level.id === value)?.rule ?? '可选。未选择时，复制内容不包含重构强度及档位规则；按原始任务执行。';
  renderOutput();
}
on('#reconstruction-options', 'click', event => { const button = event.target.closest('[data-reconstruction]'); if (button) setReconstruction(button.dataset.reconstruction); });
on('#reconstruction-clear', 'click', () => setReconstruction(''));
on('#priority-reset', 'click', () => {
  state.brief.dimensionPriorities = {}; state.brief.keywordPriorities = {};
  renderPriorities(); renderOutput(); toast('全部恢复普通，所有词条仍须落实');
});
on('#result-grid', 'change', event => {
  const select = event.target.closest('[data-dimension-priority], [data-keyword-priority]');
  if (!select || select.disabled) return;
  if (select.dataset.dimensionPriority) state.brief.dimensionPriorities[select.dataset.dimensionPriority] = priority(select.value).id;
  else if (select.value === 'inherit') delete state.brief.keywordPriorities[select.dataset.keywordPriority];
  else state.brief.keywordPriorities[select.dataset.keywordPriority] = priority(select.value).id;
  renderPriorities(); renderOutput();
});
on('#draw-library', 'change', () => applyLibrary($('#draw-library').value));
on('#library-categories', 'click', async event => {
  const button = event.target.closest('[data-library-category]'); if (!button || state.busy) return;
  const category = button.dataset.libraryCategory;
  if (category === 'personal') {
    const library = state.catalog.libraries.find(l => !l.builtIn && l.id === state.libraryId) ?? state.catalog.libraries.find(l => !l.builtIn);
    if (library) applyLibrary(library.id); else await openCollection();
  } else applyLibrary(category);
});
on('#manage-libraries', 'click', openCollection);
on('#collection-edit-select', 'change', () => {
  const library = state.catalog.libraries.find(l => l.id === $('#collection-edit-select').value);
  state.collectionSelection = new Set(library?.keywordIds ?? []); $('#collection-name').value = library?.name ?? ''; renderCollection();
});
for (const selector of ['#collection-search', '#collection-dimension', '#collection-selected-only']) on(selector, selector === '#collection-search' ? 'input' : 'change', () => { state.collectionLimit = 80; renderCollection(); $('#collection-options').scrollTop = 0; });
on('#collection-options', 'change', event => {
  const input = event.target.closest('input[type="checkbox"]'); if (!input) return;
  if (input.checked) state.collectionSelection.add(input.value); else state.collectionSelection.delete(input.value);
  const id = input.value; renderCollection(!$('#collection-selected-only').checked);
  ($(`#collection-options input[value="${id}"]`) ?? $('#collection-options input') ?? $('#collection-selected-only')).focus();
});
on('#collection-add-filtered', 'click', () => { for (const k of collectionMatches()) state.collectionSelection.add(k.id); renderCollection(); });
on('#collection-clear', 'click', () => { state.collectionSelection.clear(); renderCollection(); });
on('#collection-use-current', 'click', () => { for (const k of poolKeywords()) state.collectionSelection.add(k.id); renderCollection(); });
on('#collection-more', 'click', () => { state.collectionLimit += 80; renderCollection(); });
on('#collection-form', 'submit', event => { event.preventDefault(); return saveCollection(); });
on('#collection-save-copy', 'click', () => saveCollection(true));
on('#collection-delete', 'click', async () => {
  const id = $('#collection-edit-select').value; if (!id || state.collectionBusy) return;
  if (!confirm('删除这份个人词库？其中的词条和已保存快照仍会保留。')) return;
  try { await api(`/api/libraries/${id}`, 'DELETE'); await refreshCatalog(); $('#collection-dialog').close(); renderDraw(); toast('个人词库已删除，词条仍在全部词库中'); }
  catch (error) { showError('#collection-error', error.message); }
});
for (const selector of ['#library-search', '#library-dimension', '#library-source', '#library-temperature']) on(selector, selector === '#library-search' ? 'input' : 'change', () => { state.libraryLimit = 80; renderLibrary(); });
on('#library-more', 'click', () => { state.libraryLimit += 80; renderLibrary(); });
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
on('#edit-dimension', 'change', () => { $('#edit-temperature-field').hidden = $('#edit-dimension').value !== 'color'; });
on('#conflict-search', 'input', renderConflicts);
on('#conflict-options', 'change', event => { const input = event.target; if (input.checked) state.conflictSelection.add(input.value); else state.conflictSelection.delete(input.value); $('#conflict-count').textContent = `${state.conflictSelection.size} 项`; });
on('#refresh-records', 'click', async () => { await refreshRecords(); toast('记录已刷新'); });
for (const kind of ['favorites', 'history']) on(`#show-${kind}`, 'click', () => { state.recordKind = kind; renderRecords(); });
on('#records-list', 'click', async event => {
  const button = event.target.closest('[data-detail], [data-copy-record], [data-favorite]'); if (!button) return;
  const record = recordById(button.dataset.detail ?? button.dataset.copyRecord ?? button.dataset.favorite);
  if (button.dataset.detail) return openRecord(record);
  if (button.dataset.copyRecord) return copy(promptOf(record));
  button.disabled = true; try { await toggleFavorite(record); } finally { button.disabled = false; }
});
on('#copy-record-text', 'click', () => copy(promptOf(state.detail)));
on('#copy-record-raw', 'click', () => copy(textOf(state.detail)));
on('#copy-record-json', 'click', () => copy(JSON.stringify(state.detail, null, 2)));
$$('[data-close]').forEach(button => { button.addEventListener('click', () => $(`#${button.dataset.close}`).close()); });

// Optional browser-agent entry points; HTTP remains available in every supported browser.
async function registerBrowserTools() {
  if (!document.modelContext?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const idMap = { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, uniqueItems: true }] } };
  const definitions = [
    { name: 'read_design_catalog', description: '读取八个常规维度、独立特色池、色温分类及显式互斥关系。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => api('/api/catalog') },
    { name: 'draw_design_inspiration', description: '默认抽取八维，每维 2 条，共 16 条；可选每维度 1–5 条或随机 2–3 条。显式添加 feature 从独立池取 featureCount 条。colorTemperature 严格筛选色彩，成功保存到历史并更新网页。锁定整组保留。', inputSchema: { type: 'object', properties: { libraryId: { type: 'string', default: 'established', description: '已有术语 established；原创灵感 original；个人词库 ID。' }, dimensions: { type: 'array', items: { type: 'string', enum: state.catalog.dimensions.map(d => d.id) }, minItems: 1, maxItems: 9, uniqueItems: true }, mode: { type: 'string', enum: ['coordinated', 'free'] }, countPerDimension: { enum: ['random', 1, 2, 3, 4, 5], default: 2 }, featureCount: { type: 'integer', minimum: 1, maximum: 5, default: 1 }, colorTemperature: { type: 'string', enum: ['random', 'cool', 'warm'], default: 'random' }, locked: idMap, current: idMap }, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: input => performDraw(input, { tool: true }) },
  ];
  for (const definition of definitions) { try { await document.modelContext.registerTool(definition, { signal: lifecycle.signal }); } catch (error) { console.warn('浏览器工具注册不可用；HTTP 接口不受影响。', error); } }
}

async function init() {
  try {
    state.catalog = await api('/api/catalog');
    if (state.catalog.apiVersion !== 4 || !state.catalog.libraries.some(l => l.id === 'established')) throw Error('服务版本需要更新。请关闭旧服务窗口，重新双击桌面的「启动灵感采样.bat」，再刷新页面。');
    state.selected = regularDimensions().map(d => d.id);
    state.boardOrder = state.catalog.dimensions.map(d => d.id);
    try {
      state.libraryId = localStorage.getItem('formlex.libraryId') ?? 'established';
      const savedCount = localStorage.getItem('formlex.countPerDimension');
      state.countPerDimension = ['1','2','3','4','5'].includes(savedCount) ? Number(savedCount) : savedCount === 'random' ? 'random' : 2;
      if (localStorage.getItem('formlex.featureEnabled') === 'true') state.selected.push('feature');
      const featureCount = localStorage.getItem('formlex.featureCount');
      state.featureCount = ['1','2','3','4','5'].includes(featureCount) ? Number(featureCount) : 1;
      const colorTemperature = localStorage.getItem('formlex.colorTemperature');
      state.colorTemperature = ['cool','warm'].includes(colorTemperature) ? colorTemperature : 'random';
      const boardOrder = JSON.parse(localStorage.getItem('formlex.boardOrder') ?? '[]');
      if (Array.isArray(boardOrder)) state.boardOrder = [...new Set([...boardOrder.filter(d => state.boardOrder.includes(d)), ...state.boardOrder])];
    } catch { /* Local storage is optional. */ }
    await refreshCatalog(); await refreshRecords();
    applyLibrary(state.libraryId, true);
    await performDraw().catch(() => {
      $('#result-grid').innerHTML = `<div class="empty-state">${icon('grid')}<h3>调整条件，开始采样</h3><p>检查上方提示，调整维度或词库后重新抽取。</p></div>`;
    });
    await registerBrowserTools();
  } catch (error) {
    showError('#global-error', error.message);
    $('#result-grid').innerHTML = `<div class="empty-state">${icon('grid')}<h3>暂时无法读取词库</h3><p>确认本地服务已启动，然后刷新页面重试。</p></div>`;
  }
}
function setupSurface() {
  const canvas = $('#color-trail'), context = canvas.getContext('2d');
  const surface = $('#trail-surface'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = true, texture = 18, segments = [], frame = 0, presetFrame = 0, previous = null;
  try {
    enabled = localStorage.getItem('formlex.trailEnabled') !== 'false';
    const stored = localStorage.getItem('formlex.texture');
    if (stored !== null && Number.isFinite(Number(stored))) texture = Math.max(0, Math.min(100, Number(stored)));
  } catch { /* Surface preferences are optional. */ }
  const remember = (key, value) => { try { localStorage.setItem(`formlex.${key}`, String(value)); } catch { /* Keep current controls usable. */ } };
  function setTexture(value) {
    document.documentElement.style.setProperty('--texture', String(value / 250));
    $('#texture-strength').value = String(value); $('#texture-value').textContent = `${value}%`;
  }
  setTexture(texture);
  on('#texture-strength', 'input', () => { texture = Number($('#texture-strength').value); setTexture(texture); remember('texture', texture); });
  if (!context) { $('#trail-enabled').disabled = true; $('#trail-preview').disabled = true; $('#trail-clear').disabled = true; $('#trail-status').textContent = '此浏览器无法绘制色迹，纸面纹理仍可调节。'; return; }
  function clear() {
    cancelAnimationFrame(frame); cancelAnimationFrame(presetFrame); frame = presetFrame = 0;
    segments = []; previous = null; context.clearRect(0, 0, canvas.width, canvas.height);
  }
  function resize() {
    clear(); const ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.ceil(innerWidth * ratio); canvas.height = Math.ceil(innerHeight * ratio);
    canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`; context.setTransform(ratio,0,0,ratio,0,0);
  }
  function render(now) {
    frame = 0; context.clearRect(0,0,canvas.width,canvas.height);
    segments = segments.filter(s => s.static || now - s.time < 1100);
    for (const s of segments) {
      const opacity = s.static ? .42 : .55 * Math.max(0, 1 - (now - s.time) / 1100);
      const color = `hsla(${s.hue},78%,58%,${opacity})`;
      context.beginPath(); context.moveTo(s.x1,s.y1); context.lineTo(s.x2,s.y2);
      context.lineWidth = 10; context.lineCap = 'round'; context.strokeStyle = color;
      context.shadowColor = color; context.shadowBlur = 12; context.stroke();
    }
    if (segments.some(s => !s.static)) frame = requestAnimationFrame(render);
  }
  function add(x1,y1,x2,y2,time,staticTrail = false,index = 0) {
    segments.push({x1,y1,x2,y2,time,static:staticTrail,hue:195 + (index % 50)});
    if (segments.length > 110) segments.splice(0,segments.length - 110);
    if (!frame) frame = requestAnimationFrame(render);
  }
  function update() {
    $('#trail-enabled').checked = enabled; $('#trail-preview').disabled = !enabled;
    surface.classList.toggle('drawing-enabled', enabled && !reduced.matches);
    $('#trail-status').textContent = !enabled ? '色迹已关闭。开启后可使用鼠标、触屏或预设轨迹。' : reduced.matches ? '已停用动态跟随；预设只绘制静态色迹，可随时清空。' : '轻划鼠标，色迹约一秒后消散。触屏请在顶部试验区绘画，键盘可选预设。';
  }
  on('#trail-enabled', 'change', () => { enabled = $('#trail-enabled').checked; clear(); remember('trailEnabled', enabled); update(); });
  on('#trail-clear', 'click', () => { clear(); update(); $('#trail-status').textContent = '色迹已清空。' + $('#trail-status').textContent; });
  document.addEventListener('pointermove', event => {
    if (!enabled || reduced.matches || document.hidden || $('dialog[open]')) { previous = null; return; }
    if (event.pointerType !== 'mouse' && (!surface.contains(event.target) || !event.buttons)) { previous = null; return; }
    const time = performance.now(), point = {x:event.clientX,y:event.clientY,time,id:event.pointerId};
    if (previous && previous.id === point.id && time - previous.time < 160 && Math.hypot(point.x-previous.x,point.y-previous.y) < 140) add(previous.x,previous.y,point.x,point.y,time,false,Math.floor(time / 12));
    previous = point;
  }, {passive:true});
  surface.addEventListener('pointerdown', event => { if (enabled && !reduced.matches) { surface.setPointerCapture(event.pointerId); previous = {x:event.clientX,y:event.clientY,time:performance.now(),id:event.pointerId}; } });
  surface.addEventListener('pointerup', () => { previous = null; });
  surface.addEventListener('pointercancel', () => { previous = null; });
  on('#trail-preview', 'click', () => {
    if (!enabled) return;
    clear(); surface.scrollIntoView({block:'center',behavior:'instant'});
    presetFrame = requestAnimationFrame(() => {
      presetFrame = 0; if (!enabled || document.hidden) return;
      const rect = surface.getBoundingClientRect(), cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      const w = Math.min(rect.width * .4, 145), h = rect.height * .34, time = performance.now();
      const points = Array.from({length:65}, (_,i) => {
        const t = i / 64;
        if ($('#trail-preset').value === 'wave') return [cx + (2*t-1)*w,cy + Math.sin(t * Math.PI * 3)*h];
        if ($('#trail-preset').value === 'arc') return [cx + (2*t-1)*w*.65,cy + h - Math.sin(Math.PI*t)*h*2];
        return [cx + Math.cos(t*Math.PI*2)*w,cy + Math.sin(t*Math.PI*2)*h - Math.cos(t*Math.PI*2)*h*.35];
      });
      for (let i=1;i<points.length;i++) add(...points[i-1],...points[i],time,reduced.matches,i);
      $('#trail-status').textContent = reduced.matches ? '静态预设已绘制，可清空或改选另一条轨迹。' : '预设色迹已绘制，约一秒后消散。';
    });
  });
  reduced.addEventListener('change', () => { clear(); update(); });
  window.addEventListener('resize', resize);
  window.addEventListener('scroll', () => { if (!presetFrame) clear(); }, {passive:true});
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  window.addEventListener('pagehide', clear);
  resize(); update();
}
setupSurface();
if (matchMedia('(max-width: 900px)').matches) $('#controls-drawer').open = false;
await init();
