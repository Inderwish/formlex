import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dimensions, keywords } from './seed.mjs';
import { draw } from './core.mjs';
import { priorities, requirements, implementation, conflictRules, verification, sharedSkillRules, effectivePriority, retainKeywordPriorities, orderedGroups, buildDesignPrompt } from './public/design-rules.mjs';

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
    assert.ok(text.includes(`（${k.id}；`));
  }
  for (const section of [requirements, implementation, conflictRules, verification]) assert.ok(text.includes(section));
  assert.ok(text.indexOf('### 材质') < text.indexOf('### 风格'));
  assert.ok(text.includes('冷蓝（c1；重点；单独设置）'));
  assert.ok(text.includes('网站特色：独立全局词池 · 1 条'));
  assert.equal(text.includes('runtime/cli.mjs'), false);
  const skill = readFileSync(new URL('./plugins/formlex/skills/formlex-design/SKILL.md', import.meta.url), 'utf8');
  assert.ok(skill.includes(sharedSkillRules()), '插件 Skill 必须嵌入完整的同一份规则');
});

test('旧记录与记录页默认普通，无当前任务和权重污染；最大抽取组合无遗漏', () => {
  const old = { ...record }; delete old.colorTemperature; delete old.featureSource;
  const normal = buildDesignPrompt(old, dimensions);
  for (const k of items) assert.ok(normal.includes(`（${k.id}；普通；跟随维度）`));
  const current = buildDesignPrompt(record, dimensions, { task: '只在本页出现的任务', dimensionPriorities: { style: 'dominant' } });
  assert.notEqual(current, normal); assert.ok(!normal.includes('只在本页出现的任务'));
  const full = draw(keywords, { dimensions: dimensions.map(d => d.id), countPerDimension: 5, featureCount: 5, mode: 'free' });
  const before = structuredClone(full);
  const prompt = buildDesignPrompt(full, dimensions);
  assert.equal(full.items.length, 45);
  for (const k of full.items) assert.ok(prompt.includes(`（${k.id}；普通；跟随维度）\n${k.description}`));
  assert.deepEqual(full, before);
  assert.deepEqual(priorities.map(p => p.name), ['普通', '重点', '主导']);
});

test('同一记录有不同编排时独立生成，普通覆盖和特殊字符原样保留', () => {
  const custom = { ...record, items: [{ id: 'custom', dimension: 'style', name: '<重点> & 标题', description: '第一行\n第二行：<script>只是文本</script>' }] };
  const text = buildDesignPrompt(custom, dimensions, { task: '<b>任务</b>', dimensionPriorities: { style: 'dominant' }, keywordPriorities: { custom: 'normal' } });
  assert.ok(text.includes('维度权重：主导'));
  assert.ok(text.includes('（custom；普通；单独设置）'));
  assert.ok(text.includes(custom.items[0].description));
  assert.ok(buildDesignPrompt(custom, dimensions).includes('（custom；普通；跟随维度）'));
});

process.on('exit', code => { if (code === 0) console.log('DONE'); });
