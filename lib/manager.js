/**
 * 编排器：本地资源的加载 / 卸载 / 排队 / 淘汰 / 空闲回收。
 *
 * 关键约束（来自用户的 8GB 显存机器）：
 * - GPU 槽默认互斥：同一时刻只允许一个吃显存的资产（LLM / ComfyUI / 语音）；
 * - CPU 槽可并发：embed / rerank / MCP 这类零显存资产；
 * - 切换必须「先停后起」，否则上一份权重还没释放，新服务必然 OOM；
 * - 所有生命周期操作串行化（一把异步锁），避免两个任务同时抢显存。
 */
import { Catalog, publicAsset, KIND_LABEL } from './catalog.js'
import { Hardware } from './hardware.js'
import { Tracker } from './tracker.js'
import { TaskStore } from './tasks.js'
import { LeaseTable } from './leases.js'
import { BudgetTable, sourceOf } from './budget.js'
import * as llama from './runtimes/llama.js'
import * as comfy from './runtimes/comfy.js'
import {
  spawnManaged,
  killTree,
  findPidByPort,
  findFreePort,
  portAlive,
  waitHealthy,
  fetchJson,
} from './runtimes/process.js'
import { appendJsonl, nowIso, sleep, fmtMb, PYTHON_UTF8_ENV } from './util.js'
import { TokenStats, usageFileOf } from './stats.js'
import { readGgufMeta, summarize, planLlamaParams } from './gguf.js'
import { resolveWorkflow } from './workflows.js'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 环形事件日志：工具输出可回看最近 N 条，同时落 JSONL 供排查。 */
class EventLog {
  constructor(file, limit = 200) {
    this.file = file
    this.limit = limit
    this.items = []
  }

  push(kind, msg, data = {}) {
    const record = { ts: nowIso(), kind, msg, ...data }
    this.items.push(record)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    appendJsonl(this.file, record)
    return record
  }

  recent(n = 10) {
    return this.items.slice(-n)
  }
}

/** 把消息数组压成可读文本（IO 面板用）。 */
function formatMessages(messages = [], system) {
  const lines = []
  if (system) lines.push(`system: ${system}`)
  for (const message of messages) {
    const content = message?.content
    if (typeof content === 'string') {
      lines.push(`${message?.role ?? 'user'}: ${content}`)
    } else if (Array.isArray(content)) {
      const text = content
        .map((part) => (part?.type === 'text' ? part.text : `[${part?.type ?? '内容'}]`))
        .join('\n')
      lines.push(`${message?.role ?? 'user'}: ${text}`)
    } else {
      lines.push(`${message?.role ?? 'user'}: ${JSON.stringify(content ?? '')}`)
    }
  }
  return lines.join('\n\n')
}

export class Orchestrator {
  /**
   * @param {object} options
   * @param {object} options.config 插件配置
   * @param {object} [options.ctx] DSH 插件上下文（可选，用于日志）
   */
  constructor({ config, ctx = null }) {
    this.config = config
    this.ctx = ctx
    this.log = (msg) => this.#log(msg)
    this.events = new EventLog(config.eventsFile)
    this.hardware = new Hardware(config)
    this.catalog = new Catalog(config, (msg) => this.#log(msg))
    /** 任务/节点/IO 轨迹（Web UI 数据面）。 */
    this.tracker = new Tracker()
    /** 任务池：跨会话、可持久化的 Task/Step 状态机（见 docs/PLAN-v2）。 */
    this.tasks = new TaskStore({
      dir: path.join(config.dataDir, 'tasks'),
      config,
      onEvent: (kind, msg, data) => this.events.push(kind, msg, data),
    })
    /** 步骤级租约表：worker 执行前先拿租约，按会话公平排队。 */
    this.leases = new LeaseTable({
      config,
      onEvent: (kind, msg, data) => this.events.push(kind, msg, data),
    })
    /** 后台执行环（由 index.js 装配，未装配时为 null）。 */
    this.worker = null
    /** 单步执行器（懒创建，前后台共用；见 lib/steps.js）。 */
    this.steps = null
    /** 预算表（LLM / 工作流 / 脚本统一记账；见 lib/budget.js）。 */
    this.budget = new BudgetTable({ config, hardware: this.hardware, onEvent: (kind, msg, data) => this.events.push(kind, msg, data) })
    /** token 用量账本（每次本地对话一行；见 lib/stats.js）。 */
    this.stats = new TokenStats({ file: usageFileOf(config.dataDir) })
    /** @type {Map<string, object>} id → 运行实例 */
    this.instances = new Map()
    this.waiting = 0
    this._chain = Promise.resolve()
    this._reaper = null
    this._releaseTimer = null
    this._trackerUnsub = null
    this._started = false
    this._startPromise = null
    /** 系统提示简报缓存（同步读取，避免提示渲染等待采样）。 */
    this.cachedBriefing = ''
  }

  #log(msg) {
    try {
      this.ctx?.logger?.info?.(`[local-orchestrator] ${msg}`)
    } catch {
      /* ignore */
    }
  }

  /** 启动（幂等）：加载目录、起空闲回收定时器。 */
  start() {
    if (!this._startPromise) {
      this._startPromise = this.#start().catch((error) => {
        this._startPromise = null
        throw error
      })
    }
    return this._startPromise
  }

  async #start() {
    if (this._started) return this
    await this.catalog.load()
    await this.tasks.load()
    await this.stats.load()
    this._started = true
    const interval = Number(this.config.scheduler?.idleUnloadSec ?? 900) > 0 ? 30000 : 0
    if (interval > 0) {
      this._reaper = setInterval(() => {
        this.reapIdle().catch((error) => this.#log(`空闲回收失败：${error?.message ?? error}`))
      }, interval)
      this._reaper.unref?.()
    }
    // 任务全部结束后自动释放：监听轨迹变化，暂无运行任务就排一个延迟释放
    this._trackerUnsub = this.tracker.onChange(() => this.#scheduleRelease())
    this.events.push('boot', `编排器就绪：${this.catalog.list().length} 个资产`, {
      dataDir: this.config.dataDir,
    })
    await this.refreshBriefing()
    return this
  }

  /** 插件卸载：停掉定时器，默认不杀本地服务（与用户原有「服务独立于 UI」一致）。 */
  dispose() {
    try {
      this.worker?.stop?.()
    } catch {
      /* ignore */
    }
    if (this._reaper) clearInterval(this._reaper)
    this._reaper = null
    this.#clearReleaseTimer()
    this._trackerUnsub?.()
    this._trackerUnsub = null
    this._started = false
    this._startPromise = null
  }

  #clearReleaseTimer() {
    if (this._releaseTimer) clearTimeout(this._releaseTimer)
    this._releaseTimer = null
  }

  /**
   * 任务结束后调度资源释放：
   * - 还有 running 任务 → 取消待执行的释放；
   * - 最后一个任务结束 → releaseAfterTaskSec 秒后释放「空闲且未 pinned」的实例；
   * - 最近一个任务是 service（用户手动预加载）→ 不释放，交给 idleUnloadSec 长周期回收。
   */
  #scheduleRelease() {
    const delaySec = Number(this.config.scheduler?.releaseAfterTaskSec ?? 30)
    // 0（或负数）表示关闭「任务结束释放」，只保留 idleUnloadSec 长周期回收
    if (!Number.isFinite(delaySec) || delaySec <= 0) return
    if (this.tracker.hasRunning()) {
      this.#clearReleaseTimer()
      return
    }
    if (this._releaseTimer) return
    const last = this.tracker.lastRun()
    if (last && last.kind === 'service') return
    this._releaseTimer = setTimeout(() => {
      this._releaseTimer = null
      if (this.tracker.hasRunning()) return
      this.releaseIdle({ minIdleSec: delaySec, reason: '任务全部结束，自动释放' })
        .then((stopped) => {
          if (stopped.length > 0) this.#log(`任务结束自动释放：${stopped.join('、')}`)
        })
        .catch((error) => this.#log(`自动释放失败：${error?.message ?? error}`))
    }, delaySec * 1000)
    this._releaseTimer.unref?.()
  }

  /**
   * 回合结束属于「本会话」的收尾：取消该会话正在跑的工具 run，
   * 并把正在执行的步骤回退、任务转 paused；其它会话的任务完全不动。
   * @param {string|null} sessionId
   * @param {string} [reason]
   */
  async suspendSession(sessionId, reason = '回合结束') {
    if (!sessionId) return { runs: [], tasks: [] }
    const runs = this.tracker.cancelBySession(sessionId, reason)
    const tasks = await this.tasks.suspendSession(sessionId, reason)
    if (runs.length > 0 || tasks.length > 0) {
      this.events.push('turn:suspend', `会话 ${sessionId} 回合结束：取消 ${runs.length} 个 run，暂停 ${tasks.length} 个任务`)
    }
    return { runs, tasks }
  }

  /**
   * 释放空闲实例（默认只释放未 pinned 的）。
   * @param {{minIdleSec?: number, reason?: string, includePinned?: boolean}} [options]
   */
  async releaseIdle({ minIdleSec = 0, reason = '释放空闲资源', includePinned = false } = {}) {
    return this.#withLock(async () => {
      const now = Date.now()
      const stopped = []
      for (const instance of [...this.instances.values()]) {
        if (instance.state !== 'ready') continue
        if (instance.asset.runtime === 'mcp') continue
        if (!includePinned && instance.asset.pinned) continue
        const idleMs = now - (instance.lastUsedAt ?? now)
        if (idleMs < Math.max(0, minIdleSec) * 1000) continue
        await this.#stop(instance.asset.id, { reason })
        stopped.push(instance.asset.id)
      }
      if (stopped.length > 0) {
        this.events.push('release', `释放空闲资源：${stopped.join('、')}`, { minIdleSec, reason })
      }
      return stopped
    })
  }

  /** 全局串行锁：生命周期操作排队执行。 */
  #withLock(fn) {
    const run = this._chain.then(fn, fn)
    this._chain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  // ================================================================== 状态
  /** 完整状态快照（工具 / Web API 共用）。 */
  async status() {
    const snapshot = await this.hardware.sample()
    const budget = this.hardware.budget(snapshot)
    const running = [...this.instances.values()].map((instance) => this.#describeInstance(instance))
    const visible = this.catalog.list({ includeHidden: false })
    const componentCount = this.catalog.list({ includeHidden: true }).length - visible.length
    const byKind = {}
    for (const asset of visible) {
      byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1
    }
    const gpuBusy = running.filter((item) => item.state !== 'stopped' && item.asset.slot === 'gpu')
    const cpuBusy = running.filter((item) => item.state !== 'stopped' && item.asset.slot === 'cpu')
    return {
      enabled: this.config.enabled !== false,
      backend: snapshot.backend,
      hardware: {
        cpu: snapshot.cpu,
        memory: snapshot.memory,
        vram: snapshot.vram,
        gpus: snapshot.gpus,
        /** 含核显：kind = integrated / discrete，schedulable 标出能否进调度。 */
        adapters: snapshot.adapters ?? [],
      },
      budget,
      budgetTable: this.budget.snapshot(budget),
      running,
      slots: {
        gpu: {
          exclusive: this.config.scheduler?.gpuExclusive !== false,
          used: gpuBusy.length,
          current: gpuBusy[0]?.id ?? null,
        },
        cpu: {
          used: cpuBusy.length,
          max: Number(this.config.scheduler?.maxCpuLoads ?? 2),
        },
      },
      queue: this.waiting,
      tasks: this.tasksSummary(),
      leases: this.leases.snapshot(),
      worker: {
        running: Boolean(this.worker?.running),
        active: this.activeStep(),
      },
      catalog: {
        total: visible.length,
        enabled: visible.filter((asset) => asset.enabled).length,
        components: componentCount,
        byKind,
      },
      /** 运行框架清单（llama.cpp / ComfyUI / Python / MCP）。 */
      frameworks: this.catalog.frameworks(),
      events: this.events.recent(12),
      ts: nowIso(),
    }
  }

  /** 后台执行环当前在跑的那一步（没有则 null）。 */
  activeStep() {
    const active = this.worker?.active ?? this.steps?.activeInfo?.() ?? null
    if (!active) return null
    return {
      taskId: active.taskId,
      stepIndex: active.stepIndex,
      startedSec:
        Number.isFinite(active.startedSec)
          ? active.startedSec
          : Math.round((Date.now() - (active.startedAt ?? Date.now())) / 1000),
      background: active.background !== false,
    }
  }

  /** 任务池概览（status / Web UI 用）。 */
  tasksSummary() {
    const all = this.tasks.list({ all: true, limit: 500 })
    const bySession = {}
    for (const task of all) {
      const key = task.sessionId ?? 'no-session'
      bySession[key] = (bySession[key] ?? 0) + 1
    }
    return {
      total: all.length,
      active: all.filter((task) => !['done', 'error', 'cancelled'].includes(task.status)).length,
      bySession,
    }
  }

  /** 给工具用的紧凑状态文本。 */
  async statusText() {
    const status = await this.status()
    const lines = []
    const mem = status.hardware.memory
    const vram = status.hardware.vram
    const cpu = status.hardware.cpu
    lines.push(
      `CPU ${cpu.cores} 核 · 负载 ${cpu.loadPct ?? '—'}% · 内存 ${fmtMb(mem.usedMb)}/${fmtMb(mem.totalMb)}（${mem.usedPct ?? '—'}%）`,
    )
    const adapters = status.hardware.adapters ?? []
    const dgpu = adapters.find((item) => item.kind === 'discrete')
    const igpu = adapters.find((item) => item.kind === 'integrated')
    if (vram.totalMb) {
      // 「已用 / 可调度 / 保留」三段分开说，避免把预留当成「显卡正在被占用」；
      // 已用里再拆出「插件自己加载的模型」，其余归系统/浏览器。
      const usable = Number(status.budget.vramUsableMb) || 0
      const used = Number(vram.usedMb) || 0
      const held = Math.max(0, (Number(vram.totalMb) || 0) - used - usable)
      const pluginVram = Math.min(used, this.budget.committed().vramMb)
      const usedText = pluginVram > 0
        ? `已用 ${fmtMb(used)}（插件模型 ${fmtMb(pluginVram)} + 系统 ${fmtMb(used - pluginVram)}）`
        : `已用 ${fmtMb(used)}（插件未占，均为系统 / 浏览器 / 驱动）`
      lines.push(
        `显存${dgpu ? `（${dgpu.name}）` : ''}${fmtMb(vram.usedMb)}/${fmtMb(vram.totalMb)}` +
          `（${usedText} · 可调度 ${fmtMb(usable)} · 保留 ${fmtMb(held)}，策略上限 ${fmtMb(status.budget.vramReservedMb)}）`,
      )
    } else {
      lines.push('显存：未探测到 NVIDIA GPU（按 GPU 互斥 + 估算策略运行）')
    }
    if (igpu) {
      lines.push(`另有核显 ${igpu.name}：共享系统内存，不参与调度（llama.cpp / ComfyUI 只用独显）`)
    }
    if (status.running.length === 0) {
      lines.push('已加载：无')
    } else {
      lines.push('已加载：')
      for (const item of status.running) {
        const vramText = item.vramMb ? ` · 实测 ${fmtMb(item.vramMb)}` : ''
        lines.push(`  - ${item.id}（${KIND_LABEL[item.asset.kind] ?? item.asset.kind}，:${item.port ?? item.asset.port}）${item.state}${vramText}`)
      }
    }
    if (status.queue > 0) lines.push(`排队中：${status.queue} 个加载请求`)
    return lines.join('\n')
  }

  #describeInstance(instance) {
    const now = Date.now()
    return {
      id: instance.asset.id,
      kind: instance.asset.kind,
      state: instance.state,
      port: instance.port ?? instance.asset.port,
      pid: instance.pid ?? null,
      adopted: instance.adopted === true,
      external: instance.external === true,
      vramMb: instance.vramMb ?? null,
      loadedForSec: instance.startedAt ? Math.round((now - instance.startedAt) / 1000) : null,
      idleForSec: instance.lastUsedAt ? Math.round((now - instance.lastUsedAt) / 1000) : null,
      error: instance.error ?? null,
      asset: {
        id: instance.asset.id,
        kind: instance.asset.kind,
        slot: instance.asset.slot,
        runtime: instance.asset.runtime,
        port: instance.port ?? instance.asset.port,
      },
    }
  }

  // ================================================================== 挑选
  /**
   * 按能力挑资产：kind / tag / 显存是否放得下 / 优先级 / 是否已加载。
   * @param {{kind?: string, tags?: string[], exclude?: string[]}} options
   */
  async pick(options = {}) {
    const snapshot = await this.hardware.sample()
    const budget = this.hardware.budget(snapshot)
    const exclude = new Set(options.exclude ?? [])
    const kinds = options.kinds ?? (options.kind ? [options.kind] : null)
    const tags = options.tags ?? []

    const scored = []
    for (const asset of this.catalog.candidates()) {
      if (exclude.has(asset.id)) continue
      if (kinds && !kinds.includes(asset.kind)) continue
      if (tags.length > 0 && !tags.some((tag) => asset.tags.includes(tag))) continue
      // 本地缺文件的资产不参与选择（避免挑中一个根本跑不起来的工作流）
      const health = await this.catalog.verify(asset)
      if (!health.ok) continue
      const instance = this.instances.get(asset.id)
      const loaded = instance?.state === 'ready'
      const need = this.#costMb(asset)
      const fits = asset.slot === 'cpu' || need === null ? (asset.slot === 'cpu' || !this.#gpuBusy(asset.id)) : need <= (budget.vramUsableMb ?? Infinity)
      let score = asset.priority
      if (loaded) score += 40 // 已经加载的直接复用，省一次冷启动
      if (fits) score += 20
      else score -= 100
      score -= (need ?? 0) / 1000
      scored.push({ asset, score, fits, loaded })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored[0] ?? null
  }

  #gpuBusy(exceptId) {
    for (const instance of this.instances.values()) {
      if (instance.asset.id === exceptId) continue
      if (instance.asset.slot !== 'gpu') continue
      if (instance.state === 'ready' || instance.state === 'starting') return true
    }
    return false
  }

  #runningVram(exceptId) {
    let total = 0
    for (const instance of this.instances.values()) {
      if (instance.asset.id === exceptId) continue
      if (!['ready', 'starting'].includes(instance.state)) continue
      total += instance.vramMb ?? instance.asset.measured.vramMb ?? instance.asset.cost.vramMb ?? 0
    }
    return total
  }

  // ================================================================== 加载
  /** 预算用显存：整组峰值 > 实测平滑值 > 估算。 */
  #costMb(asset) {
    return asset.peakVramMb ?? (asset.measured?.vramMb || null) ?? asset.cost?.vramMb ?? null
  }

  /**
   * 确保资产已加载（必要时淘汰/切换）。
   * @param {string} id
   * @param {{reason?: string, timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async ensure(id, options = {}) {
    this.waiting += 1
    try {
      if (options.signal?.aborted) throw new Error('已取消')
      return await this.#withLock(() => this.#ensure(id, options))
    } finally {
      this.waiting = Math.max(0, this.waiting - 1)
    }
  }

  async #ensure(id, { reason = '调用方请求', timeoutMs, signal, runId = null } = {}) {
    const asset = this.catalog.get(id)
    if (!asset) throw new Error(`未知资产：${id}（用 local_assets 查看可用 id）`)
    if (!asset.enabled) throw new Error(`资产已禁用：${id}`)
    if (signal?.aborted) throw new Error('已取消')
    // 本地文件不存在就别启动：早失败，别等到进程起不来才发现
    const fileCheck = await this.catalog.verify(asset)
    if (!fileCheck.ok) {
      throw new Error(`资产缺文件：${id}（${fileCheck.missing.slice(0, 4).join('、')}）—— 修正路径或删除该资产`)
    }

    const existing = this.instances.get(asset.id)
    if (existing?.state === 'ready') {
      const alive = existing.proc ? existing.proc.exitCode === null : true
      if (alive) {
        const healthy = await this.#probe({ ...asset, port: existing.port ?? asset.port })
        if (healthy.ok) {
          existing.lastUsedAt = Date.now()
          this.catalog.touch(asset.id)
          if (runId) {
            const node = this.tracker.node(runId, {
              kind: 'load',
              label: `复用 ${asset.id}`,
              detail: `已加载 · :${existing.port ?? asset.port}`,
              status: 'done',
            })
            if (node) this.tracker.updateNode(runId, node.id, { endedAt: Date.now() })
          }
          return this.#describeInstance(existing)
        }
      }
      await this.#stop(id, { reason: '健康检查失败，重新加载' })
    } else if (existing) {
      await this.#stop(id, { reason: '清理陈旧实例' })
    }

    // 共享服务的资产（多套 ComfyUI 工作流共用 comfyui）：先确保服务，再挂一个「就绪标记」
    if (asset.serviceId && asset.serviceId !== asset.id) {
      const service = this.catalog.get(asset.serviceId)
      if (!service) throw new Error(`资产 ${asset.id} 依赖的服务 ${asset.serviceId} 不存在`)
      // 关键：这里必须走内部 #ensure——#ensure 已经持有全局锁，
      // 再调公开的 ensure() 会等待自己持有的锁，直接死锁（实测踩坑）。
      const svc = await this.#ensure(service.id, { reason: `${asset.id} 依赖 ${service.id}`, signal, runId })
      const instance = {
        asset,
        port: svc.port ?? service.port,
        state: 'ready',
        pid: null,
        proc: null,
        adopted: true,
        external: true,
        serviceId: service.id,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        vramMb: 0,
      }
      this.instances.set(asset.id, instance)
      if (runId) {
        const node = this.tracker.node(runId, {
          kind: 'comfy',
          label: `工作流 · ${asset.id}`,
          detail: `复用 ${service.id} · :${instance.port}`,
          status: 'done',
        })
        if (node) this.tracker.updateNode(runId, node.id, { endedAt: Date.now() })
      }
      return this.#describeInstance(instance)
    }

    // 通用依赖：requires 里 role=framework 的资产必须先加载（如自研服务依赖 comfyui）
    const frameworkDeps = (asset.requires ?? []).filter(
      (dep) => dep.role === 'framework' && dep.asset && dep.asset !== asset.id && dep.asset !== asset.serviceId,
    )
    for (const dep of frameworkDeps) {
      if (!this.catalog.get(dep.asset)) {
        this.events.push('deps:missing', `${asset.id} 依赖的框架 ${dep.asset} 不存在，已跳过`)
        continue
      }
      await this.#ensure(dep.asset, { reason: `${asset.id} 依赖框架 ${dep.asset}`, signal, runId })
    }

    // MCP 服务由 DSH 自己的 MCP 客户端管理：这里不拉进程，只标记为可用，
    // 让调度器知道它占 CPU、零显存，并在 UI 里能看到。
    if (asset.runtime === 'mcp') {
      const instance = {
        asset,
        port: asset.port || 0,
        state: 'ready',
        pid: null,
        proc: null,
        adopted: true,
        external: true,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        vramMb: 0,
      }
      this.instances.set(asset.id, instance)
      if (runId) {
        const node = this.tracker.node(runId, { kind: 'mcp', label: `MCP · ${asset.id}`, detail: '外部服务（DSH 托管）' })
        if (node) this.tracker.finishNode(runId, node.id, 'done', '就绪')
      }
      this.events.push('mcp:ready', `${asset.id} 是外部 MCP 服务，已标记为可用`)
      this.refreshBriefing().catch(() => {})
      return this.#describeInstance(instance)
    }

    // 选择实际监听端口：优先资产端口。Windows 动态端口范围从 1024 起，
    // 8080 这类常用端口可能被别的程序当临时端口占住（bind 返回 EACCES），
    // 此时允许退回到系统分配的空闲端口，保证任务能跑起来。
    const autoPort = this.config.scheduler?.autoPort !== false
    let currentPort = asset.port
    if (await portAlive(currentPort, asset.host)) {
      const probe = await this.#probe({ ...asset, port: currentPort })
      const expected = asset.health.alias || asset.id
      if (probe.ok && (probe.model === expected || probe.model === undefined)) {
        return this.#adopt(asset, probe, reason)
      }
      if (!autoPort) {
        throw new Error(
          `端口 :${currentPort} 已被其它服务占用（当前模型：${probe.model ?? '未知'}，期望：${expected}）。` +
            `请先 local_service stop ${id}，或在 catalog 里改端口。`,
        )
      }
      currentPort = await findFreePort(asset.host)
      this.events.push('port:fallback', `${asset.id} 改用空闲端口 :${currentPort}`, { preferred: asset.port })
    }

    await this.#makeRoom(asset)

    // 按当前预算自动调参（读 GGUF 元数据算 KV，再挑 ctx / ngl / KV 量化）。
    const budgetSample = await this.hardware.sample({ force: true })
    const budget = this.hardware.budget(budgetSample)
    let launch = await this.#autoTune(asset, { budget })
    const tunedNote = launch?.tuned?.changed ? launch.tuned.notes.join('；') : ''

    const logFile = await this.#logFile(asset.id)
    const startedAt = Date.now()
    // 框图节点：一次加载 = 一个节点（重试只更新 detail，不重复加节点）
    const loadNode = runId
      ? this.tracker.node(runId, {
          kind: 'load',
          label: `加载 ${asset.id}`,
          detail: `${KIND_LABEL[asset.kind] ?? asset.kind} · :${currentPort}${tunedNote ? ` · ${tunedNote}` : ''}`,
        })
      : null

    // 启动失败重试：端口被临时占用 / 上一份权重还没完全释放时，
    // llama-server 会立刻退出。退避重试并换端口，而不是直接判死。
    let instance = null
    let health = null
    let plan = null
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        this.events.push('load:retry', `${asset.id} 第 ${attempt} 次尝试加载`, { error: health?.error })
        await sleep(3000 * (attempt - 1))
      }

      const runtimeAsset = { ...asset, launch, port: currentPort }
      plan = this.#planCommand(runtimeAsset)
      if (plan.missing.length > 0) {
        if (loadNode) this.tracker.finishNode(runId, loadNode.id, 'error', plan.missing.join('；'))
        throw new Error(`无法启动 ${asset.id}：${plan.missing.join('；')}`)
      }

      const beforeSample = await this.hardware.sample({ force: true })
      this.events.push('load:start', `加载 ${asset.id}（${KIND_LABEL[asset.kind] ?? asset.kind}）`, {
        reason,
        port: currentPort,
        attempt,
        command: `${plan.exe} ${plan.args.join(' ')}`.slice(0, 500),
      })

      instance = {
        asset,
        port: currentPort,
        state: 'starting',
        pid: null,
        proc: null,
        startedAt,
        lastUsedAt: startedAt,
        vramMb: null,
      }
      this.instances.set(asset.id, instance)

      const proc = await spawnManaged({
        exe: plan.exe,
        args: plan.args,
        cwd: plan.cwd,
        env: launch.extraEnv,
        logFile,
        onExit: (code, signalName) => {
          const current = this.instances.get(asset.id)
          if (current !== instance) return
          if (current.state === 'stopping' || current.state === 'stopped') return
          current.state = 'failed'
          current.error = `进程退出（code=${code ?? 'null'}, signal=${signalName ?? 'null'}）`
          this.events.push('load:failed', `${asset.id} 进程退出`, { code, signal: signalName, log: logFile })
        },
      })
      instance.proc = proc
      instance.pid = proc.pid ?? null
      instance.beforeUsedMb = beforeSample?.vram?.usedMb ?? null

      health = await waitHealthy({
        probe: () => this.#probe(runtimeAsset),
        timeoutMs: timeoutMs ?? (asset.health.timeoutMs > 0 ? asset.health.timeoutMs : Number(this.config.scheduler?.loadTimeoutMs ?? 600000)),
        exited: () => proc.exitCode !== null,
        signal,
      })
      if (health.ok) break

      await killTree(proc.pid, { timeoutMs: Number(this.config.scheduler?.stopTimeoutMs ?? 20000) })
      this.instances.delete(asset.id)
      const earlyExit = proc.exitCode !== null && Date.now() - startedAt < 8000
      if (!(earlyExit && attempt < attempts)) break
      if (autoPort) {
        const nextPort = await findFreePort(asset.host)
        if (nextPort !== currentPort) {
          this.events.push('port:fallback', `${asset.id} 下次尝试改用 :${nextPort}（原 :${currentPort} 不可用）`)
          currentPort = nextPort
        }
      }
      // 也可能是显存不够导致 OOM：下一轮把上下文减半（下限 2048）
      if (asset.runtime === 'llama.cpp' && this.config.scheduler?.autoTune !== false) {
        const currentCtx = Number(launch.ctx ?? 8192)
        if (currentCtx > 2048) {
          const nextCtx = Math.max(2048, Math.floor(currentCtx / 2))
          launch = { ...launch, ctx: nextCtx, kvType: launch.kvType || 'q8_0' }
          this.events.push('tune:retry', `${asset.id} 加载失败，下一轮 ctx ${currentCtx} → ${nextCtx}`)
        }
      }
    }
    if (!health?.ok || !instance) {
      this.events.push('load:failed', `${asset.id} 加载失败：${health?.error ?? '未知错误'}`, { log: logFile })
      if (loadNode) this.tracker.finishNode(runId, loadNode.id, 'error', health?.error ?? '未知错误')
      throw new Error(`${asset.id} 加载失败：${health?.error ?? '未知错误'}（日志：${logFile}）`)
    }

    // 实测显存：优先从 llama-server 日志里的 buffer size 精确相加（Windows 最可靠），
    // 其次按进程查 nvidia-smi（Linux），最后退化成「加载前后总占用之差」。
    await sleep(1200)
    const snapshot = await this.hardware.sample({ force: true })
    let vramMb = asset.runtime === 'llama.cpp' ? await llama.measureFromLog(logFile) : null
    if (vramMb === null) vramMb = Hardware.appVram(snapshot, instance.pid)
    if (vramMb === null && instance.beforeUsedMb != null && snapshot?.vram?.usedMb != null) {
      const delta = snapshot.vram.usedMb - instance.beforeUsedMb
      if (delta >= 200) vramMb = delta
    }
    instance.vramMb = vramMb
    instance.state = 'ready'
    instance.lastUsedAt = Date.now()
    const loadMs = Date.now() - startedAt
    this.catalog.noteLoad(asset.id, { vramMb, loadMs }).catch(() => {})
    // 预算表登记：进程退出的地方（#stop）对称释放
    this.budget.closeByAsset(asset.id, '重新登记')
    instance.budgetId = this.budget.open({
      source: sourceOf(asset),
      assetId: asset.id,
      vramMb: instance.vramMb ?? this.#costMb(asset) ?? 0,
      ramMb: asset.cost?.ramMb ?? 0,
      note: reason,
    }).id

    this.events.push('load:ready', `${asset.id} 就绪（${Math.round(loadMs / 1000)}s${vramMb ? `，显存 ${fmtMb(vramMb)}` : ''}）`, {
      port: instance.port ?? asset.port,
      vramMb,
      loadMs,
    })
    if (loadNode) {
      this.tracker.finishNode(
        runId,
        loadNode.id,
        'done',
        `:${instance.port ?? asset.port} · ${Math.round(loadMs / 1000)}s${vramMb ? ` · ${fmtMb(vramMb)}` : ''}`,
      )
    }
    this.refreshBriefing().catch(() => {})
    return this.#describeInstance(instance)
  }

  /** 接管一个已在运行的同类服务。 */
  #adopt(asset, probe, reason) {
    const instance = {
      asset,
      port: asset.port,
      state: 'ready',
      pid: null,
      proc: null,
      adopted: true,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      vramMb: (asset.measured.vramMb || null) ?? asset.cost.vramMb ?? null,
    }
    this.instances.set(asset.id, instance)
    instance.budgetId = this.budget.open({
      source: sourceOf(asset),
      assetId: asset.id,
      vramMb: instance.vramMb ?? this.#costMb(asset) ?? 0,
      ramMb: asset.cost?.ramMb ?? 0,
      note: `接管：${reason}`,
    }).id
    findPidByPort(asset.port).then((pid) => {
      instance.pid = pid
    }).catch(() => {})
    this.events.push('load:adopt', `接管已在运行的服务 ${asset.id}（:${asset.port}）`, { reason, model: probe?.model })
    return this.#describeInstance(instance)
  }

  /** 腾地方：GPU 互斥 / 显存预算 / LRU 淘汰。 */
  async #makeRoom(asset) {
    const exclusive = this.config.scheduler?.gpuExclusive !== false
    if (exclusive && asset.slot === 'gpu') {
      for (const instance of [...this.instances.values()]) {
        if (instance.asset.slot !== 'gpu') continue
        if (instance.asset.id === asset.id) continue
        if (!['ready', 'starting'].includes(instance.state)) continue
        await this.#stop(instance.asset.id, { reason: `GPU 槽互斥，切换给 ${asset.id}` })
      }
    }

    const snapshot = await this.hardware.sample({ force: true })
    const budget = this.hardware.budget(snapshot)
    const need = this.#costMb(asset)
    if (asset.slot !== 'gpu' || need === null || budget.vramUsableMb === null) return
    if (need <= budget.vramUsableMb) return

    // 显存不够：按「未固定 → 优先级低 → 最久未用」淘汰
    const victims = [...this.instances.values()]
      .filter((instance) => instance.asset.id !== asset.id)
      .filter((instance) => ['ready', 'starting'].includes(instance.state))
      .filter((instance) => !instance.asset.pinned)
      .sort((a, b) => {
        if (a.asset.priority !== b.asset.priority) return a.asset.priority - b.asset.priority
        return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
      })

    let free = budget.vramUsableMb
    for (const victim of victims) {
      if (free >= need) break
      const freed = victim.vramMb ?? victim.asset.measured.vramMb ?? victim.asset.cost.vramMb ?? 0
      await this.#stop(victim.asset.id, { reason: `为 ${asset.id} 腾显存（需要 ${fmtMb(need)}）` })
      free += freed
    }
    if (free < need) {
      throw new Error(
        `显存不足：${asset.id} 预计需要 ${fmtMb(need)}，当前可用 ${fmtMb(budget.vramUsableMb)}。` +
          `可以调小 ctx / 关闭其它服务，或在 catalog 里把该资产标为 pinned=false 让它参与淘汰。`,
      )
    }
  }

  // ================================================================== 卸载
  /** 停止资产（或全部）。 */
  async stop(id, options = {}) {
    return this.#withLock(() => this.#stop(id, options))
  }

  async stopAll(options = {}) {
    return this.#withLock(async () => {
      const results = []
      for (const instance of [...this.instances.values()]) {
        results.push(await this.#stop(instance.asset.id, options))
      }
      return results
    })
  }

  async #stop(id, { reason = '调用方请求', timeoutMs } = {}) {
    const instance = this.instances.get(id)
    if (!instance) return { ok: true, id, message: '本就不在运行' }
    const startedAt = Date.now()
    // MCP 是外部服务：只取消资源标记，不去杀 DSH 管的进程
    if (instance.asset.runtime === 'mcp') {
      this.instances.delete(id)
      this.events.push('mcp:unmark', `${id} 取消 MCP 资源标记`, { reason })
      return { ok: true, id, message: `已移除 ${id} 的资源标记` }
    }
    // 共享服务的标记：只删标记，服务本身由 release/服务卸载处理
    if (instance.asset.serviceId) {
      this.instances.delete(id)
      return { ok: true, id, message: `已移除 ${id} 的工作流标记` }
    }
    instance.state = 'stopping'
    this.events.push('unload:start', `卸载 ${id}`, { reason })

    let pid = instance.pid
    if (!pid && instance.adopted) pid = await findPidByPort(instance.port ?? instance.asset.port)
    // 卸载前记一次总占用：kill 之后按「降了多少」判断显存是否真的回收
    const vramBefore = (await this.hardware.sample({ force: true }).catch(() => null))?.vram?.usedMb ?? null
    if (pid) {
      await killTree(pid, { timeoutMs: timeoutMs ?? Number(this.config.scheduler?.stopTimeoutMs ?? 20000) })
    }
    // 等端口释放，避免立刻重载时撞上「端口占用」
    for (let i = 0; i < 20; i += 1) {
      if (!(await portAlive(instance.port ?? instance.asset.port, instance.asset.host))) break
      await sleep(300)
    }
    // 等显存回落：WDDM 下进程退出到显存归还有延迟，不等待就起下一个模型容易 OOM
    if (instance.asset.slot === 'gpu' && (instance.vramMb ?? 0) > 512 && vramBefore != null) {
      await this.#waitVramRelease(vramBefore, instance.vramMb ?? 0)
    }
    this.budget.closeByAsset(id, reason)
    this.instances.delete(id)
    this.events.push('unload:done', `已卸载 ${id}（${Math.round((Date.now() - startedAt) / 1000)}s）`, { reason })
    this.refreshBriefing().catch(() => {})
    return { ok: true, id, killedPid: pid ?? null, message: `已卸载 ${id}` }
  }

  /** 显存回落等待：至少释放 60% 预期占用，或超时 8s 放行。 */
  async #waitVramRelease(beforeMb, expectedMb, timeoutMs = 8000) {
    if (this.config.scheduler?.waitVramRelease === false) return
    const target = beforeMb - Math.round(expectedMb * 0.6)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const used = (await this.hardware.sample({ force: true }).catch(() => null))?.vram?.usedMb ?? null
      if (used == null) return
      if (used <= target) return
      await sleep(500)
    }
    this.events.push('unload:vram-wait', `显存 ${fmtMb(beforeMb)} → 目标 ${fmtMb(target)} 未在 ${timeoutMs}ms 内回落`, {
      beforeMb,
      expectedMb,
    })
  }

  /** 空闲回收：超时未使用的资产自动卸载；顺带清理已退出进程的实例。 */
  async reapIdle() {
    return this.#withLock(async () => {
      const now = Date.now()
      const stopped = []
      for (const instance of [...this.instances.values()]) {
        if (instance.proc && instance.proc.exitCode !== null && instance.state === 'ready') {
          this.instances.delete(instance.asset.id)
          this.events.push('reap', `${instance.asset.id} 进程已退出，清理记录`)
          continue
        }
        if (instance.state !== 'ready') continue
        if (instance.asset.pinned) continue
        const limitSec = instance.asset.idleUnloadSec ?? Number(this.config.scheduler?.idleUnloadSec ?? 0)
        if (!limitSec || limitSec <= 0) continue
        if (now - (instance.lastUsedAt ?? now) < limitSec * 1000) continue
        await this.#stop(instance.asset.id, { reason: `空闲超过 ${limitSec}s 自动卸载` })
        stopped.push(instance.asset.id)
      }
      return stopped
    })
  }

  // ================================================================== 执行
  /** 实际端点：端口可能因占用回退过，一律以实例为准。 */
  #endpoint(id) {
    const asset = this.catalog.get(id)
    const instance = this.instances.get(id)
    return { ...asset, port: instance?.port ?? asset.port }
  }

  /** 在资产上跑一次对话（自动加载）。 */
  async runChat(id, options = {}) {
    const runId = options.runId ?? null
    const instance = await this.ensure(id, {
      reason: options.reason ?? '对话调用',
      signal: options.signal,
      runId,
    })
    // 推理节点在加载节点之后创建，保证框图顺序是「先加载、再推理」
    const node = runId
      ? this.tracker.node(runId, { kind: 'local-llm', label: `本地推理 · ${id}`, detail: options.label ?? '' })
      : null
    if (node) {
      this.tracker.record({
        runId,
        nodeId: node.id,
        channel: 'local',
        kind: 'request',
        title: `${id} 输入`,
        content: formatMessages(options.messages, options.system),
        meta: { asset: id, temperature: options.temperature, maxTokens: options.maxTokens },
      })
    }
    const asset = this.#endpoint(id)
    const started = Date.now()
    const reply = await llama.chat(asset, options)
    this.#touch(id, reply.ok)
    if (!reply.ok) {
      this.stats.record({
        assetId: id,
        usage: reply.usage,
        ms: Date.now() - started,
        ok: false,
        ctx: asset.launch?.ctx ?? null,
        sessionId: runId ? this.tracker.get(runId)?.sessionId ?? null : null,
      })
      this.events.push('run:failed', `${id} 对话失败：${reply.error}`)
      if (node) {
        this.tracker.record({
          runId,
          nodeId: node.id,
          channel: 'local',
          kind: 'error',
          title: `${id} 失败`,
          content: reply.error,
        })
        this.tracker.finishNode(runId, node.id, 'error', reply.error)
      }
      return { ...reply, assetId: id, ms: Date.now() - started }
    }
    const ms = Date.now() - started
    this.stats.record({
      assetId: id,
      usage: reply.usage,
      ms,
      ok: true,
      ctx: asset.launch?.ctx ?? null,
      sessionId: runId ? this.tracker.get(runId)?.sessionId ?? null : null,
    })
    this.events.push('run:done', `${id} 对话完成（${ms}ms）`, {
      tokens: reply.usage?.total_tokens ?? null,
    })
    if (node) {
      this.tracker.record({
        runId,
        nodeId: node.id,
        channel: 'local',
        kind: 'response',
        title: `${id} 输出`,
        content: reply.content || reply.reasoning || '(空)',
        meta: { tokens: reply.usage?.total_tokens ?? null, ms },
      })
      this.tracker.finishNode(
        runId,
        node.id,
        'done',
        `${(ms / 1000).toFixed(1)}s${reply.usage?.total_tokens ? ` · ${reply.usage.total_tokens} tokens` : ''}`,
      )
    }
    return {
      ...reply,
      assetId: id,
      instance,
      ms,
    }
  }

  /** 向量化。 */
  async runEmbed(id, input, options = {}) {
    await this.ensure(id, { reason: 'embedding 调用', signal: options.signal, runId: options.runId })
    const asset = this.#endpoint(id)
    const result = await llama.embed(asset, input, options)
    this.#touch(id, result.ok)
    return { ...result, assetId: id }
  }

  /** 重排。 */
  async runRerank(id, options = {}) {
    await this.ensure(id, { reason: 'rerank 调用', signal: options.signal, runId: options.runId })
    const asset = this.#endpoint(id)
    const result = await llama.rerank(asset, options)
    this.#touch(id, result.ok)
    return { ...result, assetId: id }
  }

  /** ComfyUI 生成。id 可以是 comfyui 服务，也可以是某个工作流资产。 */
  async runComfy(id, options = {}) {
    const runId = options.runId ?? null
    const assetMeta = this.catalog.get(id)
    let workflow = options.workflow ?? null
    if (!workflow && assetMeta?.workflow) {
      const resolved = await resolveWorkflow(this.config, {
        workflowName: assetMeta.workflow,
        params: options.params ?? {},
      })
      if (!resolved.ok) return { ok: false, error: resolved.error, assetId: id }
      workflow = resolved.workflow
    }
    if (!workflow) return { ok: false, error: '未提供工作流（workflow / workflowName / 资产自带 workflow）', assetId: id }

    const node = runId
      ? this.tracker.node(runId, { kind: 'comfy', label: `ComfyUI · ${id}`, detail: '提交工作流' })
      : null
    if (node) {
      this.tracker.record({
        runId,
        nodeId: node.id,
        channel: 'mcp',
        kind: 'request',
        title: `ComfyUI 工作流 · ${id}`,
        content: JSON.stringify(workflow).slice(0, 1600),
      })
    }
    await this.ensure(id, { reason: 'ComfyUI 生成', signal: options.signal, runId })
    const asset = this.#endpoint(id)
    // 工作流里的模型文件名按 ComfyUI 当前目录结构自动校正（等价 comfy_client 的 --check-names）
    const fixed = await comfy.fixWorkflowNames(asset, workflow).catch(() => ({ workflow, fixes: [] }))
    workflow = fixed.workflow ?? workflow
    if (fixed.fixes?.length) {
      this.events.push('comfy:names', `${id} 校正 ${fixed.fixes.length} 个模型名`, { fixes: fixed.fixes })
      if (node) {
        this.tracker.record({
          runId,
          nodeId: node.id,
          channel: 'mcp',
          kind: 'response',
          title: '模型名自动校正',
          content: fixed.fixes.map((fix) => `${fix.key}: ${fix.from} → ${fix.to}`).join('\n'),
        })
      }
    }
    const result = await comfy.generate(asset, { ...options, workflow })
    this.#touch(id, result.ok)
    if (node) {
      this.tracker.record({
        runId,
        nodeId: node.id,
        channel: 'mcp',
        kind: result.ok ? 'response' : 'error',
        title: result.ok ? 'ComfyUI 产物' : 'ComfyUI 失败',
        content: result.ok ? result.files.map((file) => file.url).join('\n') : result.error,
      })
      this.tracker.finishNode(runId, node.id, result.ok ? 'done' : 'error', `${(result.ms / 1000).toFixed(1)}s`)
    }
    return { ...result, assetId: id }
  }

  /** 停掉所有 GPU 槽实例（脚本类任务需要整块显存）。 */
  async stopGpu({ reason = '释放 GPU 槽' } = {}) {
    return this.#withLock(async () => {
      const stopped = []
      for (const instance of [...this.instances.values()]) {
        if (instance.asset.slot !== 'gpu') continue
        if (!['ready', 'starting'].includes(instance.state)) continue
        await this.#stop(instance.asset.id, { reason })
        stopped.push(instance.asset.id)
      }
      return stopped
    })
  }

  /**
   * 运行一次性脚本资产（TTS / ASR / 音乐质检）。
   * 输出写日志文件，返回尾部文本；运行前释放 GPU 槽，避免和模型抢显存。
   */
  async runScript(id, { args = [], timeoutMs = 900000, signal, runId = null } = {}) {
    const asset = this.catalog.get(id)
    if (!asset) throw new Error(`未知资产：${id}`)
    if (asset.runtime !== 'script' || !asset.script?.file) throw new Error(`${id} 不是一次性脚本资产`)
    if (!(await fsp.stat(asset.script.file).then(() => true).catch(() => false))) {
      throw new Error(`脚本不存在：${asset.script.file}`)
    }
    await this.stopGpu({ reason: `运行脚本 ${id}` })
    // 脚本也进同一张预算表：RAM 直接记，显存按资产画像记（torch 可能仍会占）
    const budgetEntry = this.budget.open({
      source: 'script',
      assetId: id,
      vramMb: asset.cost?.vramMb ?? 0,
      ramMb: asset.cost?.ramMb ?? 0,
      note: `脚本运行 ${id}`,
    })

    const python = this.config.paths?.pythonPath || 'python'
    const cliArgs = [asset.script.file, ...(asset.script.args ?? []), ...args]
    const logFile = await this.#logFile(id)
    const node = runId
      ? this.tracker.node(runId, { kind: 'mcp', label: `脚本 · ${asset.name}`, detail: cliArgs.slice(1).join(' ').slice(0, 80) })
      : null
    if (node) {
      this.tracker.record({
        runId,
        nodeId: node.id,
        channel: 'mcp',
        kind: 'request',
        title: `${asset.name} 输入`,
        content: `${python} ${cliArgs.join(' ')}`,
      })
    }
    await fsp.mkdir(path.dirname(logFile), { recursive: true })
    const started = Date.now()
    let code = -1
    try {
      const handle = await fsp.open(logFile, 'a')
      await handle.write(`\n===== ${nowIso()} 运行 ${id} =====\n`)
      const child = spawn(python, cliArgs, {
        cwd: path.dirname(asset.script.file),
        windowsHide: true,
        env: { ...process.env, ...PYTHON_UTF8_ENV, ...(asset.script?.env ?? {}) },
        stdio: ['ignore', handle.fd, handle.fd],
      })
      const timeout = Number(timeoutMs) > 0
        ? setTimeout(() => {
            killTree(child.pid, { timeoutMs: 10000 }).catch(() => {})
          }, Number(timeoutMs))
        : null
      code = await new Promise((resolve) => {
        child.on('exit', (exitCode) => resolve(exitCode ?? -1))
        child.on('error', () => resolve(-1))
        signal?.addEventListener?.('abort', () => killTree(child.pid, { timeoutMs: 5000 }).catch(() => {}), { once: true })
      })
      if (timeout) clearTimeout(timeout)
      await handle.close().catch(() => {})
    } finally {
      this.budget.close(budgetEntry.id, '脚本结束')
    }
    const ms = Date.now() - started
    let output = ''
    try {
      const text = await fsp.readFile(logFile, 'utf8')
      output = text.split('=====').pop().trim().slice(-6000)
    } catch {
      output = ''
    }
    const ok = code === 0
    if (node) {
      this.tracker.record({
        runId,
        nodeId: node.id,
        channel: 'mcp',
        kind: ok ? 'response' : 'error',
        title: ok ? `${asset.name} 输出` : `${asset.name} 失败`,
        content: output || `exit ${code}`,
      })
      this.tracker.finishNode(runId, node.id, ok ? 'done' : 'error', `${(ms / 1000).toFixed(1)}s`)
    }
    this.events.push(ok ? 'script:done' : 'script:failed', `${asset.name} 运行${ok ? '完成' : '失败'}（${(ms / 1000).toFixed(1)}s）`, {
      code,
      log: logFile,
    })
    return { ok, code, ms, output, logFile, assetId: id }
  }

  #touch(id, ok) {
    const instance = this.instances.get(id)
    if (instance) instance.lastUsedAt = Date.now()
    if (ok) this.catalog.noteLoad(id, { ran: true }).catch(() => {})
  }

  // ================================================================== 内部
  /** 文件体积（MB），失败返回 0。 */
  async #fileSizeMb(file) {
    if (!file) return 0
    try {
      return Math.round((await fsp.stat(file)).size / 1024 / 1024)
    } catch {
      return 0
    }
  }

  /**
   * 自动调参：读 GGUF 元数据算 KV，按可用显存挑 ctx / ngl / KV 量化。
   * 结果只影响本次加载，不写回 catalog（registry 里的推荐值保持原样）。
   */
  async #autoTune(asset, { budget } = {}) {
    const launch = { ...asset.launch }
    if (this.config.scheduler?.autoTune === false) return launch
    if (asset.runtime !== 'llama.cpp') return launch
    const ggufPath = llama.resolveModelPath(this.config, asset.launch.gguf)
    if (!ggufPath) return launch

    this._ggufCache ??= new Map()
    let info = this._ggufCache.get(ggufPath)
    if (!info) {
      const meta = await readGgufMeta(ggufPath)
      const summary = meta ? summarize(meta) : null
      const fileSizeMb = meta?.fileSizeMb || (await this.#fileSizeMb(ggufPath))
      info = { summary, fileSizeMb }
      this._ggufCache.set(ggufPath, info)
    }
    if (!info.summary || !info.summary.blockCount) return launch

    const mmprojMb = await this.#fileSizeMb(llama.resolveModelPath(this.config, asset.launch.mmproj))
    const plan = planLlamaParams({
      launch,
      fileSizeMb: info.fileSizeMb,
      summary: info.summary,
      usableVramMb: budget?.vramUsableMb ?? null,
      mmprojMb,
    })
    launch.ctx = plan.ctx
    launch.ngl = plan.ngl
    launch.kvType = plan.kvType
    launch.tuned = plan
    if (plan.changed) {
      this.events.push('tune', `${asset.id} 自动调参：${plan.notes.join('；')}`, {
        ctx: plan.ctx,
        ngl: plan.ngl,
        kvType: plan.kvType,
        estimatedVramMb: plan.estimatedVramMb,
        usableVramMb: budget?.vramUsableMb ?? null,
      })
    }
    return launch
  }

  #planCommand(asset) {
    if (asset.runtime === 'llama.cpp') return llama.buildCommand(asset, this.config)
    if (asset.runtime === 'comfyui') return comfy.buildCommand(asset, this.config)
    if (asset.runtime === 'process') {
      const command = asset.launch.command ?? []
      if (command.length === 0) return { exe: asset.launch.exe ?? '', args: [], cwd: asset.launch.cwd, missing: ['launch.command 为空'] }
      return {
        exe: asset.launch.exe ?? command[0],
        args: asset.launch.exe ? command : command.slice(1),
        cwd: asset.launch.cwd ?? undefined,
        missing: [],
      }
    }
    return { exe: '', args: [], cwd: undefined, missing: [`运行时 ${asset.runtime} 不支持加载`] }
  }

  async #probe(asset) {
    if (asset.runtime === 'llama.cpp') return llama.probe(asset)
    if (asset.runtime === 'comfyui') return comfy.probe(asset)
    // 通用进程：有 health.path 就探 HTTP，否则只看端口
    const pathName = asset.health.path || '/'
    if (pathName === '/' && asset.runtime === 'process') {
      const alive = await portAlive(asset.port, asset.host)
      return alive ? { ok: true } : { ok: false, error: '端口未监听' }
    }
    const result = await fetchJson(`http://${asset.host}:${asset.port}${pathName}`, { timeoutMs: 2500 })
    return result.ok ? { ok: true, body: result.body } : { ok: false, error: result.error }
  }

  async #logFile(id) {
    const path = await import('node:path')
    const fsp = await import('node:fs/promises')
    await fsp.mkdir(this.config.logDir, { recursive: true })
    return path.join(this.config.logDir, `${String(id).replace(/[^\w.-]+/g, '_')}.log`)
  }

  /** 刷新系统提示简报缓存（生命周期变化后调用）。 */
  async refreshBriefing() {
    try {
      this.cachedBriefing = await this.briefing()
    } catch {
      this.cachedBriefing = ''
    }
    return this.cachedBriefing
  }

  /** 系统提示用的资源简报（动态、短）。 */
  async briefing() {
    const status = await this.status()
    const enabled = this.catalog.list({ enabledOnly: true })
    const max = Number(this.config.prompt?.maxAssets ?? 8)
    const lines = []
    const vram = status.hardware.vram
    lines.push(
      `本地资源：CPU ${status.hardware.cpu.cores} 核 / 内存 ${fmtMb(status.hardware.memory.totalMb)}` +
        (vram.totalMb ? ` / 显存 ${fmtMb(vram.totalMb)}（当前空闲 ${fmtMb(vram.freeMb)}）` : ' / 未探测到 NVIDIA GPU'),
    )
    if (status.running.length > 0) {
      lines.push(`已加载：${status.running.map((item) => `${item.id}(${item.state})`).join('、')}`)
    }
    if (enabled.length > 0) {
      const items = enabled
        .filter((asset) => asset.runtime !== 'workflow' && asset.category !== 'mcp')
        .slice(0, max)
        .map((asset) => {
          const cost = (asset.measured.vramMb || null) ?? asset.cost.vramMb
          return `${asset.id}（${KIND_LABEL[asset.kind] ?? asset.kind}${cost ? `，约 ${fmtMb(cost)} 显存` : ''}）`
        })
      if (items.length > 0) lines.push(`可调度资产：${items.join('；')}`)
    }
    const workflows = enabled.filter((asset) => asset.runtime === 'workflow')
    if (workflows.length > 0) {
      lines.push(
        `生成工作流（local_generate 会按需求自动选）：${workflows
          .map((asset) => `${asset.id}（${asset.strengths || asset.task}）`)
          .join('；')}`,
      )
    }
    const mcp = enabled.filter((asset) => asset.category === 'mcp')
    if (mcp.length > 0) {
      lines.push(`MCP 工具：${mcp.map((asset) => `${asset.id}（${asset.strengths || asset.task}）`).join('；')}`)
    }
    return lines.join('\n')
  }

  /** 资产清单（含运行态与预算判断）。默认不列配套组件（编码器/VAE/声码器…）。 */
  async assets(filter = {}) {
    const snapshot = await this.hardware.sample()
    const budget = this.hardware.budget(snapshot)
    const rows = []
    for (const asset of this.catalog.list({ includeHidden: filter.includeHidden === true })) {
      if (filter.kind && asset.kind !== filter.kind) continue
      if (filter.enabledOnly && !asset.enabled) continue
      const instance = this.instances.get(asset.id)
      const need = this.#costMb(asset)
      const check = await this.catalog.verify(asset)
      // 组件带上「本地是否存在」，UI 能直接把缺失的标红
      const components = (asset.components ?? []).map((component, index) => ({
        ...component,
        exists: check.components?.[index]?.exists !== false,
        path: check.components?.[index]?.path ?? component.file ?? null,
      }))
      rows.push({
        ...publicAsset(asset, instance ? this.#describeInstance(instance) : null),
        components,
        port: instance?.port ?? asset.port,
        fitsVram: asset.slot === 'cpu' || need === null ? null : need <= (budget.vramUsableMb ?? Infinity),
        /** 连通性：本地文件/可执行文件是否都在。 */
        healthy: check.ok,
        missing: check.missing,
      })
    }
    return rows
  }

  /** 只返回「本地文件齐全」的资产（给路由器自动挑工作流用）。 */
  async usableAssets(filter = {}) {
    const rows = await this.assets(filter)
    return rows.filter((row) => row.healthy !== false)
  }
}
