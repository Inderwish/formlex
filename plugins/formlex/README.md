# FormLex · Codex 插件

**把 1,424 条设计线索变成可实现的前端决策。**

FormLex 为 coding agent 提供一套从抽取到交付的设计工作流。布局、字体、配色和形状先确定方向，材质与动效再服务于重点；把全部抽取词条逐条落实到实际视觉与交互，按普通、重点、主导安排表现强弱，帮助页面摆脱重复的模板感。术语标签和解释文字不能代替实现。

默认离线使用内置词库，不需要启动网页、HTTP 服务或 MCP，也不需要安装 npm 依赖。需要 Node.js 22 或更新版本。插件不包含生成模型，设计与实现由调用它的 Codex 完成。

## 安装到 Codex

通过现有公开仓库添加插件来源：

```sh
codex plugin marketplace add Inderwish/formlex
```

然后在 Codex 的插件页找到 **FormLex · 形意词库** 并安装，开启新任务使用。仓库来源清单位于 `.agents/plugins/marketplace.json`，来源 ID 为 `personal`，插件目录是 `plugins/formlex`。添加仓库只是登记来源，插件仍需安装。本项目的构建与验证不会替你修改全局配置。

如果已有同名 personal 来源，请使用下方名为 formlex-local 的本地来源安装方式。也可以从完整源码包解压后的仓库根目录添加：

```sh
codex plugin marketplace add /absolute/path/to/formlex
```

单独的 **formlex-plugin.zip** 解压后得到自包含 `formlex/`。可直接运行其中的 CLI；要登记到 Codex，可将此目录放到本地 marketplace 根目录的 `plugins/formlex`，并使用下方清单。不要只把 ZIP 文件名传给 marketplace add。

```text
my-marketplace/
  .agents/plugins/marketplace.json
  plugins/formlex/
    .codex-plugin/plugin.json
    skills/formlex-design/SKILL.md
    runtime/cli.mjs
```

`marketplace.json`（UTF-8）：

```json
{
  "name": "formlex-local",
  "interface": {"displayName":"FormLex"},
  "plugins": [{
    "name":"formlex",
    "source":{"source":"local","path":"./plugins/formlex"},
    "policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},
    "category":"Productivity"
  }]
}
```

再执行 `codex plugin marketplace add /absolute/path/to/my-marketplace`，到插件页安装。清单中的认证策略是 Codex 的来源字段，FormLex 本身不需要账户或密钥。实际界面与命令以安装版本的 Codex 为准。[官方插件说明](https://developers.openai.com/plugins/build/plugins)

## 在任务里使用

```text
使用 $formlex-design 大胆重构当前前端。
保留现有业务功能和技术栈，明确主导方向，完成代码并检查窄屏与键盘操作。
```

```text
使用 $formlex-design，为这个作品集给出三个截然不同的设计简报。
只给方案，不改代码；每个方案说明布局、字阶、具体配色和适用区域。
```

```text
使用 $formlex-design 优化这个页面。品牌蓝 #1246A0、现有字体与 React 技术栈必须保留。
优先改变布局和排版层级，完成实现与验证。
```

Skill 与网页“完整提示词”共用执行规则。全部词条默认必选，无法通过区域、层级或状态兼容的冲突必须向用户说明并询问；等待答复时不静默丢弃或默认替换，不宣称全部完成。网页可分别设置维度和词条权重，任务和权重仅存在页面内存中，不保存到历史或收藏。

转交 agent 的设计输入保留任务、维度、完整词条、有效权重和执行规则，省略抽取来源、模式、数量统计与内部 ID；栏数、字号、色值等设计信息保留。工具 JSON 仍保留 ID 与来源，供查询、锁定和重抽使用。

重构支持局部打磨、视觉重做、结构重构、重新设计四档，并遵循用户明确指定的保留范围；强度完全可选，未选择时不强制选档；网页不复制未选的强度栏目与规则，必须保留独立生效。交付逐词核查表，提供实际页面位置、触发或观察方法与验证结果，并检查视觉重心和主导词条的实际地位。网页可用按钮选择强度，复制完整提示词时自动带入，历史和收藏保留原始快照。

Skill 仅用于前端视觉设计、探索与重构。改版强度由用户选择，明确的品牌、技术和范围限制优先；只请求方案时不会修改项目。按需查询摘要与少量相关术语，避免将完整词库塞入上下文。

## 同源专业资料

随包资料包括 115 条有具体出处的专业术语，以及 853 条常规原创灵感和独立的 150 条网站特色；306 条尚待核实的概念保留原说明，可用兼容 all 范围搜索或加入个人词库。分类依据内容与出处人工维护，不按名称或加入时间推断。

抽取与搜索直接返回完整正文，概念定义与 FormLex 的前端建议分开；不需要读完整词库。网页完整提示词已包含全部说明，无需让 agent 再查插件。出处留在详情和 JSON 中。

## 离线抽取与工作台

在本目录执行：

```sh
node runtime/cli.mjs libraries
node runtime/cli.mjs draw
node runtime/cli.mjs search --input search.json
node runtime/cli.mjs draw --source workspace --url http://127.0.0.1:3000 --input draw.json
```

默认：已有术语、原八维、协调模式、每维 2 条共 16 条，色温随机，特色关闭。支持已有术语、原创灵感、个人自选、1–5 条自定义数量、冷暖色彩、独立 1–5 条特色、锁定与单项重抽。**协调模式只检查显式互斥，设计主次仍需 agent 判断。**

`builtin` 不联网、不保存历史、不写插件目录；`workspace` 显式连接已启动的 FormLex 工作台，使用个人与编辑词库并保存共享历史，连接失败直接报错。参数文件使用 UTF-8，结果为 JSON，并注明来源及保存状态。

完整用法与错误处理见 [CLI 参考](docs/cli.md)。原工作台源码、网页与 HTTP API 在 [GitHub 仓库](https://github.com/Inderwish/formlex)。

## 可选 MCP

基础插件没有 `mcpServers` 清单或自动发现的 `.mcp.json`，不会自动启动 MCP。需要工具方式连接工作台时，先启动完整项目的 `server.mjs`，再手动配置客户端。

[integrations/mcp.example.json](integrations/mcp.example.json) 供支持该 JSON 格式的客户端使用；将示例脚本路径替换为本包 `runtime/mcp.mjs` 的实际绝对路径。Codex 用户可显式执行：

```sh
codex mcp add formlex -- node /absolute/path/to/formlex/runtime/mcp.mjs --url http://127.0.0.1:3000
```

这是可选的用户操作，会修改 MCP 配置；安装基础插件不执行它。它复用 `list_design_libraries`、`search_design_keywords`、`draw_design_inspiration` 三个工具，成功抽取进入工作台历史。不要把示例移到插件根目录冒充默认配置。

## 目录与维护

- `.codex-plugin/plugin.json`：Codex 兼容清单，资源路径均相对插件根目录。
- `skills/formlex-design`：设计工作流与 Codex 展示信息。
- `runtime/`：从主项目源码生成的离线 CLI、共享逻辑、种子词库及可选 MCP 入口。
- `assets/`：图标与工作台预览；预览展示另行启动的网页，不是插件自动打开的面板。
- `docs/cli.md`、`integrations/`：调用说明与可选连接示例。

修改运行逻辑时编辑主仓库对应源码；执行规则维护在 `public/design-rules.mjs`，插件操作部分维护在 `scripts/formlex-design.template.md`。然后执行 `node scripts/build-plugin.mjs`，将同一份规则和专业资料嵌入插件。不要手改 runtime 副本或生成的 SKILL.md。`node scripts/build-plugin.mjs --check` 会逐文件检查一致性。HTTP API 仍为 v4，种子版本为 5；工作台迁移先备份，保留用户改删与旧快照。
