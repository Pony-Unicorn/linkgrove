# Developer & Agent Guidelines

> AI Agent 在生成、修改、审查本目录代码时，必须遵守本规范。

## 0. 规则优先级

1. 硬性禁令（MUST NOT）
2. MUST（必须）
3. SHOULD（建议）

如规则冲突，按上面顺序执行。

---

## 1. 项目概览

Linkgrove 是一个 Tag-first 个人书签管理工具，部署在 Cloudflare Workers 上。

```
/
├── src/
│   └── index.ts          # 全部后端逻辑（Hono 路由 + Kysely + AI）
├── public/
│   └── index.html        # 全部前端逻辑（Alpine.js 单文件 SPA）
├── migrations/
│   └── 0001_initial.sql  # D1 数据库 schema
├── wrangler.toml          # Cloudflare Workers 配置
└── worker-configuration.d.ts  # 由 `pnpm cf-typegen` 自动生成，勿手动修改
```

---

## 2. 后端规范（src/index.ts）

### 硬性禁令

- 禁止拆分路由文件，所有路由写在 `src/index.ts` 一个文件中。
- 禁止手动编写 `Env` / `CloudflareBindings` 类型，必须通过 `pnpm cf-typegen` 生成。
- 禁止直接使用 `c.env.DB.prepare(sql)` 原始 SQL，必须使用 Kysely。
- 禁止引入 ORM、连接池、Redis、队列、Durable Objects 等额外基础设施。

### 技术栈

- **运行时**：Cloudflare Workers（TypeScript，由 Wrangler/esbuild 编译）
- **路由**：Hono `new Hono<{ Bindings: CloudflareBindings }>()`
- **数据库**：Cloudflare D1 + Kysely（`kysely-d1` dialect）
- **AI**：Cloudflare Workers AI，模型 `@cf/meta/llama-3.1-8b-instruct`

### Kysely 使用规范

- 每个请求内调用 `createDb(c.env.DB)` 创建实例，不复用跨请求实例。
- DB schema 类型定义在文件顶部（`BookmarkTable`、`TagTable`、`BookmarkTagTable`、`DB`）。
- 动态别名表（如多 tag JOIN）允许使用 `as any`，其余禁止。

### API 规范

- 所有接口路径以 `/api/` 开头。
- 响应统一格式：成功 `{ ok: true, data: ... }`，失败 `{ ok: false, error: '...' }`。
- HTTP 状态码：200 成功、201 创建、400 参数错误、404 不存在、409 冲突、502 上游失败。

### 已有路由（Task 2–4 新增）

- `GET /api/tags/:id/aliases` — 获取标签别名列表
- `POST /api/tags/:id/aliases` — 添加标签别名
- `DELETE /api/tags/:id/aliases/:aliasId` — 删除标签别名
- `POST /api/tags/:id/merge` — 将源标签合并到目标标签（body: `{ target_tag_id }`）
- `GET /api/saved-queries` — 获取全部智能集合
- `POST /api/saved-queries` — 创建智能集合
- `PUT /api/saved-queries/:id` — 更新智能集合（name/query/sort_by/sort_dir）
- `DELETE /api/saved-queries/:id` — 删除智能集合
- `PATCH /api/saved-queries/:id/pin` — 切换智能集合置顶状态
- `POST /api/feedback` — 上报 AI 标签推荐反馈事件（body: `{ bookmark_id, event_type, payload }`）

### 命令

```bash
pnpm dev          # 本地开发
pnpm deploy       # 部署到 Cloudflare
pnpm cf-typegen   # 根据 wrangler.toml 重新生成 worker-configuration.d.ts（修改 binding 后必须执行）
```

---

## 3. 前端规范（public/index.html）

### 硬性禁令

- 禁止拆分 JS/CSS 文件，所有逻辑内联在 `public/index.html` 单文件中。
- 禁止使用构建工具（Vite/Webpack 等）。
- 禁止使用 ES Modules（`type="module"`、`import/export`）。
- 禁止使用 `<iconify-icon>` 组件，图标必须内联 SVG。
- 禁止创建额外页面；`public/index.html` 是唯一页面。

### 技术栈与加载顺序

CDN 引入顺序（不可调换）：

1. DaisyUI CSS（`cdn.jsdelivr.net`）
2. Tailwind CSS Play CDN
3. Alpine.js 插件（如有）
4. Alpine.js 主库
5. Day.js（如需日期处理）

### Alpine.js 规范

- 所有页面逻辑在 `document.addEventListener('alpine:init', () => { Alpine.data(...) })` 中注册。
- 组件命名：`[feature]Page`（如 `indexPage`）。
- 布尔状态：`is/has/show` 前缀（`isLoading`、`showModal`）。
- 交互函数：`handle/toggle` 前缀（`handleSubmit()`、`toggleSidebar()`）。
- 请求函数：`fetch` 前缀（`fetchBookmarks()`）。

### API 调用规范

- 统一使用原生 `fetch`，解析响应用 `const json = await resp.json(); json.data`。
- 所有请求必须有 `try/catch` 和 `loading` 状态。
- 写操作按钮必须有 loading 态并 `disabled`。

### 交互反馈规范

- 读操作失败：在数据模块内就地显示简短错误文案 + 重试按钮。
- 写操作反馈：使用 DaisyUI `alert` 内联提示。
- 弹窗：使用 DaisyUI `<dialog>` + Alpine `x-ref`，打开用 `$refs.modal.showModal()`，关闭用 `<form method="dialog">`。

---

## 4. 数据库规范（migrations/）

- ID 字段统一用 `TEXT`，存 nanoid 风格随机字符串（由后端 `generateId()` 生成）。
- 时间戳字段用 `INTEGER`，存 Unix 秒（由后端 `now()` 生成）。
- 新增表或字段必须创建新的迁移文件，禁止修改已有迁移文件。
- 本地应用：`wrangler d1 migrations apply linkgrove --local`
- 远端应用：`wrangler d1 migrations apply linkgrove --remote`

### 已有表

核心表：`bookmarks`、`tags`、`bookmark_tags`

扩展表（Task 2–4 新增）：
- `tag_aliases`：存储标签别名，关联 `tags.id`
- `saved_queries`：存储用户保存的筛选集合（智能集合），含 `pinned` 字段
- `user_feedback_events`：记录用户对 AI 推荐标签的接受/拒绝反馈事件

---

## 5. 提交前检查清单

**后端**
- [ ] 无裸 SQL 字符串拼接，全部使用 Kysely
- [ ] 新增 binding 后已执行 `pnpm cf-typegen`
- [ ] API 响应格式符合 `{ ok, data/error }` 规范

**前端**
- [ ] 仅产出 `public/index.html` 一个文件
- [ ] 图标为内联 SVG，无 `<iconify-icon>`
- [ ] 逻辑在 `alpine:init` 内注册
- [ ] 读操作有 loading 和错误重试
- [ ] 写操作按钮有 loading + disabled
