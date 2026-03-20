import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'

// ── DB schema types ─────────────────────────────────────────────────────────

type BookmarkType = 'article' | 'video' | 'tool' | 'docs' | 'paper' | 'other'
type TagSource = 'user' | 'ai' | 'rule'
type TagStatus = 'active' | 'rejected'

interface BookmarkTable {
  id: string
  url: string
  canonical_url: string
  title: string
  domain: string
  summary: string
  note: string
  type: BookmarkType
  created_at: number
  updated_at: number
}

interface TagTable {
  id: string
  name: string
  slug: string
  created_at: number
  updated_at: number
}

interface BookmarkTagTable {
  bookmark_id: string
  tag_id: string
  source: TagSource
  confidence: number | null
  status: TagStatus
  created_at: number
}

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

interface DB {
  bookmarks: BookmarkTable
  tags: TagTable
  bookmark_tags: BookmarkTagTable
  tag_aliases: TagAliasTable
  saved_queries: SavedQueryTable
  user_feedback_events: UserFeedbackEventTable
}

function createDb(d1: D1Database) {
  return new Kysely<DB>({ dialect: new D1Dialect({ database: d1 }) })
}

// ── app ─────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.use('/api/*', cors())

// ── utils ───────────────────────────────────────────────────────────────────

function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  const bytes = crypto.getRandomValues(new Uint8Array(21))
  for (const b of bytes) id += chars[b % chars.length]
  return id
}

function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-\u4e00-\u9fff]/g, '')
}

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'fbclid',
  'gclid',
]
function toCanonicalUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p)
    return u.toString()
  } catch {
    return rawUrl
  }
}

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

// ── page fetcher ─────────────────────────────────────────────────────────────

async function fetchPageMeta(url: string): Promise<{ title: string; description: string }> {
  const meta = { title: '', description: '' }
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Linkgrove/1.0)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return meta
    await new HTMLRewriter()
      .on('title', {
        text(t) {
          if (t.text) meta.title = (meta.title + t.text).slice(0, 200)
        },
      })
      .on('meta[name="description"]', {
        element(e) {
          meta.description ||= e.getAttribute('content')?.slice(0, 500) || ''
        },
      })
      .on('meta[property="og:title"]', {
        element(e) {
          meta.title ||= e.getAttribute('content')?.slice(0, 200) || ''
        },
      })
      .on('meta[property="og:description"]', {
        element(e) {
          meta.description ||= e.getAttribute('content')?.slice(0, 500) || ''
        },
      })
      .transform(resp)
      .text()
  } catch {}
  return meta
}

// ── bookmarks ────────────────────────────────────────────────────────────────

// GET /api/bookmarks?q=&tags=a,b&domain=&limit=&offset=
app.get('/api/bookmarks', async (c) => {
  const { q = '', tags = '', not_tags = '', domain = '', limit = '50', offset = '0', from = '', to = '' } = c.req.query()
  const db = createDb(c.env.DB)
  const lim = Math.min(parseInt(limit) || 50, 200)
  const off = parseInt(offset) || 0

  const tagList = tags
    ? tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : []

  let query = db
    .selectFrom('bookmarks as b')
    .select([
      'b.id',
      'b.url',
      'b.title',
      'b.domain',
      'b.summary',
      'b.type',
      'b.note',
      'b.created_at',
      'b.updated_at',
    ])
    .distinct()
    .orderBy('b.created_at', 'desc')
    .limit(lim)
    .offset(off)

  for (let i = 0; i < tagList.length; i++) {
    query = query
      .innerJoin(`bookmark_tags as bt${i}`, `bt${i}.bookmark_id`, 'b.id')
      .innerJoin(`tags as tg${i}`, (join) =>
        join
          .onRef(`tg${i}.id`, '=', `bt${i}.tag_id` as any)
          .on(`bt${i}.status` as any, '=', 'active')
      )
      .where(`tg${i}.slug` as any, '=', tagList[i])
  }

  // NOT tags：用 NOT EXISTS 子查询排除含某 tag 的书签
  const notTagList = not_tags ? not_tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []
  for (const notSlug of notTagList) {
    query = query.where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom('bookmark_tags as nbt' as any)
            .innerJoin('tags as ntg', 'ntg.id', 'nbt.tag_id' as any)
            .select('nbt.bookmark_id' as any)
            .whereRef('nbt.bookmark_id' as any, '=', 'b.id')
            .where('nbt.status' as any, '=', 'active')
            .where('ntg.slug' as any, '=', notSlug)
        )
      )
    )
  }

  if (from) query = query.where('b.created_at', '>=', parseInt(from))
  if (to) query = query.where('b.created_at', '<=', parseInt(to))

  if (q) {
    query = query.where((eb) =>
      eb.or([
        eb('b.title', 'like', `%${q}%`),
        eb('b.summary', 'like', `%${q}%`),
        eb('b.note', 'like', `%${q}%`),
      ])
    )
  }
  if (domain) query = query.where('b.domain', '=', domain)

  const bookmarks = await query.execute()

  // 批量查 tags
  const ids = bookmarks.map((b) => b.id)
  const tagMap: Record<
    string,
    { id: string; name: string; slug: string; source: string; confidence: number | null }[]
  > = {}
  if (ids.length > 0) {
    const tagRows = await db
      .selectFrom('bookmark_tags as bt')
      .innerJoin('tags as t', 't.id', 'bt.tag_id')
      .select(['bt.bookmark_id', 't.id', 't.name', 't.slug', 'bt.source', 'bt.confidence'])
      .where('bt.bookmark_id', 'in', ids)
      .where('bt.status', '=', 'active')
      .execute()
    for (const row of tagRows) {
      if (!tagMap[row.bookmark_id]) tagMap[row.bookmark_id] = []
      tagMap[row.bookmark_id].push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        source: row.source,
        confidence: row.confidence,
      })
    }
  }

  return c.json({ ok: true, data: bookmarks.map((b) => ({ ...b, tags: tagMap[b.id] || [] })) })
})

// POST /api/bookmarks
app.post('/api/bookmarks', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.url) return c.json({ ok: false, error: 'url is required' }, 400)

  let rawUrl = (body.url as string).trim()
  if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl

  const db = createDb(c.env.DB)
  const canonical = toCanonicalUrl(rawUrl)
  const ts = now()
  const id = generateId()
  const tagIds = (body.tag_ids as string[]) || []

  const dup = await db
    .selectFrom('bookmarks')
    .select(['id', 'url', 'title'])
    .where('canonical_url', '=', canonical)
    .executeTakeFirst()
  if (dup) return c.json({ ok: false, error: 'bookmark already exists', existing: dup }, 409)

  if (tagIds.length > 0) {
    const validTags = await db.selectFrom('tags').select('id').where('id', 'in', tagIds).execute()
    const validIds = new Set(validTags.map((t) => t.id))
    const invalid = tagIds.filter((id) => !validIds.has(id))
    if (invalid.length > 0)
      return c.json({ ok: false, error: `invalid tag ids: ${invalid.join(', ')}` }, 400)
  }

  await db
    .insertInto('bookmarks')
    .values({
      id,
      url: rawUrl,
      canonical_url: canonical,
      title: (body.title as string) || rawUrl,
      domain: extractDomain(rawUrl),
      summary: (body.summary as string) || '',
      note: (body.note as string) || '',
      type: (body.type as BookmarkType) || 'other',
      created_at: ts,
      updated_at: ts,
    })
    .execute()

  for (const tagId of tagIds) {
    await db
      .insertInto('bookmark_tags')
      .values({
        bookmark_id: id,
        tag_id: tagId,
        source: 'user',
        confidence: null,
        status: 'active',
        created_at: ts,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  const bookmark = await db
    .selectFrom('bookmarks')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return c.json({ ok: true, data: bookmark }, 201)
})

// PUT /api/bookmarks/:id
app.put('/api/bookmarks/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ ok: false, error: 'body required' }, 400)

  const db = createDb(c.env.DB)
  const ts = now()

  const existing = await db
    .selectFrom('bookmarks')
    .select(['id', 'title'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'bookmark not found' }, 404)

  await db
    .updateTable('bookmarks')
    .set({
      title: (body.title as string) ?? existing.title,
      summary: (body.summary as string) || '',
      note: (body.note as string) || '',
      type: (body.type as BookmarkType) || 'other',
      updated_at: ts,
    })
    .where('id', '=', id)
    .execute()

  if (Array.isArray(body.tag_ids)) {
    const tagIds = body.tag_ids as string[]
    if (tagIds.length > 0) {
      const validTags = await db.selectFrom('tags').select('id').where('id', 'in', tagIds).execute()
      const validIds = new Set(validTags.map((t) => t.id))
      const invalid = tagIds.filter((id) => !validIds.has(id))
      if (invalid.length > 0)
        return c.json({ ok: false, error: `invalid tag ids: ${invalid.join(', ')}` }, 400)
    }
    await db
      .deleteFrom('bookmark_tags')
      .where('bookmark_id', '=', id)
      .where('source', '=', 'user')
      .execute()
    for (const tagId of tagIds) {
      await db
        .insertInto('bookmark_tags')
        .values({
          bookmark_id: id,
          tag_id: tagId,
          source: 'user',
          confidence: null,
          status: 'active',
          created_at: ts,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }

  const bookmark = await db
    .selectFrom('bookmarks')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return c.json({ ok: true, data: bookmark })
})

// DELETE /api/bookmarks/:id
app.delete('/api/bookmarks/:id', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const existing = await db
    .selectFrom('bookmarks')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'bookmark not found' }, 404)
  await db.deleteFrom('bookmarks').where('id', '=', id).execute()
  return c.json({ ok: true })
})

// ── tags ─────────────────────────────────────────────────────────────────────

// GET /api/tags?q=
app.get('/api/tags', async (c) => {
  const { q = '' } = c.req.query()
  const db = createDb(c.env.DB)

  let query = db
    .selectFrom('tags as t')
    .leftJoin('bookmark_tags as bt', (join) =>
      join.onRef('bt.tag_id', '=', 't.id').on('bt.status', '=', 'active')
    )
    .select([
      't.id',
      't.name',
      't.slug',
      't.created_at',
      db.fn.count<number>('bt.tag_id' as any).as('usage_count'),
    ])
    .groupBy('t.id')
    .orderBy('usage_count', 'desc')
    .orderBy('t.name', 'asc')
    .limit(500)

  if (q) {
    query = query.where((eb) =>
      eb.or([eb('t.name', 'like', `%${q}%`), eb('t.slug', 'like', `%${q}%`)])
    )
  }

  const results = await query.execute()
  return c.json({ ok: true, data: results })
})

// POST /api/tags
app.post('/api/tags', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.name) return c.json({ ok: false, error: 'name is required' }, 400)

  const slug = toSlug(body.name as string)
  if (!slug) return c.json({ ok: false, error: 'invalid tag name' }, 400)

  const db = createDb(c.env.DB)
  const existing = await db
    .selectFrom('tags')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst()
  if (existing) {
    const tag = await db
      .selectFrom('tags as t')
      .leftJoin('bookmark_tags as bt', (join) =>
        join.onRef('bt.tag_id', '=', 't.id').on('bt.status', '=', 'active')
      )
      .select([
        't.id',
        't.name',
        't.slug',
        't.created_at',
        't.updated_at',
        db.fn.count<number>('bt.tag_id' as any).as('usage_count'),
      ])
      .where('t.id', '=', existing.id)
      .groupBy('t.id')
      .executeTakeFirst()
    return c.json({ ok: true, data: tag })
  }

  const id = generateId()
  const ts = now()
  await db
    .insertInto('tags')
    .values({ id, name: (body.name as string).trim(), slug, created_at: ts, updated_at: ts })
    .execute()
  const tag = await db.selectFrom('tags').selectAll().where('id', '=', id).executeTakeFirst()
  return c.json({ ok: true, data: tag }, 201)
})

// PUT /api/tags/:id
app.put('/api/tags/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.name) return c.json({ ok: false, error: 'name is required' }, 400)

  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('tags').select('id').where('id', '=', id).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'tag not found' }, 404)

  const newSlug = toSlug(body.name as string)
  if (!newSlug) return c.json({ ok: false, error: 'invalid tag name' }, 400)

  const conflict = await db
    .selectFrom('tags')
    .select('id')
    .where('slug', '=', newSlug)
    .where('id', '!=', id)
    .executeTakeFirst()
  if (conflict) return c.json({ ok: false, error: 'slug already exists' }, 409)

  const ts = now()
  await db
    .updateTable('tags')
    .set({ name: (body.name as string).trim(), slug: newSlug, updated_at: ts })
    .where('id', '=', id)
    .execute()
  const tag = await db.selectFrom('tags').selectAll().where('id', '=', id).executeTakeFirst()
  return c.json({ ok: true, data: tag })
})

// DELETE /api/tags/:id
app.delete('/api/tags/:id', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('tags').select('id').where('id', '=', id).executeTakeFirst()
  if (!existing) return c.json({ ok: false, error: 'tag not found' }, 404)
  await db.deleteFrom('tags').where('id', '=', id).execute()
  return c.json({ ok: true })
})

// ── tag aliases & merge ──────────────────────────────────────────────────────

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

  const aliasText = (body.alias as string).trim()
  const slug = toSlug(aliasText)
  if (!slug) return c.json({ ok: false, error: 'invalid alias' }, 400)

  // 检查 slug 是否已被 tag 或其他 alias 使用
  const tagConflict = await db.selectFrom('tags').select('id').where('slug', '=', slug).executeTakeFirst()
  if (tagConflict) return c.json({ ok: false, error: 'slug already used by a tag' }, 409)
  const aliasConflict = await db.selectFrom('tag_aliases').select('id').where('slug', '=', slug).executeTakeFirst()
  if (aliasConflict) return c.json({ ok: false, error: 'alias already exists' }, 409)

  const id = generateId()
  const ts = now()
  await db.insertInto('tag_aliases').values({
    id, alias: aliasText, slug, tag_id: tagId, source: 'user', created_at: ts,
  }).execute()

  const alias = await db.selectFrom('tag_aliases').selectAll().where('id', '=', id).executeTakeFirst()
  return c.json({ ok: true, data: alias }, 201)
})

// DELETE /api/tags/:id/aliases/:aliasId
app.delete('/api/tags/:id/aliases/:aliasId', async (c) => {
  const tagId = c.req.param('id')
  const aliasId = c.req.param('aliasId')
  const db = createDb(c.env.DB)
  const existing = await db.selectFrom('tag_aliases').select('id')
    .where('id', '=', aliasId)
    .where('tag_id', '=', tagId)
    .executeTakeFirst()
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

  await db.transaction().execute(async (trx) => {
    // 获取 source 的所有书签关联
    const sourceRefs = await trx.selectFrom('bookmark_tags').selectAll().where('tag_id', '=', sourceId).execute()

    for (const ref of sourceRefs) {
      // 检查 target 是否已有这个书签
      const alreadyLinked = await trx
        .selectFrom('bookmark_tags')
        .select('bookmark_id')
        .where('bookmark_id', '=', ref.bookmark_id)
        .where('tag_id', '=', targetId)
        .executeTakeFirst()
      if (alreadyLinked) {
        // 已存在就删掉 source 的引用
        await trx.deleteFrom('bookmark_tags')
          .where('bookmark_id', '=', ref.bookmark_id)
          .where('tag_id', '=', sourceId)
          .execute()
      } else {
        // 迁移到 target
        await trx.updateTable('bookmark_tags')
          .set({ tag_id: targetId })
          .where('bookmark_id', '=', ref.bookmark_id)
          .where('tag_id', '=', sourceId)
          .execute()
      }
    }

    // 将 source tag 的别名迁移到 target tag
    await trx.updateTable('tag_aliases')
      .set({ tag_id: targetId })
      .where('tag_id', '=', sourceId)
      .execute()

    // 删除 source tag（cascade 会清理剩余关联，别名已迁移）
    await trx.deleteFrom('tags').where('id', '=', sourceId).execute()
  })

  return c.json({ ok: true, data: { merged_into: targetId } })
})

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

// ── AI ───────────────────────────────────────────────────────────────────────

const AI_PROMPT = (title: string, description: string, url: string) =>
  `
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

// POST /api/ai/enrich
app.post('/api/ai/enrich', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.url) return c.json({ ok: false, error: 'url is required' }, 400)

  const meta = await fetchPageMeta(body.url as string)
  const title = (body.title as string) || meta.title || (body.url as string)
  const description = meta.description || ''

  type AiTextOutput = { response?: string }
  let aiResult: Record<string, unknown> | null = null
  try {
    const resp = (await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct' as Parameters<Ai['run']>[0], {
      prompt: AI_PROMPT(title, description, body.url as string),
      max_tokens: 512,
    })) as AiTextOutput
    const match = (resp.response || '').match(/\{[\s\S]*\}/)
    if (match) aiResult = JSON.parse(match[0]) as Record<string, unknown>
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return c.json({ ok: false, error: 'AI enrichment failed: ' + msg }, 502)
  }

  if (!aiResult) return c.json({ ok: false, error: 'AI returned invalid response' }, 502)

  const validTypes = ['article', 'video', 'tool', 'docs', 'paper', 'other']
  const type = validTypes.includes(aiResult.type as string) ? (aiResult.type as string) : 'other'
  const summary = typeof aiResult.summary === 'string' ? aiResult.summary.slice(0, 200) : ''
  const tags = Array.isArray(aiResult.tags)
    ? (aiResult.tags as Record<string, unknown>[])
        .filter((t) => t?.slug && t?.name)
        .map((t) => ({
          slug: String(t.slug).toLowerCase().replace(/\s+/g, '-').slice(0, 50),
          name: String(t.name).slice(0, 50),
          confidence:
            typeof t.confidence === 'number' ? Math.min(1, Math.max(0, t.confidence)) : 0.5,
        }))
        .slice(0, 6)
    : []

  return c.json({ ok: true, data: { title, description, type, summary, tags } })
})

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

// ── ping ─────────────────────────────────────────────────────────────────────

app.get('/api/ping', (c) => c.json({ ok: true }))

export default app
