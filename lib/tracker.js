/**
 * 任务与 IO 轨迹：给 Web UI 提供「框图 + 实时进度 + 输入输出」的数据面。
 *
 * 一个 run = 一次由决策模型/用户发起的本地调度任务：
 *   - chat：单次本地对话
 *   - delegate：决策模型拆解 + 多步执行
 *   - service：加载/卸载/重启
 *
 * run.nodes 是有顺序的执行节点（决策模型、加载、本地推理、MCP…），
 * 每个节点记录状态与耗时，供前端画框图与进度条。
 * io 是分通道的原始输入输出（decision / local / mcp / system），
 * 前端按通道分栏展示，避免混在一起看不出是谁说了什么。
 *
 * 内存环形缓冲即可：这是实时监控，不做长期审计（审计在 events.jsonl）。
 */
import { nowIso, clip } from './util.js'

let counter = 0

function nextId(prefix) {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** 单条 IO 记录。 */
function makeIo({ runId, nodeId, channel, kind, title, content, meta }) {
  return {
    id: nextId('io'),
    ts: nowIso(),
    runId: runId ?? null,
    nodeId: nodeId ?? null,
    channel,
    kind,
    title: String(title ?? ''),
    content: clip(content, 4000),
    meta: meta ?? null,
  }
}

export class Tracker {
  /**
   * @param {{runLimit?: number, ioLimit?: number}} [options]
   */
  constructor({ runLimit = 40, ioLimit = 300 } = {}) {
    this.runLimit = runLimit
    this.ioLimit = ioLimit
    /** @type {Map<string, object>} */
    this.runs = new Map()
    /** @type {object[]} */
    this.io = []
    this.listeners = new Set()
  }

  /** 订阅变更（SSE 或测试用）。 */
  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  #emit() {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        /* 监听器异常不影响调度 */
      }
    }
  }

  /** 开始一个任务。 */
  start({ kind, title, meta = null, sessionId = null }) {
    const run = {
      id: nextId('run'),
      kind,
      title: String(title ?? '').slice(0, 120),
      sessionId: sessionId ?? null,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      meta,
      nodes: [],
      summary: '',
    }
    this.runs.set(run.id, run)
    // 取消信号：不属于可序列化字段，挂成不可枚举属性
    const controller = new AbortController()
    Object.defineProperty(run, 'signal', { value: controller.signal, enumerable: false })
    this.controllers ??= new Map()
    this.controllers.set(run.id, controller)
    this.#prune()
    this.#emit()
    return run
  }

  /** 取消正在运行的任务（abort 信号 + 标记状态）。 */
  cancel(runId, reason = '用户取消') {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'running') return false
    try {
      this.controllers?.get(runId)?.abort(new Error(reason))
    } catch {
      /* ignore */
    }
    run.status = 'cancelled'
    run.endedAt = Date.now()
    run.summary = reason
    for (const node of run.nodes) {
      if (node.status === 'running' || node.status === 'pending') {
        node.status = 'skipped'
        node.endedAt = node.endedAt ?? Date.now()
      }
    }
    this.#emit()
    return true
  }

  /** 取消所有运行中的任务。 */
  cancelAll(reason = '用户取消全部任务') {
    const cancelled = []
    for (const run of this.runs.values()) {
      if (run.status === 'running' && this.cancel(run.id, reason)) cancelled.push(run.id)
    }
    return cancelled
  }

  /** 取消某个会话的 run（回合结束/会话停止时用，不波及其它会话）。 */
  cancelBySession(sessionId, reason = '会话结束') {
    const cancelled = []
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue
      if (sessionId && run.sessionId && run.sessionId !== sessionId) continue
      if (this.cancel(run.id, reason)) cancelled.push(run.id)
    }
    return cancelled
  }

  /** 某会话最近的 run（新的在前）。 */
  runsFor(sessionId, { limit = 20 } = {}) {
    return this.snapshot({ limit: 100 })
      .filter((run) => !sessionId || !run.sessionId || run.sessionId === sessionId)
      .slice(0, limit)
  }

  /** 追加一个执行节点；返回节点（后续用 updateNode 更新）。 */
  node(runId, { kind, label, detail = '', status = 'running' }) {
    const run = this.runs.get(runId)
    if (!run) return null
    const node = {
      id: nextId('node'),
      kind,
      label: String(label ?? ''),
      detail,
      status,
      startedAt: Date.now(),
      endedAt: null,
    }
    run.nodes.push(node)
    this.#emit()
    return node
  }

  updateNode(runId, nodeId, patch = {}) {
    const run = this.runs.get(runId)
    const node = run?.nodes.find((item) => item.id === nodeId)
    if (!node) return null
    Object.assign(node, patch)
    if (patch.status && ['done', 'error', 'skipped'].includes(patch.status) && !node.endedAt) {
      node.endedAt = Date.now()
    }
    this.#emit()
    return node
  }

  /** 节点完成/失败（带一句人类可读结果）。 */
  finishNode(runId, nodeId, status, detail) {
    return this.updateNode(runId, nodeId, { status, ...(detail === undefined ? {} : { detail }) })
  }

  /** 记录一条输入/输出。 */
  record({ runId, nodeId, channel, kind, title, content, meta }) {
    const entry = makeIo({ runId, nodeId, channel, kind, title, content, meta })
    this.io.push(entry)
    if (this.io.length > this.ioLimit) this.io.splice(0, this.io.length - this.ioLimit)
    this.#emit()
    return entry
  }

  /** 结束任务。 */
  end(runId, status = 'done', summary = '') {
    const run = this.runs.get(runId)
    if (!run) return null
    // 已被用户取消的任务，后续的 error/done 回调不覆盖状态
    run.status = run.status === 'cancelled' ? 'cancelled' : status
    run.endedAt = Date.now()
    run.summary = String(summary ?? '')
    // 没跑完的节点标记为跳过，避免框图一直转圈
    for (const node of run.nodes) {
      if (node.status === 'running' || node.status === 'pending') {
        node.status = status === 'error' ? 'error' : 'skipped'
        node.endedAt = node.endedAt ?? Date.now()
      }
    }
    this.controllers?.delete(runId)
    this.#emit()
    return run
  }

  get(runId) {
    return this.runs.get(runId) ?? null
  }

  /** 是否还有正在跑的任务（自动释放资源前必须为 false）。 */
  hasRunning() {
    for (const run of this.runs.values()) {
      if (run.status === 'running') return true
    }
    return false
  }

  /** 最近一个任务（按开始时间）。 */
  lastRun() {
    let latest = null
    for (const run of this.runs.values()) {
      if (!latest || run.startedAt > latest.startedAt) latest = run
    }
    return latest
  }

  /** 最近的任务（新的在前），附带耗时。 */
  snapshot({ limit = 20 } = {}) {
    const now = Date.now()
    const runs = [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((run) => ({
        ...run,
        ms: (run.endedAt ?? now) - run.startedAt,
        nodes: run.nodes.map((node) => ({
          ...node,
          ms: (node.endedAt ?? now) - node.startedAt,
        })),
      }))
    return runs
  }

  /** 分通道的 IO 快照。 */
  ioSnapshot({ limit = 120 } = {}) {
    const channels = { decision: [], local: [], mcp: [], system: [] }
    for (const entry of this.io.slice(-limit)) {
      (channels[entry.channel] ?? channels.system).push(entry)
    }
    return channels
  }

  clear() {
    for (const controller of this.controllers?.values() ?? []) {
      try {
        controller.abort(new Error('任务列表已清空'))
      } catch {
        /* ignore */
      }
    }
    this.controllers?.clear()
    this.runs.clear()
    this.io = []
    this.#emit()
  }

  #prune() {
    if (this.runs.size <= this.runLimit) return
    const finished = [...this.runs.values()]
      .filter((run) => run.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    while (this.runs.size > this.runLimit && finished.length > 0) {
      this.runs.delete(finished.shift().id)
    }
  }
}
