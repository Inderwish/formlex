# 可选 MCP 工具

MCP 让支持工具调用的 agent 直接查看词库、搜索术语和抽取灵感。**这是可选功能**：直接使用网页和 HTTP API，无需配置或运行 MCP。

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
| `list_design_libraries` | 无参数；返回内置与个人词库的 ID、名称、说明、总数及每维度候选数量。 |
| `search_design_keywords` | 按 `libraryId`、`dimension`、`query` 搜索；`limit` 默认 30，范围 1–100，`offset` 默认 0。返回术语、说明、总数及 `nextOffset`。 |
| `draw_design_inspiration` | 接受 `libraryId`、`dimensions`、`mode`、`countPerDimension`、`locked`、`current`，成功后保存历史。 |

抽取参数与 [HTTP API](api.md) 一致，默认使用全部词库、八个维度、协调模式，每维度随机 2–3 条。`countPerDimension` 可设为整数 1–5，锁定维度仍保留原数量；`locked` 与 `current` 的每维度 ID 数组最多 5 项。主题词库及个人词库都是候选范围；协调模式只排除显式互斥。

个人词库可能只包含部分维度。先查看各维度数量，再显式传入要抽取的维度；每个未锁定维度需要足够的候选词条。锁定词条不在所选词库、词条失效或保存失败时会说明原因，不会静默更换条件。

## 给 agent 的用法

可以直接向已经连接 MCP 的 agent 说明：

```text
请用 FormLex 的 MCP 工具为这个页面寻找设计方向。
先查看可用词库，选择与项目内容相符的主题；如有适合的个人词库，优先使用。
再抽取需要的设计维度，根据结果确定主导方向和局部应用范围，然后实现前端。
```

工具调用参数示例：

```json
{
  "libraryId": "digital",
  "dimensions": ["style", "color", "layout", "type", "material"],
  "mode": "free",
  "countPerDimension": 2
}
```

单独重抽一个维度时，把其他维度的结果 ID 全部放进 `locked`，并通过 `current` 传入原结果。例如，保留数字主题的风格，只重抽色彩：

```json
{
  "libraryId": "digital",
  "dimensions": ["style", "color"],
  "mode": "free",
  "countPerDimension": 2,
  "locked": { "style": ["style-111", "style-112"] },
  "current": {
    "style": ["style-111", "style-112"],
    "color": ["color-111", "color-112"]
  }
}
```

实际使用时，从搜索或前一次抽取中获取 ID。工具不会读取网页当前选择，每次调用明确传参；网页中的“刷新记录”可以读取 MCP 产生的结果。

## 返回与错误

工具结果同时提供 `structuredContent` 对象和包含同一对象 JSON 的 `content` 文本块。抽取结果中的 `text` 是可直接给 agent 使用的中文设计说明，`items` 是词条数组，`library` 保留抽取时的词库名称。

参数、约束、连接和保存错误通过 `isError: true` 返回，包含 `error.code` 和中文 `error.message`。服务未启动时会提示先启动 `server.mjs`。发生超时或取消后，抽取可能已在服务端保存，应先查看网页历史再决定是否重试。

该入口使用 UTF-8、按行分隔的 JSON-RPC stdio 消息，支持初始化、工具发现、调用与取消通知；支持协议版本 `2025-11-25` 和 `2025-06-18`。协议依据：[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[初始化生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

标准输出专供 MCP 消息，日志写入标准错误。单条输入最多 64 KB，最多同时处理 32 个请求，单次 HTTP 请求有 12 秒上限。本入口不提供 Streamable HTTP 或浏览器端 WebMCP；网页的可选浏览器工具与此 stdio 入口独立。

[返回项目介绍](../README.md)
