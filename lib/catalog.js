/**
 * 资源目录（catalog）：把「本地有什么、跑什么运行时、吃多少资源」变成结构化数据。
 *
 * 一条资产（asset）描述一个可加载的本地服务：
 * - kind：llm / vlm / embed / rerank / image / video / audio-tts / audio-asr / tool
 * - runtime：llama.cpp / comfyui / process / mcp
 * - slot：gpu（吃显存的互斥槽）或 cpu（可并发）
 * - launch / health / cost：怎么起、怎么判活、预计吃多少
 *
 * 目录文件 <dataDir>/catalog.json 可手工编辑；首次运行会从用户既有的
 * scripts/llama_cpp/models.json 导入，避免重复录入。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJsonSafe, writeJsonAtomic, existsSync, intOr, nowIso } from './util.js'

export const KIND_LABEL = {
  llm: '文本模型',
  vlm: '多模态',
  embed: '向量模型',
  rerank: '精排模型',
  image: '图像生成',
  video: '视频生成',
  music: '音乐生成',
  'audio-tts': '语音合成',
  'audio-asr': '语音识别',
  tool: '工具服务',
}

/** 组件角色 → 中文标签（UI 与工具输出共用）。 */
export const ROLE_LABEL = {
  model: '主模型',
  encoder: '编码器',
  vae: 'VAE',
  mmproj: '视觉投影',
  vocoder: '声码器',
  tokenizer: '分词/声学',
  aligner: '强制对齐',
  speaker: '声纹',
  vad: 'VAD',
  lora: 'LoRA',
  file: '其它文件',
}

/** 从文件名推断组件角色。 */
export function roleOfFile(name) {
  const text = String(name ?? '').toLowerCase().replace(/\\/g, '/')
  if (/mmproj/.test(text)) return 'mmproj'
  if (/(^|[/_.-])vae|^ae\./.test(text)) return 'vae'
  if (/lora/.test(text)) return 'lora'
  if (/tokenizer|vocoder|codec/.test(text)) return 'tokenizer'
  // 文本编码器：qwen/clip/t5/umt5/ministral 这类小语言模型
  if (/encoder|text_enc|clip|umt5|^t5|qwen3vl|qwen_|qwen-|ministral/.test(text)) return 'encoder'
  // 主模型：diffusion/unet/transformer，或带这些命名的 gguf
  if (/diffusion|unet|transformer|_base|turbo|fl2va|ti2v|i2v|t2v|wan2|ernie-image|z-image|anima-base|acestep_v|q4_k|q8_0|bf16|fp16/.test(text)) return 'model'
  return 'file'
}

/** 归一化「配套组件」：文件级（safetensors/gguf）与资产级（由脚本内部加载的模型）。 */
function normalizeComponents(raw = {}) {
  const list = []
  if (Array.isArray(raw.components)) {
    for (const item of raw.components) {
      if (!item) continue
      const name = String(item.name ?? item.file ?? '').trim()
      if (!name) continue
      list.push({
        name: path.basename(name),
        role: String(item.role ?? roleOfFile(name)),
        file: item.file ? String(item.file) : null,
      })
    }
  }
  // llama.cpp 的 mmproj 是天然组件，单独登记
  const mmproj = raw.launch?.mmproj
  if (mmproj) {
    const base = path.basename(String(mmproj))
    if (!list.some((item) => item.name === base)) {
      list.push({ name: base, role: 'mmproj', file: String(mmproj) })
    }
  }
  return list
}

/** 从工作流 JSON 里提取权重文件名，作为主模型的配套组件（编码器 / VAE / 主模型）。 */
export function extractWorkflowComponents(doc) {
  const text = JSON.stringify(doc ?? {})
  const found = new Set()
  const re = /([A-Za-z0-9_\-.\u4e00-\u9fa5 ]+\.(?:safetensors|gguf|ckpt|pt))(?=")/gi
  let match
  while ((match = re.exec(text)) !== null && found.size < 16) {
    const name = match[1].split(/[\\/]/).pop().trim()
    if (name) found.add(name)
  }
  return [...found].map((name) => ({ name, role: roleOfFile(name), file: name }))
}

/** 这个资产「怎么调」——给 UI 和模型看的调用样例。 */export function invokeOf(asset) {
  if (!asset) return ''
  const id = asset.id
  const kind = String(asset.kind ?? '')
  if (asset.runtime === 'mcp') return '（由 DSH 的 MCP 客户端挂载）'
  if (asset.runtime === 'script') {
    if (kind === 'audio-tts') return `local_audio {"action":"tts"}`
    if (kind === 'audio-asr') return `local_audio {"action":"asr","audioPath":"…"}`
    return `local_audio {"action":"music-qc","audioPath":"…"}`
  }
  if (asset.runtime === 'workflow' || ['image', 'video', 'music'].includes(kind)) {
    return `local_generate {"asset":"${id}"}`
  }
  if (['llm', 'vlm', 'embed', 'rerank'].includes(kind)) return `local_chat {"asset":"${id}"}`
  return `local_service {"action":"load","asset":"${id}"}`
}

/**
 * 生成工作流的能力画像：路由器按任务关键词挑资产。
 * key 是工作流 id（与 syncComfyWorkflows 生成的一致）。
 */
export const WORKFLOW_PROFILES = {
  zimage: {
    keywords: ['写实', '摄影', '场景', '电影感', '通用', '快速', '插画', '风景', '人物', '照片'],
    strengths: '8 步 Turbo，中文提示词，通用写实/插画',
  },
  ernie: {
    keywords: ['海报', '文字', '标题', '信息图', '排版', '带字', '中文', 'logo', '字体', '封面'],
    strengths: '中文文字渲染强，适合海报/信息图/带字画面',
  },
  anima: {
    keywords: ['二次元', '动漫', '插画', '立绘', '角色', '厚涂', '卡通', '风格化'],
    strengths: '二次元/动漫风格，30 步，建议写负面词',
  },
  'minimax-h3-t2v': {
    keywords: ['视频', '文生视频', '镜头', '片段', '音效', '动画', '运镜'],
    strengths: '文生视频 + 原生音效',
  },
  'minimax-h3-i2v': {
    keywords: ['首帧', '图生视频', '参考图', '首尾帧', '图片变视频', '首尾'],
    strengths: '首帧/尾帧驱动图生视频',
  },
  'wan22-t2v_api': {
    keywords: ['视频', '备选', '文生视频'],
    strengths: '文生视频备选',
  },
  acestep: {
    keywords: ['音乐', '配乐', '歌曲', 'bgm', '人声', '旋律', '配曲'],
    strengths: '文生音乐 48kHz',
  },
}

const CHAT_PORT = 8080
const EMBED_PORT = 8081
const RERANK_PORT = 8082

/** 默认线程数：物理核数（os.cpus 会给逻辑核，取一半更像物理核）。 */
function defaultThreads() {
  const count = (globalThis.navigator?.hardwareConcurrency ?? 8)
  return Math.max(2, Math.floor(count / 2))
}

/** 由 registry 条目推断资产类型。 */
function inferKind(entry) {
  if (entry.role === 'embed') return 'embed'
  if (entry.role === 'rerank') return 'rerank'
  if (entry.mmproj) return 'vlm'
  return 'llm'
}

/** 把 null/空串/非数字统一成 null（避免 Number(null)=0 把「未测量」变成 0）。 */
function optNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** 解析 llama.cpp 的推荐参数里我们要覆盖的几个开关。 */
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

/** 去掉指定开关（含值），返回新数组。 */
function stripFlags(args, ...flags) {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    const hit = flags.some((flag) => token === flag || token.startsWith(`${flag}=`))
    if (!hit) {
      out.push(token)
      continue
    }
    if (!token.includes('=') && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i += 1
  }
  return out
}

function asArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

/** 规范化一条资产，补齐默认值。 */
export function normalizeAsset(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('asset 必须是对象')
  const kind = String(raw.kind ?? 'llm')
  const runtime = String(raw.runtime ?? 'llama.cpp')
  const id = String(raw.id ?? '').trim()
  if (!id) throw new Error('asset.id 必填')

  const launch = raw.launch && typeof raw.launch === 'object' ? { ...raw.launch } : {}
  launch.rawArgs = asArray(launch.rawArgs ?? launch.args)
  launch.extraArgs = asArray(launch.extraArgs)
  launch.extraEnv = launch.extraEnv && typeof launch.extraEnv === 'object' ? { ...launch.extraEnv } : {}

  const cost = raw.cost && typeof raw.cost === 'object' ? { ...raw.cost } : {}
  const measured = raw.measured && typeof raw.measured === 'object' ? { ...raw.measured } : {}

  const slot = raw.slot ?? (runtime === 'llama.cpp' && kind !== 'embed' && kind !== 'rerank' ? 'gpu' : 'cpu')
  const port = kind === 'tool'
    ? Number.isFinite(Number(raw.port)) ? Number(raw.port) : 0
    : intOr(raw.port, kind === 'embed' ? EMBED_PORT : kind === 'rerank' ? RERANK_PORT : CHAT_PORT)

  return {
    id,
    name: String(raw.name ?? id),
    kind,
    runtime,
    slot,
    enabled: raw.enabled !== false,
    pinned: raw.pinned === true,
    /** 淘汰优先级：越大越不容易被卸载（0~100）。 */
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 50,
    host: String(raw.host ?? '127.0.0.1'),
    port,
    task: String(raw.task ?? ''),
    desc: String(raw.desc ?? ''),
    tags: asArray(raw.tags),
    /** 共享同一个后台服务的资产（如多套 ComfyUI 工作流共用 comfyui 进程）。 */
    serviceId: raw.serviceId ? String(raw.serviceId) : null,
    /** 依赖组：同组按「整组峰值显存」做预算（如 minimax-h3 的编码器/VAE）。 */
    group: raw.group ? String(raw.group) : null,
    /**
     * 前置依赖：[{asset, role}]。role=framework 的资产必须先加载（如 comfyui）。
     * file 目前只做记录（用于体检与 UI 展示），不参与加载。
     */
    requires: Array.isArray(raw.requires)
      ? raw.requires
          .filter((item) => item && (item.asset || item.file))
          .map((item) => ({
            asset: item.asset ? String(item.asset) : null,
            file: item.file ? String(item.file) : null,
            role: String(item.role ?? 'dep'),
          }))
      : [],
    /** 整组显存峰值（MB）：实测回填，优先于逐项相加；0 视为「没测过」。 */
    peakVramMb: Number(raw.peakVramMb) > 0 ? Number(raw.peakVramMb) : null,
    /**
     * 配套组件：编码器 / VAE / mmproj / 声码器 等。
     * 它们是「主模型的零件」，不单独参与调度，也不在资产列表里占一行。
     */
    components: normalizeComponents(raw),
    /** 组件归属的主模型 id；有值时本资产不在顶层列表显示。 */
    componentOf: raw.componentOf ? String(raw.componentOf) : null,
    /** 组件角色：encoder / vae / mmproj / vocoder / aligner / speaker / vad / lora。 */
    role: raw.role ? String(raw.role) : null,
    hidden: raw.hidden === true || Boolean(raw.componentOf),
    /** 运行框架：comfyui / llama.cpp / python / mcp —— 调用方式由它决定。 */
    framework: raw.framework
      ? String(raw.framework)
      : raw.serviceId
        ? String(raw.serviceId)
        : runtime === 'script'
          ? 'python'
          : runtime === 'mcp'
            ? 'mcp'
            : runtime,
    /** MCP 资产的启动命令（写进 DSH 的 MCP 配置用）。 */
    mcp: raw.mcp && raw.mcp.command
      ? { command: String(raw.mcp.command), args: asArray(raw.mcp.args) }
      : raw.runtime === 'mcp' && Array.isArray(raw.launch?.command) && raw.launch.command.length > 0
        ? { command: String(raw.launch.command[0]), args: raw.launch.command.slice(1) }
        : null,
    /** 生成类资产：ComfyUI 工作流文件（绝对路径或模板名）。 */
    workflow: raw.workflow ? String(raw.workflow) : null,
    /** 一次性脚本资产（TTS/ASR/质检）：{ file, args }，由 local_audio 执行。 */
    script: raw.script && typeof raw.script === 'object' && raw.script.file
      ? { file: String(raw.script.file), args: asArray(raw.script.args) }
      : null,
    /** 资源分类：text / image / video / music / audio / tool。 */
    category: String(raw.category ?? ''),
    /** 生成类资产：能力关键词与一句话特长，供路由器按需求自动选择。 */
    keywords: asArray(raw.keywords),
    strengths: String(raw.strengths ?? ''),
    launch: {
      gguf: launch.gguf ?? null,
      mmproj: launch.mmproj ?? null,
      ngl: launch.ngl ?? null,
      ctx: launch.ctx ?? null,
      threads: launch.threads ?? null,
      parallel: launch.parallel ?? null,
      kvType: launch.kvType ?? null,
      flashAttn: launch.flashAttn ?? null,
      rawArgs: launch.rawArgs,
      extraArgs: launch.extraArgs,
      extraEnv: launch.extraEnv,
      cwd: launch.cwd ?? null,
      exe: launch.exe ?? null,
      /** comfyui / process 用：完整命令行（数组）。 */
      command: asArray(launch.command),
    },
    health: {
      path: String(raw.health?.path ?? defaultHealthPath(runtime, kind)),
      alias: raw.health?.alias ?? null,
      timeoutMs: intOr(raw.health?.timeoutMs, 0),
    },
    cost: {
      vramMb: optNumber(cost.vramMb),
      ramMb: optNumber(cost.ramMb),
      loadMs: Number.isFinite(Number(cost.loadMs)) ? Number(cost.loadMs) : defaultLoadMs(kind),
      estimated: cost.estimated !== false,
    },
    measured: {
      vramMb: optNumber(measured.vramMb),
      loadMs: optNumber(measured.loadMs),
      loads: intOr(measured.loads, 0),
      runs: intOr(measured.runs, 0),
      lastUsedAt: measured.lastUsedAt ?? null,
    },
    /** idleUnloadSec 覆盖；null 表示用全局策略。 */
    idleUnloadSec: Number.isFinite(Number(raw.idleUnloadSec)) ? Number(raw.idleUnloadSec) : null,
    notes: String(raw.notes ?? ''),
    createdAt: raw.createdAt ?? nowIso(),
    updatedAt: raw.updatedAt ?? nowIso(),
  }
}

function defaultHealthPath(runtime, kind) {
  if (runtime === 'comfyui') return '/system_stats'
  if (kind === 'embed' || kind === 'rerank' || kind === 'llm' || kind === 'vlm') return '/v1/models'
  return '/'
}

function defaultLoadMs(kind) {
  switch (kind) {
    case 'llm':
    case 'vlm':
      return 45000
    case 'embed':
    case 'rerank':
      return 15000
    case 'image':
    case 'video':
      return 90000
    default:
      return 20000
  }
}

/** 资产对外的精简视图（工具输出用）。 */
export function publicAsset(asset, state = null) {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    runtime: asset.runtime,
    slot: asset.slot,
    enabled: asset.enabled,
    pinned: asset.pinned,
    priority: asset.priority,
    port: asset.port,
    task: asset.task,
    tags: asset.tags,
    category: asset.category,
    serviceId: asset.serviceId,
    group: asset.group,
    requires: asset.requires,
    peakVramMb: asset.peakVramMb,
    framework: asset.framework,
    components: asset.components,
    componentOf: asset.componentOf,
    role: asset.role,
    hidden: asset.hidden,
    invoke: invokeOf(asset),
    mcp: asset.mcp,
    workflow: asset.workflow,
    keywords: asset.keywords,
    strengths: asset.strengths,
    hasScript: Boolean(asset.script),
    estimateVramMb: (asset.measured.vramMb || null) ?? asset.cost.vramMb,
    estimateLoadMs: (asset.measured.loadMs || null) ?? asset.cost.loadMs,
    state: state?.state ?? 'stopped',
    loadedForSec: state?.loadedForSec ?? null,
    idleForSec: state?.idleForSec ?? null,
    vramMb: state?.vramMb ?? null,
  }
}

export class Catalog {
  /**
   * @param {object} config 插件配置
   * @param {(msg: string) => void} [log]
   */
  constructor(config, log = () => {}) {
    this.config = config
    this.log = log
    this.file = config.catalogFile
    this.assets = new Map()
    this.loaded = false
    /** 连通性检查缓存（id → {at, value}），避免轮询时反复 stat。 */
    this._verify = new Map()
    /** 模型文件名索引（用于组件校验与路径修复），5 分钟过期。 */
    this._index = null
  }

  /**
   * 模型文件索引：basename → 相对路径。用于校验「组件是否真的在本地」，
   * 也用于 registry 路径过期时按文件名找回。缓存 5 分钟。
   * @returns {Promise<Map<string, string>>}
   */
  async modelIndex() {
    const now = Date.now()
    if (this._index && now - this._index.at < 5 * 60 * 1000) return this._index.map
    const roots = []
    const modelsRoot = this.config.paths?.modelsRoot
    const comfyDir = this.config.paths?.comfyDir
    if (modelsRoot && existsSync(modelsRoot)) roots.push(modelsRoot)
    if (comfyDir && existsSync(comfyDir)) roots.push(comfyDir)
    const map = new Map()
    let visited = 0
    const walk = async (dir, depth) => {
      if (depth > 6 || visited > 20000) return
      let entries = []
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), depth + 1)
        } else if (/\.(safetensors|gguf|ckpt|pt|sft)$/i.test(entry.name)) {
          visited += 1
          if (!map.has(entry.name)) map.set(entry.name, path.join(dir, entry.name))
        }
      }
    }
    for (const root of roots) await walk(root, 1)
    this._index = { at: now, map }
    return map
  }

  /**
   * 解析一个组件文件：绝对路径 / modelsRoot 相对路径 / 同名文件（索引查找）。
   * @returns {Promise<{name: string, role: string, exists: boolean, path: string|null}>}
   */
  async resolveComponent(component) {
    const name = component?.file || component?.name || ''
    const role = component?.role || 'file'
    if (!name) return { name: '', role, exists: false, path: null }
    const root = this.config.paths?.modelsRoot || ''
    const direct = path.isAbsolute(name) ? name : path.join(root, name)
    if (existsSync(direct)) return { name: path.basename(name), role, exists: true, path: direct }
    const index = await this.modelIndex()
    const hit = index.get(path.basename(name))
    return { name: path.basename(name), role, exists: Boolean(hit), path: hit ?? null }
  }

  /**
   * 连通性检查：模型 / mmproj / 工作流 / 脚本 / MCP 可执行文件是否真的在磁盘上；
   * 生成类资产还会逐个校验「配套组件」（编码器/VAE/主模型）是否存在。
   * 结果缓存 30s。
   * @returns {Promise<{ok: boolean, missing: string[], components: object[], checkedAt: number}>}
   */
  async verify(asset) {
    if (!asset) return { ok: false, missing: ['资产不存在'], components: [], checkedAt: Date.now() }
    const hit = this._verify.get(asset.id)
    if (hit && Date.now() - hit.at < 30000) return hit.value
    const root = this.config.paths?.modelsRoot || ''
    const missing = []
    const check = (value, label) => {
      if (!value) return
      const full = path.isAbsolute(value) ? value : path.join(root, value)
      if (!existsSync(full)) missing.push(label ? `${label}：${value}` : value)
    }
    if (asset.runtime === 'llama.cpp') {
      check(asset.launch?.gguf, '模型文件')
      check(asset.launch?.mmproj, 'mmproj')
      check(asset.launch?.exe, 'llama-server')
    } else if (asset.runtime === 'workflow') {
      check(asset.workflow, '工作流文件')
      check(this.config.paths?.comfyDir, 'ComfyUI 目录')
    } else if (asset.runtime === 'comfyui') {
      check(this.config.paths?.comfyDir, 'ComfyUI 目录')
      const python = asset.launch?.exe || this.config.paths?.comfyPython
      if (python && path.isAbsolute(python)) check(python, 'ComfyUI Python')
    } else if (asset.runtime === 'script') {
      check(asset.script?.file, '脚本文件')
    } else if (asset.runtime === 'mcp') {
      check(asset.mcp?.command, 'MCP 可执行文件')
    }

    // 组件校验：工作流里的编码器/VAE、mmproj、声码器都要在本地找得到
    const components = []
    for (const component of asset.components ?? []) {
      const resolved = await this.resolveComponent(component)
      components.push(resolved)
      if (!resolved.exists) missing.push(`组件 ${resolved.name}`)
    }

    const value = { ok: missing.length === 0, missing, components, checkedAt: Date.now() }
    this._verify.set(asset.id, { at: Date.now(), value })
    return value
  }

  /** 运行框架清单：llama.cpp / ComfyUI / Python / MCP，含路径与可用性。 */
  frameworks() {
    const p = this.config.paths ?? {}
    const all = this.list({ includeHidden: false })
    const rows = []
    const llamaCount = all.filter((asset) => asset.runtime === 'llama.cpp').length
    const workflowCount = all.filter((asset) => asset.runtime === 'workflow').length
    const scriptCount = all.filter((asset) => asset.runtime === 'script').length
    const mcpCount = all.filter((asset) => asset.runtime === 'mcp').length
    if (p.llamaServer || llamaCount > 0) {
      rows.push({
        id: 'llama.cpp',
        name: 'llama.cpp',
        path: p.llamaServer || '',
        exists: p.llamaServer ? existsSync(p.llamaServer) : false,
        count: llamaCount,
        note: 'llama-server 进程，每加载一个模型起一个',
      })
    }
    if (p.comfyDir || workflowCount > 0) {
      rows.push({
        id: 'comfyui',
        name: 'ComfyUI',
        path: p.comfyDir || '',
        exists: p.comfyDir ? existsSync(p.comfyDir) : false,
        count: workflowCount,
        note: '工作流引擎，所有生成类资产共用同一个进程',
      })
    }
    if (p.pythonPath || scriptCount > 0) {
      rows.push({
        id: 'python',
        name: 'Python',
        path: p.pythonPath || '',
        exists: p.pythonPath ? existsSync(p.pythonPath) : false,
        count: scriptCount,
        note: '一次性脚本：TTS / ASR / 音乐质检',
      })
    }
    if (mcpCount > 0) {
      rows.push({
        id: 'mcp',
        name: 'MCP',
        path: '',
        exists: true,
        count: mcpCount,
        note: '由 DSH 的 MCP 客户端挂载（本插件只登记与避让）',
      })
    }
    return rows
  }

  /** 读取目录；不存在则从既有 registry 播种。 */
  async load() {
    const data = await readJsonSafe(this.file, null)
    if (data) {
      const list = Array.isArray(data) ? data : Array.isArray(data.assets) ? data.assets : []
      for (const raw of list) {
        try {
          const asset = normalizeAsset(raw)
          this.assets.set(asset.id, asset)
        } catch (error) {
          this.log(`跳过非法资产：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.loaded = true
      // 迁移总是跑（补齐组件 / 修过期路径，不新增资产）。
      // 目录同步默认关闭：换机器后模型散落各处，靠手动/对话添加更可靠；
      // 需要批量导入本机目录时把 paths.autoSync 设 true，或点「从目录导入」。
      await this.upgradeComponents()
      if (this.config.paths?.autoSync === true) await this.syncEcosystem()
      return this
    }
    this.loaded = true
    if (this.config.paths?.autoSync === true) {
      await this.syncEcosystem()
      await this.save()
    }
    return this
  }

  /** 写回 catalog.json。 */
  async save() {
    await writeJsonAtomic(this.file, {
      version: 1,
      updatedAt: nowIso(),
      assets: [...this.assets.values()],
    })
  }

  list({ enabledOnly = false, includeHidden = true } = {}) {
    const all = [...this.assets.values()].filter((asset) => includeHidden || !asset.hidden)
    return enabledOnly ? all.filter((asset) => asset.enabled) : all
  }

  get(id) {
    return this.assets.get(String(id)) ?? null
  }

  /** 按 kind 候选排序（供委派时挑模型）。 */
  candidates(kind) {
    return this.list({ enabledOnly: true })
      .filter((asset) => (kind ? asset.kind === kind : true))
      .sort((a, b) => b.priority - a.priority)
  }

  async upsert(raw) {
    const asset = normalizeAsset(raw)
    const prev = this.assets.get(asset.id)
    if (prev) {
      asset.createdAt = prev.createdAt
      asset.measured = { ...prev.measured, ...asset.measured }
    }
    asset.updatedAt = nowIso()
    this.assets.set(asset.id, asset)
    // 组件/路径改过之后，连通性结果要立刻失效
    this._verify.delete(asset.id)
    if (this._index) this._index.at = 0
    await this.save()
    return asset
  }

  async remove(id) {
    const hit = this.assets.delete(String(id))
    if (hit) this._verify.delete(String(id))
    if (hit) await this.save()
    return hit
  }

  /** 记录一次真实加载的实测值（带指数平滑，避免单次抖动）。 */
  async noteLoad(id, { vramMb, loadMs, ran = false }) {
    const asset = this.get(id)
    if (!asset) return
    const weight = Number(this.config?.scheduler?.measureWeight ?? 0.6)
    const smooth = (prev, next) => {
      if (!Number.isFinite(next) || next <= 0) return prev
      if (!Number.isFinite(prev) || prev <= 0) return next
      return Math.round(prev * (1 - weight) + next * weight)
    }
    asset.measured.vramMb = smooth(asset.measured.vramMb, vramMb)
    asset.measured.loadMs = smooth(asset.measured.loadMs, loadMs)
    asset.measured.loads += 1
    if (ran) asset.measured.runs += 1
    asset.measured.lastUsedAt = nowIso()
    // 峰值只升不降：同组资产（编码器+主模型+VAE）按峰值做预算，不能逐项相加
    if (Number.isFinite(vramMb) && vramMb > 0) {
      asset.peakVramMb = Math.max(Number(asset.peakVramMb) || 0, Math.round(vramMb))
    }
    await this.save()
  }

  /** 标记使用（不落盘，靠定期 save）。 */
  touch(id) {
    const asset = this.get(id)
    if (asset) asset.measured.lastUsedAt = nowIso()
  }

  /**
   * 从 llama.cpp 的 models.json 导入资产。
   * @param {{overwrite?: boolean}} options
   */
  async importRegistry({ overwrite = false } = {}) {
    const registryPath = this.config?.paths?.registry
    if (!registryPath || !existsSync(registryPath)) return []
    const data = await readJsonSafe(registryPath, null)
    if (!data || typeof data !== 'object') return []
    const imported = []
    for (const [key, entry] of Object.entries(data)) {
      if (key.startsWith('_') || !entry || typeof entry !== 'object') continue
      if (this.assets.has(key) && !overwrite) continue
      try {
        const asset = await this.#fromRegistryEntry(key, entry)
        this.assets.set(asset.id, asset)
        imported.push(asset.id)
      } catch (error) {
        this.log(`导入 ${key} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (imported.length > 0) {
      this.log(`从 registry 导入 ${imported.length} 个资产：${imported.join(', ')}`)
      await this.save()
    }
    return imported
  }

  async #fromRegistryEntry(key, entry) {
    const kind = inferKind(entry)
    const rawArgs = asArray(entry.server_args)
    const mmproj = entry.mmproj ?? null
    const port = kind === 'embed' ? EMBED_PORT : kind === 'rerank' ? RERANK_PORT : CHAT_PORT
    const threads = argValue(rawArgs, '-t', '--threads') ?? defaultThreads()
    const ctx = argValue(rawArgs, '-c', '--ctx-size') ?? '8192'
    const ngl = argValue(rawArgs, '-ngl', '--n-gpu-layers') ?? '99'

    const ggufPath = entry.gguf ? path.join(this.config.paths.modelsRoot, entry.gguf) : null
    const mmprojPath = mmproj ? path.join(this.config.paths.modelsRoot, mmproj) : null
    const cost = await this.#estimateCost(kind, ggufPath, mmprojPath, rawArgs)

    return normalizeAsset({
      id: key,
      name: entry.name ?? key,
      kind,
      runtime: 'llama.cpp',
      slot: kind === 'embed' || kind === 'rerank' ? 'cpu' : 'gpu',
      port,
      task: entry.task ?? '',
      desc: entry.desc ?? '',
      category: kind === 'embed' || kind === 'rerank' ? 'vector' : 'text',
      tags: kind === 'vlm' ? ['vision', 'chat'] : kind === 'llm' ? ['chat'] : [kind],
      launch: {
        gguf: entry.gguf ?? null,
        mmproj,
        ngl: Number(ngl),
        ctx: Number(ctx),
        threads: Number(threads),
        rawArgs,
      },
      cost,
      priority: kind === 'embed' || kind === 'rerank' ? 80 : 50,
      idleUnloadSec: kind === 'embed' || kind === 'rerank' ? 0 : null,
    })
  }

  /** 按文件体积粗估显存/内存（MoE 留在内存的专家权重按 18% 折算）。 */
  async #estimateCost(kind, ggufPath, mmprojPath, rawArgs) {
    const sizeMb = async (file) => {
      if (!file) return 0
      try {
        const stat = await fsp.stat(file)
        return Math.round(stat.size / 1024 / 1024)
      } catch {
        return 0
      }
    }
    const weights = await sizeMb(ggufPath)
    const proj = await sizeMb(mmprojPath)
    const moeOnCpu = rawArgs.includes('--cpu-moe') || rawArgs.some((arg) => arg === '--n-cpu-moe')
    if (weights === 0) {
      return { vramMb: null, ramMb: null, loadMs: defaultLoadMs(kind), estimated: true }
    }
    const vramMb = Math.round(weights * (moeOnCpu ? 0.18 : 1.05) + proj * 1.05 + 256)
    const ramMb = Math.round(moeOnCpu ? weights * 0.9 : weights * 0.2)
    return { vramMb, ramMb, loadMs: defaultLoadMs(kind), estimated: true }
  }

  /** 首次运行：ComfyUI 目录存在就登记一条图像生成资产。 */
  async seedComfy() {
    if (this.assets.has('comfyui')) return
    const dir = this.config?.paths?.comfyDir
    if (!dir || !existsSync(dir)) return
    this.assets.set('comfyui', normalizeAsset({
      id: 'comfyui',
      name: 'ComfyUI',
      kind: 'image',
      runtime: 'comfyui',
      slot: 'gpu',
      port: 8188,
      task: '图像/视频/音乐生成（工作流服务）',
      desc: 'ComfyUI 服务，按工作流出图；与 LLM 争同一块显存',
      category: 'image',
      tags: ['image', 'video', 'audio'],
      launch: {
        cwd: dir,
        exe: this.config?.paths?.comfyPython || 'python',
        // 与工程里的 start_comfyui.py 对齐：--lowvram 把大编码器卸载到内存，
        // --cache-classic 控制显存峰值；8GB 卡必须带。
        command: ['main.py', '--listen', '127.0.0.1', '--port', '8188', '--lowvram', '--cache-classic'],
      },
      // ComfyUI 的显存取决于工作流，用固定值会把 8GB 卡直接判死；
      // 实测占用靠加载后采样写回，预算判断只受 GPU 互斥约束。
      cost: { vramMb: null, ramMb: 4096, loadMs: 90000, estimated: true },
      priority: 40,
      idleUnloadSec: 300,
    }))
  }

  /**
   * 从 config.mcpServers 登记 MCP 服务。
   * MCP 的进程生命周期由 DSH 自己的 MCP 客户端管理，这里只做「资源画像」：
   * 标成 CPU 槽、零显存，让调度器知道它们存在、不与 GPU 任务抢显存。
   */
  async seedMcp() {
    const servers = Array.isArray(this.config?.mcpServers) ? this.config.mcpServers : []
    const added = []
    for (const server of servers) {
      const id = String(server?.id ?? '').trim()
      if (!id || this.assets.has(id)) continue
      this.assets.set(id, normalizeAsset({
        id,
        name: String(server.name ?? id),
        kind: 'tool',
        runtime: 'mcp',
        slot: 'cpu',
        enabled: server.enabled !== false,
        pinned: true,
        priority: 75,
        port: Number(server.port ?? 0),
        task: String(server.desc ?? server.task ?? 'MCP 工具服务（由 DSH 挂载）'),
        desc: 'MCP server：常驻 CPU、零显存，供 DSH 工具调用',
        category: 'mcp',
        tags: ['mcp', 'tool'],
        launch: { command: server.command ? [String(server.command)] : [] },
        cost: { vramMb: 0, ramMb: Number(server.ramMb ?? 200), loadMs: 0, estimated: true },
      }))
      added.push(id)
    }
    if (added.length > 0) this.log(`登记 ${added.length} 个 MCP 服务：${added.join('、')}`)
  }

  /**
   * 按 D:\models 的目录分类同步全部资源：
   * text（llama.cpp）、image/video/music（ComfyUI 工作流）、audio（一次性脚本）、MCP。
   * 已存在的资产不覆盖（保留用户改过的参数与实测值）。
   * @returns {Promise<{added: string[], total: number}>}
   */
  async syncEcosystem() {
    const before = new Set(this.assets.keys())
    await this.importRegistry({ overwrite: false })
    await this.seedComfy()
    await this.seedMcp()
    await this.syncComfyWorkflows()
    await this.syncAudioScripts()
    await this.syncMcpDirs()
    // 迁移：旧版把 ComfyUI 固定估成 7000MB，会把 8GB 卡直接判成「显存不足」
    const comfy = this.assets.get('comfyui')
    if (comfy) {
      let dirty = false
      if (comfy.cost.vramMb === 7000) {
        comfy.cost.vramMb = null
        comfy.cost.estimated = true
        dirty = true
      }
      // 迁移：早期用系统 python + 无 lowvram 会缺依赖/爆显存
      const wantedPython = this.config.paths?.comfyPython || ''
      if (comfy.runtime === 'comfyui' && wantedPython && comfy.launch.exe !== wantedPython) {
        comfy.launch.exe = wantedPython
        dirty = true
      }
      if (comfy.runtime === 'comfyui' && !(comfy.launch.command ?? []).includes('--lowvram')) {
        comfy.launch.command = [...(comfy.launch.command ?? []), '--lowvram', '--cache-classic']
        dirty = true
      }
      if (dirty) comfy.updatedAt = nowIso()
      if (dirty) comfy._migrated = true
    }
    const added = [...this.assets.keys()].filter((id) => !before.has(id))
    const migrated = Boolean(comfy?._migrated)
    if (comfy) delete comfy._migrated
    // 迁移：把「配套组件」关系补齐到已有资产上（老目录里它们是独立条目）
    const upgraded = await this.upgradeComponents()
    if (added.length > 0 || migrated || upgraded) {
      if (added.length > 0) this.log(`资源同步新增 ${added.length} 项：${added.join('、')}`)
      await this.save()
    }
    return { added, total: this.assets.size }
  }

  /**
   * 给已有资产补 componentOf / components：
   * - 音频脚本的依赖模型挂到主模型下；
   * - ComfyUI 工作流解析出实际权重文件作为组件。
   * 只补缺失字段，不覆盖用户改过的内容。
   */
  async upgradeComponents() {
    let dirty = false
    const deps = {
      'qwen3-aligner': ['qwen3-asr', 'aligner'],
      campplus: ['qwen3-asr', 'speaker'],
      'silero-vad': ['qwen3-asr', 'vad'],
      'moss-audio-tokenizer': ['moss-tts', 'vocoder'],
    }
    for (const [id, [parent, role]] of Object.entries(deps)) {
      const asset = this.assets.get(id)
      if (!asset || !this.assets.has(parent)) continue
      if (asset.componentOf) continue
      asset.componentOf = parent
      asset.role = role
      asset.hidden = true
      dirty = true
    }
    // 迁移：voxcpm2 是独立的另一套 TTS，不是 moss-tts 的组件（之前挂错了）
    // 迁移：tts_run.py 是 VoxCPM2 的入口。早期把它登记成了 moss-tts，voxcpm2 反倒成了空壳。
    // 正确关系：voxcpm2 = 主资产（audio-tts，script=tts_run.py）；本机没有 MOSS-TTS 就删掉这条幽灵资产。
    const legacyTts = this.assets.get('moss-tts')
    const vox = this.assets.get('voxcpm2')
    const base = this.config.paths?.modelsRoot ? path.dirname(this.config.paths.modelsRoot) : ''
    const ttsScript = base ? path.join(base, 'scripts', 'other', 'tts_run.py') : ''
    if (legacyTts?.script?.file && /tts_run\.py$/i.test(legacyTts.script.file)) {
      const target = vox ?? normalizeAsset({
        id: 'voxcpm2',
        name: 'VoxCPM2 TTS',
        kind: 'audio-tts',
        category: 'audio',
        runtime: 'script',
        slot: 'gpu',
        port: 0,
        tags: ['audio', 'tts'],
        priority: 55,
      })
      target.name = 'VoxCPM2 TTS'
      target.kind = 'audio-tts'
      target.runtime = 'script'
      target.enabled = true
      target.script = { file: legacyTts.script.file, args: [] }
      target.task = '中文语音合成（VoxCPM2，支持声音克隆 / Voice Design）'
      target.desc = `一次性脚本：${legacyTts.script.file}（由 local_audio 执行，运行前会先释放 GPU 槽）`
      if (!Array.isArray(target.components) || target.components.length === 0) {
        target.components = legacyTts.components ?? target.components ?? []
      }
      this.assets.set('voxcpm2', target)
      this.assets.delete('moss-tts')
      this._verify.delete('moss-tts')
      dirty = true
    }
    // 迁移：TTS 脚本改过名（tts_moss.py → tts_run.py）；顺便把 voxcpm2 的脚本接上
    const tts = this.assets.get('voxcpm2')
    if (tts && !tts.script?.file && ttsScript && existsSync(ttsScript)) {
      tts.script = { file: ttsScript, args: [] }
      tts.runtime = 'script'
      tts.kind = 'audio-tts'
      tts.enabled = true
      tts.desc = `一次性脚本：${ttsScript}（由 local_audio 执行，运行前会先释放 GPU 槽）`
      dirty = true
    } else if (tts?.script?.file && base && !existsSync(tts.script.file) && ttsScript && existsSync(ttsScript)) {
      tts.script.file = ttsScript
      tts.desc = `一次性脚本：${ttsScript}（由 local_audio 执行，运行前会先释放 GPU 槽）`
      dirty = true
    }
    for (const asset of this.assets.values()) {
      if (asset.runtime !== 'workflow' || !asset.workflow) continue
      if (Array.isArray(asset.components) && asset.components.length > 0) continue
      try {
        const doc = JSON.parse(await fsp.readFile(asset.workflow, 'utf8'))
        const components = extractWorkflowComponents(doc)
        if (components.length > 0) {
          asset.components = components
          dirty = true
        }
      } catch {
        /* 工作流文件读不到就跳过 */
      }
    }
    // 迁移：registry 里的相对路径过期（如 text/xxx 实际在 rag/xxx）→ 按文件名找回
    if (await this.repairPaths()) dirty = true
    return dirty
  }

  /**
   * 按文件名修复 llama.cpp 资产的 gguf/mmproj 路径。
   * 只在确实有文件缺失时才扫目录（避免启动开销），扫到唯一同名文件才改。
   */
  async repairPaths() {
    const root = this.config.paths?.modelsRoot
    if (!root || !existsSync(root)) return false
    const broken = []
    for (const asset of this.assets.values()) {
      if (asset.runtime !== 'llama.cpp' || !asset.launch?.gguf) continue
      const full = path.isAbsolute(asset.launch.gguf) ? asset.launch.gguf : path.join(root, asset.launch.gguf)
      if (!existsSync(full)) broken.push(asset)
    }
    if (broken.length === 0) return false

    const index = new Map()
    let visited = 0
    const walk = async (dir, depth, rel) => {
      if (depth > 3 || visited > 4000) return
      let entries = []
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const relPath = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (/^(ComfyUI|\.venv|__pycache__)$/i.test(entry.name)) continue
          await walk(path.join(dir, entry.name), depth + 1, relPath)
        } else if (/\.(gguf)$/i.test(entry.name) && !index.has(entry.name)) {
          visited += 1
          index.set(entry.name, relPath)
        }
      }
    }
    await walk(root, 1, '')

    let dirty = false
    for (const asset of broken) {
      for (const key of ['gguf', 'mmproj']) {
        const value = asset.launch?.[key]
        if (!value) continue
        const full = path.isAbsolute(value) ? value : path.join(root, value)
        if (existsSync(full)) continue
        const hit = index.get(path.basename(value))
        if (hit && hit !== value) {
          asset.launch[key] = hit
          dirty = true
          this.log(`修正路径 ${asset.id}.${key}：${value} → ${hit}`)
        }
      }
    }
    return dirty
  }

  /** ComfyUI：每个目录下的 workflow*.json 登记成独立生成资产，共用 comfyui 服务。 */
  async syncComfyWorkflows() {
    const dir = this.config.paths?.comfyScripts
    if (!dir || !existsSync(dir)) return []
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const added = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '__pycache__') continue
      const modelDir = path.join(dir, entry.name)
      let files = []
      try {
        files = (await fsp.readdir(modelDir)).filter((file) => /^workflow.*\.json$/i.test(file)).sort()
      } catch {
        continue
      }
      for (const file of files) {
        const full = path.join(modelDir, file)
        let doc = null
        try {
          doc = JSON.parse(await fsp.readFile(full, 'utf8'))
        } catch {
          continue
        }
        const meta = doc?._meta ?? {}
        // 工作流里引用的权重文件 = 这个主模型的配套组件（编码器 / VAE / 主模型…）
        const components = extractWorkflowComponents(doc)
        const kind = /minimax|wan|video/i.test(entry.name)
          ? 'video'
          : /acestep|music|audio/i.test(entry.name)
            ? 'music'
            : 'image'
        const variant = file.replace(/^workflow_?/i, '').replace(/\.json$/i, '')
        const id = variant && variant !== 'api' ? `${entry.name}-${variant}` : entry.name
        if (this.assets.has(id)) continue
        const modelName = String(meta.模型 ?? meta.model ?? entry.name)
        const profile = WORKFLOW_PROFILES[id] ?? {}
        this.assets.set(id, normalizeAsset({
          id,
          name: `${entry.name}${variant && variant !== 'api' ? ` · ${variant}` : ''}`,
          kind,
          category: kind,
          runtime: 'workflow',
          serviceId: 'comfyui',
          group: String(entry.name),
          requires: [{ asset: 'comfyui', role: 'framework' }],
          slot: 'gpu',
          port: 8188,
          task: String(meta.说明 ?? modelName),
          desc: `ComfyUI 工作流：${full}`,
          tags: [kind, 'comfyui'],
          keywords: profile.keywords ?? [],
          strengths: profile.strengths ?? '',
          workflow: full,
          components,
          priority: 45,
          cost: { vramMb: null, ramMb: null, loadMs: 5000, estimated: true },
        }))
        added.push(id)
      }
    }
    return added
  }

  /** 音频：一次性 Python 脚本（TTS / ASR+分离 / 音乐质检）以及它们依赖的模型。 */
  async syncAudioScripts() {
    const base = this.config.paths?.modelsRoot ? path.dirname(this.config.paths.modelsRoot) : ''
    if (!base) return []
    const scriptsDir = path.join(base, 'scripts', 'other')
    const modelsDir = path.join(base, 'models', 'audio')
    const added = []
    const defs = [
      { id: 'voxcpm2', name: 'VoxCPM2 TTS', kind: 'audio-tts', script: 'tts_run.py', task: '中文语音合成（VoxCPM2，支持声音克隆 / Voice Design）', args: [] },
      { id: 'qwen3-asr', name: 'Qwen3-ASR + 分离', kind: 'audio-asr', script: 'asr_diarize.py', task: '语音转写 + 说话人分离 + SRT 字幕', args: [] },
      { id: 'music-qc', name: '音乐质检', kind: 'tool', script: 'music_qc.py', task: 'MOSS-Music-8B 音乐描述/质检', args: [] },
    ]
    for (const def of defs) {
      if (this.assets.has(def.id)) continue
      const file = path.join(scriptsDir, def.script)
      if (!existsSync(file)) continue
      this.assets.set(def.id, normalizeAsset({
        id: def.id,
        name: def.name,
        kind: def.kind,
        category: 'audio',
        runtime: 'script',
        slot: 'gpu',
        port: 0,
        task: def.task,
        desc: `一次性脚本：${file}（由 local_audio 执行，运行前会先释放 GPU 槽）`,
        tags: ['audio', 'script'],
        script: { file, args: def.args },
        cost: { vramMb: null, ramMb: null, loadMs: 3000, estimated: true },
        priority: 55,
      }))
      added.push(def.id)
    }
    // 被脚本内部加载的模型：作为「配套组件」挂到主模型下，不在资产列表单独占一行
    const deps = [
      ['qwen3-aligner', 'Qwen3-ForcedAligner-0.6B', 'qwen3-asr', 'aligner', '字级时间戳对齐（ASR SRT 用）'],
      ['campplus', 'campplus', 'qwen3-asr', 'speaker', '声纹嵌入（说话人分离用）'],
      ['silero-vad', 'fsmn-vad', 'qwen3-asr', 'vad', 'VAD（默认 silero-vad，备用 fsmn）'],
    ]
    for (const [id, dirName, parent, role, task] of deps) {
      if (this.assets.has(id) || !existsSync(path.join(modelsDir, dirName))) continue
      this.assets.set(id, normalizeAsset({
        id,
        name: dirName,
        kind: 'tool',
        category: 'audio',
        runtime: 'script',
        slot: 'gpu',
        enabled: false,
        port: 0,
        task,
        desc: `${parent === 'moss-tts' ? 'MOSS-TTS' : 'Qwen3-ASR'} 的配套组件，由脚本内部加载，不单独调度`,
        tags: ['audio', 'component'],
        componentOf: parent,
        role,
        cost: { vramMb: null, ramMb: null, loadMs: 0, estimated: true },
        priority: 20,
      }))
      added.push(id)
    }
    return added
  }

  /** tools/mcp-servers 下的目录登记为 MCP 外部资产。 */
  async syncMcpDirs() {
    const base = this.config.paths?.modelsRoot ? path.dirname(this.config.paths.modelsRoot) : ''
    if (!base) return []
    const added = []
    const dir = path.join(base, 'tools', 'mcp-servers')
    if (existsSync(dir)) {
      let entries = []
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const id = entry.name
        if (this.assets.has(id)) continue
        this.assets.set(id, normalizeAsset({
          id,
          name: id,
          kind: 'tool',
          category: 'mcp',
          runtime: 'mcp',
          slot: 'cpu',
          pinned: true,
          priority: 75,
          port: 0,
          task: `MCP 服务（${entry.name}，由 DSH 挂载）`,
          desc: `目录：${path.join(dir, id)}`,
          tags: ['mcp', 'tool'],
          cost: { vramMb: 0, ramMb: 200, loadMs: 0, estimated: true },
        }))
        added.push(id)
      }
    }

    // ArtCraft 套件：每个 app 自带 `<app>-cli.exe mcp`（stdio JSON-RPC），逐个登记
    const artApps = path.join(base, 'tools', 'storytold-ArtCraft', 'apps')
    if (existsSync(artApps)) {
      let apps = []
      try {
        const entries = await fsp.readdir(artApps, { withFileTypes: true })
        apps = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => existsSync(path.join(artApps, name, `${name}-cli.exe`)))
      } catch {
        apps = []
      }
      const purpose = {
        deckcraft: 'PPT/演示文稿',
        wordcraft: 'Word 文档',
        pdfcraft: 'PDF 处理',
        photocraft: '图片编辑/修图',
        vectorcraft: '矢量图/图标',
        designcraft: '平面设计',
        figcraft: '界面/设计稿',
        filmcraft: '视频剪辑',
        soundcraft: '音频处理',
        cadcraft: 'CAD/工程图',
        gridcraft: '表格/网格',
        effectcraft: '特效',
        lightcraft: '灯光/渲染',
      }
      for (const app of apps) {
        if (this.assets.has(app)) continue
        const exe = path.join(artApps, app, `${app}-cli.exe`)
        this.assets.set(app, normalizeAsset({
          id: app,
          name: `${app} MCP`,
          kind: 'tool',
          category: 'mcp',
          runtime: 'mcp',
          slot: 'cpu',
          pinned: true,
          priority: 70,
          port: 0,
          task: `${purpose[app] ?? `创意工具`}（ArtCraft）`,
          desc: `MCP server：${exe} mcp（stdio JSON-RPC）`,
          tags: ['mcp', 'artcraft', app],
          keywords: [purpose[app], app].filter(Boolean),
          strengths: `ArtCraft 的${purpose[app] ?? '创意'}工具`,
          mcp: { command: exe, args: ['mcp'] },
          launch: { command: [exe, 'mcp'] },
          cost: { vramMb: 0, ramMb: 200, loadMs: 0, estimated: true },
        }))
        added.push(app)
      }
      // 旧版本的「套件」汇总条目：隐藏掉，避免和 13 个 app 重复
      const suite = this.assets.get('artcraft')
      if (suite && apps.length > 0 && !suite.componentOf) {
        suite.hidden = true
        suite.name = `ArtCraft 套件（${apps.length} 个 MCP）`
        suite.task = `汇总条目；实际 MCP：${apps.join('、')}`
        suite.desc = '每个 app 都是独立 MCP server（<app>-cli.exe mcp），在各自的资产条目里'
      }
    }
    return added
  }

  /**
   * 扫描模型根目录下的 .gguf，自动登记未收录的模型。
   * @param {{max?: number}} options
   */
  async discover({ max = 100 } = {}) {
    const root = this.config?.paths?.modelsRoot
    if (!root || !existsSync(root)) return []
    const found = []
    const walk = async (dir, depth) => {
      if (depth > 4 || found.length >= max) return
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (found.length >= max) break
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue
        if (/mmproj/i.test(entry.name)) continue
        found.push(full)
      }
    }
    await walk(root, 0)

    const added = []
    for (const file of found) {
      const rel = path.relative(root, file).replace(/\\/g, '/')
      const id = path.basename(file).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      if (this.assets.has(id)) continue
      const cost = await this.#estimateCost('llm', file, null, [])
      this.assets.set(id, normalizeAsset({
        id,
        name: path.basename(file, '.gguf'),
        kind: 'llm',
        runtime: 'llama.cpp',
        slot: 'gpu',
        port: CHAT_PORT,
        task: '自动发现（未标注能力）',
        desc: `扫描 ${rel} 得到`,
        launch: {
          gguf: rel,
          ngl: 99,
          ctx: 8192,
          threads: defaultThreads(),
          rawArgs: ['-ngl', '99', '-c', '8192', '-t', String(defaultThreads())],
        },
        cost,
        priority: 30,
      }))
      added.push(id)
    }
    if (added.length > 0) await this.save()
    return added
  }
}
