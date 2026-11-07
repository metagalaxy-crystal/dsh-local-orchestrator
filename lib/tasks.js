/**
 * 任务状态机：Task / Step / Substep 的模型、迁移与持久化。
 *
 * 定位（见 docs/PLAN-v2-有限资源调度器改造方案.md）：
 * - 「任务」是跨工具调用、跨回合、跨会话存活的一串步骤；
 * - 「决策环」归宿主（会话模型决定下一步），本文件只负责状态；
 * - 「执行环」由 tools.js 的 local_step 驱动（一次调用推进一步）。
 *
 * 存储：<dataDir>/tasks/<taskId>.json，一个任务一个文件，原子写；
 * 不维护全局 index，重启时扫目录重建（任务数按 keepFinished 控制，量很小）。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'

import { clip, intOr, nowIso, readJsonSafe, writeJsonAtomic } from './util.js'

let counter = 0

function nextTaskId() {
  counter += 1
  return `task-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** 终态：不再推进。 */
const TERMINAL = new Set(['done', 'error', 'cancelled'])

/** 任务状态迁移表；未列出的迁移一律拒绝（早失败好过状态漂移）。 */
const TASK_TRANSITIONS = {
  queued: ['running', 'paused', 'cancelled', 'done'],
  running: ['done', 'error', 'cancelled', 'paused', 'waiting_decision'],
  waiting_decision: ['running', 'done', 'error', 'cancelled', 'paused'],
  paused: ['running', 'queued', 'cancelled'],
  done: [],
  error: ['running', 'cancelled'],
  cancelled: [],
}

/** 步骤状态：pending 待跑，ready 依赖已满足，running 执行中。 */
const STEP_ACTIVE = new Set(['pending', 'ready'])

export function isTerminal(status) {
  return TERMINAL.has(status)
}

export class TaskStore {
  /**
   * @param {object} options
   * @param {string} options.dir 任务目录
   * @param {object} [options.config] 插件配置（读 config.tasks）
   * @param {(kind: string, msg: string, data?: object) => void} [options.onEvent] 事件回调
   */
  constructor({ dir, config = {}, onEvent = null }) {
    this.dir = dir
    this.config = config
    this.onEvent = onEvent
    /** @type {Map<string, object>} */
    this.tasks = new Map()
    this.loaded = false
    /** 串行写盘，避免同一任务并发写坏文件。 */
    this._queue = Promise.resolve()
  }

  #file(id) {
    return path.join(this.dir, `${id}.json`)
  }

  #emit(kind, msg, data) {
    try {
      this.onEvent?.(kind, msg, data)
    } catch {
      /* 事件回调不能影响状态机 */
    }
  }

  // ================================================================ 存取
  /** 扫目录加载；`running` 的任务一律降级为 paused（进程可能已随宿主重启消失）。 */
  async load() {
    if (this.loaded) return this
    this.loaded = true
    let names = []
    try {
      names = await fsp.readdir(this.dir)
    } catch {
      return this
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const task = await readJsonSafe(path.join(this.dir, name), null)
      if (!task?.id || !Array.isArray(task.steps)) continue
      let dirty = false
      // 兼容旧版本 / 手写文件：补齐缺省字段，避免读旧任务时抛错
      if (!Array.isArray(task.artifacts)) {
        task.artifacts = []
        dirty = true
      }
      if (!task.budget || typeof task.budget !== 'object') {
        task.budget = {
          maxSteps: intOr(this.config.tasks?.maxSteps, 8),
          maxRequires: intOr(this.config.tasks?.maxRequires, 2),
          maxWallMs: intOr(this.config.tasks?.maxWallMin, 30) * 60000,
          usedMs: 0,
          usedTokens: 0,
          requires: 0,
        }
        dirty = true
      }
      if (task.status === 'running') {
        task.status = 'paused'
        task.pauseReason = '插件重启，任务已暂停'
        dirty = true
      }
      for (const step of task.steps) {
        if (step.status === 'running') {
          step.status = 'pending'
          dirty = true
        }
      }
      this.tasks.set(task.id, task)
      if (dirty) this.save(task).catch(() => {})
    }
    this.#prune()
    return this
  }

  /** 异步落盘（不阻塞调用方）。 */
  save(task) {
    const data = JSON.parse(JSON.stringify(task))
    const file = this.#file(task.id)
    const run = this._queue.then(() => writeJsonAtomic(file, data))
    this._queue = run.catch(() => {})
    return run
  }

  get(id) {
    return this.tasks.get(id) ?? null
  }

  /** 是否允许 sessionId 操作该任务；历史任务没有归属时放行。 */
  owns(task, sessionId) {
    if (!task) return false
    if (!task.sessionId || !sessionId) return true
    return task.sessionId === sessionId
  }

  /**
   * @param {{sessionId?: string|null, all?: boolean, status?: string|null, limit?: number}} [options]
   */
  list({ sessionId = null, all = false, status = null, limit = 50 } = {}) {
    const items = [...this.tasks.values()]
      .filter((task) => (all || !sessionId ? true : task.sessionId === sessionId))
      .filter((task) => (status ? task.status === status : true))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return items.slice(0, limit)
  }

  // ================================================================ 创建
  /**
   * @param {object} input
   * @param {string|null} [input.sessionId]
   * @param {string} [input.title]
   * @param {string} [input.goal]
   * @param {object[]} [input.steps]
   * @param {object} [input.budget]
   */
  create({ sessionId = null, title = '', goal = '', steps = [], budget = {}, autoAdvance }) {
    const tasksCfg = this.config.tasks ?? {}
    const task = {
      id: nextTaskId(),
      sessionId: sessionId ?? null,
      title: String(title || goal || '未命名任务').slice(0, 120),
      goal: String(goal ?? ''),
      status: 'queued',
      /** true = 后台 worker 可以继续推进；false = 只能由 local_step 手动推。 */
      autoAdvance: autoAdvance === undefined ? tasksCfg.background !== false : Boolean(autoAdvance),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      endedAt: null,
      pauseReason: null,
      error: null,
      steps: steps.map((step, index) => this.#normalizeStep(step, index)),
      cursor: 0,
      planSummary: '',
      budget: {
        maxSteps: intOr(budget.maxSteps ?? tasksCfg.maxSteps, 8),
        maxRequires: intOr(budget.maxRequires ?? tasksCfg.maxRequires, 2),
        maxWallMs: intOr(budget.maxWallMin ?? tasksCfg.maxWallMin, 30) * 60000,
        usedMs: 0,
        usedTokens: 0,
        requires: 0,
      },
      artifacts: [],
    }
    this.tasks.set(task.id, task)
    this.save(task).catch(() => {})
    this.#emit('task:create', `新建任务 ${task.id}（${task.steps.length} 步）`, { id: task.id })
    return task
  }

  #normalizeStep(step, index) {
    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < index)
      : []
    return {
      index,
      goal: String(step.goal ?? '').trim(),
      kind: String(step.kind ?? 'llm'),
      asset: String(step.asset ?? ''),
      dependsOn,
      substeps: Array.isArray(step.substeps) ? step.substeps.map((sub, i) => ({ index: i, ...sub })) : [],
      verification: step.verification ?? null,
      rubric: String(step.rubric ?? ''),
      status: 'pending',
      attempts: 0,
      startedAt: null,
      endedAt: null,
      heartbeatAt: null,
      ms: 0,
      error: null,
      result: null,
    }
  }

  // ================================================================ 迁移
  /**
   * 任务状态迁移（校验合法性）。
   * @param {object} task
   * @param {string} next
   * @param {string} [reason]
   */
  setStatus(task, next, reason = '') {
    if (!task) throw new Error('任务不存在')
    if (task.status === next) return task
    const allowed = TASK_TRANSITIONS[task.status] ?? []
    if (!allowed.includes(next)) {
      throw new Error(`任务 ${task.id} 不能从 ${task.status} 迁移到 ${next}${reason ? `（${reason}）` : ''}`)
    }
    task.status = next
    task.updatedAt = nowIso()
    if (next === 'running' && !task.startedAt) task.startedAt = nowIso()
    if (next === 'running') task.pauseReason = null
    if (TERMINAL.has(next)) task.endedAt = nowIso()
    this.#emit(`task:${next}`, `任务 ${task.id} → ${next}${reason ? `（${reason}）` : ''}`, { id: task.id })
    return task
  }

  /** 同步包一层 async，便于调用方 await。 */
  async update(id, mutator) {
    const task = this.tasks.get(id)
    if (!task) return null
    await mutator(task)
    task.updatedAt = nowIso()
    await this.save(task)
    return task
  }

  /** 下一个可执行的步骤（依赖已完成的 pending/ready）。 */
  nextStep(task) {
    for (const step of task.steps) {
      if (!STEP_ACTIVE.has(step.status)) continue
      const depsOk = (step.dependsOn ?? []).every((i) => task.steps[i]?.status === 'done')
      if (depsOk) return step
    }
    return null
  }

  /** 卡住的失败步骤（需要 retry / skip / 人工判断）。 */
  failedStep(task) {
    return task.steps.find((step) => step.status === 'error') ?? null
  }

  isComplete(task) {
    return task.steps.every((step) => ['done', 'skipped'].includes(step.status))
  }

  progress(task) {
    const done = task.steps.filter((step) => ['done', 'skipped'].includes(step.status)).length
    return { done, total: task.steps.length }
  }

  /** 预算检查：步数 / 墙钟时间。 */
  checkBudget(task) {
    const { done } = this.progress(task)
    if (done >= task.budget.maxSteps) {
      return { ok: false, reason: `已达到步数上限 ${task.budget.maxSteps}` }
    }
    if (task.budget.maxWallMs > 0 && task.startedAt) {
      const used = Date.now() - new Date(task.startedAt).getTime()
      if (used > task.budget.maxWallMs) {
        return { ok: false, reason: `已超过总时长上限 ${Math.round(task.budget.maxWallMs / 60000)} 分钟` }
      }
    }
    return { ok: true }
  }

  beginStep(task, step) {
    step.status = 'running'
    step.startedAt = nowIso()
    step.heartbeatAt = step.startedAt
    step.error = null
    task.status = 'running'
    task.updatedAt = nowIso()
  }

  /**
   * 原子地「认领」一个步骤：只有处于 pending/ready 且没有别的步骤在跑时才成功。
   * 会话内 local_step 与后台 worker 都走这里，避免同一个步骤被两边同时执行。
   */
  claimStep(task, step) {
    if (!step) return false
    if (!['pending', 'ready'].includes(step.status)) return false
    if (task.steps.some((item) => item.status === 'running' && item.index !== step.index)) return false
    this.beginStep(task, step)
    return true
  }

  /**
   * 记录步骤结果。
   * @param {object} task
   * @param {object} step
   * @param {{ok: boolean, output?: string, asset?: string, usage?: object, ms?: number, error?: string}} result
   * @param {{maxAttempts?: number}} [options]
   */
  finishStep(task, step, result, { maxAttempts = 2 } = {}) {
    const now = Date.now()
    const started = step.startedAt ? new Date(step.startedAt).getTime() : now
    step.ms = Number.isFinite(result.ms) ? result.ms : now - started
    step.endedAt = nowIso()
    task.budget.usedMs += step.ms
    if (result.usage?.total_tokens) task.budget.usedTokens += result.usage.total_tokens

    if (result.ok) {
      step.status = 'done'
      step.result = {
        ok: true,
        asset: result.asset ?? step.asset ?? null,
        output: clip(result.output ?? '', 4000),
        ms: step.ms,
        usage: result.usage ?? null,
      }
      if (typeof result.output === 'string' && result.output.trim() !== '') {
        task.artifacts.push({
          step: step.index,
          kind: step.kind,
          asset: result.asset ?? step.asset ?? null,
          chars: result.output.length,
          at: nowIso(),
        })
      }
      if (this.isComplete(task)) this.setStatus(task, 'done', '全部步骤完成')
      return step
    }

    step.attempts += 1
    step.error = String(result.error ?? result.output ?? '执行失败')
    step.result = { ok: false, error: clip(step.error, 1000), ms: step.ms }
    if (step.attempts < maxAttempts) {
      // 自动重试一次：回到 pending，下次 local_step run 会再跑
      step.status = 'pending'
      step.error = `${step.error}（第 ${step.attempts} 次失败，将重试）`
    } else {
      step.status = 'error'
      this.setStatus(task, 'error', `步骤 ${step.index + 1} 失败`)
    }
    return step
  }

  // ================================================================ 会话动作
  /**
   * 回合结束时调用：只把「正在执行」的步骤回退，任务转 paused；
   * 没有在执行的步骤就完全不动（任务跨回合存活）。
   */
  async suspendSession(sessionId, reason = '回合结束') {
    const touched = []
    for (const task of this.tasks.values()) {
      if (sessionId && task.sessionId && task.sessionId !== sessionId) continue
      const running = task.steps.filter((step) => step.status === 'running')
      if (running.length === 0) continue
      for (const step of running) {
        step.status = 'pending'
        step.endedAt = nowIso()
      }
      if (task.status === 'running') {
        task.status = 'paused'
        task.pauseReason = reason
      }
      task.updatedAt = nowIso()
      await this.save(task)
      touched.push(task.id)
    }
    return touched
  }

  /** 取消某会话的任务（只作用于该会话）。 */
  async cancelSession(sessionId, reason = '用户取消') {
    const cancelled = []
    for (const task of this.tasks.values()) {
      if (sessionId && task.sessionId && task.sessionId !== sessionId) continue
      if (TERMINAL.has(task.status)) continue
      task.status = 'cancelled'
      task.endedAt = nowIso()
      task.pauseReason = reason
      task.updatedAt = nowIso()
      for (const step of task.steps) {
        if (['running', 'pending', 'ready'].includes(step.status)) step.status = 'skipped'
      }
      await this.save(task)
      cancelled.push(task.id)
    }
    return cancelled
  }

  /** 取消单个任务（只影响它自己）。 */
  async cancelTask(task, reason = '用户取消') {
    if (!task) return null
    task.status = 'cancelled'
    task.endedAt = nowIso()
    task.pauseReason = reason
    task.updatedAt = nowIso()
    for (const step of task.steps) {
      if (['running', 'pending', 'ready'].includes(step.status)) step.status = 'skipped'
    }
    await this.save(task)
    this.#emit('task:cancelled', `任务 ${task.id} 已取消`, { id: task.id })
    return task
  }

  /** 用新计划替换步骤（replan）。 */
  async replacePlan(task, { summary = '', steps = [] }) {
    if (!task) return null
    task.steps = steps.map((step, index) => this.#normalizeStep(step, index))
    task.planSummary = String(summary ?? '')
    task.status = 'queued'
    task.error = null
    task.pauseReason = null
    task.updatedAt = nowIso()
    await this.save(task)
    return task
  }

  /** 回滚到某个步骤（含），后续步骤回到 pending；产物记录保留。 */
  async rollback(task, toIndex) {
    const index = Math.max(0, Math.min(Number(toIndex) || 0, task.steps.length - 1))
    for (const step of task.steps) {
      if (step.index < index) continue
      step.status = 'pending'
      step.result = null
      step.error = null
      step.attempts = 0
      step.startedAt = null
      step.endedAt = null
    }
    task.artifacts = task.artifacts.filter((item) => item.step < index)
    task.cursor = index
    task.error = null
    if (TERMINAL.has(task.status)) task.status = 'running'
    task.updatedAt = nowIso()
    await this.save(task)
    return task
  }

  /** 只保留最近 N 个终态任务，其余从磁盘与内存移除（产物不动）。 */
  #prune() {
    const keep = intOr(this.config.tasks?.keepFinished, 100)
    const finished = [...this.tasks.values()]
      .filter((task) => TERMINAL.has(task.status))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    for (const task of finished.slice(keep)) {
      this.tasks.delete(task.id)
      fsp.rm(this.#file(task.id), { force: true }).catch(() => {})
    }
  }

  /** 给工具/UI 的紧凑文本。 */
  describe(task, { detail = false } = {}) {
    const { done, total } = this.progress(task)
    const lines = [
      `${task.id}  [${task.status}]  ${done}/${total} 步 · ${task.title}`,
    ]
    if (task.pauseReason) lines.push(`  暂停原因：${task.pauseReason}`)
    if (detail) {
      for (const step of task.steps) {
        const mark = {
          done: '✅',
          error: '❌',
          running: '▶',
          skipped: '⏭',
          pending: '·',
          ready: '·',
        }[step.status] ?? '?'
        const asset = step.result?.asset ?? step.asset
        const ms = step.ms ? ` ${(step.ms / 1000).toFixed(1)}s` : ''
        lines.push(`  ${mark} ${step.index + 1}. ${step.goal || step.kind}${asset ? ` → ${asset}` : ''}${ms}`)
        if (step.error) lines.push(`     ${clip(step.error, 200)}`)
      }
    }
    return lines.join('\n')
  }
}
