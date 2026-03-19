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
