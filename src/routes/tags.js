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
  const { results: [existing] } = await db.prepare(`SELECT * FROM tags WHERE slug = ?`).bind(slug).all()
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
