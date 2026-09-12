import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync, copyFileSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { dimensions, keywords as seed, seedRevision, expansionConflicts } from './seed.mjs';

export class AppError extends Error {
  constructor(status, message, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}
const bad = message => { throw new AppError(400, message); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dimensionIds = dimensions.map(d => d.id);
const dimensionName = id => dimensions.find(d => d.id === id)?.name ?? id;
export const conflicts = (a, b) => a.conflicts.includes(b.id) || b.conflicts.includes(a.id);
const clone = value => structuredClone(value);

export function validateKeyword(value, all, id) {
  if (!object(value)) bad('词条必须为 JSON 对象。');
  if (!dimensionIds.includes(value.dimension)) bad('请选择有效维度。');
  for (const [key, label, max] of [['name', '关键词', 80], ['description', '设计说明', 2000]]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > max) bad(`${label}不能为空，且不能超过 ${max} 字。`);
  }
  if (!Array.isArray(value.conflicts) || new Set(value.conflicts).size !== value.conflicts.length) bad('互斥词条必须为不重复的 ID 数组。');
  if (value.conflicts.some(other => other === id || !all.some(k => k.id === other))) bad('互斥关系包含自身或失效词条，请重新加载词库。');
  return { id, dimension: value.dimension, name: value.name.trim(), description: value.description.trim(), conflicts: [...value.conflicts] };
}

function validateSnapshot(record) {
  if (!object(record) || typeof record.id !== 'string' || !record.id || !Number.isFinite(Date.parse(record.createdAt)) ||
      !['coordinated', 'free'].includes(record.mode) || !Array.isArray(record.items) || !record.items.length ||
      typeof record.text !== 'string' || !Array.isArray(record.warnings) || record.warnings.some(x => typeof x !== 'string')) throw Error('记录格式错误');
  const seen = new Set(); const counts = new Map();
  for (const k of record.items) {
    if (!object(k) || !dimensionIds.includes(k.dimension) || seen.has(k.id) || typeof k.id !== 'string' ||
        !k.id || typeof k.name !== 'string' || typeof k.description !== 'string' || !Array.isArray(k.conflicts) ||
        k.conflicts.some(x => typeof x !== 'string')) throw Error('记录词条格式错误');
    seen.add(k.id); counts.set(k.dimension, (counts.get(k.dimension) ?? 0) + 1);
    if (counts.get(k.dimension) > 3) throw Error('同一维度最多保留三条词条');
  }
}

export function validateState(state) {
  if (!object(state) || ![1, 2].includes(state.version) || (state.seedRevision !== undefined && (!Number.isInteger(state.seedRevision) || state.seedRevision < 1 || state.seedRevision > seedRevision)) || !Array.isArray(state.keywords) || !Array.isArray(state.history) ||
      !Array.isArray(state.favorites) || state.history.length > 100) throw Error('数据结构错误');
  const ids = new Set();
  for (const k of state.keywords) {
    if (!object(k) || typeof k.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(k.id) || ids.has(k.id)) throw Error('词条 ID 错误');
    ids.add(k.id);
    validateKeyword(k, state.keywords, k.id);
  }
  for (const group of [state.history, state.favorites]) {
    const recordIds = new Set();
    for (const record of group) { validateSnapshot(record); if (recordIds.has(record.id)) throw Error('记录 ID 重复'); recordIds.add(record.id); }
  }
}

export function atomicWrite(file, state) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temp, 'wx');
    writeFileSync(descriptor, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temp, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function upgradeState(previous) {
  if (previous.version === 2 && previous.seedRevision === seedRevision) return previous;
  const next = clone(previous);
  const present = new Set(next.keywords.map(k => k.id));
  // Only the newly introduced seed range is merged; deleted original entries stay deleted.
  for (const keyword of seed) if (Number(keyword.id.split('-')[1]) >= 21 && !present.has(keyword.id)) {
    next.keywords.push(clone(keyword)); present.add(keyword.id);
  }
  const byId = new Map(next.keywords.map(k => [k.id, k]));
  const original = new Map(seed.map(k => [k.id, k]));
  for (const keyword of next.keywords) keyword.conflicts = keyword.conflicts.filter(id => present.has(id));
  for (const [left, right] of expansionConflicts) {
    const a = byId.get(left); const b = byId.get(right);
    // Keep custom text and its chosen constraints; extend rules only for unchanged seed terms.
    if (a && b && [a, b].every(k => k.name === original.get(k.id)?.name && k.description === original.get(k.id)?.description) && !a.conflicts.includes(right)) a.conflicts.push(right);
  }
  next.version = 2; next.seedRevision = seedRevision;
  validateState(next); return next;
}

export function openStore(file, write = atomicWrite) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); validateState(state); }
  catch (error) {
    if (error.code !== 'ENOENT') throw Error(`本地数据无法读取：${error.message}。原文件已保留，请修复或备份后重试。`);
    state = { version: 2, seedRevision, keywords: clone(seed), history: [], favorites: [] };
    mkdirSync(dirname(file), { recursive: true }); write(file, state);
  }
  const migrated = upgradeState(state);
  if (migrated !== state) {
    try { copyFileSync(file, `${file}.before-v2.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw Error('无法备份旧数据，升级未提交，请检查数据目录权限。'); }
    try { write(file, migrated); } catch { throw Error('无法保存升级后的词库，原数据已保留，请检查磁盘与目录权限。'); }
    state = migrated;
  }
  return {
    get state() { return state; },
    transact(action) {
      // ponytail: synchronous snapshots fit a personal 100-record tool; use SQLite for a shared or larger service.
      const next = clone(state);
      const result = action(next);
      try { write(file, next); } catch { throw new AppError(500, '保存失败，修改未提交。请检查数据目录权限和磁盘空间后重试。', 'SAVE_FAILED'); }
      state = next;
      return result;
    },
  };
}

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) { const j = randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

export function draw(all, input, maxNodes = 50000) {
  if (!object(input)) bad('抽取参数必须为 JSON 对象。');
  const selected = input.dimensions ?? dimensionIds;
  const mode = input.mode ?? 'coordinated';
  const countPerDimension = input.countPerDimension ?? 'random';
  if (!Array.isArray(selected) || !selected.length || selected.length > 8 || selected.some(d => !dimensionIds.includes(d)) || new Set(selected).size !== selected.length) bad('请选择一到八个不重复的有效维度。');
  if (!['coordinated', 'free'].includes(mode)) bad('模式必须为 coordinated 或 free。');
  if (!['random', 1, 2, 3].includes(countPerDimension)) bad('countPerDimension 必须为 random、1、2 或 3。');
  const byId = new Map(all.map(k => [k.id, k]));
  function normalize(map) {
    if (!object(map)) bad('locked 和 current 必须为「维度 ID: 词条 ID 数组」对象。');
    const result = {};
    for (const [dim, value] of Object.entries(map)) {
      if (!selected.includes(dim)) bad('锁定或当前结果包含未启用维度。');
      const ids = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length) bad('每个维度应包含一到三个不重复的词条 ID。');
      if (ids.some(id => typeof id !== 'string' || byId.get(id)?.dimension !== dim)) bad('引用的词条已失效或维度不符，请重新加载词库。');
      result[dim] = ids;
    }
    return result;
  }
  const locked = normalize(input.locked ?? {}); const current = normalize(input.current ?? {});
  const fixed = Object.values(locked).flat().map(id => byId.get(id));
  const pending = dimensionIds.filter(d => selected.includes(d) && !Object.hasOwn(locked, d));
  if (!pending.length) bad('全部维度已锁定，请至少解锁一个维度。');
  if (mode === 'coordinated') for (let i = 0; i < fixed.length; i++) for (const other of fixed.slice(i + 1)) {
    if (conflicts(fixed[i], other)) throw new AppError(409, `锁定的「${fixed[i].name}」与「${other.name}」互斥，请先解锁其中一项。`, 'LOCK_CONFLICT');
  }
  const counts = new Map();
  const pools = new Map(pending.map(dim => {
    let pool = shuffle(all.filter(k => k.dimension === dim));
    if (!pool.length) throw new AppError(409, `「${dimensionName(dim)}」词库为空，请添加词条或取消该维度。`, 'EMPTY_DIMENSION');
    if (mode === 'coordinated') pool = pool.filter(k => fixed.every(f => !conflicts(k, f)));
    const count = countPerDimension === 'random' ? (pool.length >= 3 ? randomInt(2, 4) : 2) : countPerDimension;
    if (pool.length < count) throw new AppError(409, `「${dimensionName(dim)}」在当前条件下只有 ${pool.length} 条候选，无法抽取 ${count} 条。请补充词库、减少锁定或调整数量。`, 'INSUFFICIENT_CANDIDATES');
    counts.set(dim, count);
    pool.sort((a, b) => Number(current[dim]?.includes(a.id) ?? false) - Number(current[dim]?.includes(b.id) ?? false));
    return [dim, pool];
  }));
  let chosen;
  if (mode === 'free') chosen = [...fixed, ...pending.flatMap(dim => pools.get(dim).slice(0, counts.get(dim)))];
  else {
    const order = [...pending].sort((a, b) => pools.get(a).length - counts.get(a) - (pools.get(b).length - counts.get(b)));
    const novel = (dim, k) => Boolean(current[dim]) && !current[dim].includes(k.id);
    const possibleNew = order.map(dim => Math.min(counts.get(dim), pools.get(dim).filter(k => novel(dim, k)).length));
    let nodes = 0;
    const working = [...fixed];
    function budget() {
      if (++nodes > maxNodes) throw new AppError(409, '已达到搜索上限，暂未找到满足条件的组合。请减少锁定项、数量或参与维度后重试；这不代表组合一定不存在。', 'SEARCH_LIMIT');
    }
    function search(index, start, remaining, changes, target) {
      budget();
      if (index === order.length) { if (changes < target) return false; chosen = [...working]; return true; }
      const dim = order[index];
      if (remaining === 0) return search(index + 1, 0, counts.get(order[index + 1]) ?? 0, changes, target);
      const pool = pools.get(dim);
      if (pool.length - start < remaining) return false;
      const upper = Math.min(remaining, pool.slice(start).filter(k => novel(dim, k)).length) + possibleNew.slice(index + 1).reduce((a, b) => a + b, 0);
      if (changes + upper < target) return false;
      for (let j = start; j <= pool.length - remaining; j++) {
        budget(); const candidate = pool[j];
        if (working.some(k => conflicts(k, candidate))) continue;
        working.push(candidate);
        if (search(index, j + 1, remaining - 1, changes + Number(novel(dim, candidate)), target)) return true;
        working.pop();
      }
      return false;
    }
    for (let target = possibleNew.reduce((a, b) => a + b, 0); target >= 0 && !chosen; target--) search(0, 0, counts.get(order[0]), 0, target);
    if (!chosen) throw new AppError(409, '当前维度和锁定条件下没有满足互斥规则的组合。请调整条件后重试。', 'NO_COMBINATION');
  }
  const items = clone(dimensionIds.filter(d => selected.includes(d)).flatMap(d => chosen.filter(k => k.dimension === d)));
  const warnings = pending.flatMap(d => {
    const retained = items.filter(k => k.dimension === d && current[d]?.includes(k.id));
    return retained.length ? [`「${dimensionName(d)}」为满足当前数量与约束，保留了 ${retained.length} 条：${retained.map(k => k.name).join('、')}。`] : [];
  });
  const label = mode === 'coordinated' ? '协调模式' : '自由模式';
  return { id: randomUUID(), createdAt: new Date().toISOString(), mode, countPerDimension, items, warnings,
    text: `设计灵感 · ${label}\n将同一维度的术语作为可组合的灵感线索，结合任务确定主次与应用范围。\n\n` + dimensionIds.filter(d => selected.includes(d)).map(d => `${dimensionName(d)}\n` + items.filter(k => k.dimension === d).map(k => `• ${k.name}\n  ${k.description}`).join('\n')).join('\n\n') };
}

export function mutateKeyword(state, method, id, body) {
  const index = state.keywords.findIndex(k => k.id === id);
  if (method !== 'POST' && index < 0) throw new AppError(404, '词条不存在，请重新加载词库。', 'NOT_FOUND');
  if (method === 'DELETE') {
    state.keywords.splice(index, 1);
    for (const k of state.keywords) k.conflicts = k.conflicts.filter(other => other !== id);
    return { deleted: id };
  }
  if (!object(body)) bad('词条参数必须为 JSON 对象。');
  if (Object.hasOwn(body, 'id')) bad('词条 ID 由服务生成且不能修改。');
  const nextId = method === 'POST' ? randomUUID() : id;
  const previous = method === 'POST' ? { conflicts: [] } : state.keywords[index];
  const effective = state.keywords.filter(k => k.id !== nextId && (k.conflicts.includes(nextId) || previous.conflicts.includes(k.id))).map(k => k.id);
  const next = validateKeyword({ ...previous, conflicts: effective, ...body }, state.keywords, nextId);
  // Store edited relations in one direction, clearing old inbound edges so deselection really removes a relation.
  for (const k of state.keywords) k.conflicts = k.conflicts.filter(other => other !== nextId);
  if (method === 'POST') state.keywords.push(next); else state.keywords[index] = next;
  return next;
}

export { dimensions };
