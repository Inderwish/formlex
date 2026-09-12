import { dimensions, defaultDimensions } from './seed.mjs';
import { AppError, object, temperatures } from './core.mjs';
import { listLibraries } from './libraries.mjs';

export function createCatalog(state) {
  return { apiVersion: 4, dimensions, keywords: state.keywords, libraries: listLibraries(state),
    featurePool: { source: 'global', dimension: 'feature', count: state.keywords.filter(k => k.dimension === 'feature').length } };
}

export function librarySummary(catalog) {
  return { dimensions: catalog.dimensions, featurePool: catalog.featurePool, libraries: catalog.libraries.map(library => {
    const ids = new Set(library.keywordIds);
    const counts = Object.fromEntries(defaultDimensions.map(d => [d.id, 0]));
    const temperatureCounts = Object.fromEntries(temperatures.map(t => [t, 0]));
    for (const keyword of catalog.keywords) if (ids.has(keyword.id)) {
      counts[keyword.dimension]++;
      if (keyword.dimension === 'color') temperatureCounts[keyword.temperature ?? 'unspecified']++;
    }
    return { id: library.id, name: library.name, description: library.description ?? '', builtIn: library.builtIn, count: library.keywordIds.length, counts, temperatureCounts };
  }) };
}

export function searchKeywords(catalog, args) {
  if (!object(args) || Object.keys(args).some(key => !['libraryId', 'dimension', 'temperature', 'query', 'limit', 'offset'].includes(key))) throw new AppError(400, '搜索参数必须为对象，且只能包含声明的字段。');
  const { libraryId = 'all', dimension, temperature, query = '', limit = 30, offset = 0 } = args;
  if (temperature !== undefined && (!temperatures.includes(temperature) || (dimension !== undefined && dimension !== 'color'))) throw new AppError(400, 'temperature 只可筛选色彩维度，且必须使用有效分类。');
  if (typeof libraryId !== 'string' || (dimension !== undefined && !dimensions.some(d => d.id === dimension)) || typeof query !== 'string' || query.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError(400, '搜索参数无效：维度须有效，query 最多 160 字，limit 为 1–100 的整数，offset 为非负整数。');
  const library = catalog.libraries.find(l => l.id === libraryId);
  if (!library) throw new AppError(400, '词库已失效，请重新查询词库列表。');
  const ids = new Set(library.keywordIds); const needle = query.trim().toLocaleLowerCase();
  const matches = catalog.keywords.filter(k => (dimension === 'feature' ? k.dimension === 'feature' : ids.has(k.id)) && (!dimension || k.dimension === dimension) && (temperature === undefined || (k.dimension === 'color' && (k.temperature ?? 'unspecified') === temperature)) && `${k.name} ${k.description}`.toLocaleLowerCase().includes(needle));
  return { library: dimension === 'feature' ? null : { id: library.id, name: library.name }, source: dimension === 'feature' ? 'global' : 'library', total: matches.length, offset, limit, nextOffset: offset + limit < matches.length ? offset + limit : null, keywords: matches.slice(offset, offset + limit) };
}
