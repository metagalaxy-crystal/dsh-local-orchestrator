/**
 * 后台执行环：把「已开始（running）」的任务一步一步往前推。
 *
 * 与 tools.local_step 的关系：
 * - 两者共用 `StepRunner`（lib/steps.js）：claim → 租约 → 执行 → 判定 → 写回 只有一份实现；
 * - local_step 是**会话内**推进（模型看着结果走）；
 * - worker 是**会话外**推进（关掉页面也继续跑），跑到「需要人/模型判断」的点就停下并唤醒。
 *
 * 边界：
 * - 只碰 `status === 'running'` 且 `autoAdvance !== false` 的任务；`queued`（刚建、还没人跑第一步）不动；
 * - `verification.mode === 'require'`、步骤失败、任务预算耗尽 → 转 `waiting_decision`（或 error），
 *   并用 schedule 唤醒归属会话；
 * - 每次执行前先拿租约（lib/leases.js），GPU 槽被别的任务占着就等下一 tick。
 */
import { intOr } from './util.js'
import { ensureStepRunner, STEP_STATUS } from './steps.js'

const WAKE_COOLDOWN_MS = 30000

export class Worker {
  /**
   * @param {object} options
   * @param {import('./manager.js').Orchestrator} options.orchestrator
   * @param {{executeStep: Function}} options.decision
   * @param {object} options.config
   * @param {(sessionId: string, payload: object) => Promise<boolean>|boolean} [options.wake]
   */
  constructor({ orchestrator, decision, config, wake = null }) {
    this.orchestrator = orchestrator
    this.decision = decision
    this.config = config
    this.wake = wake
    this.runner = ensureStepRunner({ orchestrator, decision, config })
    this.timer = null
    this.busy = false
    /** stop() 之后不再接受 tick（dispose 用）；start() 之前允许手动 tick（测试/单步调试）。 */
    this.stopped = false
    this._lastSession = null
  }

  get store() {
    return this.orchestrator.tasks
  }

  get leases() {
    return this.orchestrator.leases
  }

  get running() {
    return this.timer !== null
  }

  get active() {
    return this.runner.activeInfo()
  }

  /** 暂停/取消：真正打断正在跑的那一步（runner 持有 controller）。 */
  abortTask(taskId, reason = 'paused') {
    return this.runner.abortTask(taskId, reason)
  }

  #log(msg, data) {
    try {
      this.orchestrator.events.push('worker', msg, data ?? {})
    } catch {
      /* ignore */
    }
  }

  start() {
    if (this.timer) return this
    if (this.config.worker?.enabled === false || this.config.tasks?.background === false) {
      this.#log('后台执行已关闭（worker.enabled=false 或 tasks.background=false）')
      return this
    }
    this.stopped = false
    const tickMs = intOr(this.config.worker?.tickMs, 2000)
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.#log(`tick 失败：${error?.message ?? error}`))
    }, tickMs)
    this.timer.unref?.()
    this.#log(`后台执行已启动（每 ${tickMs}ms 检查一次）`)
    return this
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 一次 tick 最多推进一步，避免长时间占着事件循环。 */
  async tick() {
    if (this.busy || this.stopped) return null
    this.busy = true
    try {
      return await this.#drainOnce()
    } finally {
      this.busy = false
    }
  }

  // ================================================================ 选任务
  /** 公平轮转：上次执行的会话排后面，其余按开始时间先来先到。 */
  #candidates() {
    const tasks = this.store
      .list({ all: true, limit: 200 })
      .filter((task) => task.status === 'running' && task.autoAdvance !== false)
    tasks.sort((a, b) => {
      const sa = a.sessionId && a.sessionId === this._lastSession ? 1 : 0
      const sb = b.sessionId && b.sessionId === this._lastSession ? 1 : 0
      if (sa !== sb) return sa - sb
      const ta = String(a.startedAt ?? a.createdAt)
      const tb = String(b.startedAt ?? b.createdAt)
      if (ta !== tb) return ta.localeCompare(tb)
      return String(a.id).localeCompare(String(b.id))
    })
    return tasks
  }

  async #drainOnce() {
    for (const task of this.#candidates()) {
      // 已有步骤在跑（可能是会话内的 local_step）：让路
      if (task.steps.some((step) => step.status === 'running')) continue

      const budget = this.store.checkBudget(task)
      if (!budget.ok) {
        this.store.setStatus(task, 'error', budget.reason)
        await this.store.save(task)
        await this.#wake(task, budget.reason)
        continue
      }

      const step = this.store.nextStep(task)
      if (!step) {
        if (this.store.isComplete(task)) {
          this.store.setStatus(task, 'done', '全部步骤完成')
          await this.store.save(task)
        } else {
          task.status = 'paused'
          task.pauseReason = '依赖未满足，等待人工处理'
          await this.store.save(task)
        }
        continue
      }
      return await this.#runStep(task, step)
    }
    return null
  }

  // ================================================================ 执行一步
  async #runStep(task, step) {
    const result = await this.runner.run(task, step, { background: true })
    this._lastSession = task.sessionId

    if (result.status === STEP_STATUS.BUSY) {
      this.#log(`步骤等待资源：${result.output}`)
      return null
    }
    if (result.status === STEP_STATUS.WAITING) {
      await this.#wake(task, '需要判断')
    } else if (result.status === STEP_STATUS.FAILED) {
      await this.#wake(task, `步骤 ${step.index + 1} 失败`)
    } else if (task.status === 'done') {
      this.#log(`任务完成：${task.id}`)
    }
    return result
  }

  /**
   * 唤醒任务所属会话（不广播）：优先 schedule 持久化提醒，否则靠系统提示兜底。
   * @returns {Promise<boolean>}
   */
  async #wake(task, reason) {
    if (!task.sessionId) return false
    const now = Date.now()
    if (task.wakeAt && now - task.wakeAt < WAKE_COOLDOWN_MS) return false
    task.wakeAt = now
    await this.store.save(task)
    const prompt =
      `本地任务 ${task.id}「${task.title}」${reason}。\n` +
      `用 local_task {"action":"get","taskId":"${task.id}"} 查看详情，再决定 resume / retry / rollback / cancel。`
    try {
      const ok = await this.wake?.(task.sessionId, { taskId: task.id, title: task.title, reason, prompt })
      this.#log(ok ? `已唤醒会话处理任务 ${task.id}` : `唤醒不可用，任务 ${task.id} 等待下次会话查看`, {
        taskId: task.id,
        sessionId: task.sessionId,
      })
      return Boolean(ok)
    } catch (error) {
      this.#log(`唤醒失败：${error?.message ?? error}`, { taskId: task.id })
      return false
    }
  }
}
