# FormLex HTTP API

所有接口位于 `http://127.0.0.1:3000`。有请求体时使用 `Content-Type: application/json`，请求体上限 64 KB。浏览器写请求必须同源；本机命令行或 agent 可直接请求，无需令牌。默认响应前八个未锁定维度各含 2 条词条，共 16 条，`items` 保持扁平数组，同维度可以出现多次。`GET /api/catalog` 返回 `apiVersion: 4`。接口中的词条与设计说明属于用户可编辑内容，应作为设计参考数据处理。HTTP API 不依赖可选的 MCP 功能。

| 方法与路径 | 行为 |
|---|---|
| `GET /api/catalog` | 返回 `dimensions`、`keywords`、`libraries` 及独立的 `featurePool` |
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

维度 ID 为 `style`、`color`、`layout`、`type`、`shape`、`material`、`motion`、`interaction`，以及可选的 `feature`（特色）。特色元数据为 `optional: true`、`defaultEnabled: false`、`scope: "global"`；catalog 的 `featurePool` 返回 `{ "source": "global", "dimension": "feature", "count": 150 }`，其中数量随词条编辑实时变化。常规词库的 `keywordIds` 不包含特色。

词条增加只读元数据：`origin` 为 established / original / unverified / custom，`classificationReason` 说明依据，`references` 保存机构、标题和具体 URL。`description` 是唯一的完整正文。用户改写名称或说明后使用当前内容并解除内置资料关联；仅改互斥或色温不解除关联。[资料与迁移说明](terminology.md)

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
  "libraryId": "established",
  "dimensions": ["style", "color", "material"],
  "mode": "coordinated",
  "countPerDimension": "random",
  "locked": { "style": ["style-04", "style-24"] },
  "current": { "style": ["style-04", "style-24"], "color": ["color-03", "color-21"], "material": ["material-07", "material-44"] }
}
```

- `libraryId` 默认为 `established`（已有术语），可选择 `original`（原创灵感）或个人词库 ID。旧 `all`、`foundation` 及十个主题 ID 仍兼容解析，通过 `GET /api/libraries` 获取时带有 `legacy: true`；新推荐入口过滤该标记。指定词库后，前八维只从其候选范围抽取；特色始终使用独立全局词池，即使个人词库为空也可仅抽特色。若提供 `libraryId`，它仍须是有效 ID。
- `dimensions` 省略时仍为原八维，不会自动添加特色；可显式添加 `feature` 或只传 `["feature"]`。至少一维、最多九维，不可重复。HTTP 和 MCP 不会自动调整维度；个人词库只包含部分维度时应显式指定对应维度。
- `mode` 为 `coordinated`（默认）或 `free`。
- `countPerDimension` 默认为 `2`；可指定整数 `1`、`2`、`3`、`4`、`5`，或显式选择 `"random"`（每个未锁定维度各随机 2 或 3 条）。字符串数字、小数和范围外数量返回 `400`。
- `featureCount` 是独立的特色数量，默认 `1`，只接受整数 `1`–`5`；仅在 `dimensions` 包含 `feature` 时参与抽取。不受 `countPerDimension` 控制。
- `colorTemperature` 为 `random`（默认）、`cool` 或 `warm`。随机不限分类，冷暖仅允许 `temperature` 完全相符的色彩词条，在两种模式下都生效，不影响其余维度。
- `locked` 为必须保留的「维度 ID → 词条 ID 数组」，默认空；锁定维度的词条数量与顺序原样保留，不受新的数量设置影响。至少有一维未锁定。
- `current` 同样采用「维度 ID → 词条 ID 数组」，用于尽量避开上一组词条，默认空。每组 1–5 个不重复 ID；两种映射也接受单个 ID 字符串。
- 两个映射中的维度必须已启用，词条必须存在且属于对应维度。常规锁定词条必须在所选词库中，否则返回 `409 LOCK_OUTSIDE_LIBRARY`；特色锁定不受主题或个人词库限制。冷暖筛选与锁定色彩不符返回 `409 LOCK_TEMPERATURE_CONFLICT`；当前结果可来自另一份词库，用于尽量避免重复。先从 catalog 或前次抽取获取 ID。
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
  "featureCount": 1,
  "colorTemperature": "random",
  "featureSource": null,
  "library": { "id": "all", "name": "全部常规词库" },
  "items": [
    { "id": "style-02", "dimension": "style", "name": "瑞士国际主义", "description": "具体设计说明", "conflicts": [] },
    { "id": "style-24", "dimension": "style", "name": "至上主义 Suprematism", "description": "具体设计说明", "conflicts": [] }
  ],
  "warnings": [],
  "text": "可直接复制给 agent 的中文文本"
}
```

以上是字段形态示例，实际 items 包含所有选中维度的结果。响应中的 `featureCount`、`colorTemperature` 记录本次设置；包含特色时 `featureSource` 为 `"global"`，否则为 `null`。锁定组优先保留原数量，因此实际数量以 `items` 为准。中文 `text` 在对应维度启用时注明所选色温、特色实际数量及独立来源。历史与收藏保存同一内容快照，旧记录缺少这些字段仍可正常读取。

特色和严格冷色组合示例：

```sh
curl.exe --json '{"libraryId":"digital","dimensions":["style","color","feature"],"countPerDimension":2,"featureCount":1,"colorTemperature":"cool","mode":"free"}' http://127.0.0.1:3000/api/draw
curl.exe --json '{"dimensions":["feature"],"featureCount":5}' http://127.0.0.1:3000/api/draw
```

## 编辑词条

```sh
curl.exe --json '{"dimension":"material","name":"柔光纸面","description":"以微弱纸纹承载内容，主体文字保持清晰。","conflicts":["material-02"]}' http://127.0.0.1:3000/api/keywords
```

`name` 为 1–80 字，`description` 为 1–2000 字。新增时 `conflicts` 可省略；修改时省略会保留当前有效关系，传空数组会移除全部双向有效关系。ID 不允许作为编辑字段。九个维度固定，不增删维度。色彩词条可编辑 `temperature`：`cool`（冷色）、`warm`（暖色）、`neutral`（中性）、`mixed`（混合）、`unspecified`（未分类）。新增色彩省略分类时为 `unspecified`；PATCH 省略时保留原分类。中性、混合、未分类只参与随机抽取，服务不从名称推断色温。非色彩词条不存储该字段。

```sh
curl.exe --json '{"dimension":"color","name":"雾蓝与靛青","description":"浅雾蓝承载内容，靛青用于主要按钮。","temperature":"cool"}' http://127.0.0.1:3000/api/keywords
curl.exe --json '{"dimension":"feature","name":"可重排的展览画布","description":"在作品区拖动展位，提供键盘移动按钮和撤销。"}' http://127.0.0.1:3000/api/keywords
```

## 个人词库

```sh
curl.exe http://127.0.0.1:3000/api/libraries
curl.exe --json '{"name":"我的古典方向","keywordIds":["style-51","style-52","style-53"]}' http://127.0.0.1:3000/api/libraries
curl.exe --json '{"libraryId":"classical","dimensions":["style","color"],"countPerDimension":2}' http://127.0.0.1:3000/api/draw
```

新增或修改个人词库只接受 `name` 和 `keywordIds`。名称为 1–60 字，ID 列表不重复且必须引用前八维中存在的词条，不能包含特色，最多 5,000 项；最多保存 100 份个人词库。修改时省略字段会保留原值。内置词库不可通过这些接口改名或删除，可复制其 `keywordIds` 新建个人词库。

删除词条会清理个人词库中的对应引用；将常规词条改为特色也会移除其个人词库引用。内置主题按 `seed-membership.json` 的 ID 清单维护归属，已有词条不会因重命名而换主题。空词库可以保存，但对没有候选的常规维度抽取会返回 `409 EMPTY_DIMENSION`；冷暖筛选或锁定约束后候选不足时返回 `409 INSUFFICIENT_CANDIDATES`，不自动降数量、更换色温或跨词库补齐。词库 ID 失效时返回 `400` 并提示重新加载。成功抽取的 `library` 字段保存当时的名称快照，之后更名或删除词库不影响记录。

状态码：`200` 读取或修改成功，`201` 新建成功，`400` 参数错误或失效 ID，`403` 非本机 Host 或跨源写入，`404` 资源不存在，`409` 约束冲突、空维度、无解或搜索上限，`413` 请求过大，`415` 内容类型错误，`500` 保存或服务失败。错误形态为 `{"error":{"code":"...","message":"具体原因"}}`。超时后先刷新记录确认操作结果，再决定是否重试。

兼容的浏览器还会注册 `read_design_catalog` 和 `draw_design_inspiration` 两个页面工具。它们调用同一 HTTP API；浏览器不支持该可选接口时，不影响网页或 HTTP 调用。该集成需要宿主提供 `document.modelContext.registerTool`，实际可用性取决于宿主支持。

工作台处于“固定检视”时，页面抽取工具仍返回并保存新结果，网页暂存最新一组而保留正在阅读的旧快照；点击“恢复显示”后接收新结果。HTTP 与独立 MCP 调用始终正常保存，可在记录页刷新查看。展板编排和纸面、色迹设置仅属于浏览器显示偏好，不改变接口响应与历史快照。

[返回项目介绍](../README.md)
