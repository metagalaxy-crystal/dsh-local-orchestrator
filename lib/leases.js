/**
 * 资源租约表：步骤级占用凭据（谁在跑、占哪个槽、算哪个会话的账）。
 *
 * 分工：
 * - manager.js 负责「物理」：真的起停进程、GPU 互斥、显存淘汰；
 * - 本文件负责「账本」：worker 执行步骤前必须先拿租约，跑完释放；
 *   按会话做公平排队，TTL 到期自动回收（进程崩溃也不会永久占槽）。
 *
 * 为什么还要一层：8GB 卡上「谁先跑」不是 FIFO 问题，而是公平问题——
 * 一个会话连交 10 个任务时，另一个会话不该一直等。租约表让 worker 能
 * 按会话轮转地选下一个执行者，并把「当前 GPU 槽属于哪个任务」显式暴露给 UI。
 */
import { nowIso } from './util.js'

let counter = 0

function nextLeaseId() {
  counter += 1
  return `lease-${Date.now().toString(36)}-${counter.toString(36)}`
}

export class LeaseTable {
  /**
   * @param {{config?: object, onEvent?: (kind: string, msg: string, data?: object) => void}} [options]
   */
  constructor({ config = {}, onEvent = null } = {}) {
    this.config = config
    this.onEvent = onEvent
    /** @type {Map<string, object>} */
    this.leases = new Map()
    this.gpuExclusive = config.scheduler?.gpuExclusive !== false
    this.maxCpu = Math.max(1, Number(config.scheduler?.maxCpuLoads ?? 2))
  }

  #emit(kind, msg, data) {
    try {
      this.onEvent?.(kind, msg, data)
    } catch {
      /* 不阻塞调度 */
    }
  }

  list() {
    return [...this.leases.values()]
  }

  active() {
    return this.list().filter((lease) => lease.state === 'active')
  }

  get(id) {
    return this.leases.get(id) ?? null
  }

  /** GPU 槽当前持有者（不含 expired）。 */
  gpuHolder() {
    return this.active().find((lease) => lease.slot === 'gpu') ?? null
  }

  cpuCount() {
    return this.active().filter((lease) => lease.slot === 'cpu').length
  }

  /**
   * @param {{slot?: 'gpu'|'cpu', assetId: string, vramMb?: number, sessionId?: string|null,
   *          taskId?: string|null, stepIndex?: number|null, ttlMs?: number}} input
   * @returns {{ok: true, lease: object} | {ok: false, reason: string, holder?: object|null}}
   */
  acquire({ slot = 'gpu', assetId, vramMb = 0, sessionId = null, taskId = null, stepIndex = null, ttlMs } = {}) {
    this.sweep()
    if (slot === 'gpu' && this.gpuExclusive) {
      const holder = this.gpuHolder()
      if (holder) {
        return { ok: false, reason: `GPU 槽被 ${holder.assetId} 占用（会话 ${holder.sessionId ?? '—'}）`, holder }
      }
    }
    if (slot === 'cpu' && this.cpuCount() >= this.maxCpu) {
      return { ok: false, reason: `CPU 槽已满（${this.cpuCount()}/${this.maxCpu}）` }
    }
    const lease = {
      id: nextLeaseId(),
      slot,
      assetId,
      vramMb: Number(vramMb) || 0,
      sessionId,
      taskId,
      stepIndex,
      state: 'active',
      since: nowIso(),
      renewedAt: Date.now(),
      ttlMs: Number(ttlMs) || Number(this.config.worker?.leaseTtlSec ?? 1800) * 1000,
    }
    this.leases.set(lease.id, lease)
    this.#emit('lease:acquire', `租约 ${lease.slot}:${lease.assetId} → ${taskId ?? '-'}`, {
      lease: lease.id,
      assetId,
      sessionId,
      taskId,
    })
    return { ok: true, lease }
  }

  /** 续租（长步骤每 30s 续一次，避免被 sweep 误杀）。 */
  renew(id) {
    const lease = this.leases.get(id)
    if (!lease || lease.state !== 'active') return null
    lease.renewedAt = Date.now()
    return lease
  }

  release(id, reason = '释放') {
    const lease = this.leases.get(id)
    if (!lease) return null
    this.leases.delete(id)
    this.#emit('lease:release', `释放租约 ${lease.slot}:${lease.assetId}（${reason}）`, {
      lease: id,
      taskId: lease.taskId,
    })
    return lease
  }

  releaseByTask(taskId, reason = '任务结束') {
    if (!taskId) return []
    const released = this.list().filter((lease) => lease.taskId === taskId)
    for (const lease of released) this.release(lease.id, reason)
    return released
  }

  releaseBySession(sessionId, reason = '会话收尾') {
    if (!sessionId) return []
    const released = this.list().filter((lease) => lease.sessionId === sessionId)
    for (const lease of released) this.release(lease.id, reason)
    return released
  }

  /** 回收过期租约（超过 TTL 没续）——进程崩溃时的兜底。 */
  sweep(now = Date.now()) {
    const expired = []
    for (const lease of this.list()) {
      if (lease.state !== 'active') continue
      if (now - lease.renewedAt <= lease.ttlMs) continue
      lease.state = 'expired'
      this.leases.delete(lease.id)
      expired.push(lease)
      this.#emit('lease:expire', `租约过期回收 ${lease.slot}:${lease.assetId}`, { lease: lease.id })
    }
    return expired
  }

  /** 给 /state 用的紧凑视图。 */
  snapshot() {
    return this.active().map((lease) => ({
      id: lease.id,
      slot: lease.slot,
      assetId: lease.assetId,
      vramMb: lease.vramMb,
      sessionId: lease.sessionId,
      taskId: lease.taskId,
      stepIndex: lease.stepIndex,
      sinceSec: Math.round((Date.now() - new Date(lease.since).getTime()) / 1000),
    }))
  }
}
