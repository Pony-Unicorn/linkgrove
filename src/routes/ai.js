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

// POST /api/ai/enrich  { url, title? }
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
