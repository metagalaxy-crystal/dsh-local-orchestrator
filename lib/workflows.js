/**
 * ComfyUI 工作流：加载 + 参数注入 + 去掉 `_meta`。
 *
 * 现有工程（D:\models\scripts\comfyui\*）里的工作流带一个 `_meta` 段：
 *   {"positive":"3","negative":"4","sampler":"7","latent":"6","模型":"..."}
 * 真正的 ComfyUI 接口只接受「节点 id → 节点」，`_meta` 必须剥掉；这里顺便
 * 用它把 prompt / 负面词 / 步数 / seed / 分辨率注入对应节点。
 *
 * 模板查找顺序：绝对路径 → <dataDir>/workflows/<名>.json →
 * <comfyScripts>/<名>.json → <comfyScripts>/<名>/workflow*.json。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { existsSync } from './util.js'

/** 递归替换字符串里的 `{{key}}`；对象/数组递归处理。 */
export function fillWorkflow(node, params = {}) {
  if (typeof node === 'string') {
    return node.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) => {
      const value = params[key]
      return value === undefined || value === null ? whole : String(value)
    })
  }
  if (Array.isArray(node)) return node.map((item) => fillWorkflow(item, params))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) out[key] = fillWorkflow(value, params)
    return out
  }
  return node
}

function textField(node) {
  return node?.class_type === 'CLIPTextEncode' ? 'text' : 'prompt'
}

/**
 * 把参数写进工作流（剥掉 `_meta`）。
 * @param {object} raw 原始工作流
 * @param {object} params {prompt, negative, steps, cfg, seed, width, height, res, ...}
 */
export function prepareWorkflow(raw, params = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const meta = raw._meta && typeof raw._meta === 'object' ? raw._meta : {}
  const wf = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === '_meta') continue
    wf[key] = value
  }
  const inputs = (id) => (id && wf[id] && typeof wf[id] === 'object' ? wf[id].inputs : null)

  const positive = inputs(meta.positive)
  if (positive) {
    const field = textField(wf[meta.positive])
    if (params.prompt !== undefined) positive[field] = String(params.prompt)
    if (params.negative !== undefined && meta.negative === meta.positive) positive.negative = String(params.negative)
  }
  const negative = inputs(meta.negative)
  if (negative && params.negative !== undefined) negative[textField(wf[meta.negative])] = String(params.negative)

  const sampler = inputs(meta.sampler)
  if (sampler) {
    if (params.steps !== undefined) sampler.steps = Number(params.steps)
    if (params.cfg !== undefined) sampler.cfg = Number(params.cfg)
    if (params.seed !== undefined) sampler.seed = Number(params.seed)
  }
  const latent = inputs(meta.latent)
  if (latent) {
    let width = params.width
    let height = params.height
    if ((width === undefined || height === undefined) && typeof params.res === 'string') {
      const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(params.res.trim())
      if (match) {
        width = Number(match[1])
        height = Number(match[2])
      }
    }
    if (width !== undefined) latent.width = Number(width)
    if (height !== undefined) latent.height = Number(height)
    if (params.batchSize !== undefined) latent.batch_size = Number(params.batchSize)
  }
  return { workflow: fillWorkflow(wf, params), meta }
}

/**
 * 扫描 comfyScripts 下的所有 workflow*.json，得到稳定 id：
 *   zimage/workflow.json          → zimage
 *   minimax-h3/workflow_t2v.json  → minimax-h3-t2v
 *   wan22/workflow_t2v_api.json   → wan22-t2v_api
 */
export async function scanComfyWorkflows(config) {
  const base = config.paths?.comfyScripts
  if (!base || !existsSync(base)) return []
  let dirs = []
  try {
    dirs = await fsp.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.name === '__pycache__') continue
    const dir = path.join(base, entry.name)
    let files = []
    try {
      files = (await fsp.readdir(dir)).filter((file) => /^workflow.*\.json$/i.test(file)).sort()
    } catch {
      continue
    }
    for (const file of files) {
      const variant = file.replace(/^workflow_?/i, '').replace(/\.json$/i, '')
      const id = variant && variant !== 'api' ? `${entry.name}-${variant}` : entry.name
      out.push({ id, dir: entry.name, variant, file: path.join(dir, file) })
    }
  }
  return out
}

/** 在候选目录里找模板文件。 */
export async function findWorkflowFile(config, name) {
  if (!name) return null
  if (path.isAbsolute(name)) return existsSync(name) ? name : null

  const candidates = [path.join(config.dataDir, 'workflows', `${name}.json`)]
  if (config.paths?.comfyScripts) {
    candidates.push(path.join(config.paths.comfyScripts, `${name}.json`))
    const dir = path.join(config.paths.comfyScripts, name)
    if (existsSync(dir)) {
      try {
        const files = (await fsp.readdir(dir)).filter((file) => /^workflow.*\.json$/i.test(file)).sort()
        for (const file of files) candidates.push(path.join(dir, file))
      } catch {
        /* ignore */
      }
    }
  }
  const direct = candidates.find((file) => existsSync(file))
  if (direct) return direct

  // 兼容 minimax-h3-t2v / minimax-h3/t2v 这类「目录 + 变体」名字
  const index = await scanComfyWorkflows(config)
  const hit = index.find(
    (item) =>
      item.id === name ||
      (item.variant && `${item.dir}-${item.variant}` === name) ||
      (item.variant && `${item.dir}/${item.variant}` === name),
  )
  return hit?.file ?? null
}

/**
 * 解析工作流：优先内联对象，其次模板名（或绝对路径）。
 * @returns {Promise<{ok:true, workflow:object, name:string, meta:object, missing:string[]} | {ok:false,error:string}>}
 */
export async function resolveWorkflow(config, { workflow, workflowName, params = {} } = {}) {
  let raw = workflow
  let name = workflowName ?? (workflow ? '(内联)' : '')

  if (!raw) {
    if (!workflowName) return { ok: false, error: '需要 workflow（内联 JSON）或 workflowName（模板名）' }
    const file = await findWorkflowFile(config, workflowName)
    if (!file) {
      const hint = config.paths?.comfyScripts ? `${config.dataDir}\\workflows 或 ${config.paths.comfyScripts}` : `${config.dataDir}\\workflows`
      return { ok: false, error: `找不到工作流模板：${workflowName}（查找目录：${hint}）` }
    }
    try {
      raw = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch (error) {
      return { ok: false, error: `工作流模板解析失败：${error.message}` }
    }
    name = workflowName
  }

  const prepared = prepareWorkflow(raw, params)
  if (!prepared) return { ok: false, error: '工作流必须是 ComfyUI API 格式对象（节点 id → 节点）' }

  const missing = []
  JSON.stringify(prepared.workflow, (key, value) => {
    if (typeof value === 'string' && /\{\{\s*[\w.-]+\s*\}\}/.test(value)) missing.push(value)
    return value
  })
  return { ok: true, workflow: prepared.workflow, meta: prepared.meta, name, missing }
}

/** 列出可用模板名（与 resolveWorkflow 使用同一套 id）。 */
export async function listWorkflows(config) {
  const names = new Set()
  const userDir = path.join(config.dataDir, 'workflows')
  if (existsSync(userDir)) {
    try {
      for (const file of await fsp.readdir(userDir)) {
        if (file.endsWith('.json')) names.add(file.replace(/\.json$/, ''))
      }
    } catch {
      /* ignore */
    }
  }
  for (const item of await scanComfyWorkflows(config)) names.add(item.id)
  return [...names].sort()
}
