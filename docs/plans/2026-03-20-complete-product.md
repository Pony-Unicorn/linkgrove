# Linkgrove 完整产品实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 基于现有骨架实现 README 描述的完整产品功能：tag 合并/别名、saved queries 智能集合、AI 反馈事件、高级搜索过滤（NOT/日期）、批量操作。

**Architecture:** 后端在 `src/index.ts` 追加新路由和 Kysely 类型；新建一条 D1 migration 添加三张表；前端在 `public/index.html` 内扩展 Alpine.js 组件，保持单文件。

**Tech Stack:** Cloudflare Workers + D1 + Hono + Kysely + Alpine.js + DaisyUI

---

## 当前状态

已实现：
- `bookmarks` / `tags` / `bookmark_tags` 表及 CRUD
- AI enrich 接口
- 前端：书签列表、保存/编辑弹窗、侧边栏 tag 过滤、tags 管理弹窗

待实现（本计划覆盖）：
- DB: `tag_aliases` / `saved_queries` / `user_feedback_events`
- 后端: tag 合并、别名管理、saved queries CRUD、反馈事件、NOT tags/日期搜索
- 前端: saved queries 侧边栏、tag merge+alias UI、AI 反馈追踪、高级过滤、批量操作

---

## Task 1: DB Migration

**Files:**
- Create: `migrations/0002_tag_aliases_saved_queries_feedback.sql`

**Step 1: 创建 migration 文件**

```sql
-- migrations/0002_tag_aliases_saved_queries_feedback.sql

CREATE TABLE IF NOT EXISTS tag_aliases (
  id          TEXT PRIMARY KEY,
  alias       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai', 'system')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tag_aliases_tag ON tag_aliases(tag_id);

CREATE TABLE IF NOT EXISTS saved_queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  query_json  TEXT NOT NULL DEFAULT '{}',
  sort_by     TEXT NOT NULL DEFAULT 'created_at',
  sort_dir    TEXT NOT NULL DEFAULT 'desc',
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_feedback_events (
  id          TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('tag_accepted', 'tag_rejected', 'tag_added', 'tag_replaced')),
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_bookmark ON user_feedback_events(bookmark_id);
```

**说明：**
- `tag_aliases.slug` = 别名规范化后的 slug（用于 slug 查重）
- `tag_aliases.alias` = 展示用别名原文
- `saved_queries.query_json` 存储 JSON 字符串，结构：
  ```json
  { "tags": ["ai"], "not_tags": ["archived"], "q": "keyword", "domain": "github.com", "from": 1700000000, "to": 1800000000 }
  ```

**Step 2: 本地应用 migration**

```bash
npx wrangler d1 migrations apply linkgrove --local
```

Expected: `Migrations applied: 1`

**Step 3: Commit**

```bash
git add migrations/0002_tag_aliases_saved_queries_feedback.sql
git commit -m "feat: add tag_aliases, saved_queries, user_feedback_events migrations"
```

---

## Task 2: 后端 Kysely 类型 + Tag 合并 + Tag 别名 API

**Files:**
- Modify: `src/index.ts`

**Step 1: 在文件顶部 DB schema types 区域追加三个新 interface**

在现有 `interface DB { ... }` 之前插入：

```typescript
type AliasSource = 'user' | 'ai' | 'system'

interface TagAliasTable {
  id: string
  alias: string
  slug: string
  tag_id: string
  source: AliasSource
  created_at: number
}

interface SavedQueryTable {
  id: string
  name: string
  query_json: string
  sort_by: string
  sort_dir: string
  pinned: number   // 0 | 1，SQLite 无 BOOLEAN
  created_at: number
  updated_at: number
}

type FeedbackEventType = 'tag_accepted' | 'tag_rejected' | 'tag_added' | 'tag_replaced'

interface UserFeedbackEventTable {
  id: string
  bookmark_id: string
  event_type: FeedbackEventType
  payload: string  // JSON string
  created_at: number
}
```

然后更新 `interface DB`：

```typescript
interface DB {
  bookmarks: BookmarkTable
  tags: TagTable
  bookmark_tags: BookmarkTagTable
  tag_aliases: TagAliasTable
  saved_queries: SavedQueryTable
  user_feedback_events: UserFeedbackEventTable
}
```

**Step 2: 在 tags DELETE 路由之后添加 Tag 别名路由**

```typescript
// GET /api/tags/:id/aliases
app.get('/api/tags/:id/aliases', async (c) => {
  const tagId = c.req.param('id')
  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('tags').select('id').where('id', '=', tagId).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'tag not found' }, 404)
  const aliases = await db.selectFrom('tag_aliases').selectAll().where('tag_id', '=', tagId).execute()
  return c.json({ ok: true, data: aliases })
})

// POST /api/tags/:id/aliases  body: { alias: string }
app.post('/api/tags/:id/aliases', async (c) => {
  const tagId = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.alias) return c.json({ ok: false, error: 'alias is required' }, 400)

  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('tags').select('id').where('id', '=', tagId).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'tag not found' }, 404)

  const slug = toSlug(body.alias as string)
  if (!slug) return c.json({ ok: false, error: 'invalid alias' }, 400)

  // 检查 slug 是否已被 tag 或其他 alias 使用
  const tagConflict = await db.selectFrom('tags').select('id').where('slug', '=', slug).executeTakeFirst()
  if (tagConflict) return c.json({ ok: false, error: 'slug already used by a tag' }, 409)
  const aliasConflict = await db.selectFrom('tag_aliases').select('id').where('slug', '=', slug).executeTakeFirst()
  if (aliasConflict) return c.json({ ok: false, error: 'alias already exists' }, 409)

  const id = generateId()
  const ts = now()
  await db.insertInto('tag_aliases').values({
    id, alias: (body.alias as string).trim(), slug, tag_id: tagId, source: 'user', created_at: ts,
  }).execute()

  const alias = await db.selectFrom('tag_aliases').selectAll().where('id', '=', id).executeTakeFirst()
  return c.json({ ok: true, data: alias }, 201)
})

// DELETE /api/tags/:id/aliases/:aliasId
app.delete('/api/tags/:id/aliases/:aliasId', async (c) => {
  const aliasId = c.req.param('aliasId')
  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('tag_aliases').select('id').where('id', '=', aliasId).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'alias not found' }, 404)
  await db.deleteFrom('tag_aliases').where('id', '=', aliasId).execute()
  return c.json({ ok: true })
})

// POST /api/tags/:id/merge  body: { target_tag_id: string }
// 将 :id 的所有 bookmark_tags 引用迁移到 target_tag_id，然后删除 :id
app.post('/api/tags/:id/merge', async (c) => {
  const sourceId = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.target_tag_id) return c.json({ ok: false, error: 'target_tag_id is required' }, 400)
  const targetId = body.target_tag_id as string
  if (sourceId === targetId) return c.json({ ok: false, error: 'source and target must differ' }, 400)

  const db = createDb(c.env.DB)
  const source = await db.selectFrom('tags').select(['id', 'name']).where('id', '=', sourceId).executeTakeFirst()
  if (!source) return c.json({ ok: false, error: 'source tag not found' }, 404)
  const target = await db.selectFrom('tags').select(['id', 'name']).where('id', '=', targetId).executeTakeFirst()
  if (!target) return c.json({ ok: false, error: 'target tag not found' }, 404)

  // 获取 source 的所有书签关联
  const sourceRefs = await db.selectFrom('bookmark_tags').selectAll().where('tag_id', '=', sourceId).execute()

  for (const ref of sourceRefs) {
    // 检查 target 是否已有这个书签
    const alreadyLinked = await db
      .selectFrom('bookmark_tags')
      .select('bookmark_id')
      .where('bookmark_id', '=', ref.bookmark_id)
      .where('tag_id', '=', targetId)
      .executeTakeFirst()
    if (alreadyLinked) {
      // 已存在就删掉 source 的引用
      await db.deleteFrom('bookmark_tags')
        .where('bookmark_id', '=', ref.bookmark_id)
        .where('tag_id', '=', sourceId)
        .execute()
    } else {
      // 迁移到 target
      await db.updateTable('bookmark_tags')
        .set({ tag_id: targetId })
        .where('bookmark_id', '=', ref.bookmark_id)
        .where('tag_id', '=', sourceId)
        .execute()
    }
  }

  // 删除 source tag（cascade 会清理别名）
  await db.deleteFrom('tags').where('id', '=', sourceId).execute()

  return c.json({ ok: true, data: { merged_into: targetId } })
})
```

**Step 3: 验证**

```bash
npx wrangler dev --local
# 测试 tag merge
curl -X POST http://localhost:8787/api/tags/TAG_A_ID/merge \
  -H "Content-Type: application/json" \
  -d '{"target_tag_id":"TAG_B_ID"}'
# Expected: {"ok":true,"data":{"merged_into":"TAG_B_ID"}}
```

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add tag alias and merge APIs"
```

---

## Task 3: 后端 Saved Queries API

**Files:**
- Modify: `src/index.ts`

**Step 1: 在 AI enrich 路由之前添加 saved queries 路由**

```typescript
// ── saved queries ──────────────────────────────────────────────────────────

// GET /api/saved-queries
app.get('/api/saved-queries', async (c) => {
  const db = createDb(c.env.DB)
  const results = await db
    .selectFrom('saved_queries')
    .selectAll()
    .orderBy('pinned', 'desc')
    .orderBy('updated_at', 'desc')
    .execute()
  // 将 query_json string 解析为对象返回
  return c.json({ ok: true, data: results.map(r => ({ ...r, query: JSON.parse(r.query_json) })) })
})

// POST /api/saved-queries  body: { name, query: {...} }
app.post('/api/saved-queries', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.name) return c.json({ ok: false, error: 'name is required' }, 400)
  if (!body?.query || typeof body.query !== 'object') return c.json({ ok: false, error: 'query is required' }, 400)

  const db = createDb(c.env.DB)
  const id = generateId()
  const ts = now()
  await db.insertInto('saved_queries').values({
    id,
    name: (body.name as string).trim(),
    query_json: JSON.stringify(body.query),
    sort_by: (body.sort_by as string) || 'created_at',
    sort_dir: (body.sort_dir as string) || 'desc',
    pinned: 0,
    created_at: ts,
    updated_at: ts,
  }).execute()

  const sq = await db.selectFrom('saved_queries').selectAll().where('id', '=', id).executeTakeFirst()
  if (!sq) return c.json({ ok: false, error: 'failed to create' }, 500)
  return c.json({ ok: true, data: { ...sq, query: JSON.parse(sq.query_json) } }, 201)
})

// PUT /api/saved-queries/:id  body: { name?, query?, sort_by?, sort_dir? }
app.put('/api/saved-queries/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ ok: false, error: 'body required' }, 400)

  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('saved_queries').selectAll().where('id', '=', id).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'saved query not found' }, 404)

  const ts = now()
  await db.updateTable('saved_queries').set({
    name: body.name ? (body.name as string).trim() : existing.name,
    query_json: body.query ? JSON.stringify(body.query) : existing.query_json,
    sort_by: (body.sort_by as string) || existing.sort_by,
    sort_dir: (body.sort_dir as string) || existing.sort_dir,
    updated_at: ts,
  }).where('id', '=', id).execute()

  const sq = await db.selectFrom('saved_queries').selectAll().where('id', '=', id).executeTakeFirst()
  if (!sq) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json({ ok: true, data: { ...sq, query: JSON.parse(sq.query_json) } })
})

// PATCH /api/saved-queries/:id/pin  — toggle pinned
app.patch('/api/saved-queries/:id/pin', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('saved_queries').select(['id', 'pinned']).where('id', '=', id).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'saved query not found' }, 404)
  await db.updateTable('saved_queries').set({ pinned: existing.pinned ? 0 : 1, updated_at: now() }).where('id', '=', id).execute()
  const sq = await db.selectFrom('saved_queries').selectAll().where('id', '=', id).executeTakeFirst()
  if (!sq) return c.json({ ok: false, error: 'not found' }, 404)
  return c.json({ ok: true, data: { ...sq, query: JSON.parse(sq.query_json) } })
})

// DELETE /api/saved-queries/:id
app.delete('/api/saved-queries/:id', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('saved_queries').select('id').where('id', '=', id).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'saved query not found' }, 404)
  await db.deleteFrom('saved_queries').where('id', '=', id).execute()
  return c.json({ ok: true })
})
```

**Step 2: 验证**

```bash
# 创建
curl -X POST http://localhost:8787/api/saved-queries \
  -H "Content-Type: application/json" \
  -d '{"name":"AI 工具","query":{"tags":["ai","tool"]}}'
# Expected: {"ok":true,"data":{"id":"...","name":"AI 工具","query":{"tags":["ai","tool"]},...}}

# 列表
curl http://localhost:8787/api/saved-queries
# Expected: {"ok":true,"data":[...]}

# Pin
curl -X PATCH http://localhost:8787/api/saved-queries/SQ_ID/pin
# Expected: {"ok":true,"data":{"pinned":1,...}}
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add saved queries CRUD and pin API"
```

---

## Task 4: 后端 Feedback API + 增强搜索（NOT tags / 日期）

**Files:**
- Modify: `src/index.ts`

**Step 1: 添加 feedback 路由（在 ping 路由之前）**

```typescript
// ── feedback ──────────────────────────────────────────────────────────────

// POST /api/feedback  body: { bookmark_id, event_type, payload? }
app.post('/api/feedback', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.bookmark_id) return c.json({ ok: false, error: 'bookmark_id is required' }, 400)
  if (!body?.event_type) return c.json({ ok: false, error: 'event_type is required' }, 400)

  const validTypes: FeedbackEventType[] = ['tag_accepted', 'tag_rejected', 'tag_added', 'tag_replaced']
  if (!validTypes.includes(body.event_type as FeedbackEventType)) {
    return c.json({ ok: false, error: 'invalid event_type' }, 400)
  }

  const db = createDb(c.env.DB)
  const bookmark = await db.selectFrom('bookmarks').select('id').where('id', '=', body.bookmark_id as string).executeTakeFirst()
  if (!bookmark) return c.json({ ok: false, error: 'bookmark not found' }, 404)

  const id = generateId()
  const ts = now()
  await db.insertInto('user_feedback_events').values({
    id,
    bookmark_id: body.bookmark_id as string,
    event_type: body.event_type as FeedbackEventType,
    payload: JSON.stringify(body.payload || {}),
    created_at: ts,
  }).execute()

  return c.json({ ok: true, data: { id } }, 201)
})
```

**Step 2: 增强 GET /api/bookmarks 支持 not_tags 和日期过滤**

找到 `app.get('/api/bookmarks', ...)` 中的查询参数解构，将：

```typescript
const { q = '', tags = '', domain = '', limit = '50', offset = '0' } = c.req.query()
```

改为：

```typescript
const { q = '', tags = '', not_tags = '', domain = '', limit = '50', offset = '0', from = '', to = '' } = c.req.query()
```

然后在 tag AND JOIN 循环之后，在 `if (q)` 判断之前，追加 NOT tags 和日期过滤：

```typescript
// NOT tags：用 NOT EXISTS 子查询排除含某 tag 的书签
const notTagList = not_tags ? not_tags.split(',').map(t => t.trim()).filter(Boolean) : []
for (const notSlug of notTagList) {
  query = query.where((eb) =>
    eb.not(
      eb.exists(
        eb.selectFrom('bookmark_tags as nbt')
          .innerJoin('tags as ntg', 'ntg.id', 'nbt.tag_id')
          .select('nbt.bookmark_id')
          .whereRef('nbt.bookmark_id', '=', 'b.id')
          .where('nbt.status', '=', 'active')
          .where('ntg.slug', '=', notSlug)
      )
    )
  )
}

if (from) query = query.where('b.created_at', '>=', parseInt(from))
if (to) query = query.where('b.created_at', '<=', parseInt(to))
```

**Step 3: 验证**

```bash
# NOT tags 搜索
curl "http://localhost:8787/api/bookmarks?not_tags=archived"
# Expected: 不含 archived 标签的书签

# 日期范围
curl "http://localhost:8787/api/bookmarks?from=1700000000&to=1800000000"

# Feedback
curl -X POST http://localhost:8787/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"bookmark_id":"BM_ID","event_type":"tag_accepted","payload":{"tag_slug":"ai"}}'
# Expected: {"ok":true,"data":{"id":"..."}}
```

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add feedback API and enhance bookmark search with not_tags and date range"
```

---

## Task 5: 前端 Saved Queries 侧边栏

**Files:**
- Modify: `public/index.html`

**Step 1: 在 Alpine.js 数据区域 `// Tags state` 下方添加 saved queries 状态**

```javascript
// Saved queries state
savedQueries: [],
isLoadingSavedQueries: false,
```

**Step 2: 在 `init()` 中追加加载**

```javascript
async init() {
  await Promise.all([this.fetchBookmarks(), this.fetchTags(), this.fetchSavedQueries()]);
},
```

**Step 3: 添加 saved queries 方法（在 `fetchTags` 之后）**

```javascript
async fetchSavedQueries() {
  this.isLoadingSavedQueries = true;
  try {
    const res = await fetch(`${API_BASE}/api/saved-queries`);
    if (!res.ok) throw new Error();
    const json = await res.json();
    this.savedQueries = json.data;
  } catch {
    // 静默失败，不影响主流程
  } finally {
    this.isLoadingSavedQueries = false;
  }
},

applyQuery(sq) {
  const q = sq.query || {};
  this.selectedTags = q.tags || [];
  this.excludedTags = q.not_tags || [];
  this.searchQuery = q.q || '';
  this.domainFilter = q.domain || '';
  this.dateFrom = q.from || '';
  this.dateTo = q.to || '';
  this.fetchBookmarks();
},

async saveCurrentQuery(name) {
  if (!name) return;
  const query = {};
  if (this.selectedTags.length) query.tags = [...this.selectedTags];
  if (this.excludedTags.length) query.not_tags = [...this.excludedTags];
  if (this.searchQuery.trim()) query.q = this.searchQuery.trim();
  if (this.domainFilter.trim()) query.domain = this.domainFilter.trim();
  if (this.dateFrom) query.from = this.dateFrom;
  if (this.dateTo) query.to = this.dateTo;
  try {
    const res = await fetch(`${API_BASE}/api/saved-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, query }),
    });
    if (!res.ok) throw new Error();
    const json = await res.json();
    this.savedQueries.unshift(json.data);
    Alpine.store('alert').show('已保存为智能集合', 'success');
  } catch {
    Alpine.store('alert').show('保存失败', 'error');
  }
},

async togglePinQuery(sq) {
  try {
    const res = await fetch(`${API_BASE}/api/saved-queries/${sq.id}/pin`, { method: 'PATCH' });
    if (!res.ok) throw new Error();
    const json = await res.json();
    const idx = this.savedQueries.findIndex(s => s.id === sq.id);
    if (idx !== -1) this.savedQueries[idx] = json.data;
    this.savedQueries.sort((a, b) => b.pinned - a.pinned);
  } catch {
    Alpine.store('alert').show('操作失败', 'error');
  }
},

async deleteQuery(sq) {
  if (!confirm(`确认删除「${sq.name}」？`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/saved-queries/${sq.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    this.savedQueries = this.savedQueries.filter(s => s.id !== sq.id);
  } catch {
    Alpine.store('alert').show('删除失败', 'error');
  }
},
```

**Step 4: 在左侧边栏 tags card 下方插入 saved queries 卡片**

在 `</aside>` 之前、tags card `</div>` 之后插入：

```html
<!-- Saved Queries Card -->
<div class="card bg-base-100 border border-base-300 shadow-sm">
  <div class="card-body p-4 gap-3">
    <div class="flex items-center justify-between">
      <h2 class="font-semibold text-sm">智能集合</h2>
      <button
        class="btn btn-ghost btn-xs"
        title="保存当前筛选"
        @click="
          const name = prompt('集合名称：');
          if (name && name.trim()) saveCurrentQuery(name.trim());
        "
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true">
          <path d="M5 12h14"></path><path d="M12 5v14"></path>
        </svg>
      </button>
    </div>

    <div x-show="isLoadingSavedQueries" class="space-y-2">
      <div class="skeleton h-7 w-full rounded-btn"></div>
      <div class="skeleton h-7 w-4/5 rounded-btn"></div>
    </div>

    <div x-show="!isLoadingSavedQueries" class="space-y-1">
      <template x-for="sq in savedQueries" :key="sq.id">
        <div class="flex items-center gap-1 group">
          <button
            class="flex-1 text-left btn btn-xs btn-ghost justify-start truncate"
            @click="applyQuery(sq)"
          >
            <svg x-show="sq.pinned" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3 text-warning shrink-0" aria-hidden="true">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
            </svg>
            <span class="truncate" x-text="sq.name"></span>
          </button>
          <div class="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <button class="btn btn-ghost btn-xs btn-square" @click="togglePinQuery(sq)" :title="sq.pinned ? '取消置顶' : '置顶'">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
              </svg>
            </button>
            <button class="btn btn-ghost btn-xs btn-square text-error" @click="deleteQuery(sq)" title="删除">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true">
                <path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>
              </svg>
            </button>
          </div>
        </div>
      </template>
      <div x-show="savedQueries.length === 0" class="text-xs opacity-50 text-center py-2">暂无智能集合</div>
    </div>
  </div>
</div>
```

**Step 5: 验证**

启动 `pnpm dev`，在浏览器中：
1. 选择几个 tag，点击智能集合区域右上角 `+`，输入名称保存
2. 侧边栏出现新智能集合条目
3. 点击条目，书签列表按对应过滤条件刷新
4. 鼠标悬停显示置顶/删除按钮

**Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: add saved queries sidebar with save/pin/delete"
```

---

## Task 6: 前端 Tag 合并 + 别名管理 UI

**Files:**
- Modify: `public/index.html`

**Step 1: 在 Alpine 数据区域 tags management state 下方添加状态**

```javascript
// Tag merge / alias state
mergingTagId: null,      // 正在合并的 source tag id
mergeTargetId: '',       // 合并目标 tag id
isMerging: false,
aliasTagId: null,        // 正在管理别名的 tag id
aliasInput: '',
tagAliases: [],          // 当前 aliasTagId 的别名列表
isLoadingAliases: false,
```

**Step 2: 添加 merge / alias 方法（在 `handleDeleteTag` 之后）**

```javascript
startMerge(tag) {
  this.mergingTagId = tag.id;
  this.mergeTargetId = '';
},

async handleMerge() {
  if (!this.mergingTagId || !this.mergeTargetId) return;
  if (!confirm('合并后源标签将被删除，确认？')) return;
  this.isMerging = true;
  try {
    const res = await fetch(`${API_BASE}/api/tags/${this.mergingTagId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_tag_id: this.mergeTargetId }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '合并失败');
    this.allTags = this.allTags.filter(t => t.id !== this.mergingTagId);
    this.selectedTags = this.selectedTags.filter(s => {
      const src = this.allTags.find(t => t.id === this.mergingTagId);
      return !src || s !== src.slug;
    });
    this.mergingTagId = null;
    this.mergeTargetId = '';
    await this.fetchBookmarks();
    await this.fetchTags();
    Alpine.store('alert').show('标签合并成功', 'success');
  } catch (e) {
    Alpine.store('alert').show(e?.message || '合并失败', 'error');
  } finally {
    this.isMerging = false;
  }
},

async openAliasManager(tag) {
  this.aliasTagId = tag.id;
  this.aliasInput = '';
  this.isLoadingAliases = true;
  try {
    const res = await fetch(`${API_BASE}/api/tags/${tag.id}/aliases`);
    const json = await res.json();
    this.tagAliases = json.data || [];
  } catch {
    this.tagAliases = [];
  } finally {
    this.isLoadingAliases = false;
  }
  this.$refs.aliasModal.showModal();
},

async handleAddAlias() {
  const alias = this.aliasInput.trim();
  if (!alias) return;
  try {
    const res = await fetch(`${API_BASE}/api/tags/${this.aliasTagId}/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    });
    if (!res.ok) throw new Error((await res.json()).error || '添加失败');
    const json = await res.json();
    this.tagAliases.push(json.data);
    this.aliasInput = '';
  } catch (e) {
    Alpine.store('alert').show(e?.message || '添加别名失败', 'error');
  }
},

async handleDeleteAlias(alias) {
  try {
    const res = await fetch(`${API_BASE}/api/tags/${this.aliasTagId}/aliases/${alias.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    this.tagAliases = this.tagAliases.filter(a => a.id !== alias.id);
  } catch {
    Alpine.store('alert').show('删除别名失败', 'error');
  }
},
```

**Step 3: 在 Tags Management Modal 的每个 tag 行操作按钮区域，在删除按钮之后追加合并和别名按钮**

找到 `<!-- Action buttons (normal view) -->` div 里的按钮组，添加：

```html
<!-- Merge button -->
<div x-show="mergingTagId === tag.id" class="flex items-center gap-1 flex-1">
  <select class="select select-bordered select-xs flex-1" x-model="mergeTargetId">
    <option value="">选择合并目标...</option>
    <template x-for="t in allTags.filter(t => t.id !== tag.id)" :key="t.id">
      <option :value="t.id" x-text="t.name"></option>
    </template>
  </select>
  <button class="btn btn-xs btn-primary" :disabled="!mergeTargetId || isMerging" @click="handleMerge()">确认</button>
  <button class="btn btn-xs btn-ghost" @click="mergingTagId = null">取消</button>
</div>

<!-- Normal action buttons -->
<div x-show="editingTagId !== tag.id && mergingTagId !== tag.id" class="flex items-center gap-1 shrink-0">
  <button class="btn btn-ghost btn-xs btn-square" @click="startEditTag(tag)" title="重命名">
    <!-- edit SVG (已有) -->
  </button>
  <button class="btn btn-ghost btn-xs btn-square" @click="startMerge(tag)" title="合并到...">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5" aria-hidden="true">
      <path d="M8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3"></path>
      <polyline points="15 3 12 0 9 3"></polyline><line x1="12" y1="0" x2="12" y2="13"></line>
    </svg>
  </button>
  <button class="btn btn-ghost btn-xs btn-square" @click="openAliasManager(tag)" title="别名">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  </button>
  <button class="btn btn-ghost btn-xs btn-square text-error" @click="handleDeleteTag(tag)" title="删除">
    <!-- delete SVG (已有) -->
  </button>
</div>
```

**Step 4: 在 Tags Management Modal 关闭标签之前添加别名管理 Modal**

```html
<!-- ==================== Alias Management Modal ==================== -->
<dialog x-ref="aliasModal" class="modal">
  <div class="modal-box w-11/12 max-w-md">
    <form method="dialog">
      <button class="btn btn-sm btn-circle btn-ghost absolute right-3 top-3">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
          <path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>
        </svg>
      </button>
    </form>
    <h3 class="font-bold text-lg mb-1">管理别名</h3>
    <p class="text-sm opacity-60 mb-4" x-text="'标签：' + (allTags.find(t => t.id === aliasTagId)?.name || '')"></p>

    <div class="flex gap-2 mb-4">
      <input
        type="text"
        class="input input-bordered input-sm flex-1"
        placeholder="输入别名..."
        x-model="aliasInput"
        @keydown.enter.prevent="handleAddAlias()"
      />
      <button
        class="btn btn-sm btn-primary shrink-0"
        :disabled="!aliasInput.trim()"
        @click="handleAddAlias()"
      >添加</button>
    </div>

    <div class="space-y-2 max-h-60 overflow-y-auto">
      <div x-show="isLoadingAliases" class="text-sm opacity-50 text-center py-4">加载中...</div>
      <template x-for="alias in tagAliases" :key="alias.id">
        <div class="flex items-center justify-between p-2 rounded-lg bg-base-200">
          <span class="text-sm" x-text="alias.alias"></span>
          <button class="btn btn-ghost btn-xs btn-square text-error" @click="handleDeleteAlias(alias)">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true">
              <path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>
            </svg>
          </button>
        </div>
      </template>
      <div x-show="!isLoadingAliases && tagAliases.length === 0" class="text-sm opacity-50 text-center py-4">暂无别名</div>
    </div>

    <div class="modal-action">
      <form method="dialog"><button class="btn">关闭</button></form>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
```

**Step 5: 验证**

1. 打开 Tags 管理，每行出现合并图标和别名图标
2. 点击合并 → 出现下拉选择目标 tag → 确认后源 tag 消失，书签重新归属到目标
3. 点击别名图标 → 打开别名 Modal，可添加/删除别名

**Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: add tag merge and alias management UI"
```

---

## Task 7: 前端 AI 反馈事件追踪

**Files:**
- Modify: `public/index.html`

**Step 1: 修改 `addSuggestedTag` 方法，保存后发送 `tag_accepted` 事件**

在 `addSuggestedTag` 方法中，在 push tag 到 `selectedTags` 之后追加：

```javascript
// 记录 AI tag 接受事件（非阻塞，静默失败）
if (this.saveForm.bookmarkId) {
  fetch(`${API_BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookmark_id: this.saveForm.bookmarkId,
      event_type: 'tag_accepted',
      payload: { tag_slug: tag.slug, confidence: tag.confidence },
    }),
  }).catch(() => {});
}
```

**说明：** `saveForm.bookmarkId` 只在编辑已存在书签时有值，新建书签 AI 补全阶段无 id，需在保存成功后补发。

**Step 2: 在 `handleSaveBookmark` 成功后，为被接受的 AI tag（已在 selectedTags 中且原来在 suggestedTags 里）批量发送事件**

在 `this.$refs.saveModal.close()` 之后追加：

```javascript
// 为已接受的 AI 建议 tag 发送 feedback
const bookmarkId = (await (await fetch(`${API_BASE}/api/bookmarks/${data.id}`)).json()).data?.id;
// 实际上 data 就是新书签，直接用 data.id
for (const tag of this.saveForm._acceptedAiTags || []) {
  fetch(`${API_BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookmark_id: json.data.id,
      event_type: 'tag_accepted',
      payload: { tag_slug: tag.slug, confidence: tag.confidence },
    }),
  }).catch(() => {});
}
```

**Step 3: 在 `handleEnrich` 成功后，记录 `_originalSuggestedTags`**

在 `this.saveForm.suggestedTags = ...` 之后：

```javascript
this.saveForm._originalSuggestedTags = [...this.saveForm.suggestedTags];
this.saveForm._acceptedAiTags = [];
```

**Step 4: 在 `addSuggestedTag` 中追踪接受记录**

```javascript
this.saveForm._acceptedAiTags = this.saveForm._acceptedAiTags || [];
this.saveForm._acceptedAiTags.push({ slug: tag.slug, confidence: tag.confidence });
```

**Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: track AI tag feedback events on accept"
```

---

## Task 8: 前端高级过滤（NOT tags / 日期范围 / 域名）

**Files:**
- Modify: `public/index.html`

**Step 1: 在 Alpine 数据区域添加高级过滤状态**

```javascript
// Advanced filter state
excludedTags: [],
domainFilter: '',
dateFrom: '',
dateTo: '',
showAdvancedFilter: false,
```

**Step 2: 更新 `fetchBookmarks` 方法，透传新参数**

在 `params` 构建处追加：

```javascript
if (this.excludedTags.length) params.set('not_tags', this.excludedTags.join(','));
if (this.domainFilter.trim()) params.set('domain', this.domainFilter.trim());
if (this.dateFrom) params.set('from', String(dayjs(this.dateFrom).unix()));
if (this.dateTo) params.set('to', String(dayjs(this.dateTo).endOf('day').unix()));
```

同样在 `loadMore` 中同步。

**Step 3: 添加 NOT tag 切换方法**

```javascript
toggleExcludeTag(slug) {
  // 先从 selectedTags 移除（不能同时选中和排除）
  this.selectedTags = this.selectedTags.filter(s => s !== slug);
  const idx = this.excludedTags.indexOf(slug);
  if (idx === -1) {
    this.excludedTags.push(slug);
  } else {
    this.excludedTags.splice(idx, 1);
  }
  this.fetchBookmarks();
},
```

**Step 4: 在 sidebar tag 按钮上加右键/长按排除支持**

将 tag 按钮修改（同时支持点击选中、shift+click 排除）：

```html
<button
  class="w-full text-left btn btn-xs justify-between"
  :class="{
    'btn-primary': selectedTags.includes(tag.slug),
    'btn-error btn-outline': excludedTags.includes(tag.slug),
    'btn-ghost': !selectedTags.includes(tag.slug) && !excludedTags.includes(tag.slug)
  }"
  @click="$event.shiftKey ? toggleExcludeTag(tag.slug) : toggleTag(tag.slug)"
  :title="'Shift+点击排除 ' + tag.name"
>
  <span class="truncate" x-text="tag.name"></span>
  <span class="badge badge-xs ml-1 shrink-0" x-text="tag.usage_count"></span>
</button>
```

**Step 5: 在主内容区筛选状态栏显示 NOT tag**

在 `selectedTags` 的 badge 模板之后追加：

```html
<template x-for="slug in excludedTags" :key="'not-' + slug">
  <span class="badge badge-error badge-outline gap-1">
    <span class="opacity-70 text-xs">NOT</span>
    <span x-text="allTags.find(t => t.slug === slug)?.name || slug"></span>
    <button @click="toggleExcludeTag(slug)" class="hover:opacity-70" aria-label="移除排除">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3" aria-hidden="true">
        <path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>
      </svg>
    </button>
  </span>
</template>
```

**Step 6: 在 header 搜索框旁添加高级过滤入口**

在 `保存链接` 按钮之前：

```html
<button class="btn btn-ghost btn-sm shrink-0" @click="showAdvancedFilter = !showAdvancedFilter" title="高级过滤">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
  </svg>
</button>
```

**Step 7: 在 header 下方插入可折叠的高级过滤栏**

```html
<!-- Advanced Filter Bar -->
<div x-show="showAdvancedFilter" x-transition class="border-b border-base-300 bg-base-100">
  <div class="max-w-7xl mx-auto px-4 md:px-6 py-3 flex flex-wrap gap-3 items-end">
    <label class="flex flex-col gap-1">
      <span class="text-xs opacity-60">域名</span>
      <input type="text" class="input input-bordered input-xs w-36" placeholder="github.com" x-model="domainFilter" @change="fetchBookmarks()" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs opacity-60">开始日期</span>
      <input type="date" class="input input-bordered input-xs" x-model="dateFrom" @change="fetchBookmarks()" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs opacity-60">结束日期</span>
      <input type="date" class="input input-bordered input-xs" x-model="dateTo" @change="fetchBookmarks()" />
    </label>
    <button class="btn btn-ghost btn-xs" @click="domainFilter=''; dateFrom=''; dateTo=''; fetchBookmarks()">清除</button>
  </div>
</div>
```

**Step 8: Commit**

```bash
git add public/index.html
git commit -m "feat: add NOT tag filter, domain filter, and date range filter"
```

---

## Task 9: 前端批量操作（多选 / 批量删除 / 批量加标签）

**Files:**
- Modify: `public/index.html`

**Step 1: 添加批量操作状态**

```javascript
// Batch operation state
selectedBookmarkIds: [],
isBatchMode: false,
isBatchDeleting: false,
isBatchTagging: false,
batchTagInput: '',
batchTagSearchResults: [],
```

**Step 2: 添加批量操作方法**

```javascript
toggleBatchMode() {
  this.isBatchMode = !this.isBatchMode;
  if (!this.isBatchMode) this.selectedBookmarkIds = [];
},

toggleBookmarkSelect(id) {
  const idx = this.selectedBookmarkIds.indexOf(id);
  if (idx === -1) this.selectedBookmarkIds.push(id);
  else this.selectedBookmarkIds.splice(idx, 1);
},

toggleSelectAll() {
  if (this.selectedBookmarkIds.length === this.bookmarks.length) {
    this.selectedBookmarkIds = [];
  } else {
    this.selectedBookmarkIds = this.bookmarks.map(b => b.id);
  }
},

async handleBatchDelete() {
  if (!this.selectedBookmarkIds.length) return;
  if (!confirm(`确认删除选中的 ${this.selectedBookmarkIds.length} 个书签？`)) return;
  this.isBatchDeleting = true;
  try {
    await Promise.all(
      this.selectedBookmarkIds.map(id =>
        fetch(`${API_BASE}/api/bookmarks/${id}`, { method: 'DELETE' })
      )
    );
    this.bookmarks = this.bookmarks.filter(b => !this.selectedBookmarkIds.includes(b.id));
    this.selectedBookmarkIds = [];
    Alpine.store('alert').show('批量删除成功', 'success');
    await this.fetchTags();
  } catch {
    Alpine.store('alert').show('部分删除失败', 'error');
  } finally {
    this.isBatchDeleting = false;
  }
},

filterBatchTagSuggestions() {
  const q = this.batchTagInput.trim().toLowerCase();
  if (!q) { this.batchTagSearchResults = []; return; }
  this.batchTagSearchResults = this.allTags.filter(t => t.name.toLowerCase().includes(q));
},

async handleBatchAddTag(tag) {
  if (!this.selectedBookmarkIds.length) return;
  this.isBatchTagging = true;
  try {
    for (const bmId of this.selectedBookmarkIds) {
      const bm = this.bookmarks.find(b => b.id === bmId);
      if (!bm) continue;
      const currentTagIds = (bm.tags || []).map(t => t.id);
      if (currentTagIds.includes(tag.id)) continue;
      await fetch(`${API_BASE}/api/bookmarks/${bmId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_ids: [...currentTagIds, tag.id] }),
      });
    }
    this.batchTagInput = '';
    this.batchTagSearchResults = [];
    await this.fetchBookmarks();
    await this.fetchTags();
    Alpine.store('alert').show(`已为选中书签添加标签「${tag.name}」`, 'success');
  } catch {
    Alpine.store('alert').show('批量打标签失败', 'error');
  } finally {
    this.isBatchTagging = false;
  }
},
```

**Step 3: 在 header 区域添加批量模式切换按钮**

在保存链接按钮之前：

```html
<button
  class="btn btn-sm shrink-0"
  :class="isBatchMode ? 'btn-secondary' : 'btn-ghost'"
  @click="toggleBatchMode()"
>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
    <rect x="3" y="5" width="4" height="4" rx="1"></rect><rect x="3" y="13" width="4" height="4" rx="1"></rect>
    <line x1="10" y1="7" x2="21" y2="7"></line><line x1="10" y1="15" x2="21" y2="15"></line>
  </svg>
  <span x-text="isBatchMode ? '退出批量' : '批量'"></span>
</button>
```

**Step 4: 在 Filter status bar 下方添加批量操作工具栏**

```html
<!-- Batch toolbar -->
<div x-show="isBatchMode" class="flex items-center gap-2 flex-wrap p-3 bg-base-100 rounded-box border border-base-300">
  <label class="flex items-center gap-2 cursor-pointer">
    <input type="checkbox" class="checkbox checkbox-sm"
      :checked="selectedBookmarkIds.length === bookmarks.length && bookmarks.length > 0"
      @change="toggleSelectAll()"
    />
    <span class="text-sm" x-text="selectedBookmarkIds.length ? `已选 ${selectedBookmarkIds.length} 个` : '全选'"></span>
  </label>

  <div class="flex-1"></div>

  <!-- Batch tag -->
  <div class="relative" x-show="selectedBookmarkIds.length > 0">
    <div class="flex gap-1">
      <input
        type="text"
        class="input input-bordered input-xs w-32"
        placeholder="搜索标签..."
        x-model="batchTagInput"
        @input="filterBatchTagSuggestions()"
      />
    </div>
    <div
      x-show="batchTagInput && batchTagSearchResults.length > 0"
      class="absolute top-full left-0 z-50 mt-1 bg-base-100 border border-base-300 rounded-box shadow-lg max-h-40 overflow-y-auto w-40"
    >
      <template x-for="tag in batchTagSearchResults" :key="tag.id">
        <button
          class="w-full text-left px-3 py-1.5 text-sm hover:bg-base-200"
          @click="handleBatchAddTag(tag)"
          x-text="tag.name"
        ></button>
      </template>
    </div>
  </div>

  <button
    class="btn btn-error btn-sm"
    :class="{ 'loading': isBatchDeleting }"
    :disabled="selectedBookmarkIds.length === 0 || isBatchDeleting"
    @click="handleBatchDelete()"
  >
    <svg x-show="!isBatchDeleting" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
    </svg>
    <span x-text="selectedBookmarkIds.length ? `删除 (${selectedBookmarkIds.length})` : '删除'"></span>
  </button>
</div>
```

**Step 5: 在书签卡片左侧添加 checkbox（批量模式下显示）**

在 `<article ...>` 内部最外层 div 改为：

```html
<div class="card-body p-4 gap-2 flex-row">
  <!-- Batch checkbox -->
  <div x-show="isBatchMode" class="pt-1 shrink-0">
    <input
      type="checkbox"
      class="checkbox checkbox-sm"
      :checked="selectedBookmarkIds.includes(bm.id)"
      @change="toggleBookmarkSelect(bm.id)"
    />
  </div>
  <!-- 原有内容 div -->
  <div class="flex-1 min-w-0 flex flex-col gap-2">
    <!-- ... 原有书签内容 ... -->
  </div>
</div>
```

**Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: add batch select, bulk delete, and bulk tag operations"
```

---

## Task 10: 收尾 — 修复 `addOrCreateTag` 数据解析 + 更新 AGENTS.md

**Files:**
- Modify: `public/index.html`
- Modify: `AGENTS.md`

**Step 1: 修复现有 `addOrCreateTag` 返回值解析**

当前代码 `const tag = data.tag || data` 不正确，API 返回 `{ ok: true, data: {...} }`，修改为：

```javascript
// addOrCreateTag 和 addOrCreateEditTag 中
const json = await res.json();
tag = json.data;
this.allTags.push(tag);
```

同样修复 `handleCreateTag` 中：

```javascript
const json = await res.json();
const tag = json.data;
this.allTags.push(tag);
```

**Step 2: 修复 `handleRenameTag` 返回值解析**

```javascript
const json = await res.json();
const updated = json.data;
const idx = this.allTags.findIndex(t => t.id === tag.id);
if (idx !== -1) this.allTags[idx] = updated;
```

**Step 3: 应用远端 migration（需要用户手动执行）**

```bash
npx wrangler d1 migrations apply linkgrove --remote
```

**Step 4: 更新 AGENTS.md 补充新表和新 API**

在 AGENTS.md 数据库规范中追加新表说明，在后端规范中补充新路由。

**Step 5: Commit**

```bash
git add public/index.html AGENTS.md
git commit -m "fix: correct API response parsing; docs: update AGENTS.md for new tables and routes"
```

---

## 验收标准

完成所有 Task 后，以下功能应正常工作：

- [ ] 侧边栏显示 Saved Queries，点击应用过滤，可置顶/删除
- [ ] 当前过滤条件可保存为智能集合
- [ ] Tags 管理支持 Merge（源 tag 消失，书签重新归属）
- [ ] Tags 管理支持 Alias（添加/删除别名）
- [ ] Shift+点击 tag 排除（NOT filter），状态栏显示红色 NOT 徽章
- [ ] 高级过滤栏支持域名过滤和日期范围
- [ ] AI 建议 tag 被接受时发送 feedback 事件
- [ ] 批量模式：多选书签、批量删除、批量加标签
- [ ] 所有 API 响应解析正确（`json.data`）
