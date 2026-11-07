/**
 * 通用进程运行时：拉起子进程、把日志落到文件、按端口/进程树停止、HTTP 判活。
 *
 * 所有 heavy runtime（llama-server、ComfyUI、任意自定义命令）都复用这一层，
 * 这样「加载/卸载」只有一份实现，不会每个模型类型各写一套。
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sleep, nowIso, PYTHON_UTF8_ENV, isPythonCommand } from '../util.js'

/** 保障日志目录存在，并以追加方式打开日志文件。 */
export async function openLog(logDir, id) {
  await fsp.mkdir(logDir, { recursive: true })
  const file = path.join(logDir, `${String(id).replace(/[^\w.-]+/g, '_')}.log`)
  const handle = await fsp.open(file, 'a')
  await handle.write(`\n===== ${nowIso()} 启动 =====\n`)
  return { file, handle }
}

/**
 * 启动一个受控子进程。
 * @param {object} options
 * @param {string} options.exe 可执行文件
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {Record<string,string>} [options.env]
 * @param {string} options.logFile
 * @param {(code:number|null, signal:string|null) => void} [options.onExit]
 */
export async function spawnManaged({ exe, args = [], cwd, env, logFile, onExit }) {
  const handle = await fsp.open(logFile, 'a')
  const pyEnv = isPythonCommand(exe, args) ? PYTHON_UTF8_ENV : {}
  const child = spawn(exe, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...pyEnv, ...(env ?? {}) },
    stdio: ['ignore', handle.fd, handle.fd],
    windowsHide: true,
  })
  child.on('exit', (code, signal) => {
    handle.close().catch(() => {})
    try {
      onExit?.(code, signal)
    } catch {
      /* 回调异常不影响主流程 */
    }
  })
  child.on('error', (error) => {
    handle.close().catch(() => {})
    try {
      onExit?.(null, String(error))
    } catch {
      /* ignore */
    }
  })
  return child
}

/** 跑一个短命令并忽略输出（避免管道依赖，沙箱环境也能工作）。 */
function runQuiet(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(false)
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** 结束整棵进程树（Windows 用 taskkill /T，其它平台走 SIGTERM→SIGKILL）。 */
export async function killTree(pid, { timeoutMs = 20000 } = {}) {
  if (!pid) return false
  if (process.platform === 'win32') {
    const ok = await runQuiet('taskkill', ['/PID', String(pid), '/T', '/F'], timeoutMs)
    if (ok) return true
    // taskkill 失败时退回直接杀进程（至少保证主进程退出）
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return false
    }
  }
  for (let i = 0; i < Math.min(20, Math.floor(timeoutMs / 500)); i += 1) {
    await sleep(500)
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已经退出 */
  }
  return true
}

/** 跑命令并捕获 stdout（重定向到临时文件，绕开管道限制）。 */
async function capture(cmd, args, timeoutMs = 8000) {
  const file = path.join(os.tmpdir(), `dsh-lo-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
  let handle = null
  try {
    handle = await fsp.open(file, 'w')
    const child = spawn(cmd, args, { stdio: ['ignore', handle.fd, 'ignore'], windowsHide: true })
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        resolve(-1)
      }, timeoutMs)
      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode ?? 0)
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
    })
    await handle.close()
    handle = null
    if (code === -1) return null
    return await fsp.readFile(file, 'utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
    await fsp.unlink(file).catch(() => {})
  }
}

/** 通过监听端口找 PID（用于接管不是本插件拉起的服务）。 */
export async function findPidByPort(port) {
  if (!Number.isFinite(port)) return null
  if (process.platform === 'win32') {
    const stdout = await capture('netstat', ['-ano', '-p', 'tcp'])
    if (!stdout) return null
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts.at(-1))
      if (Number.isFinite(pid) && pid > 0) return pid
    }
    return null
  }
  const stdout = await capture('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1`])
  const pid = Number(String(stdout ?? '').trim())
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/** 端口是否被监听（不依赖外部命令，快速判断）。 */
export async function portAlive(port, host = '127.0.0.1', timeoutMs = 800) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 让系统分配一个空闲端口（用于首选端口被系统临时占用时的回退）。 */
export async function findFreePort(host = '127.0.0.1') {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => (port ? resolve(port) : reject(new Error('分配端口失败'))))
    })
  })
}

/**
 * 轮询 HTTP 健康检查直到成功或超时。
 * @param {object} options
 * @param {() => Promise<{ok:boolean, body?:any, error?:string}>} options.probe 单次探测
 * @param {number} options.timeoutMs
 * @param {() => boolean} [options.exited] 进程是否已退出
 * @param {number} [options.intervalMs]
 */
export async function waitHealthy({ probe, timeoutMs, exited, intervalMs = 1000, signal }) {
  const started = Date.now()
  let lastError = ''
  for (;;) {
    if (signal?.aborted) return { ok: false, error: '已取消', ms: Date.now() - started }
    if (exited?.()) {
      return { ok: false, error: '进程已退出，详见日志', ms: Date.now() - started, exited: true }
    }
    const result = await probe()
    if (result?.ok) return { ok: true, body: result.body, ms: Date.now() - started }
    lastError = result?.error ?? lastError
    if (Date.now() - started > timeoutMs) {
      return { ok: false, error: `等待就绪超时（${Math.round(timeoutMs / 1000)}s）：${lastError}`, ms: Date.now() - started }
    }
    await sleep(intervalMs)
  }
}

/** 带超时的 GET/POST JSON。 */
export async function fetchJson(url, { method = 'GET', body, timeoutMs = 5000, signal, headers } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, body: json }
    }
    return { ok: true, status: res.status, body: json ?? text }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
