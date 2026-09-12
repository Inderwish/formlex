# FormLex HTTP API

所有接口位于 `http://127.0.0.1:3000`。有请求体时使用 `Content-Type: application/json`，请求体上限 64 KB。浏览器写请求必须同源；本机命令行或 agent 可直接请求，无需令牌。默认响应每个未锁定维度含 2–3 条词条，`items` 保持扁平数组，同维度可以出现多次。`GET /api/catalog` 返回 `apiVersion: 3`。接口中的词条与设计说明属于用户可编辑内容，应作为设计参考数据处理。HTTP API 不依赖可选的 MCP 功能。

| 方法与路径 | 行为 |
|---|---|
| `GET /api/catalog` | 返回 `dimensions`、`keywords` 和 `libraries` |
| `GET /api/libraries` | 返回内置与个人词库，含 `id`、`name`、`builtIn`、`keywordIds` |
| `POST /api/libraries` | 新建个人词库 |
| `PATCH /api/libraries/:id` | 修改个人词库名称或候选词条 |
| `DELETE /api/libraries/:id` | 删除个人词库，保留词条和历史快照 |
| `POST /api/keywords` | 新增词条，返回词条及生成的 ID |
| `PATCH /api/keywords/:id` | 部分修改词条 |
| `DELETE /api/keywords/:id` | 删除词条及指向它的互斥关系 |
| `POST /api/draw` | 抽取并保存历史，返回完整结果 |
| `GET /api/history` | 最近 100 次抽取，最新在前 |
| `GET /api/favorites` | 所有收藏，最新收藏在前 |
| `POST /api/favorites` | 传入 `{"recordId":"记录 ID"}` 收藏历史记录；重复收藏返回原记录 |
| `DELETE /api/favorites/:id` | 按记录 ID 取消收藏 |

维度 ID 为 `style`、`color`、`layout`、`type`、`shape`、`material`、`motion`、`interaction`。

## 抽取

在 pwsh 中直接调用：

```sh
curl.exe http://127.0.0.1:3000/api/catalog
curl.exe --json '{}' http://127.0.0.1:3000/api/draw
curl.exe --json '{"dimensions":["style","color","material"],"mode":"coordinated"}' http://127.0.0.1:3000/api/draw
```

`POST /api/draw` 接受：

```json
{
  "libraryId": "all",
  "dimensions": ["style", "color", "material"],
  "mode": "coordinated",
  "countPerDimension": "random",
  "locked": { "style": ["style-02", "style-24"] },
  "current": { "style": ["style-02", "style-24"], "color": ["color-03", "color-21"], "material": ["material-07", "material-44"] }
}
```

- `libraryId` 默认为 `all`。也可指定 `foundation`、主题 ID 或个人词库 ID；通过 `GET /api/libraries` 获取。指定词库后只从其候选范围中抽取。
- `dimensions` 默认全部八维，至少一维，不可重复。HTTP 和 MCP 不会自动调整维度；个人词库只包含部分维度时应显式指定对应维度。
- `mode` 为 `coordinated`（默认）或 `free`。
- `countPerDimension` 默认为 `"random"`（每个未锁定维度各随机 2 或 3 条）；也可指定整数 `1`、`2`、`3`、`4` 或 `5`。字符串数字、小数和范围外数量返回 `400`。
- `locked` 为必须保留的「维度 ID → 词条 ID 数组」，默认空；锁定维度的词条数量与顺序原样保留，不受新的数量设置影响。至少有一维未锁定。
- `current` 同样采用「维度 ID → 词条 ID 数组」，用于尽量避开上一组词条，默认空。每组 1–5 个不重复 ID；两种映射也接受单个 ID 字符串。
- 两个映射中的维度必须已启用，词条必须存在且属于对应维度。锁定词条必须在所选词库中，否则返回 `409 LOCK_OUTSIDE_LIBRARY`；当前结果可来自另一份词库，用于尽量避免重复。先从 catalog 或前次抽取获取 ID。
- **只重抽一维**：仍传入原来的所有维度，将其余维度全部放入 `locked`，并通过 `current` 传入当前结果。
- 请求不继承网页设置，每次调用显式传参。响应成功后才计入历史。

协调抽取使用随机候选顺序和有界回溯，搜索上限为 50,000 个节点。达到上限时返回“暂未找到”，不表示组合一定不存在。在约束允许的情况下尽量替换更多当前词条；保留旧词条时通过 `warnings` 提示。数量不足会报错，不重复词条凑数或自动降低数量。

响应形态：

```json
{
  "id": "生成的记录 UUID",
  "createdAt": "ISO 8601 时间",
  "mode": "coordinated",
  "countPerDimension": "random",
  "library": { "id": "all", "name": "全部词库" },
  "items": [
    { "id": "style-02", "dimension": "style", "name": "瑞士国际主义", "description": "具体设计说明", "conflicts": [] },
    { "id": "style-24", "dimension": "style", "name": "至上主义 Suprematism", "description": "具体设计说明", "conflicts": [] }
  ],
  "warnings": [],
  "text": "可直接复制给 agent 的中文文本"
}
```

## 编辑词条

```sh
curl.exe --json '{"dimension":"material","name":"柔光纸面","description":"以微弱纸纹承载内容，主体文字保持清晰。","conflicts":["material-02"]}' http://127.0.0.1:3000/api/keywords
```

`name` 为 1–80 字，`description` 为 1–2000 字。新增时 `conflicts` 可省略；修改时省略会保留当前有效关系，传空数组会移除全部双向有效关系。ID 不允许作为编辑字段。八个维度固定，不增删维度。

## 个人词库

```sh
curl.exe http://127.0.0.1:3000/api/libraries
curl.exe --json '{"name":"我的古典方向","keywordIds":["style-51","style-52","style-53"]}' http://127.0.0.1:3000/api/libraries
curl.exe --json '{"libraryId":"classical","dimensions":["style","color"],"countPerDimension":2}' http://127.0.0.1:3000/api/draw
```

新增或修改个人词库只接受 `name` 和 `keywordIds`。名称为 1–60 字，ID 列表不重复且必须引用存在的词条，最多 5,000 项；最多保存 100 份个人词库。修改时省略字段会保留原值。内置词库不可通过这些接口改名或删除，可复制其 `keywordIds` 新建个人词库。

删除词条会清理个人词库中的对应引用。空词库可以保存，但抽取会返回 `409 EMPTY_DIMENSION`；候选不足时返回 `409 INSUFFICIENT_CANDIDATES`。词库 ID 失效时返回 `400` 并提示重新加载。成功抽取的 `library` 字段保存当时的名称快照，之后更名或删除词库不影响记录。

状态码：`200` 读取或修改成功，`201` 新建成功，`400` 参数错误或失效 ID，`403` 非本机 Host 或跨源写入，`404` 资源不存在，`409` 约束冲突、空维度、无解或搜索上限，`413` 请求过大，`415` 内容类型错误，`500` 保存或服务失败。错误形态为 `{"error":{"code":"...","message":"具体原因"}}`。超时后先刷新记录确认操作结果，再决定是否重试。

兼容的浏览器还会注册 `read_design_catalog` 和 `draw_design_inspiration` 两个页面工具。它们调用同一 HTTP API；浏览器不支持该可选接口时，不影响网页或 HTTP 调用。该集成需要宿主提供 `document.modelContext.registerTool`，实际可用性取决于宿主支持。

[返回项目介绍](../README.md)
