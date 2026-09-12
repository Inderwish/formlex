# FormLex 一次性 CLI

需要 Node.js 22+，无第三方依赖。源码根目录使用 `node cli.mjs`，插件包使用 `node runtime/cli.mjs`；可从任意目录用脚本绝对路径调用。程序输出一行 UTF-8 JSON 后退出，不启动服务。

```sh
node runtime/cli.mjs libraries
node runtime/cli.mjs search --input search.json
node runtime/cli.mjs draw --input draw.json
node runtime/cli.mjs draw
node runtime/cli.mjs --help
```

## 数据来源

| source | 行为 |
| --- | --- |
| `builtin`（默认） | 随包 1,424 条词库；离线，不读个人数据，不保存历史，不写安装目录。 |
| `workspace` | 通过本机 HTTP API v4 读取实际词库；成功抽取写入工作台共享历史。需自行启动工作台。 |

```sh
node runtime/cli.mjs libraries --source workspace --url http://127.0.0.1:3000
node runtime/cli.mjs draw --source workspace --input draw.json
```

`--url` 仅与 `--source workspace` 一起使用，省略时为 `http://127.0.0.1:3000`。只接受 HTTP 的 127.0.0.1 或 localhost 根地址，拒绝重定向与远程地址；CLI 不读取 FORMLEX_URL 环境变量。连接失败不回退。每个 HTTP 请求最多等待 12 秒，无自动重试。

## UTF-8 参数文件

`--input` 为 UTF-8 JSON 对象文件（支持 BOM，最大 64 KB）。`libraries` 不接受字段；`search`、`draw` 的参数如下。省略文件等同 `{}`，拒绝未知字段。使用文件避免终端转义问题。例如在 **pwsh** 中：

```powershell
Set-Content -LiteralPath draw.json -Encoding utf8 -Value '{"libraryId":"digital","dimensions":["style","color","layout","type","feature"],"colorTemperature":"cool","featureCount":1}'
node runtime/cli.mjs draw --input draw.json
```

### libraries

返回九个维度、独立特色词池，以及全部、基础、10 个主题和当前数据源中的个人词库摘要。各常规维度数量与五类色温数量单独列出；不返回全量词条。先用它获取有效 libraryId。

### search

`search.json`：

```json
{"libraryId":"digital","dimension":"color","temperature":"cool","query":"蓝","limit":8,"offset":0}
```

- `libraryId` 默认 `all`；`dimension` 可省略，或为下表之一。
- `temperature` 仅筛选色彩：`cool`、`warm`、`neutral`、`mixed`、`unspecified`。省略即不限；这里不使用 `random`。
- `query` 搜索名称和说明，不超过 160 字；默认空字符串。
- `limit` 为 1–100，默认 30；`offset` 非负整数。响应的 `nextOffset=null` 表示没有下一页。
- `{"dimension":"feature","query":"鼠标","limit":8}` 搜索全局特色。特色不受主题或个人词库影响，返回 `result.source="global"`。常规查询不会混入特色。

### draw

| 参数 | 取值与默认 |
| --- | --- |
| `libraryId` | 默认 `all`，主题或个人词库 ID 由 libraries 提供。 |
| `dimensions` | `style` 风格、`color` 色彩、`layout` 布局、`type` 字体排版、`shape` 形状、`material` 材质、`motion` 动效、`interaction` 交互、`feature` 特色。默认原八维，可仅选特色。 |
| `mode` | `coordinated`（默认）或 `free`。协调只排除明确配置的互斥关系。 |
| `countPerDimension` | `random`（默认，每维随机 2–3）或整数 1–5；不控制特色。 |
| `featureCount` | 整数 1–5，默认 1。只有 dimensions 包含 feature 时启用特色。 |
| `colorTemperature` | `random`（默认，不限分类）、`cool`、`warm`；两种模式均严格筛选。 |
| `locked` | 维度 ID 到词条 ID 数组的映射，锁定该维度整组及顺序；锁定数量不随数量控件更改。兼容单 ID 字符串。 |
| `current` | 同样的映射，用于重抽时尽量避开旧词条；有保留时响应 warnings 说明。 |

锁定与 current 中的维度必须已启用，词条必须有效且属于该维度。锁定的常规词条还必须在所选词库内，锁定色彩必须符合色温；特色始终来自独立全局词池。全部维度锁定则报错。

仅重抽色彩、保留风格与特色的示例（以下 ID 是内置有效词条；实际使用请从上次 `result.items` 按 dimension 分组取 ID）：

```json
{
  "dimensions": ["style", "color", "feature"],
  "mode": "free",
  "countPerDimension": 2,
  "featureCount": 1,
  "current": {"style":["style-01","style-02"],"color":["color-01","color-02"],"feature":["feature-01"]},
  "locked": {"style":["style-01","style-02"],"feature":["feature-01"]}
}
```

完整单项重抽应保持原有 dimensions，并将目标以外所有维度放入 locked。关闭特色后，从 dimensions、locked、current 同时移除 feature；此前记录内容仍可保留。

## 输出与错误

成功（退出码 0）：

```json
{"source":"builtin","historySaved":false,"result":{"id":"…","createdAt":"…","mode":"coordinated","items":[],"text":"…"}}
```

示例省略了具体结果。draw 的 `result` 与 HTTP 抽取记录结构一致，包含数量、色温、`featureSource`、词库、快照 `items`、`warnings` 与可复制中文 `text`。工作台成功抽取的 `historySaved=true`；查询均为 false。离线返回的 ID 仅标识本次结果，工作台没有保存它。

失败（退出码 1，仍在 stdout 返回 JSON）：

```json
{"source":"workspace","historySaved":false,"error":{"code":"SAVE_FAILED","message":"…","status":500}}
```

无效参数 `INVALID_INPUT`；锁定色温冲突 `LOCK_TEMPERATURE_CONFLICT`；范围冲突 `LOCK_OUTSIDE_LIBRARY`；锁定互斥 `LOCK_CONFLICT`；候选不足 `INSUFFICIENT_CANDIDATES`；空维度 `EMPTY_DIMENSION`；组合不存在 `NO_COMBINATION`；搜索上限 `SEARCH_LIMIT`。达到上限只表示本次没有找到结果，不代表组合一定不存在。不自动改条件或模式。

工作台连接/响应异常为 `SERVICE_UNAVAILABLE`，取消/超时为 `REQUEST_INTERRUPTED`，API 不兼容为 `SERVICE_VERSION`。提交抽取后若响应中断，`historySaved=null` 表示保存状态未知；先查看工作台历史，避免盲目重试。明确保存失败不会返回成功记录。旧快照和用户数据格式保持原样，CLI 不触发离线数据迁移。
