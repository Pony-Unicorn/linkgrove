import { Hono } from 'hono'

const app = new Hono()

app.get('/api/ping', (c) => c.json({ ok: true }))

export default app
