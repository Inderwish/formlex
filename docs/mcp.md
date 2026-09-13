# 可选 MCP 工具

MCP 让支持工具调用的 agent 直接查看词库、搜索术语和抽取灵感。**这是可选功能**：直接使用网页和 HTTP API，无需配置或运行 MCP。

Codex 插件默认使用 [离线 CLI](cli.md)，不注册 MCP。需要可选工具连接时，可使用插件内的 `runtime/mcp.mjs`；它与本页的项目根目录 `mcp.mjs` 来自同一源码，连接同一工作台并提供以下三个工具。[插件安装与连接说明](../plugins/formlex/README.md)

## 接入

先正常启动 FormLex：

```sh
node server.mjs
```

随后在支持 **stdio MCP** 的客户端中添加下面的配置。将脚本路径替换为你下载项目后的绝对路径；若客户端找不到 `node`，将 `command` 替换为 Node.js 可执行文件的绝对路径。

```json
{
  "mcpServers": {
    "formlex": {
      "command": "node",
      "args": ["C:/path/to/formlex/mcp.mjs"],
      "env": {
        "FORMLEX_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

此示例适用于使用 `mcpServers` JSON 配置格式的客户端。其他客户端中，填写相同的命令、参数和环境变量即可。macOS 或 Linux 使用相应的绝对脚本路径。无需安装额外依赖，也无需 API Key。

客户端负责启动和关闭 `mcp.mjs`。该程序通过 HTTP 连接已经运行的 FormLex 服务，不另开词库文件，不启动第二份 HTTP 服务。网页、HTTP 和 MCP 的成功抽取会进入同一份历史。可使用 `--url http://127.0.0.1:3001` 指定端口，命令行优先于环境变量；只接受本机 `127.0.0.1` 或 `localhost` 地址。

## 提供的工具

| 工具 | 参数与用途 |
| --- | --- |
| `list_design_libraries` | 无参数；返回内置与个人词库的 ID、名称、说明、常规总数、每维度候选数量、色温分类数量 `temperatureCounts` 及独立的 `featurePool`。 |
| `search_design_keywords` | 按 `libraryId`、`dimension`、`temperature`、`query` 搜索；`limit` 默认 30，范围 1–100，`offset` 默认 0。返回术语、说明、总数及 `nextOffset`。 |
| `draw_design_inspiration` | 接受 `libraryId`、`dimensions`、`mode`、`countPerDimension`、`featureCount`、`colorTemperature`、`locked`、`current`，成功后保存历史。 |

抽取参数与 [HTTP API](api.md) 一致，默认使用已有术语（`established`）、原八个维度、协调模式，每维度 2 条，共 16 条。显式选择 `random` 可恢复每维随机 2–3 条。`countPerDimension` 可设为整数 1–5，锁定维度仍保留原数量；`locked` 与 `current` 的每维度 ID 数组最多 5 项。已有术语、原创灵感及个人词库控制前八维的候选范围；协调模式只排除显式互斥。

显式在 `dimensions` 加入 `feature` 可开启特色，也可以只传 `["feature"]`。它始终从独立全局词池抽取，数量由 `featureCount` 控制（整数 1–5，默认 1），不受 `countPerDimension` 或所选词库范围影响。`colorTemperature` 支持 `random`、`cool`、`warm`，默认随机；自由与协调模式都严格遵守冷暖标签，候选不足或锁定色彩不符时保留条件并返回原因。

搜索时，`dimension: "feature"` 表示全局特色搜索，返回 `source: "global"` 和 `library: null`；省略 dimension 的搜索仍限于常规词库。`temperature` 接受 `cool`、`warm`、`neutral`、`mixed`、`unspecified`，只用于色彩，可与 `dimension: "color"` 一起使用或单独指定；与其他维度一起传入会报错。取消搜索色温限制请省略该字段，不传 `random`。

个人词库可能只包含部分维度。先查看各维度数量，再显式传入要抽取的维度；每个未锁定维度需要足够的候选词条。锁定词条不在所选词库、词条失效或保存失败时会说明原因，不会静默更换条件。

## 给 agent 的用法

可以直接向已经连接 MCP 的 agent 说明：

```text
请用 FormLex 的 MCP 工具为这个页面寻找设计方向。
先查看可用词库，选择已有术语或原创灵感；如有适合的个人词库，优先使用。
再抽取需要的设计维度，将全部词条安排到实际视觉或交互中，然后实现前端。
无法兼容的冲突先向我说明并询问，不静默丢弃词条。
```

工具调用参数示例：

```json
{
  "libraryId": "original",
  "dimensions": ["style", "color", "layout", "type", "material", "feature"],
  "mode": "free",
  "countPerDimension": 2,
  "featureCount": 1,
  "colorTemperature": "cool"
}
```

单独重抽一个维度时，把其他维度的结果 ID 全部放进 `locked`，并通过 `current` 传入原结果。例如，保留原创灵感的风格，只重抽色彩：

```json
{
  "libraryId": "original",
  "dimensions": ["style", "color"],
  "mode": "free",
  "countPerDimension": 2,
  "locked": { "style": ["style-03", "style-06"] },
  "current": {
    "style": ["style-03", "style-06"],
    "color": ["color-111", "color-112"]
  }
}
```

全局查找鼠标光效，或只搜索原创灵感中的暖色配色：

```json
{"libraryId":"original","dimension":"feature","query":"鼠标","limit":10}
```

```json
{"libraryId":"original","dimension":"color","temperature":"warm"}
```

只抽三个网站特色：

```json
{"dimensions":["feature"],"featureCount":3}
```

实际使用时，从搜索或前一次抽取中获取 ID。工具不会读取网页当前选择，每次调用明确传参；网页中的“刷新记录”可以读取 MCP 产生的结果。

推荐列表只显示 established、original 及个人词库。旧主题、all、foundation 的 ID 仍可显式调用。搜索和抽取均返回完整正文及出处元数据，不新增查询命令。[资料字段](terminology.md)

## 返回与错误

工具结果同时提供 `structuredContent` 对象和包含同一对象 JSON 的 `content` 文本块。抽取结果中的 `text` 是可直接给 agent 使用的中文设计说明，`items` 是词条数组，`library` 保留抽取时的常规词库名称，`colorTemperature` 和 `featureCount` 记录设置；包含特色时 `featureSource` 为 `global`，否则为 `null`。锁定的特色组可跨主题保留，实际词条数量以 `items` 为准。

参数、约束、连接和保存错误通过 `isError: true` 返回，包含 `error.code` 和中文 `error.message`。服务未启动时会提示先启动 `server.mjs`；服务版本不符返回 `SERVICE_VERSION`，请关闭旧服务后重新启动。当前要求 HTTP API 版本 4。发生超时或取消后，抽取可能已在服务端保存，应先查看网页历史再决定是否重试。

该入口使用 UTF-8、按行分隔的 JSON-RPC stdio 消息，支持初始化、工具发现、调用与取消通知；支持协议版本 `2025-11-25` 和 `2025-06-18`。协议依据：[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[初始化生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

标准输出专供 MCP 消息，日志写入标准错误。单条输入最多 64 KB，最多同时处理 32 个请求，单次 HTTP 请求有 12 秒上限。本入口不提供 Streamable HTTP 或浏览器端 WebMCP；网页的可选浏览器工具与此 stdio 入口独立。

[返回项目介绍](../README.md)
