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
    console.warn('[fetchPageMeta] failed to fetch', url, e?.message)
  }

  return {
    title: (result.ogTitle || result.title || '').trim().slice(0, 500),
    description: (result.ogDescription || result.description || '').trim().slice(0, 2000),
  }
}
