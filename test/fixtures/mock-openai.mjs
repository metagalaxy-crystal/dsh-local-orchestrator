/**
 * 测试用的最小 OpenAI 兼容服务：模拟 llama-server 的 /v1/models 与对话接口。
 * 用法：node mock-openai.mjs <port> <name>
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 18080)
const name = process.argv[3] ?? 'mock-model'

const send = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return send(res, 200, { object: 'list', data: [{ id: name, object: 'model' }] })
  }
  if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
    return send(res, 200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], usage: { total_tokens: 3 } })
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* ignore */
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const last = messages.at(-1)?.content
      const text = typeof last === 'string' ? last : JSON.stringify(last ?? '')
      send(res, 200, {
        model: name,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `[${name}] echo: ${text}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      })
    })
    return
  }
  send(res, 404, { error: 'not found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock ready on ${port}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
