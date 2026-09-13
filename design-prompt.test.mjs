import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dimensions, keywords } from './seed.mjs';
import { draw } from './core.mjs';
import { priorities, requirements, implementation, conflictRules, verification, sharedSkillRules, effectivePriority, retainKeywordPriorities, orderedGroups, buildDesignPrompt, buildKeywordText, reconstructionLevels, reconstructionRules } from './public/design-rules.mjs';

const items = [
  { id: 's1', dimension: 'style', name: '未来派', description: '以斜向构图组织主要内容。' },
  { id: 's2', dimension: 'style', name: '侘寂', description: '用安静留白组织阅读区。' },
  { id: 'c1', dimension: 'color', name: '冷蓝', description: '冷蓝用于交互强调。' },
  { id: 'm1', dimension: 'material', name: '液态金属', description: '金属表面有流动的反射与柔性轮廓。' },
  { id: 'f1', dimension: 'feature', name: '可拖拽画布', description: '拖拽改变视图位置，键盘提供等效操作。' },
];
const record = { id: 'snapshot', mode: 'coordinated', items, createdAt: '2026-09-13T00:00:00Z', text: '原始快照', warnings: [], colorTemperature: 'cool', featureSource: 'global' };

test('设计权重继承、显式覆盖与移除词条清理，不改变快照或草稿', () => {
  const draft = { dimensionPriorities: { style: 'dominant', material: 'emphasis' }, keywordPriorities: { s1: 'normal', s2: 'emphasis' }, dimensionOrder: ['color', 'material', 'style', 'feature'] };
  const before = structuredClone({ record, draft });
  assert.equal(effectivePriority(items[0], draft), 'normal');
  assert.equal(effectivePriority(items[3], draft), 'emphasis');
  const follow = { ...draft, keywordPriorities: {} };
  assert.equal(effectivePriority(items[0], follow), 'dominant');
  const groups = orderedGroups(record, dimensions, draft);
  assert.deepEqual(groups.map(g => g.id), ['style', 'material', 'color', 'feature']);
  assert.deepEqual(groups[0].items.map(k => k.id), ['s2', 's1']);
  assert.deepEqual(orderedGroups(record, dimensions, { dimensionOrder: ['feature', 'color'] }).map(g => g.id), ['feature', 'color', 'style', 'material']);
  assert.deepEqual(retainKeywordPriorities({ s1: 'dominant', s2: 'normal', removed: 'emphasis' }, [items[0], items[2]]), { s1: 'dominant' });
  assert.deepEqual({ record, draft }, before);
});

test('完整提示词保留每条说明及优先级，共用规则完整包含且不混入插件操作', () => {
  const draft = { task: '离线掌机菜单。品牌色 #123456，保留键盘操作。', dimensionPriorities: { material: 'dominant', feature: 'dominant' }, keywordPriorities: { c1: 'emphasis' } };
  const text = buildDesignPrompt(record, dimensions, draft);
  assert.ok(text.includes(draft.task));
  for (const k of items) {
    assert.equal(text.split(k.description).length - 1, 1, `完整保留一次说明：${k.id}`);
    assert.ok(text.includes(`• ${k.name}（`));
  }
  for (const section of [requirements, implementation, conflictRules, verification]) assert.ok(text.includes(section));
  assert.ok(text.indexOf('## 材质') < text.indexOf('## 风格'));
  assert.ok(text.includes('冷蓝（重点）'));
  assert.equal(text.includes('runtime/cli.mjs'), false);
  const skill = readFileSync(new URL('./plugins/formlex/skills/formlex-design/SKILL.md', import.meta.url), 'utf8');
  assert.ok(skill.includes(sharedSkillRules()), '插件 Skill 必须嵌入完整的同一份规则');
});

test('旧记录与记录页默认普通，无当前任务和权重污染；最大抽取组合无遗漏', () => {
  const old = { ...record }; delete old.colorTemperature; delete old.featureSource;
  const normal = buildDesignPrompt(old, dimensions);
  for (const k of items) assert.ok(normal.includes(`${k.name}（普通）`));
  const current = buildDesignPrompt(record, dimensions, { task: '只在本页出现的任务', dimensionPriorities: { style: 'dominant' } });
  assert.notEqual(current, normal); assert.ok(!normal.includes('只在本页出现的任务'));
  const full = draw(keywords, { dimensions: dimensions.map(d => d.id), countPerDimension: 5, featureCount: 5, mode: 'free' });
  const before = structuredClone(full);
  const prompt = buildDesignPrompt(full, dimensions);
  assert.equal(full.items.length, 45);
  for (const k of full.items) assert.ok(prompt.includes(`${k.name}（普通）\n${k.description}`));
  assert.deepEqual(full, before);
  assert.deepEqual(priorities.map(p => p.name), ['普通', '重点', '主导']);
});

test('同一记录有不同编排时独立生成，普通覆盖和特殊字符原样保留', () => {
  const custom = { ...record, items: [{ id: 'custom', dimension: 'style', name: '<重点> & 标题', description: '第一行\n第二行：<script>只是文本</script>' }] };
  const text = buildDesignPrompt(custom, dimensions, { task: '<b>任务</b>', dimensionPriorities: { style: 'dominant' }, keywordPriorities: { custom: 'normal' } });
  assert.ok(text.includes('风格 · 主导'));
  assert.ok(text.includes(`${custom.items[0].name}（普通）`));
  assert.ok(text.includes(custom.items[0].description));
  assert.ok(buildDesignPrompt(custom, dimensions).includes(`${custom.items[0].name}（普通）`));
});

test('面向 agent 的文本只输出设计信息，不泄露抽取元数据且保留设计数值与原始快照', () => {
  const snapshot = { ...record, id: 'record-internal-41', library: { id: 'all', name: '仅供工具识别的词库' },
    featureCount: 1, countPerDimension: 5, featureSource: '独立全局词池',
    items: [
      { id: 'style-63', dimension: 'style', name: '十二栏构图', description: '使用 12 栏，标题 36px，正文色 #123456。' },
      { id: 'interact-41', dimension: 'interaction', name: '延迟预览', description: '停留 200ms 后显示预览，支持键盘焦点。' },
      items[4],
    ] };
  const before = JSON.stringify(snapshot);
  const task = '构建 3 个页面，内容宽度 1280px。';
  const prompt = buildDesignPrompt(snapshot, dimensions, { task, dimensionPriorities: { style: 'dominant' } });
  const plain = buildKeywordText(snapshot, dimensions);
  for (const text of [prompt, plain]) {
    for (const k of snapshot.items) {
      assert.ok(text.includes(k.name));
      assert.ok(text.includes(k.description));
      assert.ok(!text.includes(k.id));
    }
    for (const metadata of [snapshot.id, snapshot.createdAt, snapshot.library.name, snapshot.featureSource, '完整设计词条', '模式：', '色彩筛选：', '共 3 条']) assert.ok(!text.includes(metadata), metadata);
    for (const name of ['风格', '交互', '特色']) assert.ok(text.includes(name));
  }
  assert.ok(prompt.includes(task));
  assert.ok(!plain.includes(task));
  assert.equal(JSON.stringify(snapshot), before);
  assert.ok(before.includes('style-63'));
  assert.equal(buildKeywordText({ ...snapshot, items: [] }, dimensions), '');
});

test('四档强度只展开所选规则；未选或清除不复制强度，保留范围独立生效且不污染记录', () => {
  const before = structuredClone(record);
  const preserve = '保留品牌色 #123456、16px 正文及既有支付能力。\n允许调整导航布局。';
  for (const level of reconstructionLevels) {
    const draft = { reconstruction: level.id, preserve, dimensionPriorities: { material: 'dominant' } };
    const text = buildDesignPrompt(record, dimensions, draft);
    assert.ok(text.includes(`## 重构强度\n\n${level.name}\n${level.rule}`));
    assert.ok(text.includes(reconstructionRules));
    assert.ok(text.includes(preserve));
    assert.ok(text.includes('液态金属（主导）'));
    for (const other of reconstructionLevels.filter(other => other.id !== level.id)) assert.ok(!text.includes(other.rule));
    for (const k of record.items) assert.ok(text.includes(k.description));
  }
  const empty = buildDesignPrompt(record, dimensions);
  assert.ok(!empty.includes('重构强度'));
  assert.ok(!empty.includes(reconstructionRules));
  assert.ok(!empty.includes('必须保留：'));
  assert.ok(!empty.includes(preserve));
  for (const level of reconstructionLevels) assert.ok(!empty.includes(level.rule));
  assert.equal(buildDesignPrompt(record, dimensions, { reconstruction: 'obsolete' }), empty);
  assert.equal(buildDesignPrompt(record, dimensions, { reconstruction: '' }), empty);
  const preserveOnly = buildDesignPrompt(record, dimensions, { preserve });
  assert.ok(preserveOnly.includes(`必须保留：${preserve}`));
  assert.ok(!preserveOnly.includes('重构强度'));
  assert.equal(buildKeywordText(record, dimensions).includes(preserve), false);
  assert.deepEqual(record, before);
});

process.on('exit', code => { if (code === 0) console.log('DONE'); });
