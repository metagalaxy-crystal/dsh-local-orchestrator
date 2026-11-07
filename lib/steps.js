/**
 * 单步执行器：前台（local_step）与后台（worker）共用同一条执行路径。
 *
 * 定位（见 docs/PLAN-v2 与 README 的「资源调度运行时」）：
 * - 决策权在宿主：谁决定「下一步做什么」是会话模型；
 * - 执行权在插件：本文件负责「把这一步安全地做完」——
 *   claim 认领 → 租约 → 执行 → 判定 → 写回 → （必要时）转 waiting_decision。
 *
 * 之所以只有一个入口：前台和后台各写一份，规则一定会漂移（超时、暂停、重试语义）。
 * 现在两条驱动共用它，差异只剩「谁在等结果」。
 */
import { anySignal, sleep } from './util.js'

export const STEP_STATUS = {
  DONE: 'done',
  FAILED: 'failed',
  WAITING: 'waiting_decision',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  BUSY: 'busy',
  SKIPPED: 'skipped',
  UNAVAILABLE: 'unavailable',
}

export class StepRunner {
  /**
   * @param {{orchestrator: import('./manager.js').Orchestrator, decision: object, config: object}} options
   */
  constructor({ orchestrator, decision, config }) {
    this.orchestrator = orchestrator
    this.decision = decision
    this.config = config
    /** taskId → {controller, abort, startedAt, stepIndex, background} */
    this.active = new Map()
  }

  get store() {
    return this.orchestrator.tasks
  }

  get leases() {
    return this.orchestrator.leases
  }

  get busy() {
    return this.active.size > 0
  }

  /** 当前正在执行的一步（/state 用；跨任务取第一个）。 */
  activeInfo() {
    for (const [taskId, item] of this.active) {
      return {
        taskId,
        stepIndex: item.stepIndex,
        startedSec: Math.round((Date.now() - item.startedAt) / 1000),
        background: item.background,
      }
    }
    return null
  }

  /** 暂停/取消某个任务时，真正把正在跑的那一步打断。 */
  abortTask(taskId, reason = 'paused') {
    const item = this.active.get(taskId)
    if (!item) return false
    item.abort(reason)
    return true
  }

  #stepTimeoutMs() {
    const minutes = Number(this.config.worker?.maxStepMin ?? 30)
    return Math.max(60000, (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60000)
  }

  /**
   * 取租约；拿不到就等（前台最多等 waitMs，后台等 0 → 下一 tick 再来）。
   * @returns {Promise<object|null>}
   */
  async #acquireLease(task, step, waitMs) {
    const asset = step.asset ? this.orchestrator.catalog.get(step.asset) : null
    const slot = asset?.slot === 'cpu' ? 'cpu' : 'gpu'
    const vramMb = asset ? (asset.peakVramMb ?? asset.measured?.vramMb ?? asset.cost?.vramMb ?? 0) : 0
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0)
    for (;;) {
      const got = this.leases.acquire({
        slot,
        assetId: asset?.id ?? step.kind,
        vramMb,
        sessionId: task.sessionId,
        taskId: task.id,
        stepIndex: step.index,
        ttlMs: this.#stepTimeoutMs() * 2,
      })
      if (got.ok) return got.lease
      if (Date.now() >= deadline) return null
      await sleep(250)
    }
  }

  #doneResults(task) {
    return task.steps.map((item) =>
      item.status === 'done'
        ? { index: item.index, goal: item.goal, ok: true, output: item.result?.output ?? '' }
        : undefined,
    )
  }

  /**
   * 执行一个步骤。调用方负责：预算检查、暂停态判断、事后唤醒。
   *
   * @param {object} task
   * @param {object} step
   * @param {{signal?: AbortSignal, waitMs?: number, background?: boolean}} [options]
   * @returns {Promise<{status: string, ok: boolean, output: string, task: object, step: object, runId: string|null, ms: number}>}
   */
  async run(task, step, options = {}) {
    const base = { task, step, ok: false, output: '', runId: null, ms: 0 }
    if (typeof this.decision?.executeStep !== 'function') {
      return { ...base, status: STEP_STATUS.UNAVAILABLE, output: '执行器不可用：decision.executeStep 未装配' }
    }
    if (!this.store.claimStep(task, step)) {
      return { ...base, status: STEP_STATUS.SKIPPED, output: '这一步已被其它执行者认领' }
    }
    await this.store.save(task)

    const lease = await this.#acquireLease(task, step, options.waitMs ?? 0)
    if (!lease) {
      step.status = 'pending'
      step.startedAt = null
      await this.store.save(task)
      return { ...base, status: STEP_STATUS.BUSY, output: '资源忙：等下一轮' }
    }

    const background = options.background === true
    const run = this.orchestrator.tracker.start({
      kind: 'task',
      title: `${task.title} · 步骤 ${step.index + 1}`,
      sessionId: task.sessionId,
      meta: { taskId: task.id, step: step.index, kind: step.kind, background },
    })
    base.runId = run.id

    const controller = new AbortController()
    let abortReason = null
    const abort = (reason) => {
      if (controller.signal.aborted) return
      abortReason = reason
      controller.abort(new Error(reason))
    }
    const startedAt = Date.now()
    this.active.set(task.id, { controller, abort, startedAt, stepIndex: step.index, background })

    const onExternalAbort = () => abort('cancelled')
    if (options.signal?.aborted) abort('cancelled')
    else options.signal?.addEventListener?.('abort', onExternalAbort, { once: true })

    const hardMs = this.#stepTimeoutMs()
    const watchdog = setInterval(() => {
      this.leases.renew(lease.id)
      step.heartbeatAt = new Date().toISOString()
      if (Date.now() - startedAt > hardMs) abort('timeout')
    }, 2000)
    watchdog.unref?.()

    let out
    try {
      out = await this.decision.executeStep(step, {
        results: this.#doneResults(task),
        signal: anySignal(controller.signal),
        runId: run.id,
      })
    } catch (error) {
      out = { ok: false, output: `失败：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      clearInterval(watchdog)
      options.signal?.removeEventListener?.('abort', onExternalAbort)
      this.active.delete(task.id)
      this.leases.release(lease.id, '步骤结束')
    }

    // ---- 被打断：暂停/取消不消耗尝试次数，也不写产物
    if (abortReason === 'paused' || abortReason === 'cancelled') {
      step.status = 'pending'
      step.endedAt = new Date().toISOString()
      step.error = null
      if (task.status === 'running' || task.status === 'waiting_decision') {
        task.status = 'paused'
        task.pauseReason = abortReason === 'paused' ? '手动暂停' : '回合结束'
      }
      await this.store.save(task)
      this.orchestrator.tracker.end(run.id, 'cancelled', abortReason === 'paused' ? '已暂停' : '已取消')
      return {
        ...base,
        status: abortReason === 'paused' ? STEP_STATUS.PAUSED : STEP_STATUS.CANCELLED,
        output: abortReason === 'paused' ? '已暂停：任务保持可恢复' : '已取消：任务保持可恢复',
        ms: Date.now() - startedAt,
      }
    }

    if (abortReason === 'timeout') {
      out = { ok: false, output: `失败：步骤超时（${Math.round(hardMs / 60000)} 分钟）` }
    }

    this.store.finishStep(task, step, out)
    await this.store.save(task)
    this.orchestrator.tracker.end(run.id, out.ok ? 'done' : 'error', String(out.output ?? '').slice(0, 120))

    // ---- 决策点：需要人/模型判断
    if (out.ok && step.verification?.mode === 'require') {
      task.status = 'waiting_decision'
      task.pauseReason = '步骤需要判断（verification=require）'
      await this.store.save(task)
      return {
        ...base,
        ok: true,
        status: STEP_STATUS.WAITING,
        output: String(out.output ?? ''),
        ms: Date.now() - startedAt,
      }
    }
    if (!out.ok) {
      return {
        ...base,
        status: STEP_STATUS.FAILED,
        output: String(out.output ?? ''),
        ms: Date.now() - startedAt,
      }
    }
    return {
      ...base,
      ok: true,
      status: STEP_STATUS.DONE,
      output: String(out.output ?? ''),
      ms: Date.now() - startedAt,
    }
  }
}

/** 懒加载单例：谁先需要谁创建，保证前台/后台共享同一份 active 表。 */
export function ensureStepRunner({ orchestrator, decision, config }) {
  if (orchestrator.steps) {
    if (!orchestrator.steps.decision && decision) orchestrator.steps.decision = decision
    return orchestrator.steps
  }
  orchestrator.steps = new StepRunner({ orchestrator, decision, config })
  return orchestrator.steps
}
