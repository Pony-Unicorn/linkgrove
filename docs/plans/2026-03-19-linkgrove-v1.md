# Linkgrove V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建 Tag-first 个人链接知识库，支持书签 CRUD、AI 自动补全标题/摘要/标签、标签管理、关键词+标签组合搜索。

**Architecture:** Cloudflare Workers 承载 API 逻辑 + 静态 HTML 资产（Workers Assets）；D1 存储书签、标签、映射关系；Workers AI 提供结构化 summary/type/tags 建议；前端为纯 Alpine.js 单文件 HTML，无构建步骤。

**Tech Stack:** Cloudflare Workers (Hono) · Cloudflare D1 · Cloudflare Workers AI · Alpine.js + Tailwind + DaisyUI (CDN) · Day.js

---

## V1 范围说明

首版**包含**：书签 CRUD、AI 内容补全（点击触发）、标签管理（增删改）、关键词搜索、标签筛选、基础列表页。

首版**不包含**：Saved Query、批量操作、导入导出、tag_aliases、user_feedback_events、全文正文检索。

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `wrangler.toml`
- Create: `.gitignore`
- Create: `src/index.js`（空骨架）

**Step 1: 创建 package.json**

```json
{
  "name": "linkgrove",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
```

**Step 2: 创建 wrangler.toml**

```toml
name = "linkgrove"
main = "src/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "public"
binding = "ASSETS"
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "linkgrove"
database_id = "REPLACE_AFTER_CREATE"

[ai]
binding = "AI"
```

**Step 3: 创建 .gitignore**

```
node_modules/
.wrangler/
dist/
.dev.vars
```

**Step 4: 创建空入口文件 src/index.js**

```js
import { Hono } from 'hono'

const app = new Hono()

app.get('/api/ping', (c) => c.json({ ok: true }))

export default app
```

**Step 5: 安装依赖**

```bash
npm install
```

**Step 6: 创建 D1 数据库**

```bash
npx wrangler d1 create linkgrove
```

将命令输出的 `database_id` 填入 `wrangler.toml`。

**Step 7: 创建 public 目录并复制 favicon**

```bash
mkdir -p public
cp favicon.png public/favicon.png
```

**Step 8: 验证 Workers 能启动**

```bash
npm run dev
```

访问 `http://localhost:8787/api/ping`，预期返回 `{"ok":true}`。

---

## Task 2: D1 数据库 Schema

**Files:**
- Create: `migrations/0001_initial.sql`

**Step 1: 创建迁移文件**

```sql
-- migrations/0001_initial.sql

CREATE TABLE IF NOT EXISTS bookmarks (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  domain      TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'other',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_domain ON bookmarks(domain);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks(created_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'user',   -- user | ai | rule
  confidence  REAL,
  status      TEXT NOT NULL DEFAULT 'active', -- active | rejected
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmark_tags_bookmark ON bookmark_tags(bookmark_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag ON bookmark_tags(tag_id);
```

**Step 2: 在本地 D1 执行迁移**

```bash
npx wrangler d1 migrations apply linkgrove --local
```

预期输出：`Migrations applied successfully.`

**Step 3: 验证表结构**

```bash
npx wrangler d1 execute linkgrove --local --command "SELECT name FROM sqlite_master WHERE type='table';"
```

预期输出包含：`bookmarks`、`tags`、`bookmark_tags`

---

## Task 3: 工具函数层

**Files:**
- Create: `src/utils.js`

**Step 1: 创建工具函数（ID 生成、slug、canonical URL、错误响应）**

```js
// src/utils.js

/** 生成 nanoid 风格的随机 ID（不依赖外部库）*/
export function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  const bytes = crypto.getRandomValues(new Uint8Array(21))
  for (const b of bytes) id += chars[b % chars.length]
  return id
}

/** tag slug 规范化：lowercase、trim、空格转- */
export function toSlug(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-\u4e00-\u9fff]/g, '')
}

/** canonical URL：移除常见追踪参数 */
const TRACKING_PARAMS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','ref','fbclid','gclid']

export function toCanonicalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p)
    return u.toString()
  } catch {
    return rawUrl
  }
}

/** 从 URL 提取 domain */
export function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 统一错误响应 */
export function errorResponse(c, status, message) {
  return c.json({ ok: false, error: message }, status)
}

/** 当前 Unix 时间戳（秒） */
export function now() {
  return Math.floor(Date.now() / 1000)
}
```

---

## Task 4: 书签 API

**Files:**
- Create: `src/routes/bookmarks.js`
- Modify: `src/index.js`

**Step 1: 创建书签路由文件**

```js
// src/routes/bookmarks.js
import { Hono } from 'hono'
import { generateId, toCanonicalUrl, extractDomain, errorResponse, now } from '../utils.js'

const bookmarks = new Hono()

// GET /api/bookmarks?q=&tags=a,b&domain=&limit=&offset=
bookmarks.get('/', async (c) => {
  const { q = '', tags = '', domain = '', limit = '50', offset = '0' } = c.req.query()
  const db = c.env.DB
  const lim = Math.min(parseInt(limit) || 50, 200)
  const off = parseInt(offset) || 0

  let sql = `
    SELECT DISTINCT b.id, b.url, b.title, b.domain, b.summary, b.type, b.note, b.created_at, b.updated_at
    FROM bookmarks b
  `
  const params = []
  const conditions = []

  const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []

  if (tagList.length > 0) {
    for (let i = 0; i < tagList.length; i++) {
      sql += ` JOIN bookmark_tags bt${i} ON bt${i}.bookmark_id = b.id
               JOIN tags tg${i} ON tg${i}.id = bt${i}.tag_id AND bt${i}.status = 'active'`
      conditions.push(`tg${i}.slug = ?`)
      params.push(tagList[i])
    }
  }

  if (q) {
    conditions.push(`(b.title LIKE ? OR b.summary LIKE ? OR b.note LIKE ?)`)
    params.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }

  if (domain) {
    conditions.push(`b.domain = ?`)
    params.push(domain)
  }

  if (conditions.length > 0) sql += ` WHERE ` + conditions.join(' AND ')
  sql += ` ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
  params.push(lim, off)

  const { results } = await db.prepare(sql).bind(...params).all()

  // 查每个书签的 tags
  const ids = results.map(r => r.id)
  let tagMap = {}
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    const { results: tagRows } = await db.prepare(
      `SELECT bt.bookmark_id, t.id, t.name, t.slug, bt.source, bt.confidence, bt.status
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.bookmark_id IN (${placeholders}) AND bt.status = 'active'`
    ).bind(...ids).all()
    for (const row of tagRows) {
      if (!tagMap[row.bookmark_id]) tagMap[row.bookmark_id] = []
      tagMap[row.bookmark_id].push({ id: row.id, name: row.name, slug: row.slug, source: row.source, confidence: row.confidence })
    }
  }

  const data = results.map(r => ({ ...r, tags: tagMap[r.id] || [] }))
  return c.json({ ok: true, data })
})

// POST /api/bookmarks
bookmarks.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.url) return errorResponse(c, 400, 'url is required')

  let rawUrl = body.url.trim()
  if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl

  const db = c.env.DB
  const canonical = toCanonicalUrl(rawUrl)
  const domain = extractDomain(rawUrl)
  const ts = now()
  const id = generateId()

  const tagIds = body.tag_ids || []

  await db.prepare(
    `INSERT INTO bookmarks (id, url, canonical_url, title, domain, summary, note, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, rawUrl, canonical, body.title || rawUrl, domain, body.summary || '', body.note || '', body.type || 'other', ts, ts).run()

  for (const tagId of tagIds) {
    await db.prepare(
      `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, confidence, status, created_at)
       VALUES (?, ?, 'user', NULL, 'active', ?)`
    ).bind(id, tagId, ts).run()
  }

  const { results: [bookmark] } = await db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: bookmark }, 201)
})

// PUT /api/bookmarks/:id
bookmarks.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  if (!body) return errorResponse(c, 400, 'body required')

  const db = c.env.DB
  const ts = now()

  const { results: [existing] } = await db.prepare(`SELECT id FROM bookmarks WHERE id = ?`).bind(id).all()
  if (!existing) return errorResponse(c, 404, 'bookmark not found')

  await db.prepare(
    `UPDATE bookmarks SET title=?, summary=?, note=?, type=?, updated_at=? WHERE id=?`
  ).bind(body.title, body.summary || '', body.note || '', body.type || 'other', ts, id).run()

  // 更新 tags：先清除 user 来源的，再重新写入
  if (Array.isArray(body.tag_ids)) {
    await db.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ? AND source = 'user'`).bind(id).run()
    for (const tagId of body.tag_ids) {
      await db.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, confidence, status, created_at)
         VALUES (?, ?, 'user', NULL, 'active', ?)`
      ).bind(id, tagId, ts).run()
    }
  }

  const { results: [bookmark] } = await db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: bookmark })
})

// DELETE /api/bookmarks/:id
bookmarks.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const { results: [existing] } = await db.prepare(`SELECT id FROM bookmarks WHERE id = ?`).bind(id).all()
  if (!existing) return errorResponse(c, 404, 'bookmark not found')
  await db.prepare(`DELETE FROM bookmarks WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

export default bookmarks
```

**Step 2: 注册路由到 src/index.js**

```js
// src/index.js
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import bookmarks from './routes/bookmarks.js'
import tags from './routes/tags.js'
import ai from './routes/ai.js'

const app = new Hono()

app.use('/api/*', cors())

app.get('/api/ping', (c) => c.json({ ok: true }))
app.route('/api/bookmarks', bookmarks)
app.route('/api/tags', tags)
app.route('/api/ai', ai)

export default app
```

**Step 3: 本地验证**

```bash
npm run dev
# 新终端
curl -X POST http://localhost:8787/api/bookmarks \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","title":"Example"}'
```

预期：HTTP 201，返回包含 `id` 的书签对象。

---

## Task 5: 标签 API

**Files:**
- Create: `src/routes/tags.js`

**Step 1: 创建标签路由**

```js
// src/routes/tags.js
import { Hono } from 'hono'
import { generateId, toSlug, errorResponse, now } from '../utils.js'

const tags = new Hono()

// GET /api/tags?q=
tags.get('/', async (c) => {
  const { q = '' } = c.req.query()
  const db = c.env.DB
  let sql = `SELECT t.id, t.name, t.slug, t.created_at,
               COUNT(bt.tag_id) as usage_count
             FROM tags t
             LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id AND bt.status = 'active'`
  const params = []
  if (q) {
    sql += ` WHERE t.name LIKE ? OR t.slug LIKE ?`
    params.push(`%${q}%`, `%${q}%`)
  }
  sql += ` GROUP BY t.id ORDER BY usage_count DESC, t.name ASC`
  const { results } = await db.prepare(sql).bind(...params).all()
  return c.json({ ok: true, data: results })
})

// POST /api/tags
tags.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.name) return errorResponse(c, 400, 'name is required')

  const slug = toSlug(body.name)
  if (!slug) return errorResponse(c, 400, 'invalid tag name')

  const db = c.env.DB
  const { results: [existing] } = await db.prepare(`SELECT id FROM tags WHERE slug = ?`).bind(slug).all()
  if (existing) return c.json({ ok: true, data: existing }) // 幂等：slug 已存在直接返回

  const id = generateId()
  const ts = now()
  await db.prepare(`INSERT INTO tags (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, body.name.trim(), slug, ts, ts).run()

  const { results: [tag] } = await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: tag }, 201)
})

// PUT /api/tags/:id  (重命名)
tags.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  if (!body?.name) return errorResponse(c, 400, 'name is required')

  const db = c.env.DB
  const { results: [existing] } = await db.prepare(`SELECT id FROM tags WHERE id = ?`).bind(id).all()
  if (!existing) return errorResponse(c, 404, 'tag not found')

  const newSlug = toSlug(body.name)
  const { results: [conflict] } = await db.prepare(`SELECT id FROM tags WHERE slug = ? AND id != ?`).bind(newSlug, id).all()
  if (conflict) return errorResponse(c, 409, 'slug already exists')

  const ts = now()
  await db.prepare(`UPDATE tags SET name=?, slug=?, updated_at=? WHERE id=?`)
    .bind(body.name.trim(), newSlug, ts, id).run()

  const { results: [tag] } = await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: tag })
})

// DELETE /api/tags/:id
tags.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const { results: [existing] } = await db.prepare(`SELECT id FROM tags WHERE id = ?`).bind(id).all()
  if (!existing) return errorResponse(c, 404, 'tag not found')
  await db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

export default tags
```

**Step 2: 验证标签 API**

```bash
curl -X POST http://localhost:8787/api/tags \
  -H "Content-Type: application/json" \
  -d '{"name":"AI"}'
# 预期：201，返回 {id, name:"AI", slug:"ai"}

curl http://localhost:8787/api/tags
# 预期：200，返回标签列表
```

---

## Task 6: URL 元数据抓取 + AI 补全 API

**Files:**
- Create: `src/routes/ai.js`
- Create: `src/services/fetcher.js`

**Step 1: 创建页面内容抓取服务**

```js
// src/services/fetcher.js

/**
 * 抓取 URL 的 title、description、og 信息
 * 使用 HTMLRewriter 流式提取，不保存完整 HTML
 */
export async function fetchPageMeta(url) {
  const result = { title: '', description: '', ogTitle: '', ogDescription: '' }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Linkgrove/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })

    if (!resp.ok) return result

    const contentType = resp.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) return result

    await new HTMLRewriter()
      .on('title', {
        text(chunk) { result.title += chunk.text }
      })
      .on('meta[name="description"]', {
        element(el) { result.description = el.getAttribute('content') || '' }
      })
      .on('meta[property="og:title"]', {
        element(el) { result.ogTitle = el.getAttribute('content') || '' }
      })
      .on('meta[property="og:description"]', {
        element(el) { result.ogDescription = el.getAttribute('content') || '' }
      })
      .transform(resp)
      .text() // 消费响应体触发 HTMLRewriter

  } catch (e) {
    // 抓取失败时降级，返回空值
  }

  return {
    title: (result.ogTitle || result.title || '').trim().slice(0, 500),
    description: (result.ogDescription || result.description || '').trim().slice(0, 2000),
  }
}
```

**Step 2: 创建 AI 路由**

```js
// src/routes/ai.js
import { Hono } from 'hono'
import { errorResponse } from '../utils.js'
import { fetchPageMeta } from '../services/fetcher.js'

const ai = new Hono()

const AI_PROMPT = (title, description, url) => `
你是一个书签整理助手。根据以下网页信息，输出 JSON 格式的结构化数据。

URL: ${url}
标题: ${title}
描述: ${description}

请输出以下 JSON 格式（不要输出任何其他内容）：
{
  "type": "article|video|tool|docs|paper|other",
  "summary": "一句话描述这个页面的内容（中文，30字以内）",
  "tags": [
    {"slug": "标签slug（英文小写，连字符分隔）", "name": "标签名（中文或英文）", "confidence": 0.9}
  ]
}

tags 输出 3~6 个，按置信度从高到低排序。slug 必须是英文小写。
`.trim()

// POST /api/ai/enrich  { url, title?, description? }
ai.post('/enrich', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.url) return errorResponse(c, 400, 'url is required')

  // 1. 抓取页面元数据
  const meta = await fetchPageMeta(body.url)
  const title = body.title || meta.title || body.url
  const description = meta.description || ''

  // 2. 调用 Workers AI
  let aiResult = null
  try {
    const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: AI_PROMPT(title, description, body.url),
      max_tokens: 512,
      response_format: { type: 'json_object' },
    })
    const text = resp.response || ''
    // 提取 JSON（模型可能输出额外文本）
    const match = text.match(/\{[\s\S]*\}/)
    if (match) aiResult = JSON.parse(match[0])
  } catch (e) {
    return errorResponse(c, 502, 'AI enrichment failed: ' + (e?.message || 'unknown'))
  }

  if (!aiResult) return errorResponse(c, 502, 'AI returned invalid response')

  // 3. 校验并清洗输出
  const validTypes = ['article', 'video', 'tool', 'docs', 'paper', 'other']
  const type = validTypes.includes(aiResult.type) ? aiResult.type : 'other'
  const summary = typeof aiResult.summary === 'string' ? aiResult.summary.slice(0, 200) : ''
  const tags = Array.isArray(aiResult.tags)
    ? aiResult.tags
        .filter(t => t?.slug && t?.name)
        .map(t => ({
          slug: String(t.slug).toLowerCase().replace(/\s+/g, '-').slice(0, 50),
          name: String(t.name).slice(0, 50),
          confidence: typeof t.confidence === 'number' ? Math.min(1, Math.max(0, t.confidence)) : 0.5,
        }))
        .slice(0, 6)
    : []

  return c.json({
    ok: true,
    data: {
      title,
      description,
      type,
      summary,
      tags,
    }
  })
})

export default ai
```

**Step 3: 验证（需要 wrangler dev，AI 本地调用需要登录 Cloudflare）**

```bash
curl -X POST http://localhost:8787/api/ai/enrich \
  -H "Content-Type: application/json" \
  -d '{"url":"https://blog.cloudflare.com/workers-ai"}'
```

预期：返回 `{ok:true, data:{title, type, summary, tags:[...]}}`

若 AI 无法本地调用，跳过，部署后验证。

---

## Task 7: 前端主页面（书签列表 + 保存 + AI 补全）

**Files:**
- Create: `public/index.html`（以 template.html 为基础）

**Step 1: 创建主页面**

完整文件内容见下方。此页面包含：
- 顶部导航（Logo + 搜索框）
- 左侧边栏（标签筛选）
- 主区域（书签列表 + 保存书签 Modal）
- AI 补全流程：输入 URL → 点击"AI 补全" → 填充 title/summary/type/tags → 用户确认 → 保存

```html
<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Linkgrove</title>
  <link rel="icon" href="/favicon.png" />
  <link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.8/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.19/dayjs.min.js"></script>
</head>
<body class="min-h-screen bg-base-200 text-base-content">

<div x-data="indexPage" class="min-h-screen flex flex-col">

  <!-- 全局提示条 -->
  <div class="relative z-30">
    <div
      x-show="$store.alert.visible"
      x-transition:enter="transition ease-out duration-200"
      x-transition:enter-start="opacity-0 -translate-y-2"
      x-transition:enter-end="opacity-100 translate-y-0"
      x-transition:leave="transition ease-in duration-150"
      x-transition:leave-start="opacity-100 translate-y-0"
      x-transition:leave-end="opacity-0 -translate-y-2"
      class="absolute inset-x-0 pt-2"
      role="alert"
    >
      <div class="max-w-6xl mx-auto px-4">
        <div :class="'alert alert-' + $store.alert.type" class="shadow-md">
          <span x-text="$store.alert.message"></span>
          <button class="btn btn-ghost btn-sm btn-square ml-auto" @click="$store.alert.dismiss()">
            <!-- lucide: x -->
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 顶部导航 -->
  <header class="border-b border-base-300 bg-base-100/95 backdrop-blur sticky top-0 z-20">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
      <!-- Logo -->
      <div class="flex items-center gap-2 shrink-0">
        <div class="w-8 h-8 rounded-lg bg-primary/15 text-primary grid place-items-center">
          <!-- lucide: bookmark -->
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
        </div>
        <span class="font-bold text-lg tracking-tight">Linkgrove</span>
      </div>

      <!-- 搜索框 -->
      <div class="flex-1 max-w-lg">
        <input
          type="search"
          class="input input-bordered input-sm w-full"
          placeholder="搜索标题、摘要、备注..."
          x-model.debounce.400ms="searchQuery"
          @input="fetchBookmarks()"
          aria-label="搜索书签"
        />
      </div>

      <!-- 保存书签按钮 -->
      <button class="btn btn-primary btn-sm gap-1" @click="$refs.saveModal.showModal()">
        <!-- lucide: plus -->
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        保存链接
      </button>
    </div>
  </header>

  <!-- 主体：侧边栏 + 内容 -->
  <div class="flex-1 max-w-6xl mx-auto w-full px-4 py-6 flex gap-6">

    <!-- 左侧：标签筛选 -->
    <aside class="hidden md:flex flex-col gap-2 w-48 shrink-0">
      <div class="flex items-center justify-between mb-1">
        <h2 class="text-sm font-semibold opacity-60 uppercase tracking-wide">标签</h2>
        <button class="btn btn-ghost btn-xs" @click="clearTagFilter()" x-show="selectedTags.length > 0">清除</button>
      </div>

      <div x-show="isLoadingTags" class="space-y-2">
        <div class="skeleton h-6 w-full rounded-full"></div>
        <div class="skeleton h-6 w-4/5 rounded-full"></div>
        <div class="skeleton h-6 w-3/5 rounded-full"></div>
      </div>

      <div x-show="tagsError" class="text-xs text-error">
        <span x-text="tagsError"></span>
        <button class="link ml-1" @click="fetchTags()">重试</button>
      </div>

      <template x-for="tag in allTags" :key="tag.id">
        <button
          class="flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors text-left"
          :class="selectedTags.includes(tag.slug) ? 'bg-primary text-primary-content' : 'hover:bg-base-300'"
          @click="toggleTag(tag.slug)"
        >
          <span class="truncate" x-text="tag.name"></span>
          <span class="text-xs opacity-60 ml-1" x-text="tag.usage_count"></span>
        </button>
      </template>

      <button class="btn btn-ghost btn-xs mt-2 self-start" @click="$refs.tagsModal.showModal()">
        管理标签
      </button>
    </aside>

    <!-- 主内容：书签列表 -->
    <main class="flex-1 min-w-0">

      <!-- 当前筛选状态 -->
      <div class="flex items-center gap-2 mb-4 flex-wrap" x-show="selectedTags.length > 0">
        <span class="text-sm opacity-60">已选标签：</span>
        <template x-for="slug in selectedTags" :key="slug">
          <div class="badge badge-primary gap-1">
            <span x-text="slug"></span>
            <button @click="toggleTag(slug)" aria-label="移除标签筛选">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </template>
      </div>

      <!-- loading -->
      <div x-show="isLoadingBookmarks" class="space-y-3">
        <div class="skeleton h-20 w-full rounded-xl"></div>
        <div class="skeleton h-20 w-full rounded-xl"></div>
        <div class="skeleton h-20 w-full rounded-xl"></div>
      </div>

      <!-- 错误 -->
      <div x-show="bookmarksError" class="alert">
        <span x-text="bookmarksError"></span>
        <button class="btn btn-sm" @click="fetchBookmarks()">重试</button>
      </div>

      <!-- 空状态 -->
      <div x-show="!isLoadingBookmarks && !bookmarksError && bookmarks.length === 0" class="text-center py-20 opacity-50">
        <p class="text-lg">还没有书签</p>
        <p class="text-sm mt-1">点击右上角「保存链接」开始添加</p>
      </div>

      <!-- 书签列表 -->
      <div x-show="!isLoadingBookmarks && !bookmarksError" class="space-y-3">
        <template x-for="bm in bookmarks" :key="bm.id">
          <article class="card bg-base-100 shadow-sm border border-base-300 hover:border-base-content/20 transition-colors">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <a :href="bm.url" target="_blank" rel="noopener noreferrer"
                     class="font-semibold leading-snug hover:text-primary transition-colors line-clamp-2"
                     x-text="bm.title || bm.url">
                  </a>
                  <p class="text-xs opacity-50 mt-0.5" x-text="bm.domain"></p>
                </div>
                <div class="shrink-0 flex gap-1">
                  <button class="btn btn-ghost btn-xs btn-square" @click="openEditModal(bm)" aria-label="编辑书签">
                    <!-- lucide: pencil -->
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                  </button>
                  <button class="btn btn-ghost btn-xs btn-square text-error" @click="deleteBookmark(bm.id)" aria-label="删除书签">
                    <!-- lucide: trash-2 -->
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                  </button>
                </div>
              </div>

              <p x-show="bm.summary" class="text-sm opacity-70 line-clamp-2" x-text="bm.summary"></p>

              <div class="flex items-center gap-2 flex-wrap">
                <template x-for="tag in bm.tags" :key="tag.id">
                  <button
                    class="badge badge-outline badge-sm hover:badge-primary transition-colors"
                    x-text="tag.name"
                    @click="toggleTag(tag.slug)"
                  ></button>
                </template>
                <span class="text-xs opacity-40 ml-auto" x-text="formatDate(bm.created_at)"></span>
              </div>
            </div>
          </article>
        </template>
      </div>

      <!-- 加载更多 -->
      <div class="text-center mt-6" x-show="hasMore && !isLoadingBookmarks">
        <button class="btn btn-ghost btn-sm" @click="loadMore()" :disabled="isLoadingMore">
          <span x-show="isLoadingMore" class="loading loading-spinner loading-xs"></span>
          加载更多
        </button>
      </div>
    </main>
  </div>

  <!-- ===== 保存书签 Modal ===== -->
  <dialog x-ref="saveModal" class="modal">
    <div class="modal-box w-full max-w-lg">
      <h3 class="font-bold text-lg mb-4">保存链接</h3>

      <form @submit.prevent="handleSaveBookmark()">
        <div class="space-y-4">

          <!-- URL 输入 -->
          <div class="form-control">
            <label class="label"><span class="label-text">URL <span class="text-error">*</span></span></label>
            <div class="flex gap-2">
              <input
                type="url"
                class="input input-bordered flex-1"
                placeholder="https://..."
                x-model="saveForm.url"
                required
              />
              <button
                type="button"
                class="btn btn-outline gap-1"
                :class="{ 'loading': isEnriching }"
                :disabled="!saveForm.url || isEnriching"
                @click="handleEnrich()"
              >
                <!-- lucide: sparkles -->
                <svg x-show="!isEnriching" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
                AI 补全
              </button>
            </div>
          </div>

          <!-- 标题 -->
          <div class="form-control">
            <label class="label"><span class="label-text">标题</span></label>
            <input type="text" class="input input-bordered" placeholder="页面标题" x-model="saveForm.title" />
          </div>

          <!-- 类型 -->
          <div class="form-control">
            <label class="label"><span class="label-text">类型</span></label>
            <select class="select select-bordered" x-model="saveForm.type">
              <option value="other">other</option>
              <option value="article">article</option>
              <option value="video">video</option>
              <option value="tool">tool</option>
              <option value="docs">docs</option>
              <option value="paper">paper</option>
            </select>
          </div>

          <!-- 摘要 -->
          <div class="form-control">
            <label class="label">
              <span class="label-text">摘要</span>
              <span class="label-text-alt opacity-60">AI 生成的内容描述</span>
            </label>
            <textarea class="textarea textarea-bordered h-16" placeholder="这个页面在讲什么..." x-model="saveForm.summary"></textarea>
          </div>

          <!-- 备注 -->
          <div class="form-control">
            <label class="label">
              <span class="label-text">备注</span>
              <span class="label-text-alt opacity-60">为什么保存这个链接</span>
            </label>
            <textarea class="textarea textarea-bordered h-16" placeholder="我保存它是因为..." x-model="saveForm.note"></textarea>
          </div>

          <!-- 标签 -->
          <div class="form-control">
            <label class="label"><span class="label-text">标签</span></label>
            <!-- 已选标签 -->
            <div class="flex flex-wrap gap-1 mb-2" x-show="saveForm.selectedTags.length > 0">
              <template x-for="tag in saveForm.selectedTags" :key="tag.id">
                <div class="badge badge-primary gap-1">
                  <span x-text="tag.name"></span>
                  <button type="button" @click="removeTagFromForm(tag)" aria-label="移除标签">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                  </button>
                </div>
              </template>
            </div>
            <!-- AI 建议标签 -->
            <div class="flex flex-wrap gap-1 mb-2" x-show="saveForm.suggestedTags.length > 0">
              <span class="text-xs opacity-50 self-center">AI 建议：</span>
              <template x-for="tag in saveForm.suggestedTags" :key="tag.slug">
                <button
                  type="button"
                  class="badge badge-outline badge-sm hover:badge-primary transition-colors"
                  x-text="tag.name"
                  @click="addSuggestedTag(tag)"
                ></button>
              </template>
            </div>
            <!-- 标签搜索/创建 -->
            <div class="flex gap-2">
              <input
                type="text"
                class="input input-bordered input-sm flex-1"
                placeholder="搜索或创建标签..."
                x-model="tagInput"
                @input="filterTagSuggestions()"
                @keydown.enter.prevent="addOrCreateTag()"
              />
              <button type="button" class="btn btn-sm btn-outline" @click="addOrCreateTag()" :disabled="!tagInput.trim()">添加</button>
            </div>
            <!-- 标签下拉建议 -->
            <div class="dropdown-content z-10 menu bg-base-200 rounded-box shadow mt-1 w-full max-h-40 overflow-auto"
                 x-show="tagSearchResults.length > 0 && tagInput.trim()">
              <template x-for="tag in tagSearchResults" :key="tag.id">
                <button type="button" class="flex items-center justify-between px-3 py-2 hover:bg-base-300 rounded text-sm text-left"
                        @click="selectTag(tag)">
                  <span x-text="tag.name"></span>
                  <span class="text-xs opacity-50" x-text="tag.slug"></span>
                </button>
              </template>
            </div>
          </div>

        </div>

        <div class="modal-action mt-6">
          <form method="dialog"><button class="btn btn-ghost">取消</button></form>
          <button type="submit" class="btn btn-primary" :disabled="isSaving || !saveForm.url" :class="{ 'loading': isSaving }">
            保存
          </button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop"><button>关闭</button></form>
  </dialog>

  <!-- ===== 编辑书签 Modal ===== -->
  <dialog x-ref="editModal" class="modal">
    <div class="modal-box w-full max-w-lg">
      <h3 class="font-bold text-lg mb-4">编辑书签</h3>

      <form @submit.prevent="handleUpdateBookmark()">
        <div class="space-y-4">
          <div class="form-control">
            <label class="label"><span class="label-text">标题</span></label>
            <input type="text" class="input input-bordered" x-model="editForm.title" />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">类型</span></label>
            <select class="select select-bordered" x-model="editForm.type">
              <option value="other">other</option>
              <option value="article">article</option>
              <option value="video">video</option>
              <option value="tool">tool</option>
              <option value="docs">docs</option>
              <option value="paper">paper</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">摘要</span></label>
            <textarea class="textarea textarea-bordered h-16" x-model="editForm.summary"></textarea>
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">备注</span></label>
            <textarea class="textarea textarea-bordered h-16" x-model="editForm.note"></textarea>
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">标签</span></label>
            <div class="flex flex-wrap gap-1 mb-2">
              <template x-for="tag in editForm.selectedTags" :key="tag.id">
                <div class="badge badge-primary gap-1">
                  <span x-text="tag.name"></span>
                  <button type="button" @click="removeTagFromEditForm(tag)">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                  </button>
                </div>
              </template>
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                class="input input-bordered input-sm flex-1"
                placeholder="搜索或创建标签..."
                x-model="editTagInput"
                @input="filterEditTagSuggestions()"
                @keydown.enter.prevent="addOrCreateEditTag()"
              />
              <button type="button" class="btn btn-sm btn-outline" @click="addOrCreateEditTag()" :disabled="!editTagInput.trim()">添加</button>
            </div>
            <div class="bg-base-200 rounded-box mt-1 w-full max-h-40 overflow-auto"
                 x-show="editTagSearchResults.length > 0 && editTagInput.trim()">
              <template x-for="tag in editTagSearchResults" :key="tag.id">
                <button type="button" class="flex items-center justify-between px-3 py-2 hover:bg-base-300 rounded text-sm w-full text-left"
                        @click="selectEditTag(tag)">
                  <span x-text="tag.name"></span>
                  <span class="text-xs opacity-50" x-text="tag.slug"></span>
                </button>
              </template>
            </div>
          </div>
        </div>
        <div class="modal-action mt-6">
          <form method="dialog"><button class="btn btn-ghost">取消</button></form>
          <button type="submit" class="btn btn-primary" :disabled="isUpdating" :class="{ 'loading': isUpdating }">保存</button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop"><button>关闭</button></form>
  </dialog>

  <!-- ===== 标签管理 Modal ===== -->
  <dialog x-ref="tagsModal" class="modal">
    <div class="modal-box w-full max-w-md">
      <h3 class="font-bold text-lg mb-4">管理标签</h3>

      <div class="flex gap-2 mb-4">
        <input type="text" class="input input-bordered input-sm flex-1" placeholder="新标签名称..." x-model="newTagName" @keydown.enter.prevent="handleCreateTag()" />
        <button class="btn btn-primary btn-sm" @click="handleCreateTag()" :disabled="isCreatingTag || !newTagName.trim()" :class="{ 'loading': isCreatingTag }">创建</button>
      </div>

      <div class="space-y-2 max-h-80 overflow-auto">
        <template x-for="tag in allTags" :key="tag.id">
          <div class="flex items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-base-200">
            <div x-show="editingTagId !== tag.id" class="flex items-center gap-2 flex-1">
              <span class="font-medium" x-text="tag.name"></span>
              <span class="text-xs opacity-50" x-text="tag.slug"></span>
              <span class="badge badge-xs" x-text="tag.usage_count + ' 个书签'"></span>
            </div>
            <div x-show="editingTagId === tag.id" class="flex items-center gap-2 flex-1">
              <input type="text" class="input input-bordered input-xs flex-1" x-model="editingTagName" @keydown.enter.prevent="handleRenameTag(tag)" @keydown.escape="editingTagId = null" />
              <button class="btn btn-xs btn-primary" @click="handleRenameTag(tag)">保存</button>
              <button class="btn btn-xs btn-ghost" @click="editingTagId = null">取消</button>
            </div>
            <div class="flex gap-1 shrink-0" x-show="editingTagId !== tag.id">
              <button class="btn btn-ghost btn-xs btn-square" @click="startEditTag(tag)" aria-label="重命名">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
              </button>
              <button class="btn btn-ghost btn-xs btn-square text-error" @click="handleDeleteTag(tag)" aria-label="删除">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-action">
        <form method="dialog"><button class="btn">关闭</button></form>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>关闭</button></form>
  </dialog>

</div>

<script>
const API_BASE = ''  // 同源，无需前缀
let _alertTimer = null

document.addEventListener('alpine:init', () => {
  Alpine.store('alert', {
    message: '', type: 'success', visible: false,
    show(msg, type = 'success') {
      clearTimeout(_alertTimer)
      this.message = msg; this.type = type; this.visible = true
      _alertTimer = setTimeout(() => { this.visible = false }, 3000)
    },
    dismiss() { clearTimeout(_alertTimer); this.visible = false },
  })

  Alpine.data('indexPage', () => ({
    // 书签列表
    bookmarks: [],
    isLoadingBookmarks: false,
    bookmarksError: '',
    searchQuery: '',
    selectedTags: [],
    offset: 0,
    hasMore: false,
    isLoadingMore: false,

    // 标签
    allTags: [],
    isLoadingTags: false,
    tagsError: '',

    // 保存 Modal
    saveForm: { url: '', title: '', type: 'other', summary: '', note: '', selectedTags: [], suggestedTags: [] },
    isSaving: false,
    isEnriching: false,
    tagInput: '',
    tagSearchResults: [],

    // 编辑 Modal
    editForm: { id: '', title: '', type: 'other', summary: '', note: '', selectedTags: [] },
    isUpdating: false,
    editTagInput: '',
    editTagSearchResults: [],

    // 标签管理
    newTagName: '',
    isCreatingTag: false,
    editingTagId: null,
    editingTagName: '',

    async init() {
      await Promise.all([this.fetchBookmarks(), this.fetchTags()])
    },

    // ——— 书签列表 ———
    async fetchBookmarks() {
      this.isLoadingBookmarks = true
      this.bookmarksError = ''
      this.offset = 0
      try {
        const params = new URLSearchParams()
        if (this.searchQuery) params.set('q', this.searchQuery)
        if (this.selectedTags.length) params.set('tags', this.selectedTags.join(','))
        params.set('limit', '30')
        const resp = await fetch(`${API_BASE}/api/bookmarks?${params}`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        this.bookmarks = data
        this.hasMore = data.length === 30
      } catch (e) {
        this.bookmarksError = e?.message || '加载书签失败'
      } finally {
        this.isLoadingBookmarks = false
      }
    },

    async loadMore() {
      this.isLoadingMore = true
      this.offset += 30
      try {
        const params = new URLSearchParams()
        if (this.searchQuery) params.set('q', this.searchQuery)
        if (this.selectedTags.length) params.set('tags', this.selectedTags.join(','))
        params.set('limit', '30')
        params.set('offset', this.offset)
        const resp = await fetch(`${API_BASE}/api/bookmarks?${params}`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        this.bookmarks.push(...data)
        this.hasMore = data.length === 30
      } catch (e) {
        Alpine.store('alert').show('加载更多失败：' + (e?.message || ''), 'error')
      } finally {
        this.isLoadingMore = false
      }
    },

    toggleTag(slug) {
      const idx = this.selectedTags.indexOf(slug)
      if (idx >= 0) this.selectedTags.splice(idx, 1)
      else this.selectedTags.push(slug)
      this.fetchBookmarks()
    },

    clearTagFilter() {
      this.selectedTags = []
      this.fetchBookmarks()
    },

    async deleteBookmark(id) {
      if (!confirm('确定删除这个书签？')) return
      try {
        const resp = await fetch(`${API_BASE}/api/bookmarks/${id}`, { method: 'DELETE' })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        this.bookmarks = this.bookmarks.filter(b => b.id !== id)
        Alpine.store('alert').show('书签已删除')
      } catch (e) {
        Alpine.store('alert').show('删除失败：' + (e?.message || ''), 'error')
      }
    },

    // ——— 标签 ———
    async fetchTags() {
      this.isLoadingTags = true
      this.tagsError = ''
      try {
        const resp = await fetch(`${API_BASE}/api/tags`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        this.allTags = data
      } catch (e) {
        this.tagsError = e?.message || '加载标签失败'
      } finally {
        this.isLoadingTags = false
      }
    },

    // ——— 保存书签 ———
    async handleEnrich() {
      if (!this.saveForm.url) return
      this.isEnriching = true
      try {
        const resp = await fetch(`${API_BASE}/api/ai/enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: this.saveForm.url, title: this.saveForm.title }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        if (data.title && !this.saveForm.title) this.saveForm.title = data.title
        if (data.summary) this.saveForm.summary = data.summary
        if (data.type) this.saveForm.type = data.type
        // 过滤掉已选的
        const selectedSlugs = this.saveForm.selectedTags.map(t => t.slug)
        this.saveForm.suggestedTags = (data.tags || []).filter(t => !selectedSlugs.includes(t.slug))
        Alpine.store('alert').show('AI 补全完成')
      } catch (e) {
        Alpine.store('alert').show('AI 补全失败：' + (e?.message || ''), 'error')
      } finally {
        this.isEnriching = false
      }
    },

    async addSuggestedTag(tag) {
      // 在 allTags 中找或创建
      let found = this.allTags.find(t => t.slug === tag.slug)
      if (!found) {
        try {
          const resp = await fetch(`${API_BASE}/api/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: tag.name }),
          })
          if (!resp.ok) throw new Error()
          const { data } = await resp.json()
          found = data
          this.allTags.unshift(data)
        } catch { return }
      }
      if (!this.saveForm.selectedTags.find(t => t.id === found.id)) {
        this.saveForm.selectedTags.push(found)
      }
      this.saveForm.suggestedTags = this.saveForm.suggestedTags.filter(t => t.slug !== tag.slug)
    },

    filterTagSuggestions() {
      const q = this.tagInput.trim().toLowerCase()
      if (!q) { this.tagSearchResults = []; return }
      const selected = this.saveForm.selectedTags.map(t => t.id)
      this.tagSearchResults = this.allTags
        .filter(t => !selected.includes(t.id) && (t.name.toLowerCase().includes(q) || t.slug.includes(q)))
        .slice(0, 8)
    },

    selectTag(tag) {
      if (!this.saveForm.selectedTags.find(t => t.id === tag.id)) {
        this.saveForm.selectedTags.push(tag)
      }
      this.tagInput = ''
      this.tagSearchResults = []
    },

    async addOrCreateTag() {
      const name = this.tagInput.trim()
      if (!name) return
      // 先找完全匹配的
      const existing = this.allTags.find(t => t.name.toLowerCase() === name.toLowerCase() || t.slug === name.toLowerCase())
      if (existing) { this.selectTag(existing); return }
      // 创建新标签
      try {
        const resp = await fetch(`${API_BASE}/api/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        if (!this.allTags.find(t => t.id === data.id)) this.allTags.unshift(data)
        this.selectTag(data)
      } catch (e) {
        Alpine.store('alert').show('创建标签失败', 'error')
      }
    },

    removeTagFromForm(tag) {
      this.saveForm.selectedTags = this.saveForm.selectedTags.filter(t => t.id !== tag.id)
    },

    async handleSaveBookmark() {
      if (!this.saveForm.url) return
      this.isSaving = true
      try {
        const resp = await fetch(`${API_BASE}/api/bookmarks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: this.saveForm.url,
            title: this.saveForm.title,
            type: this.saveForm.type,
            summary: this.saveForm.summary,
            note: this.saveForm.note,
            tag_ids: this.saveForm.selectedTags.map(t => t.id),
          }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        Alpine.store('alert').show('书签已保存')
        this.$refs.saveModal.close()
        this.resetSaveForm()
        await Promise.all([this.fetchBookmarks(), this.fetchTags()])
      } catch (e) {
        Alpine.store('alert').show('保存失败：' + (e?.message || ''), 'error')
      } finally {
        this.isSaving = false
      }
    },

    resetSaveForm() {
      this.saveForm = { url: '', title: '', type: 'other', summary: '', note: '', selectedTags: [], suggestedTags: [] }
      this.tagInput = ''
      this.tagSearchResults = []
    },

    // ——— 编辑书签 ———
    openEditModal(bm) {
      this.editForm = {
        id: bm.id,
        title: bm.title,
        type: bm.type,
        summary: bm.summary,
        note: bm.note,
        selectedTags: [...(bm.tags || [])],
      }
      this.editTagInput = ''
      this.editTagSearchResults = []
      this.$refs.editModal.showModal()
    },

    filterEditTagSuggestions() {
      const q = this.editTagInput.trim().toLowerCase()
      if (!q) { this.editTagSearchResults = []; return }
      const selected = this.editForm.selectedTags.map(t => t.id)
      this.editTagSearchResults = this.allTags
        .filter(t => !selected.includes(t.id) && (t.name.toLowerCase().includes(q) || t.slug.includes(q)))
        .slice(0, 8)
    },

    selectEditTag(tag) {
      if (!this.editForm.selectedTags.find(t => t.id === tag.id)) {
        this.editForm.selectedTags.push(tag)
      }
      this.editTagInput = ''
      this.editTagSearchResults = []
    },

    async addOrCreateEditTag() {
      const name = this.editTagInput.trim()
      if (!name) return
      const existing = this.allTags.find(t => t.name.toLowerCase() === name.toLowerCase() || t.slug === name.toLowerCase())
      if (existing) { this.selectEditTag(existing); return }
      try {
        const resp = await fetch(`${API_BASE}/api/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!resp.ok) throw new Error()
        const { data } = await resp.json()
        if (!this.allTags.find(t => t.id === data.id)) this.allTags.unshift(data)
        this.selectEditTag(data)
      } catch {
        Alpine.store('alert').show('创建标签失败', 'error')
      }
    },

    removeTagFromEditForm(tag) {
      this.editForm.selectedTags = this.editForm.selectedTags.filter(t => t.id !== tag.id)
    },

    async handleUpdateBookmark() {
      this.isUpdating = true
      try {
        const resp = await fetch(`${API_BASE}/api/bookmarks/${this.editForm.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: this.editForm.title,
            type: this.editForm.type,
            summary: this.editForm.summary,
            note: this.editForm.note,
            tag_ids: this.editForm.selectedTags.map(t => t.id),
          }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        Alpine.store('alert').show('书签已更新')
        this.$refs.editModal.close()
        await Promise.all([this.fetchBookmarks(), this.fetchTags()])
      } catch (e) {
        Alpine.store('alert').show('更新失败：' + (e?.message || ''), 'error')
      } finally {
        this.isUpdating = false
      }
    },

    // ——— 标签管理 ———
    async handleCreateTag() {
      const name = this.newTagName.trim()
      if (!name) return
      this.isCreatingTag = true
      try {
        const resp = await fetch(`${API_BASE}/api/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        if (!this.allTags.find(t => t.id === data.id)) this.allTags.unshift(data)
        this.newTagName = ''
        Alpine.store('alert').show('标签已创建')
      } catch (e) {
        Alpine.store('alert').show('创建失败：' + (e?.message || ''), 'error')
      } finally {
        this.isCreatingTag = false
      }
    },

    startEditTag(tag) {
      this.editingTagId = tag.id
      this.editingTagName = tag.name
    },

    async handleRenameTag(tag) {
      const name = this.editingTagName.trim()
      if (!name || name === tag.name) { this.editingTagId = null; return }
      try {
        const resp = await fetch(`${API_BASE}/api/tags/${tag.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { data } = await resp.json()
        const idx = this.allTags.findIndex(t => t.id === tag.id)
        if (idx >= 0) this.allTags[idx] = { ...this.allTags[idx], ...data }
        this.editingTagId = null
        Alpine.store('alert').show('标签已重命名')
      } catch (e) {
        Alpine.store('alert').show('重命名失败：' + (e?.message || ''), 'error')
      }
    },

    async handleDeleteTag(tag) {
      if (!confirm(`确定删除标签「${tag.name}」？该标签将从所有书签中移除。`)) return
      try {
        const resp = await fetch(`${API_BASE}/api/tags/${tag.id}`, { method: 'DELETE' })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        this.allTags = this.allTags.filter(t => t.id !== tag.id)
        Alpine.store('alert').show('标签已删除')
        await this.fetchBookmarks()
      } catch (e) {
        Alpine.store('alert').show('删除失败：' + (e?.message || ''), 'error')
      }
    },

    formatDate(ts) {
      return dayjs.unix(ts).format('YYYY-MM-DD HH:mm')
    },
  }))
})
</script>
</body>
</html>
```

**Step 2: 启动并验证页面加载**

```bash
npm run dev
```

打开 `http://localhost:8787`，应看到 Linkgrove 主界面：顶部导航、左侧标签栏、书签列表区。

**Step 3: 端到端验证**

1. 点击「保存链接」，输入 `https://github.com`，点击「AI 补全」，等待填充
2. 选择/创建标签，点击「保存」
3. 书签出现在列表中
4. 点击书签上的标签徽章，左侧对应标签高亮，列表筛选
5. 点击编辑图标，修改备注，保存
6. 删除书签

---

## Task 8: 本地联调 & 问题修复

**Step 1: 检查 D1 本地数据库是否存在**

```bash
npx wrangler d1 execute linkgrove --local --command "SELECT COUNT(*) FROM bookmarks;"
```

**Step 2: 检查 Hono 路由是否正确挂载**

```bash
curl http://localhost:8787/api/tags
curl http://localhost:8787/api/bookmarks
```

预期均返回 `{"ok":true,"data":[]}`

**Step 3: 修复所有 console 报错**

打开浏览器 DevTools，观察 Network 和 Console，逐一修复。

---

## Task 9: 部署到 Cloudflare

**Step 1: 在 Cloudflare 上创建 D1（如果还没有）**

```bash
npx wrangler d1 create linkgrove
# 更新 wrangler.toml 中的 database_id
```

**Step 2: 执行远程迁移**

```bash
npx wrangler d1 migrations apply linkgrove
```

**Step 3: 部署 Worker**

```bash
npm run deploy
```

**Step 4: 配置 Cloudflare Access**

在 Cloudflare Zero Trust 控制台：
1. Applications → Add → Self-hosted
2. 填入 Workers 域名（如 `linkgrove.xxx.workers.dev`）
3. 配置 Policy：允许自己的邮箱/GitHub 账户
4. 保存

**Step 5: 验证线上访问**

打开 Workers 域名，应跳转到 Cloudflare Access 登录页，登录后进入 Linkgrove 主界面。

---

## 后续扩展方向（不在 V1 范围）

- Saved Query（智能集合）
- 批量操作（多选 + 批量打标）
- Chrome 书签 HTML 导入
- tag alias / merge
- Full Text Search（D1 FTS）
- 移动端侧边栏抽屉
