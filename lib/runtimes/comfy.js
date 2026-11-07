/**
 * ComfyUI 适配层：拉起服务、查 /system_stats、提交工作流并取产物。
 *
 * 插件不内置工作流；工作流由工具调用方给（JSON），或从 <dataDir>/workflows/
 * 的模板文件加载。这样调度层与具体出图流程解耦。
 */
import path from 'node:path'
import { existsSync } from '../util.js'
import { fetchJson } from './process.js'

/** 生成 ComfyUI 启动命令。 */
export function buildCommand(asset, config) {
  const missing = []
  const cwd = asset.launch.cwd || config.paths.comfyDir
  if (!cwd || !existsSync(cwd)) missing.push(`找不到 ComfyUI 目录：${cwd || '(未配置)'}`)
  const exe = asset.launch.exe || config.paths.comfyPython || 'python'
  const command = Array.isArray(asset.launch.command) && asset.launch.command.length > 0
    ? asset.launch.command
    : ['main.py', '--listen', asset.host, '--port', String(asset.port)]
  return { exe, args: command, cwd, missing }
}

function baseUrl(asset) {
  return `http://${asset.host}:${asset.port}`
}

/** 判活：/system_stats 返回系统信息即就绪。 */
export async function probe(asset, { timeoutMs = 2500 } = {}) {
  const result = await fetchJson(`${baseUrl(asset)}/system_stats`, { timeoutMs })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, body: result.body }
}

/**
 * 提交工作流并等待产物。
 * @param {object} asset
 * @param {object} options
 * @param {object} options.workflow ComfyUI API 格式工作流（节点 id → 节点）
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 */
export async function generate(asset, { workflow, timeoutMs = 900000, signal, pollMs = 1500 } = {}) {
  if (!workflow || typeof workflow !== 'object') return { ok: false, error: '缺少 workflow' }
  const clientId = `dsh-${Date.now().toString(36)}`
  const submit = await fetchJson(`${baseUrl(asset)}/prompt`, {
    method: 'POST',
    body: { prompt: workflow, client_id: clientId },
    timeoutMs: 30000,
    signal,
  })
  if (!submit.ok) return { ok: false, error: submit.error }
  const promptId = submit.body?.prompt_id
  if (!promptId) return { ok: false, error: 'ComfyUI 未返回 prompt_id' }

  const started = Date.now()
  for (;;) {
    if (signal?.aborted) return { ok: false, error: '已取消', promptId }
    if (Date.now() - started > timeoutMs) return { ok: false, error: `生成超时（${timeoutMs}ms）`, promptId }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const history = await fetchJson(`${baseUrl(asset)}/history/${promptId}`, { timeoutMs: 10000, signal })
    if (!history.ok) continue
    const entry = history.body?.[promptId]
    if (!entry) continue
    if (entry.status?.status_str === 'error' || entry.status?.completed === false) {
      return { ok: false, error: 'ComfyUI 执行失败', promptId, detail: entry.status }
    }
    const files = []
    for (const output of Object.values(entry.outputs ?? {})) {
      for (const key of ['images', 'gifs', 'videos', 'audio']) {
        for (const item of output?.[key] ?? []) {
          if (!item?.filename) continue
          const query = new URLSearchParams({
            filename: item.filename,
            subfolder: item.subfolder ?? '',
            type: item.type ?? 'output',
          })
          files.push({
            filename: item.filename,
            subfolder: item.subfolder ?? '',
            type: item.type ?? 'output',
            url: `${baseUrl(asset)}/view?${query.toString()}`,
          })
        }
      }
    }
    return { ok: true, promptId, files, ms: Date.now() - started }
  }
}

/** 读取工作流模板（<dataDir>/workflows/<name>.json）。 */
export async function loadWorkflow(config, name) {
  if (!name) return null
  const file = path.join(config.dataDir, 'workflows', `${name}.json`)
  if (!existsSync(file)) return null
  const fsp = await import('node:fs/promises')
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 模型名校正
// 工作流 JSON 里的模型名是按导出时的目录写的（如 ae.safetensors），
// 但 ComfyUI 的实际列表是相对 extra_model_paths 的（如 Z-Image-Turbo\ae.safetensors）。
// 提交前用 /object_info 的下拉列表按「文件名匹配」纠正，等价于工程里的 comfy_client 自动校正。
let objectInfoCache = { at: 0, url: '', data: null }

async function getObjectInfo(asset, { timeoutMs = 30000 } = {}) {
  const url = baseUrl(asset)
  if (objectInfoCache.data && objectInfoCache.url === url && Date.now() - objectInfoCache.at < 120000) {
    return objectInfoCache.data
  }
  const result = await fetchJson(`${url}/object_info`, { timeoutMs })
  if (!result.ok) return null
  objectInfoCache = { at: Date.now(), url, data: result.body }
  return result.body
}

function comboList(classInfo, key) {
  const spec = classInfo?.input?.required?.[key] ?? classInfo?.input?.optional?.[key]
  const first = Array.isArray(spec) ? spec[0] : null
  if (Array.isArray(first) && first.length > 0 && first.every((item) => typeof item === 'string')) return first
  return null
}

function matchName(value, list) {
  if (list.includes(value)) return value
  const base = String(value).split(/[\\/]/).pop().toLowerCase()
  const byBase = list.filter((item) => String(item).split(/[\\/]/).pop().toLowerCase() === base)
  if (byBase.length > 0) return byBase.sort((a, b) => a.length - b.length)[0]
  const bySuffix = list.filter((item) => String(item).toLowerCase().endsWith(base))
  if (bySuffix.length > 0) return bySuffix.sort((a, b) => a.length - b.length)[0]
  return null
}

/**
 * 按 ComfyUI 实际可用的模型列表纠正工作流里的文件名。
 * @returns {Promise<{workflow: object, fixes: Array<{nodeId:string,key:string,from:string,to:string}>}>}
 */
export async function fixWorkflowNames(asset, workflow) {
  const info = await getObjectInfo(asset).catch(() => null)
  if (!info) return { workflow, fixes: [] }
  const fixes = []
  for (const [nodeId, node] of Object.entries(workflow ?? {})) {
    if (!node || typeof node !== 'object' || !node.class_type) continue
    const classInfo = info[node.class_type]
    if (!classInfo || !node.inputs) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string') continue
      const list = comboList(classInfo, key)
      if (!list) continue
      if (list.includes(value)) continue
      const picked = matchName(value, list)
      if (picked && picked !== value) {
        node.inputs[key] = picked
        fixes.push({ nodeId, key, from: value, to: picked })
      }
    }
  }
  return { workflow, fixes }
}
