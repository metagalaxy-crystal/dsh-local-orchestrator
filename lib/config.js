/**
 * 插件配置：默认值 → 本机路径探测 → config.json 覆盖 → profile 行内配置。
 *
 * 优先级（后者覆盖前者）：
 *   1. DEFAULT_CONFIG / 环境变量 / 自动探测出的本机路径
 *   2. <dataDir>/config.json（运行期可由 local_service 工具修改）
 *   3. profile 里给插件行写的 config（cordis.patch.yml 的 config: 字段）
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { existsSync, isDirSync, readJsonSafe, writeJsonAtomic, expandPath, PLUGIN_ROOT } from './util.js'

/** DSH 数据根目录。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/**
 * 本机路径探测：优先环境变量（与用户原有 scripts/config.py 的约定一致），
 * 其次 D:\models 之类的常见布局，最后留空交给用户配置。
 */
export function detectPaths() {
  const pick = (envName, candidates) => {
    if (process.env[envName]) return expandPath(process.env[envName])
    const found = candidates.find((item) => existsSync(item) || isDirSync(item))
    return found ? path.resolve(found) : ''
  }

  const modelsRoot = pick('MODEL_ROOT', ['D:/models/models', path.join(os.homedir(), 'models')])
  const llamaDir = pick('LLAMA_DIR', ['D:/models/llama.cpp', path.join(os.homedir(), 'llama.cpp')])
  const comfyDir = pick('COMFY_DIR', ['D:/models/ComfyUI', path.join(os.homedir(), 'ComfyUI')])
  const outputRoot = pick('OUTPUT_ROOT', ['D:/models/output', path.join(os.homedir(), 'models-output')])

  const llamaServer = process.env.LLAMA_SERVER
    ? expandPath(process.env.LLAMA_SERVER)
    : llamaDir
      ? path.join(llamaDir, 'build', 'bin', process.platform === 'win32' ? 'Release' : '', `llama-server${process.platform === 'win32' ? '.exe' : ''}`)
      : ''

  const registry = process.env.MODEL_REGISTRY
    ? expandPath(process.env.MODEL_REGISTRY)
    : llamaDir
      ? path.join(path.dirname(llamaDir), 'scripts', 'llama_cpp', 'models.json')
      : ''

  const comfyScripts = process.env.COMFY_SCRIPTS
    ? expandPath(process.env.COMFY_SCRIPTS)
    : comfyDir
      ? path.join(path.dirname(comfyDir), 'scripts', 'comfyui')
      : ''

  const modelsBase = modelsRoot ? path.dirname(modelsRoot) : ''
  const venvPython = modelsBase
    ? path.join(modelsBase, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    : ''

  const pythonPath = process.env.MODELS_PY || (existsSync(venvPython) ? venvPython : '')
  return {
    modelsRoot,
    llamaDir,
    llamaServer,
    registry,
    comfyDir,
    comfyScripts,
    outputRoot,
    pythonPath,
    // ComfyUI 必须用它自己的 .venv（系统 python 缺 yaml/alembic 等依赖）
    comfyPython: process.env.COMFY_PY || pythonPath || 'python',
  }
}

/** 默认配置。路径类字段由 detectPaths() 补齐。 */
export function DEFAULT_CONFIG(paths = detectPaths()) {
  return {
    enabled: true,
    /** 运行期数据目录：catalog.json / config.json / events.jsonl / logs。 */
    dataDir: path.join(dshHome(), 'local-orchestrator'),
    paths: {
      /** 基础目录：模型 / llama.cpp / ComfyUI / scripts / tools 的父目录（如 D:\models）。 */
      base: '',
      modelsRoot: paths.modelsRoot,
      llamaDir: paths.llamaDir,
      llamaServer: paths.llamaServer,
      registry: paths.registry,
      comfyDir: paths.comfyDir,
      comfyScripts: paths.comfyScripts,
      comfyPython: paths.comfyPython,
      pythonPath: paths.pythonPath,
      outputRoot: paths.outputRoot,
      /** 便携运行时目录（插件内）：llama 二进制 / python venv / comfy 指针都放这。 */
      runtimeDir: path.join(PLUGIN_ROOT, 'runtime'),
      /** 优先用 runtime/llama 里的便携 llama-server，其次 paths.llamaServer。 */
      bundleLlama: true,
      /** 启动时扫描目录自动登记资产。默认关闭：换机器后模型散落各处，手动添加更可靠。 */
      autoSync: false,
    },
    hardware: {
      /** 自动采样间隔；0 表示只在需要时采样。 */
      probeIntervalMs: 3000,
      /** 显存预留：既要给桌面/浏览器留，也要避免 llama.cpp 分配失败。 */
      reserveVramMb: 768,
      reserveRatio: 0.08,
      /** 内存预留。 */
      reserveRamMb: 2048,
      /** auto | nvidia-smi | none */
      gpuBackend: 'auto',
    },
    scheduler: {
      /** 8GB 显存下 GPU 模型互斥；显存放得下时可关掉做并发实验。 */
      gpuExclusive: true,
      /** 同时最多加载几个 CPU 槽资产（embed / rerank / MCP）。 */
      maxCpuLoads: 2,
      /** 空闲多久自动卸载（秒）；0 表示不自动卸载。 */
      idleUnloadSec: 900,
      /** 任务全部结束后多少秒释放空闲资源；0 表示不按任务释放（只靠 idleUnloadSec）。 */
      releaseAfterTaskSec: 30,
      /** 冷启动等待上限。 */
      loadTimeoutMs: 600000,
      stopTimeoutMs: 20000,
      /** 排队等待 GPU 槽的上限。 */
      queueTimeoutMs: 900000,
      /** 首选端口不可用时（Windows 动态端口占用）自动换空闲端口。 */
      autoPort: true,
      /** 按剩余显存自动调 ctx / ngl / KV 量化（依赖 GGUF 元数据）。 */
      autoTune: true,
      /** llama-server 并行槽位数；单个 agent 用 1 个槽最省显存。 */
      parallelSlots: 1,
      /** 学习到的实测值权重（0~1），用于修正 catalog 里的估算。 */
      measureWeight: 0.6,
      /** 卸载 GPU 资产后等显存真正回落再起下一个（8GB 卡上防 OOM）。 */
      waitVramRelease: true,
    },
    decision: {
      /**
       * 决策模型来源：
       * - session：由当前 DSH 会话模型自己决策（插件只提供工具，零额外调用）
       * - dsh：调用 DSH 已配置的 provider/model（如 deepseek-v4），适合复杂任务分解
       * - openai：任意 OpenAI 兼容端点（云端或本地 llama-server）
       * - local：直接用本地已注册的某个模型当决策模型
       */
      mode: 'session',
      provider: 'deepseek',
      model: '',
      baseUrl: '',
      apiKey: '',
      localAsset: '',
      maxTokens: 1500,
      temperature: 0.2,
      /** 允许 local_delegate 自主分解任务（多步）。 */
      planning: true,
      /** 单次委派最多步数。 */
      maxSteps: 6,
    },
    tools: {
      enable: true,
      /** 工具名前缀，避免和其他插件撞名。 */
      prefix: 'local_',
    },
    /**
     * 任务池：跨会话的多步任务（local_task / local_step）。
     * 任务状态落在 <dataDir>/tasks/<taskId>.json，重启后自动恢复为 paused。
     */
    tasks: {
      enabled: true,
      /** 单任务最多执行多少步。 */
      maxSteps: 8,
      /** 单任务最多几次人工/模型判断（require）。 */
      maxRequires: 2,
      /** 单任务总时长上限（分钟）；超时任务置为 error。 */
      maxWallMin: 30,
      /** 终态任务保留多少个（超出按时间清理，产物不动）。 */
      keepFinished: 100,
      /** 后台继续推进 running 的任务；关掉后只能靠 local_step 手动推进。 */
      background: true,
    },
    /** 后台执行环：关掉页面也把任务一步步跑完，到决策点停住并唤醒会话。 */
    worker: {
      enabled: true,
      /** 检查间隔（毫秒）。 */
      tickMs: 2000,
      /** 单步最长执行时间（分钟），超时中止并按失败处理。 */
      maxStepMin: 30,
      /** 租约 TTL（秒）：进程崩溃时按此兜底回收槽位。 */
      leaseTtlSec: 1800,
    },
    /** ComfyUI 出图：默认工作流模板名（来自 scripts/comfyui/<目录>/workflow*.json）。 */
    comfy: {
      /** 按 prompt 自动挑工作流；关掉则永远用下面的固定模板。 */
      autoSelect: true,
      imageWorkflow: 'zimage',
      videoWorkflow: 'minimax-h3-t2v',
      audioWorkflow: 'acestep',
    },
    /**
     * MCP 服务器登记（只做资源标记与调度避让，挂载仍由 DSH 负责）。
     * 每项：{id, name, desc, command?}
     */
    mcpServers: [],
    prompt: {
      /** 是否往系统提示里注入本地资源简报。 */
      enabled: true,
      /** 简报最多列几个资产。 */
      maxAssets: 8,
    },
    web: { enabled: true },
  }
}

/** 深合并：对象递归，数组与标量直接覆盖。 */
export function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch
  const out = Array.isArray(base) || base === null || typeof base !== 'object' ? {} : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value)
  }
  return out
}

/**
 * 迁移：早期版本曾把 comfyPython 写死成裸 "python"（会落到系统 python，缺 alembic/comfy_aimdo），
 * 只要本机有 .venv 就改用它，否则 ComfyUI 永远起不来。
 * @param {object} config
 */
export function repairComfyPython(config) {
  if (!config?.paths) return config
  const value = String(config.paths.comfyPython ?? '').trim()
  if (value && !/^python(\.exe)?$/i.test(value)) return config
  const detected = detectPaths()
  if (detected.comfyPython && !/^python(\.exe)?$/i.test(detected.comfyPython)) {
    config.paths.comfyPython = detected.comfyPython
  }
  return config
}

/**
 * 解析配置。
 * @param {object} inlineConfig profile 行内配置
 * @returns {Promise<{config: object, file: string}>}
 */
export async function resolveConfig(inlineConfig = {}) {
  const defaults = DEFAULT_CONFIG()
  const dataDir = expandPath(inlineConfig?.dataDir || defaults.dataDir)
  const file = path.join(dataDir, 'config.json')
  const saved = await readJsonSafe(file, null)
  const config = deepMerge(deepMerge(defaults, saved ?? {}), inlineConfig ?? {})
  // 只在「持久化配置里写死了裸 python」时修复；行内配置与默认值不动
  if (saved?.paths?.comfyPython && !inlineConfig?.paths?.comfyPython) repairComfyPython(config)
  config.dataDir = dataDir
  config.configFile = file
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  return { config, file }
}

/**
 * 同步版配置解析：插件 apply() 是同步阶段，读一个很小的 JSON 用同步 IO 最稳。
 * @param {object} inlineConfig profile 行内配置
 * @returns {{config: object, file: string}}
 */
export function resolveConfigSync(inlineConfig = {}) {
  const defaults = DEFAULT_CONFIG()
  const dataDir = expandPath(inlineConfig?.dataDir || defaults.dataDir)
  const file = path.join(dataDir, 'config.json')
  let saved = null
  try {
    saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  } catch {
    saved = null
  }
  const config = deepMerge(deepMerge(defaults, saved ?? {}), inlineConfig ?? {})
  if (saved?.paths?.comfyPython && !inlineConfig?.paths?.comfyPython) repairComfyPython(config)
  config.dataDir = dataDir
  config.configFile = file
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  return { config, file }
}

/** 把补丁写回 config.json 并原地更新 config 对象（工具改配置走这里）。 */
export async function saveConfigPatch(config, patch) {
  const next = deepMerge(config, patch)
  // 只持久化用户可能改的部分，避免把探测结果写死
  const persisted = {
    paths: next.paths,
    hardware: next.hardware,
    scheduler: next.scheduler,
    decision: next.decision,
    tools: next.tools,
    tasks: next.tasks,
    worker: next.worker,
    prompt: next.prompt,
    web: next.web,
    enabled: next.enabled,
  }
  await writeJsonAtomic(config.configFile, persisted)
  Object.assign(config, next)
  return config
}
