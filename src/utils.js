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
