Linkgrove

个人链接知识库（Tag-first Bookmarks + AI Tagging）

# 1. 背景与问题定义

## 1.1 背景

现有书签工具多采用文件夹/层级嵌套结构，存在以下问题：

- **单一归属**：一个链接只能放一个文件夹，不符合链接的多维属性（主题/用途/项目/状态等）。
- **层级复杂导致检索困难**：嵌套层级越深，定位成本越高。
- **整理成本高**：保存链接时必须“先想好放哪”，用户更倾向于“先存再说”，导致长期堆积。
- **标签功能薄弱**：多数产品标签仅作为辅助，缺少组合保存（Saved Query）、治理（alias/合并）、学习等能力。

## 1.2 问题定义

我们希望构建一个工具，使用户可以：

- 用 **Tag（标签）作为唯一核心组织方式**（文件夹为可选或不提供）。
- 通过 **标签组合筛选**快速找到链接，并将筛选条件保存为“智能集合”（Saved Query / Smart List）。
- 通过 **AI 自动理解 URL 内容**，生成摘要、类型、标签建议（或自动打标），显著降低整理成本。

# 2. 产品目标与成功指标

## 2.1 产品愿景

将书签从“收藏夹”升级为 **个人链接知识库**：

> 保存几乎零成本，找回极快，并能不断沉淀与复用。

## 2.2 核心目标

1. **保存链接成本极低**：粘贴 URL → 自动完成结构化（标题、摘要、tag、类型） → 一键保存
2. **检索速度极快**：关键词 + 标签组合筛选 + 保存组合入口
3. **标签体系不爆炸**：规范化、补全、alias、合并

# 3. 核心概念与术语

- **Bookmark（书签）**：一个 URL 的保存记录
- **Tag（标签）**：用于分类与检索的语义单位，一个书签可多个 tag
- **Saved Query / Smart List（智能集合）**：保存筛选表达式与视图配置
- **User Tag（用户标签）**：用户自定义标签（项目/习惯/状态）
- **AI Suggestion（AI 建议）**：AI 生成的 tag/摘要/类型等建议，用户可确认或拒绝
- **Content Fingerprint（内容指纹）**：对页面正文提取并归一化后 hash，用于稳定映射 tags（后续扩展概念）

# 4. 主要功能

> 本章描述完整产品能力；具体首版落地范围以第 7 章当前实现方案为准。

## 4.1 书签采集（Capture）

- 支持输入 URL 保存
- 自动拉取 title、domain
- 支持手动添加备注 note
- 支持拖拽链接保存
- 支持批量导入（Chrome/HTML）
  **验收标准**
- 输入合法 URL，成功保存，至少包含 title+url+created_at
- title 拉取失败时使用 url 作为 fallback

## 4.2 标签系统（Tag-first）

- 创建 tag：输入 name → 自动生成 slug（规范化：lowercase、空格→-、trim、去重）
- 标签补全：输入时匹配已有 tag
- 一个书签支持多个 tag
- 支持删除 tag（同时移除所有引用）
- 支持重命名 tag（name 可变，slug 可选保持或跟随变更）
- tag 合并：A → B，所有引用迁移
- tag alias：别名映射到 canonical tag
- 标签视觉属性（可选）
  **验收标准**
- 同用户下 slug 唯一，避免重复 tag
- 添加 tag 时 O(1) 或近似 O(log n) 的响应（良好体验）

## 4.3 搜索与筛选（Retrieve）

- 全局搜索框：title + note + summary（可选：域名）
- tag 筛选：可多选 tag（AND 关系）
- NOT 排除某 tag
- 排序：最近保存、标题
- 域名过滤：domain:github.com
- 时间过滤：created:7d
- OR 条件（tag1 OR tag2）
- 搜索建议：最近关键词、常用 tag 组合
  **验收标准**
- 1000 条书签检索 < 200ms（不含网络）
- 筛选行为能组合并保持可回溯（可生成 query）

## 4.4 Saved Query（智能集合 / 保存筛选条件）

- 保存当前筛选为“智能集合”
- 智能集合显示在侧边栏（可 pin）
- 支持编辑：名称、排序、视图（列表/卡片）
- 支持删除
- 支持 Query AST 编辑器（可视化）
- 支持 Query 引用 Query
- 支持共享（链接分享/模板）
  **数据要求**
- query 表达式建议存 AST（JSON）
  **验收标准**
- 保存后能稳定复现筛选结果（与当时条件一致）
- 侧边栏入口体验不逊于文件夹

## 4.5 AI 自动结构化（Auto Tagging + Summary）

> 目标：降低保存与整理成本，同时保持可控与稳定

### 4.5.1 AI 输入与内容抽取

- 抓取页面：title、meta description、正文（readability 抽取，限制长度）
- 抽取失败时降级为 title + domain

### 4.5.2 AI 输出

- 输出 tags 建议（3~7 个，按置信度排序）
- 输出 type（article/video/tool/docs/paper/other）
- 输出 summary（一句话）
- 输出 JSON（强制结构化）

### 4.5.3 写入策略

- 默认半自动：展示建议 tags，用户一键确认保存
- 高置信度 tag（例如 >0.85）可默认勾选
- 用户拒绝/删除建议 tag 会记录反馈事件
- 自动写入模式：对特定用户开启（设置项）
- 域名规则补全：github.com → #code #tool
- 共现推荐：基于用户历史 tag 共现
  **验收标准**
- AI 返回格式稳定（JSON schema 校验通过率 > 99%）
- 平均建议 tag 的采纳率 > 70%
- 用户可在 1 秒内纠错（删除/替换）

## 4.6 批量管理（效率功能）

- 多选书签
- 批量添加/移除 tag
- 批量删除
- 批量应用 Tag Bundle（标签模板）
- 批量设置状态（todo/done）
- 状态体系优先用系统 tag 或默认智能集合表达，不单独引入复杂状态机

## 4.7 数据导入导出

- 导入：Chrome 书签 HTML → 转换为 tags（根据路径生成 tags 或保存为 smart list）
- 导出：JSON/CSV（含 tags、note、created_at）

## 4.8 后续扩展

- 默认智能集合：如 `Unprocessed`、`Recently Added`、`Untagged`
- 正文索引、全文检索、embedding 相似推荐、内容高亮/笔记
- 全局标签体系、多设备同步、协作

# 5. 用户故事与典型场景

## 场景 A：快速保存

- 我复制一个 URL，系统自动补全标题、摘要和 tag 建议，我可以立即保存，后续再整理

## 场景 B：快速找回

- 我通过关键词和标签组合快速找到目标链接，也可以把常用筛选保存成智能集合作为固定入口

## 场景 C：AI 学习与优化

- 我保存链接时收到 AI 的摘要和 tag 建议；当我接受、删除或替换建议后，系统会逐步学习我的偏好

# 6. 交互与界面（信息架构）

## 6.1 主要页面

1. **首页/All Bookmarks**：最近保存、快速搜索、常用智能集合
2. **列表页**：书签列表 + 筛选器（tags / domain / date）
3. **书签详情**：标题、URL、summary、tags、note、元数据
4. **标签页**：tag 列表、usage、合并/alias
5. **智能集合页**：saved query 管理

## 6.2 关键交互细节

- 保存 URL 时：
  - AI 建议 tags 默认勾选高置信度
  - 可显示“系统标签 / 我的标签”分组
  - 一键确认 & 可快速删除/替换
- 选择 tag 时：
  - 支持键盘：输入 → tab 选择 → enter 添加
  - 支持创建新 tag：若未匹配，enter 即创建
- Saved Query：
  - “保存当前筛选”按钮固定位置
  - 保存后自动出现在侧边栏，可 pin
- 默认智能集合：
  - 侧边栏可内置 `Unprocessed`、`Recently Added`、`Untagged` 等默认智能集合

# 7. 技术实现（Cloudflare Workers + D1）

> 本章描述当前实现方案，用于约束首版技术落地；不要求一次覆盖第 3 章中的全部能力。

## 7.1 总体架构

- Cloudflare `Workers` 负责 API、页面抓取编排、AI 调用、鉴权与业务逻辑
- Cloudflare `D1` 作为主数据库，保存书签、标签、映射、查询与反馈事件
- Cloudflare `Workers AI` 提供 `type`、`summary`、tag 建议等推理能力
- 前端可使用浏览器本地缓存提升体验，但不以本地存储作为真相源
- 当前方案不引入 `R2`；仅保存书签最重要的结构化信息

## 7.2 设计原则

- 关系建模：书签、标签、映射、查询按实体和关系设计，避免后续结构失控
- 结构化优先：当前方案只存书签最重要的信息，不保存原始 HTML 或全文内容
- 简化实现：不做同步协议、不做对象存储层、不做软删除
- 逐步增强：若后续需要正文缓存、页面快照、chunk 或导出文件，再引入 `R2`

## 7.3 核心数据模型

### 7.3.1 bookmarks

- 作用：书签主实体
- 当前字段：
  - `id`
  - `url`
  - `canonical_url`
  - `title`
  - `domain`
  - `summary`
  - `note`
  - `type`
  - `created_at`
  - `updated_at`
- 字段说明：
  - `id`：内部唯一标识，不直接依赖 `url`
  - `url`：用户实际保存的原始链接
  - `canonical_url`：规范化后的链接，用于去重和结果复用。例如 `https://example.com/post?id=1&utm_source=x` 与 `https://example.com/post?id=1&utm_source=y` 可归一到同一个 `canonical_url`
  - `title`：页面标题，抓取失败时可用 `url` 兜底
  - `domain`：从 `url` 解析出的域名，用于展示、筛选与规则打标
  - `summary`：页面内容的一句话摘要，偏内容描述
  - `note`：用户自己写的备注，偏个人用途和上下文
  - `type`：粗粒度内容类型，使用枚举值
  - `created_at`：书签创建时间
  - `updated_at`：书签最后修改时间
- `summary` 与 `note` 不重复：
  - `summary` 回答“这篇内容在讲什么”
  - `note` 回答“我为什么保存它”
- `type` 建议枚举：
  - `article`
  - `video`
  - `tool`
  - `docs`
  - `paper`
  - `other`

### 7.3.2 tags

- 作用：标签实体；tag 必须有稳定 id，不能只靠名字
- 当前字段：
  - `id`
  - `name`
  - `slug`
  - `created_at`
  - `updated_at`
- 字段说明：
  - `id`：内部稳定主键，用于关联关系
  - `name`：展示名称，例如 `AI`
  - `slug`：标准写法，例如 `ai`，用于规范化和查重
  - `created_at` / `updated_at`：用于排序、审计与同步扩展

### 7.3.3 tag_aliases

- 作用：维护别名到 canonical tag 的映射，避免 tag 爆炸
- 说明：数据模型先预留，产品能力后续开放
- 可选字段：
  - `id`
  - `alias`
  - `normalized_alias`
  - `tag_id`
  - `source`（user/ai/system）
  - `created_at`

### 7.3.4 bookmark_tags

- 作用：书签与标签的多对多映射
- 当前字段：
  - `bookmark_id`
  - `tag_id`
  - `source`（user/ai/rule）
  - `confidence`
  - `status`（active/rejected）
  - `created_at`
- 说明：
  - `source` 用于区分标签来源，便于后续分析 AI 建议效果
  - `confidence` 主要用于 AI 标签；用户手动标签可为空
  - `status` 用于表达 AI 标签被接受或拒绝

### 7.3.5 saved_queries

- 作用：保存筛选条件与视图配置；本质是“保存一条查询”，不是只存 tag 列表
- 当前字段：
  - `id`
  - `name`
  - `query_ast`
  - `sort_spec`
  - `view_mode`
  - `pinned`
  - `created_at`
  - `updated_at`
- 说明：
  - `query_ast` 用于表达 `AND / NOT / keyword / domain / sort`
  - 后续若支持 `OR`，不需要推翻模型，只扩展 AST 即可

### 7.3.6 user_feedback_events

- 作用：记录用户对 AI 建议的接受、拒绝、替换行为
- 建议字段：
  - `id`
  - `bookmark_id`
  - `event_type`
  - `payload`
  - `created_at`

## 7.4 查询与搜索执行

- 查询主要由 Worker + D1 执行
- 当前搜索范围：
  - `title`
  - `note`
  - `summary`
  - `type`
  - `domain`
  - `tags`
- Saved Query 的执行流程：
  - 先解析 `query_ast`
  - 再转为 D1 查询条件
  - 最后做排序和视图投影
- 当前方案不要求全文正文搜索；正文全文检索放到后续阶段
- 若后续需要更强搜索，可考虑：
  - D1 FTS 或外部搜索索引
  - 将正文、chunk、embedding 放入 `R2` 或其他内容层

## 7.5 AI 集成

### 7.5.1 调用路径

- Worker 负责：
  - 页面抓取编排
  - 内容提取
  - 提示词组织
  - JSON schema 校验
  - 通过 Cloudflare `Workers AI` 调用模型
  - 失败重试与限流
- 当前推荐模型：
  - 默认使用 `@cf/meta/llama-3.1-8b-instruct`（支持 JSON mode，快速且经济）
  - 若后续更强调摘要和标签质量，可升级到 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- 输出方式：
  - 优先使用 JSON Mode 或等价的结构化输出约束，确保 `type + summary + tags` 稳定落为 JSON

### 7.5.2 处理流程

1. 保存 URL
2. Worker 拉取页面并提取 `title/domain`
3. Worker 抓取页面并抽取内容
4. 规则层给出基础 tag
5. LLM 输出 `type + summary + tags`
6. 结果写入 D1，并记录反馈事件

### 7.5.3 稳定性原则

- AI 结果只作为建议，不直接替代用户意图
- 高置信度 tag 可默认勾选，但保留显式确认
- 同一 `canonical_url` 优先复用历史结果，降低成本与波动
- 模型选择优先满足结构化稳定性、延迟和成本，再追求更强推理能力

# 8. 规则与算法

## 8.1 标签生成策略

1. 规则层：`domain/type` → 基础 tag
2. 映射层：alias 归一化到 canonical tag
3. LLM 建议层：输出补充 tags、type、summary
4. 缓存层：命中 `canonical_url` 时优先复用

## 8.2 Tag 规范化策略

- `slug` 作为标准写法：lowercase、trim、空格转 `-`
- `id` 作为内部稳定主键
- `name` 作为展示名
- `alias` 用于同义词与历史写法兼容
- 新 tag 创建前先做 `slug` 查重与 alias 命中检查

## 8.3 Saved Query 表达式

- 建议使用 AST，而不是只存 tag 数组
- 当前支持：
  - `AND`
  - `NOT`
  - keyword
  - domain
  - sort
- `OR` 作为表达式能力的一部分保留在模型中

## 8.4 纠错学习

- 用户删除 AI tag：记录 `tag_rejected`
- 用户新增 tag：记录 `tag_added`
- 用户替换 tag：记录 `tag_replaced`
- 后续推荐优先参考：
  - 用户历史接受率
  - domain 偏好
  - tag 共现关系

# 9. 账户与同步边界

- 当前方案以单用户为前提
- 不做多人实时协作
- 若未来支持多设备缓存同步，可在 D1 基础上增加浏览器本地缓存与同步策略
- 若未来支持 workspace 或团队，再引入 scope 与权限模型

# 10. 性能与非功能要求

## 10.1 性能目标

- 搜索/筛选响应：< 200ms（D1 查询 + 应用层组装）
- 列表首屏：< 1s
- 保存 URL：无 AI < 1s；含 AI 的异步补全 < 4s

## 10.2 可用性

- AI 服务异常时仍可保存，后续补全
- 抓取失败时回退到 `title/url/domain`
- 数据库写入失败时返回明确错误；前端允许用户重试

## 10.3 数据安全

- 用户数据按用户隔离
- 支持导出、清除
- AI key 若支持 BYOK，应仅用于服务端代理调用，不直接暴露为平台级密钥

# 11. 风险与对策

## 风险 1：tag 爆炸导致检索失控

- 对策：`slug` 唯一、alias、merge、补全优先、AI 优先复用已有 tag

## 风险 2：AI 不稳定降低信任

- 对策：默认半自动、JSON schema 校验、规则优先、用户反馈回流

## 风险 3：URL 去重不稳定

- 对策：保守实现 `canonical_url` 规范化，只移除明显追踪参数，避免错误合并

## 风险 4：过早引入复杂内容层

- 对策：当前方案只保存结构化元数据；原始 HTML、全文、chunk、embedding 全部后置

# 附录 A：Query 语法（建议）

- AND：多 tag 选择默认 AND
- NOT：排除 tag
- OR
- domain filter
- created filter

# 附录 B：AI 输出 JSON Schema（示例）

```json
{
  "type": "article",
  "summary": "一句话描述这篇内容在讲什么。",
  "tags": [
    { "slug": "ai", "confidence": 0.92 },
    { "slug": "llm", "confidence": 0.83 },
    { "slug": "paper", "confidence": 0.71 }
  ]
}
```

## Todo list

- ai 抓去不对的地方，可以认为的输入一段话，然后 AI 补全一下
