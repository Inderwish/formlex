import membership from './seed-membership.json' with { type: 'json' };

export const themes = [
  { id: 'classical', name: '古典与装饰', description: '从建筑秩序、历史装饰与珠宝工艺提取华丽而有章法的构成。' },
  { id: 'eastern', name: '东方与书写', description: '以笔墨、书卷、园林与东亚工艺组织留白、节奏和触感。' },
  { id: 'rational', name: '理性与系统', description: '探索网格、测量、信息秩序和几何结构的精确表达。' },
  { id: 'playful', name: '波普与游乐', description: '用漫画、玩具、商业印刷与舞台语言形成鲜明的视觉性格。' },
  { id: 'raw', name: '粗粝与反叛', description: '从独立出版、街头图形和未修饰材料中寻找直接的表达。' },
  { id: 'organic', name: '自然与生长', description: '借助生态结构、自然色谱和生长节奏建立有机界面。' },
  { id: 'digital', name: '数字与异境', description: '从早期网络、电子影像和虚拟空间探索鲜明的数字美学。' },
  { id: 'craft', name: '手工与民艺', description: '把织造、陶艺、版画和装帧中的工序与材料转为界面线索。' },
  { id: 'cinematic', name: '影像与叙事', description: '使用镜头、场面调度、照明和剪辑组织页面的阅读节奏。' },
  { id: 'experimental', name: '实验与观念', description: '以过程、规则、空间与观念艺术探索不同寻常的信息表达。' },
];

export function listLibraries(state) {
  const present = new Set(state.keywords.filter(k => k.dimension !== 'feature').map(k => k.id));
  const builtIn = (id, name, description, matches) => ({ id, name, description, builtIn: true,
    keywordIds: state.keywords.filter(k => k.dimension !== 'feature' && matches(k)).map(k => k.id) });
  const legacy = [
    builtIn('all', '全部常规词库', '包含前八维全部词条；特色使用独立全局词池。', () => true),
    builtIn('foundation', '基础与混合', '涵盖多种设计方向的通用词汇，适合跨风格探索。', k => membership.foundation.includes(k.id)),
    ...themes.map(theme => builtIn(theme.id, theme.name, theme.description, k => membership[theme.id].includes(k.id))),
  ];
  return [
    builtIn('established', '已有术语', '有具体参考出处的专业概念；前端应用建议由 FormLex 整理。', k => k.origin === 'established'),
    builtIn('original', '原创灵感', 'FormLex 编排的设计方案；借用的基础概念与材料并非声称由 FormLex 发明。', k => k.origin === 'original'),
    ...legacy.map(library => ({ ...library, legacy: true })),
    ...(state.libraries ?? []).map(library => ({ ...library, builtIn: false, keywordIds: library.keywordIds.filter(id => present.has(id)) })),
  ];
}
