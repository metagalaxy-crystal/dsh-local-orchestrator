/**
 * Web API 传输层：把 Node 的 req/res 适配给 lib/api.js。
 *
 * 路由挂在 /api/local-orchestrator 前缀下；真正的路由逻辑在 api.js，
 * 便于单测与复用（脚本/面板/未来 TUI 都走同一套）。
 */
import { createApi } from './api.js'

export function registerWeb(ctx, { config, orchestrator, decision, prefs = null }) {
  const api = createApi({ config, orchestrator, decision, prefs })
  const base = '/api/local-orchestrator'

  const readBody = async (req, maxBytes = 1024 * 1024) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > maxBytes) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(base.length) || '/'
    let body = {}
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await readBody(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: `请求体解析失败：${error.message}` })
      }
    }
    const query = Object.fromEntries(url.searchParams.entries())
    const result = await api({ method: req.method ?? 'GET', path: route, query, body })
    sendJson(res, result.status, result.body)
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: base, handler }),
      'dsh-local-orchestrator: web api',
    )
  })
}
