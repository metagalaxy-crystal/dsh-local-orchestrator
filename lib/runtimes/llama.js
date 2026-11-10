/**
 * llama.cpp / llama-server 适配层。
 *
 * 只做四件事：
 * 1. 把资产描述拼成 llama-server 命令行（保留用户 registry 里的调优开关，
 *    只在需要时覆盖 ctx / ngl / threads / kv 量化）；
 * 2. 判活（/v1/models）；
 * 3. 对话（OpenAI 兼容 /v1/chat/completions，支持工具调用与图片）；
 * 4. 向量（/v1/embeddings）与重排（/rerank）。
 */
import path from 'node:path'
import { existsSync } from '../util.js'
import { resolveLlamaServer } from '../env.js'
import { fetchJson } from './process.js'

/** 把 registry 里的相对路径解析成绝对路径。 */
export function resolveModelPath(config, relative) {
  if (!relative) return null
  if (path.isAbsolute(relative)) return relative
  return path.join(config.paths.modelsRoot, relative.replace(/\\/g, '/'))
}

function argValue(args, ...flags) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    for (const flag of flags) {
      if (token === flag) return args[i + 1]
      if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
    }
  }
  return undefined
}

/** 删除参数里由我们统一接管的开关（避免重复/冲突）。 */
function stripManagedFlags(args) {
  const managed = new Set([
    '-m', '--model', '-mm', '--mmproj', '-c', '--ctx-size', '-ngl', '--n-gpu-layers',
    '-t', '--threads', '--host', '--port', '--alias', '-ctk', '--cache-type-k',
    '-ctv', '--cache-type-v', '--parallel', '-np', '--flash-attn', '-fa',
  ])
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    const base = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
    if (!managed.has(base)) {
      out.push(token)
      continue
    }
    if (!token.includes('=') && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i += 1
  }
  return out
}

/**
 * 生成 llama-server 启动命令。
 * @returns {{exe:string,args:string[],cwd:string|undefined,missing:string[]}}
 */
export function buildCommand(asset, config) {
  const missing = []
  // 便携副本优先：插件内 runtime/llama 有就直接用，换机器不用再配 LLAMA_SERVER
  const resolved = resolveLlamaServer(config)
  const exe = asset.launch.exe || resolved.exe
  if (!exe) missing.push('llamaServer 未配置（local_env {"action":"vendor-llama"} 或 paths.llamaServer）')
  else if (!existsSync(exe)) missing.push(`找不到 llama-server：${exe}（local_env {"action":"doctor"} 可定位）`)

  const gguf = resolveModelPath(config, asset.launch.gguf)
  if (!gguf) missing.push('资产缺少 launch.gguf')
  else if (!existsSync(gguf)) missing.push(`找不到模型文件：${gguf}`)

  const mmproj = resolveModelPath(config, asset.launch.mmproj)
  if (asset.launch.mmproj && !existsSync(mmproj)) missing.push(`找不到 mmproj：${mmproj}`)

  if (missing.length > 0) {
    return { exe: exe || 'llama-server', args: [], cwd: undefined, missing }
  }

  const rawArgs = stripManagedFlags(asset.launch.rawArgs ?? [])
  const args = [
    '-m', gguf,
    ...rawArgs,
  ]
  if (mmproj) args.push('-mm', mmproj)

  const ctx = asset.launch.ctx ?? argValue(asset.launch.rawArgs ?? [], '-c', '--ctx-size')
  const ngl = asset.launch.ngl ?? argValue(asset.launch.rawArgs ?? [], '-ngl', '--n-gpu-layers')
  const threads = asset.launch.threads ?? argValue(asset.launch.rawArgs ?? [], '-t', '--threads')

  if (ctx !== null && ctx !== undefined) args.push('-c', String(ctx))
  if (ngl !== null && ngl !== undefined) args.push('-ngl', String(ngl))
  if (threads !== null && threads !== undefined) args.push('-t', String(threads))
  // 并行槽位：llama-server 默认 4，会为每个槽各留一份计算缓冲；
  // 单个 agent 串行调用时 1 个槽足够，显存更省（可在 config 里调大）。
  const hasParallel = (asset.launch.rawArgs ?? []).some(
    (arg) => arg === '--parallel' || arg === '-np' || String(arg).startsWith('--parallel='),
  )
  const parallel = asset.launch.parallel ?? (hasParallel ? null : Number(config.scheduler?.parallelSlots ?? 1))
  if (parallel) args.push('--parallel', String(parallel))
  if (asset.launch.kvType) args.push('-ctk', String(asset.launch.kvType), '-ctv', String(asset.launch.kvType))
  if (asset.launch.flashAttn === true) args.push('--flash-attn')

  args.push('--host', asset.host, '--port', String(asset.port), '--alias', asset.id)
  for (const extra of asset.launch.extraArgs ?? []) args.push(...String(extra).split(/\s+/).filter(Boolean))

  return { exe, args, cwd: path.dirname(exe), missing }
}

function baseUrl(asset) {
  return `http://${asset.host}:${asset.port}`
}

/** 单次健康探测：/v1/models 里有模型即视为就绪。 */
export async function probe(asset, { timeoutMs = 2500 } = {}) {
  const pathName = asset.health.path || '/v1/models'
  const result = await fetchJson(`${baseUrl(asset)}${pathName}`, { timeoutMs })
  if (!result.ok) return { ok: false, error: result.error }
  const body = result.body
  if (pathName.startsWith('/v1/models')) {
    const ids = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter(Boolean) : []
    if (ids.length === 0) return { ok: false, error: '服务已启动但尚未加载模型' }
    return { ok: true, body, model: ids[0] }
  }
  return { ok: true, body }
}

/** 当前服务里加载的模型 id。 */
export async function currentModel(asset) {
  const result = await probe(asset)
  return result.ok ? result.model ?? null : null
}

/**
 * 对话。
 * @param {object} asset
 * @param {object} options
 * @param {Array<{role:string,content:any}>} options.messages
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {string} [options.system]
 * @param {boolean} [options.json]
 * @param {Array<object>} [options.tools]
 * @param {AbortSignal} [options.signal]
 */
export async function chat(asset, options = {}) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  messages.push(...(options.messages ?? []))

  const body = {
    model: asset.health.alias || asset.id,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 2048,
  }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = options.toolChoice ?? 'auto'
  }
  if (options.json) body.response_format = { type: 'json_object' }
  if (options.topP !== undefined) body.top_p = options.topP
  if (options.topK !== undefined) body.top_k = options.topK
  if (options.extra && typeof options.extra === 'object') Object.assign(body, options.extra)

  const result = await fetchJson(`${baseUrl(asset)}/v1/chat/completions`, {
    method: 'POST',
    body,
    timeoutMs: options.timeoutMs ?? 600000,
    signal: options.signal,
  })
  if (!result.ok) return { ok: false, error: result.error }

  const data = result.body ?? {}
  const choice = data.choices?.[0] ?? {}
  const message = choice.message ?? {}
  return {
    ok: true,
    content: String(message.content ?? ''),
    reasoning: String(message.reasoning_content ?? ''),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finishReason: choice.finish_reason ?? null,
    model: data.model ?? asset.id,
    usage: data.usage ?? null,
    timings: data.timings ?? null,
  }
}

/** 向量化。 */
export async function embed(asset, input, { signal, timeoutMs = 120000 } = {}) {
  const result = await fetchJson(`${baseUrl(asset)}/v1/embeddings`, {
    method: 'POST',
    body: { model: asset.health.alias || asset.id, input },
    timeoutMs,
    signal,
  })
  if (!result.ok) return { ok: false, error: result.error }
  const vectors = (result.body?.data ?? []).map((item) => item.embedding)
  return { ok: true, vectors, dim: vectors[0]?.length ?? 0, usage: result.body?.usage ?? null }
}

/** 重排。 */
export async function rerank(asset, { query, documents, topN = 5, signal, timeoutMs = 120000 } = {}) {
  const result = await fetchJson(`${baseUrl(asset)}/rerank`, {
    method: 'POST',
    body: { model: asset.health.alias || asset.id, query, documents, top_n: topN },
    timeoutMs,
    signal,
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, results: result.body?.results ?? [] }
}

/**
 * 从 llama-server 日志精确读取 GPU 缓冲占用：
 * 日志会打印 `CUDA0 model buffer size = x MiB` / `KV buffer size` / `compute buffer size`，
 * 相加就是该进程真实占用的显存——Windows WDDM 下这是最可靠的口径。
 */
export async function measureFromLog(logFile) {
  if (!logFile) return null
  let text
  try {
    const fsp = await import('node:fs/promises')
    text = await fsp.readFile(logFile, 'utf8')
  } catch {
    return null
  }
  let total = 0
  let found = false
  // 日志是追加写的：只看最后一次启动之后的部分，避免把历史加载的缓冲加起来
  const start = text.lastIndexOf('llama_server: initializing')
  if (start >= 0) text = text.slice(start)
  const pattern = /CUDA\d+\s+(?:model|KV|compute|MMQ)\s+buffer size\s*=\s*([\d.]+)\s*MiB/gi
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) {
      total += value
      found = true
    }
  }
  return found ? Math.round(total) : null
}
