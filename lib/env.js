/**
 * 便携运行时：把「跑起来需要的东西」尽量收进插件目录，少让别人 debug 环境。
 *
 * 目录约定（都在 `<插件>/runtime/`，gitignore 掉，不进仓库）：
 *
 *   runtime/llama/    llama-server.exe + 依赖 DLL（从已有安装 copy，MIT）
 *   runtime/py/       ComfyUI 用的 Python venv（torch 太大，按需装）
 *   runtime/comfy.json  指向本机 ComfyUI 目录（不复制 200MB+ 源码）
 *   runtime/env.json    本文件记录上次 doctor 结果，方便排查
 *
 * 设计原则：
 * - **能 copy 的就 copy**：llama.cpp 二进制 81MB，直接复制到插件目录，运行时不依赖 PATH；
 * - **太大的写指针**：ComfyUI 源码 200MB、venv 2.5GB、模型几 GB，不复制，只记路径；
 * - **模型永远不移动**：只登记路径，用户随时换盘；
 * - doctor 输出的每条都带 `fix`，让模型知道下一步做什么，不用看日志猜。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { PLUGIN_ROOT, existsSync } from './util.js'

/** 运行时根目录：默认在插件里，可用 config.paths.runtimeDir 覆盖。 */
export function runtimeDirOf(config = {}) {
  return path.resolve(config.paths?.runtimeDir || path.join(PLUGIN_ROOT, 'runtime'))
}

/**
 * 单个「基础目录」推导出所有路径。
 *
 * 本机约定（也是仓库里所有示例的写法）：`D:\models` 下面同时放
 * `models/`（GGUF）、`llama.cpp/`（源码+编译产物）、`ComfyUI/`（含 models）、
 * `scripts/`（llama_cpp、comfyui、other）、`tools/`（MCP）、`output/`。
 * 换机器只要指对这一个目录，其余自动派生。
 * @param {string} base
 */
export function pathsFromBase(base) {
  const root = path.resolve(String(base || ''))
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  return {
    base: root,
    modelsRoot: path.join(root, 'models'),
    llamaDir: path.join(root, 'llama.cpp'),
    llamaServer: path.join(root, 'llama.cpp', 'build', 'bin', 'Release', exe),
    registry: path.join(root, 'scripts', 'llama_cpp', 'models.json'),
    comfyDir: path.join(root, 'ComfyUI'),
    comfyScripts: path.join(root, 'scripts', 'comfyui'),
    outputRoot: path.join(root, 'output'),
  }
}

/** 当前基础目录：显式配置优先，否则由 modelsRoot 反推。 */
export function baseDirOf(config = {}) {
  const explicit = String(config.paths?.base || '').trim()
  if (explicit) return path.resolve(explicit)
  const modelsRoot = String(config.paths?.modelsRoot || '').trim()
  if (!modelsRoot) return ''
  return path.dirname(path.resolve(modelsRoot))
}

/** 便携 llama-server 的位置。 */
export function bundledLlamaServer(config = {}) {
  return path.join(runtimeDirOf(config), 'llama', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
}

/**
 * 实际用哪个 llama-server：便携副本优先，其次配置里的路径。
 * 这样「下载插件即用」和「用我自己编译的版本」都能成立。
 * @returns {{exe: string, source: 'bundled'|'configured', exists: boolean}}
 */
export function resolveLlamaServer(config = {}) {
  const bundled = bundledLlamaServer(config)
  if (config.paths?.bundleLlama !== false && existsSync(bundled)) {
    return { exe: bundled, source: 'bundled', exists: true }
  }
  const configured = String(config.paths?.llamaServer || '').trim()
  return { exe: configured, source: 'configured', exists: Boolean(configured) && existsSync(configured) }
}

/** ComfyUI 目录：runtime/comfy.json 里登记的优先，其次配置。 */
export async function resolveComfyDir(config = {}) {
  const pointer = path.join(runtimeDirOf(config), 'comfy.json')
  try {
    const raw = JSON.parse(await fsp.readFile(pointer, 'utf8'))
    if (raw?.dir && existsSync(path.join(raw.dir, 'main.py'))) return { dir: raw.dir, source: 'pointer' }
  } catch {
    /* 没指针就回落到配置 */
  }
  const dir = String(config.paths?.comfyDir || '').trim()
  return { dir, source: 'config', valid: Boolean(dir) && existsSync(path.join(dir, 'main.py')) }
}

/** 目录里文件数/总字节（只数一层 + 一层子目录即可，避免大目录卡死）。 */
async function dirStats(dir, depth = 1) {
  let files = 0
  let bytes = 0
  const walk = async (current, level) => {
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (level < depth) await walk(full, level + 1)
      } else {
        files += 1
        try {
          bytes += (await fsp.stat(full)).size
        } catch {
          /* 权限问题跳过 */
        }
      }
    }
  }
  await walk(dir, 0)
  return { files, bytes }
}

const fmtGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`

/**
 * 体检：逐项给出 ok / warn / error 与 fix（fix 是可直接执行的一步，不是日志）。
 * @param {object} config
 * @param {{deep?: boolean}} [options] deep=true 时才统计模型目录大小
 */
export async function doctor(config = {}, { deep = false } = {}) {
  const items = []
  const add = (id, title, level, detail, fix = '') => items.push({ id, title, level, detail, fix })
  const rt = runtimeDirOf(config)

  // 基础目录
  const base = baseDirOf(config)
  if (base) {
    const exists = existsSync(base)
    add(
      'base',
      '基础目录',
      exists ? 'ok' : 'error',
      exists ? `${base}（模型 / llama.cpp / ComfyUI / scripts / tools 都在它下面）` : `不存在：${base}`,
      exists ? '' : 'local_env {"action":"set-base","dir":"D:\\\\models"}',
    )
  } else {
    add('base', '基础目录', 'warn', '未配置（可由 modelsRoot 反推）', 'local_env {"action":"set-base","dir":"D:\\\\models"}')
  }

  // 运行时目录
  try {
    await fsp.mkdir(rt, { recursive: true })
    await fsp.writeFile(path.join(rt, '.probe'), 'ok')
    await fsp.rm(path.join(rt, '.probe'), { force: true })
    add('runtime', '运行时目录', 'ok', rt)
  } catch (error) {
    add('runtime', '运行时目录', 'error', `不可写：${error?.message ?? error}`, '把插件挪到有写权限的目录，或设 paths.runtimeDir')
  }

  // llama.cpp
  const llama = resolveLlamaServer(config)
  if (llama.exists) {
    const stats = await dirStats(path.dirname(llama.exe))
    add('llama', 'llama.cpp', 'ok', `${llama.exe}（${llama.source === 'bundled' ? '插件内便携副本' : '系统安装'}，${fmtGb(stats.bytes)}）`)
  } else {
    add(
      'llama',
      'llama.cpp',
      'error',
      llama.exe ? `找不到：${llama.exe}` : '未配置，也没有插件内副本',
      'local_env {"action":"vendor-llama"}（从已有安装复制），或设 paths.llamaServer',
    )
  }

  // ComfyUI
  const comfy = await resolveComfyDir(config)
  const comfyOk = comfy.source === 'pointer' || comfy.valid
  if (comfyOk) {
    const stats = await dirStats(comfy.dir, 1)
    add('comfyui', 'ComfyUI', 'ok', `${comfy.dir}（${comfy.source === 'pointer' ? '指针' : '配置'}，${stats.files} 文件）`)
  } else {
    add('comfyui', 'ComfyUI', 'warn', comfy.dir ? `没有 main.py：${comfy.dir}` : '未配置', 'local_env {"action":"link-comfy","dir":"D:\\\\models\\\\ComfyUI"}')
  }

  // ComfyUI 的 Python（venv 优先）
  const venvPy = path.join(rt, 'py', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const configuredPy = String(config.paths?.comfyPython || '').trim()
  if (existsSync(venvPy)) add('python', 'ComfyUI Python', 'ok', `插件内 venv：${venvPy}`)
  else if (configuredPy && existsSync(configuredPy)) add('python', 'ComfyUI Python', 'ok', `外部解释器：${configuredPy}`)
  else add('python', 'ComfyUI Python', 'warn', '没有可用的 Python 解释器', '装 ComfyUI 依赖：见 local_env {"action":"plan"}')

  // 模型目录
  const modelsRoot = String(config.paths?.modelsRoot || '').trim()
  if (!modelsRoot) {
    add('models', '模型目录', 'warn', '未配置', 'local_env {"action":"set-model-root","dir":"D:\\\\models\\\\models"}')
  } else if (!existsSync(modelsRoot)) {
    add('models', '模型目录', 'error', `不存在：${modelsRoot}`, 'local_env {"action":"set-model-root","dir":"<你的模型目录>"}')
  } else {
    const stats = deep ? await dirStats(modelsRoot, 3) : { files: 0, bytes: 0 }
    add('models', '模型目录', 'ok', deep ? `${modelsRoot}（${stats.files} 文件，${fmtGb(stats.bytes)}）` : modelsRoot)
  }

  const summary = {
    ok: items.filter((item) => item.level === 'ok').length,
    warn: items.filter((item) => item.level === 'warn').length,
    error: items.filter((item) => item.level === 'error').length,
  }
  return { runtimeDir: rt, items, summary, ready: summary.error === 0 }
}

/**
 * 把已有 llama.cpp 的 llama-server + DLL 复制到插件 runtime/llama。
 * 只复制运行时需要的（跳过 test-*、llama-bench 之类的工具），其余原样保留。
 * @param {object} config
 * @param {{source?: string, force?: boolean}} [options]
 */
export async function vendorLlama(config = {}, { source = '', force = false } = {}) {
  const src = path.resolve(source || (resolveLlamaServer(config).source === 'configured' ? path.dirname(config.paths?.llamaServer ?? '') : ''))
  if (!src || !existsSync(src)) {
    return { ok: false, error: `来源目录不存在：${src || '（未提供）'}`, hint: 'local_env {"action":"vendor-llama","source":"D:\\\\models\\\\llama.cpp\\\\build\\\\bin\\\\Release"}' }
  }
  const srcExe = path.join(src, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  if (!existsSync(srcExe)) return { ok: false, error: `目录里没有 llama-server：${src}` }

  const dest = path.join(runtimeDirOf(config), 'llama')
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  let copied = 0
  let bytes = 0
  // 只搬运行时要用的：llama-server + 依赖 DLL；bench / cli / quantize 之类的工具不搬
  const skip = /^(test-|llama-(bench|batched-bench|cli|quantize|gguf|gbnf|perplexity|imatrix|tokenize|embedding))/i
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (skip.test(entry.name)) continue
    if (!/\.(exe|dll)$/i.test(entry.name)) continue
    const target = path.join(dest, entry.name)
    if (!force && existsSync(target)) continue
    await fsp.copyFile(path.join(src, entry.name), target)
    copied += 1
    bytes += (await fsp.stat(path.join(src, entry.name))).size
  }
  return {
    ok: existsSync(bundledLlamaServer(config)),
    dest,
    copied,
    bytes,
    hint: copied === 0 ? '已经是最新的，没有需要复制的文件（force=true 可强制覆盖）' : '现在 llama.cpp 走插件内副本，不再依赖系统路径',
  }
}

/** 记录一个已有的 ComfyUI 目录（不复制源码，只写指针）。 */
export async function linkComfy(config = {}, dir) {
  const target = path.resolve(String(dir || ''))
  if (!target || !existsSync(path.join(target, 'main.py'))) {
    return { ok: false, error: `不是 ComfyUI 目录（缺 main.py）：${target || '（空）'}` }
  }
  const pointer = path.join(runtimeDirOf(config), 'comfy.json')
  await fsp.mkdir(path.dirname(pointer), { recursive: true })
  await fsp.writeFile(pointer, `${JSON.stringify({ dir: target, linkedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return { ok: true, dir: target, pointer }
}

/**
 * 安装计划：告诉用户/模型「还差什么、大概多大、一条命令怎么做」。
 * 这里只产出计划，不自动下载大文件（torch/venv 动辄 GB 级，必须让用户决定）。
 */
export async function plan(config = {}) {
  const report = await doctor(config)
  const steps = []
  for (const item of report.items) {
    if (item.level === 'ok') continue
    steps.push({ id: item.id, title: item.title, fix: item.fix, blocked: item.level === 'error' })
  }
  steps.push({
    id: 'comfy-deps',
    title: 'ComfyUI 依赖（torch 等，约 2-3 GB）',
    fix: '在 ComfyUI 目录用它的 .venv 装 requirements.txt；插件只负责记路径，不替你下 torch',
    blocked: false,
  })
  return { ready: report.ready, steps }
}
