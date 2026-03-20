import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.use('/api/*', cors())

// ── utils ──────────────────────────────────────────────────────────────────

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

// ── page fetcher ───────────────────────────────────────────────────────────

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

// ── bookmarks ──────────────────────────────────────────────────────────────

// GET /api/bookmarks?q=&tags=a,b&domain=&limit=&offset=
app.get('/api/bookmarks', async (c) => {
  const { q = '', tags = '', domain = '', limit = '50', offset = '0' } = c.req.query()
  const db = c.env.DB
  const lim = Math.min(parseInt(limit) || 50, 200)
  const off = parseInt(offset) || 0

  let sql = `SELECT DISTINCT b.id, b.url, b.title, b.domain, b.summary, b.type, b.note, b.created_at, b.updated_at FROM bookmarks b`
  const params: (string | number)[] = []
  const conditions: string[] = []

  const tagList = tags
    ? tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : []
  for (let i = 0; i < tagList.length; i++) {
    sql += ` JOIN bookmark_tags bt${i} ON bt${i}.bookmark_id = b.id JOIN tags tg${i} ON tg${i}.id = bt${i}.tag_id AND bt${i}.status = 'active'`
    conditions.push(`tg${i}.slug = ?`)
    params.push(tagList[i])
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

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>()

  const ids = results.map((r) => r.id as string)
  const tagMap: Record<string, unknown[]> = {}
  if (ids.length > 0) {
    const { results: tagRows } = await db
      .prepare(
        `SELECT bt.bookmark_id, t.id, t.name, t.slug, bt.source, bt.confidence
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.bookmark_id IN (${ids.map(() => '?').join(',')}) AND bt.status = 'active'`
      )
      .bind(...ids)
      .all<Record<string, unknown>>()
    for (const row of tagRows) {
      const bid = row.bookmark_id as string
      if (!tagMap[bid]) tagMap[bid] = []
      tagMap[bid].push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        source: row.source,
        confidence: row.confidence,
      })
    }
  }

  return c.json({
    ok: true,
    data: results.map((r) => ({ ...r, tags: tagMap[r.id as string] || [] })),
  })
})

// POST /api/bookmarks
app.post('/api/bookmarks', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.url) return c.json({ ok: false, error: 'url is required' }, 400)

  let rawUrl = (body.url as string).trim()
  if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl

  const db = c.env.DB
  const canonical = toCanonicalUrl(rawUrl)
  const ts = now()
  const id = generateId()
  const tagIds = (body.tag_ids as string[]) || []

  const {
    results: [dup],
  } = await db
    .prepare(`SELECT id, url, title FROM bookmarks WHERE canonical_url = ?`)
    .bind(canonical)
    .all()
  if (dup) return c.json({ ok: false, error: 'bookmark already exists', existing: dup }, 409)

  if (tagIds.length > 0) {
    const { results: validTags } = await db
      .prepare(`SELECT id FROM tags WHERE id IN (${tagIds.map(() => '?').join(',')})`)
      .bind(...tagIds)
      .all<{ id: string }>()
    const validIds = new Set(validTags.map((t) => t.id))
    const invalid = tagIds.filter((id) => !validIds.has(id))
    if (invalid.length > 0)
      return c.json({ ok: false, error: `invalid tag ids: ${invalid.join(', ')}` }, 400)
  }

  await db
    .prepare(
      `INSERT INTO bookmarks (id, url, canonical_url, title, domain, summary, note, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      rawUrl,
      canonical,
      body.title || rawUrl,
      extractDomain(rawUrl),
      body.summary || '',
      body.note || '',
      body.type || 'other',
      ts,
      ts
    )
    .run()

  for (const tagId of tagIds) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, confidence, status, created_at) VALUES (?, ?, 'user', NULL, 'active', ?)`
      )
      .bind(id, tagId, ts)
      .run()
  }

  const {
    results: [bookmark],
  } = await db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: bookmark }, 201)
})

// PUT /api/bookmarks/:id
app.put('/api/bookmarks/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ ok: false, error: 'body required' }, 400)

  const db = c.env.DB
  const ts = now()
  const {
    results: [existing],
  } = await db
    .prepare(`SELECT id, title FROM bookmarks WHERE id = ?`)
    .bind(id)
    .all<{ id: string; title: string }>()
  if (!existing) return c.json({ ok: false, error: 'bookmark not found' }, 404)

  await db
    .prepare(`UPDATE bookmarks SET title=?, summary=?, note=?, type=?, updated_at=? WHERE id=?`)
    .bind(
      body.title ?? existing.title,
      body.summary || '',
      body.note || '',
      body.type || 'other',
      ts,
      id
    )
    .run()

  if (Array.isArray(body.tag_ids)) {
    const tagIds = body.tag_ids as string[]
    if (tagIds.length > 0) {
      const { results: validTags } = await db
        .prepare(`SELECT id FROM tags WHERE id IN (${tagIds.map(() => '?').join(',')})`)
        .bind(...tagIds)
        .all<{ id: string }>()
      const validIds = new Set(validTags.map((t) => t.id))
      const invalid = tagIds.filter((id) => !validIds.has(id))
      if (invalid.length > 0)
        return c.json({ ok: false, error: `invalid tag ids: ${invalid.join(', ')}` }, 400)
    }
    await db
      .prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ? AND source = 'user'`)
      .bind(id)
      .run()
    for (const tagId of body.tag_ids as string[]) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, confidence, status, created_at) VALUES (?, ?, 'user', NULL, 'active', ?)`
        )
        .bind(id, tagId, ts)
        .run()
    }
  }

  const {
    results: [bookmark],
  } = await db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: bookmark })
})

// DELETE /api/bookmarks/:id
app.delete('/api/bookmarks/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const {
    results: [existing],
  } = await db.prepare(`SELECT id FROM bookmarks WHERE id = ?`).bind(id).all()
  if (!existing) return c.json({ ok: false, error: 'bookmark not found' }, 404)
  await db.prepare(`DELETE FROM bookmarks WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

// ── tags ───────────────────────────────────────────────────────────────────

// GET /api/tags?q=
app.get('/api/tags', async (c) => {
  const { q = '' } = c.req.query()
  const db = c.env.DB
  let sql = `SELECT t.id, t.name, t.slug, t.created_at, COUNT(bt.tag_id) as usage_count
             FROM tags t LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id AND bt.status = 'active'`
  const params: string[] = []
  if (q) {
    sql += ` WHERE t.name LIKE ? OR t.slug LIKE ?`
    params.push(`%${q}%`, `%${q}%`)
  }
  sql += ` GROUP BY t.id ORDER BY usage_count DESC, t.name ASC LIMIT 500`
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all()
  return c.json({ ok: true, data: results })
})

// POST /api/tags
app.post('/api/tags', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.name) return c.json({ ok: false, error: 'name is required' }, 400)

  const slug = toSlug(body.name as string)
  if (!slug) return c.json({ ok: false, error: 'invalid tag name' }, 400)

  const db = c.env.DB
  const {
    results: [existing],
  } = await db.prepare(`SELECT * FROM tags WHERE slug = ?`).bind(slug).all<{ id: string }>()
  if (existing) {
    const {
      results: [tag],
    } = await db
      .prepare(
        `SELECT t.id, t.name, t.slug, t.created_at, t.updated_at, COUNT(bt.tag_id) as usage_count
       FROM tags t LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id AND bt.status = 'active'
       WHERE t.id = ? GROUP BY t.id`
      )
      .bind(existing.id)
      .all()
    return c.json({ ok: true, data: tag })
  }

  const id = generateId()
  const ts = now()
  await db
    .prepare(`INSERT INTO tags (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, (body.name as string).trim(), slug, ts, ts)
    .run()

  const {
    results: [tag],
  } = await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: tag }, 201)
})

// PUT /api/tags/:id
app.put('/api/tags/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body?.name) return c.json({ ok: false, error: 'name is required' }, 400)

  const db = c.env.DB
  const {
    results: [existing],
  } = await db.prepare(`SELECT id FROM tags WHERE id = ?`).bind(id).all()
  if (!existing) return c.json({ ok: false, error: 'tag not found' }, 404)

  const newSlug = toSlug(body.name as string)
  if (!newSlug) return c.json({ ok: false, error: 'invalid tag name' }, 400)
  const {
    results: [conflict],
  } = await db.prepare(`SELECT id FROM tags WHERE slug = ? AND id != ?`).bind(newSlug, id).all()
  if (conflict) return c.json({ ok: false, error: 'slug already exists' }, 409)

  const ts = now()
  await db
    .prepare(`UPDATE tags SET name=?, slug=?, updated_at=? WHERE id=?`)
    .bind((body.name as string).trim(), newSlug, ts, id)
    .run()

  const {
    results: [tag],
  } = await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).all()
  return c.json({ ok: true, data: tag })
})

// DELETE /api/tags/:id
app.delete('/api/tags/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const {
    results: [existing],
  } = await db.prepare(`SELECT id FROM tags WHERE id = ?`).bind(id).all()
  if (!existing) return c.json({ ok: false, error: 'tag not found' }, 404)
  await db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run()
  return c.json({ ok: true })
})

// ── AI ─────────────────────────────────────────────────────────────────────

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
      response_format: { type: 'json_object' },
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

// ── ping ───────────────────────────────────────────────────────────────────

app.get('/api/ping', (c) => c.json({ ok: true }))

export default app
