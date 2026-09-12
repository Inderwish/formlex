import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { sharedSkillRules } from '../public/design-rules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const pluginRoot = join(root, 'plugins', 'formlex');
export const generatedFiles = [
  ...['cli.mjs', 'catalog.mjs', 'workspace.mjs', 'mcp.mjs', 'core.mjs', 'libraries.mjs',
    'seed.mjs', 'seed-extra.mjs', 'seed-palette.mjs', 'seed-features.mjs', 'seed-membership.json']
    .map(file => [file, `runtime/${file}`]),
  ['public/favicon.svg', 'assets/icon.svg'],
  ['preview/desktop.png', 'assets/workbench.png'],
  ['docs/cli.md', 'docs/cli.md'],
  ['public/design-rules.mjs', 'runtime/design-rules.mjs'],
];

export function buildPlugin({ check = false } = {}) {
  const expected = new Set(generatedFiles.filter(([, target]) => target.startsWith('runtime/')).map(([, target]) => target.slice(8)));
  let runtimeFiles = [];
  try { runtimeFiles = readdirSync(join(pluginRoot, 'runtime')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (runtimeFiles.some(file => !expected.has(file))) throw Error('runtime 中存在非生成文件，请人工检查后移出；不会自动删除。');
  const template = readFileSync(join(root, 'scripts/formlex-design.template.md'), 'utf8');
  if (template.split('{{DESIGN_RULES}}').length !== 2) throw Error('Skill 模板必须恰好包含一个规则插入点。');
  const outputs = [...generatedFiles.map(([source, target]) => [target, readFileSync(join(root, source))]),
    ['skills/formlex-design/SKILL.md', Buffer.from(template.replace('{{DESIGN_RULES}}', sharedSkillRules()), 'utf8')]];
  for (const [target, content] of outputs) {
    const destination = join(pluginRoot, target);
    if (check) {
      if (!content.equals(readFileSync(destination))) throw Error(`插件文件与源码不一致：${target}，请运行 node scripts/build-plugin.mjs。`);
    } else { mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content); }
  }
  return { generatedFiles: outputs.length, check };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
    console.log(JSON.stringify(buildPlugin({ check: values.check ?? false })));
    console.log('DONE');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
