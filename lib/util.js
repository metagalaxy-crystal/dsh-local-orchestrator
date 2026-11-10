/**
 * 通用小工具：路径、JSON 读写、时间、字节格式化、进程等待。
 * 不依赖任何第三方包，保证插件在 DSH 内置 Node 里可直接跑。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 插件自身目录（lib/ 的上一级）。
 *
 * 便携运行时都放在这里：`<插件>/runtime/llama`（llama.cpp 二进制）、
 * `<插件>/runtime/py`（Python venv）、`<插件>/runtime/comfy`（指向 ComfyUI 的指针）。
 * 不写到用户目录，卸载插件即全部清掉。
 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 毫秒等待。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Python 子进程统一 UTF-8。
 *
 * Windows 下 stdout 是管道时 Python 3 默认用 locale 编码（cp936），脚本里 print 一个
 * emoji（✅/❌）就直接 UnicodeEncodeError 退出——本地 TTS/ASR 脚本大量用 emoji 打日志，
 * 不设这两个变量时「模型加载完了、打印进度时崩」。
 */
export const PYTHON_UTF8_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

/** 看起来是 Python 解释器或 .py 脚本就走 UTF-8 环境。 */
export function isPythonCommand(exe, args = []) {
  const name = String(exe ?? '').toLowerCase()
  if (/(^|[\\/])python[0-9.]*(\.exe)?$/.test(name)) return true
  return args.some((arg) => /\.py$/i.test(String(arg)))
}

/** 统一时间戳（本地 ISO，便于日志阅读）。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 读取 JSON；文件不存在或解析失败返回 fallback。 */
export async function readJsonSafe(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免半截文件。 */
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
}

/** 追加一行 JSONL（失败不影响主流程）。 */
export async function appendJsonl(file, record) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* 日志写失败不能影响调度 */
  }
}

/** 文件存在判断。 */
export function existsSync(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

/** 目录存在判断。 */
export function isDirSync(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 解析 `~` 与 `%VAR%`/$VAR 形式的环境变量，返回绝对路径。 */
export function expandPath(value) {
  if (typeof value !== 'string' || value === '') return ''
  let out = value.trim()
  out = out.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => process.env[name] ?? '')
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1))
  return path.resolve(out)
}

/** 字节 → 人类可读。 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

/** MB → 人类可读（整数 MB 场景更常用）。 */
export function fmtMb(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return '0MB'
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`
  return `${Math.round(mb)}MB`
}

/** 截断文本。 */
export function clip(text, max = 4000) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}\n…（已截断 ${value.length - max} 字符）` : value
}

/** 把 Windows 路径转成可读的正斜杠形式（展示用）。 */
export function prettyPath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/**
 * 合并多个 AbortSignal：任一触发即中止。
 * 用于把「DSH 取消」和「任务面板取消」两个来源都接进同一次调用。
 */
export function anySignal(...signals) {
  const list = signals.filter(Boolean)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') {
    try {
      return AbortSignal.any(list)
    } catch {
      /* fall through */
    }
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort(list.find((signal) => signal.aborted)?.reason)
  for (const signal of list) {
    if (signal.aborted) {
      onAbort()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

/** Promise 超时竞速；超时返回 `{ timedOut: true }`。 */
export async function withTimeout(promise, ms, label = 'operation') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** 容忍 abort：把 AbortSignal 接进 fetch。 */
export function joinSignals(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : null
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

/** 保证是正整数，否则取默认值。 */
export function intOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 安全 JSON 解析（模型输出里可能带 ```json 包裹）。 */
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
