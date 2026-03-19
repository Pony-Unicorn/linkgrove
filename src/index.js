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
