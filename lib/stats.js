/**
 * 本地模型 token 用量账本。
 *
 * 只记「一次对话调用」这个粒度：谁（asset）在哪个会话/任务里跑了多久、吃了多少
 * prompt / completion token、占了上下文窗口多少。数据落 `<dataDir>/usage.jsonl`，
 * 一行一次调用，重启后仍然能看趋势。
 *
 * 为什么单独一个模块：显存预算表（budget.js）管的是「资源占用」，token 是「推理成本」，
 * 两者生命周期和查询方式都不一样，混在 Manager 里会让状态越来越糊。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { appendJsonl } from './util.js'

/** 只保留最近这么多条在内存里（文件仍全量追加）。 */
const MEMORY_LIMIT = 2000

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export class TokenStats {
  /**
   * @param {{file?: string, limit?: number, now?: () => number}} [options]
   */
  constructor({ file = '', limit = MEMORY_LIMIT, now = () => Date.now() } = {}) {
    this.file = file
    this.limit = limit
    this.now = now
    this.entries = []
    this._loaded = false
    this._writing = Promise.resolve()
  }

  /** 读历史（只取最后 limit 条）；文件不存在就空着。 */
  async load() {
    if (this._loaded) return this
    this._loaded = true
    if (!this.file) return this
    let text = ''
    try {
      text = await fsp.readFile(this.file, 'utf8')
    } catch {
      return this
    }
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (item && typeof item === 'object' && item.assetId) rows.push(item)
      } catch {
        /* 坏行跳过，别让一条脏数据拖死整本账 */
      }
    }
    this.entries = rows.slice(-this.limit)
    return this
  }

  /**
   * 记一次调用。
   * @param {{assetId: string, usage?: object|null, ms?: number, ok?: boolean, ctx?: number|null,
   *          sessionId?: string|null, taskId?: string|null, kind?: string}} input
   */
  record(input = {}) {
    const usage = input.usage ?? null
    const entry = {
      ts: new Date(this.now()).toISOString(),
      assetId: String(input.assetId ?? 'unknown'),
      kind: input.kind ?? 'chat',
      ok: input.ok !== false,
      promptTokens: num(usage?.prompt_tokens),
      completionTokens: num(usage?.completion_tokens),
      totalTokens: num(usage?.total_tokens) || num(usage?.prompt_tokens) + num(usage?.completion_tokens),
      ms: num(input.ms),
      ctx: num(input.ctx) || null,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
    }
    entry.ctxPct = entry.ctx ? Math.round((entry.totalTokens / entry.ctx) * 1000) / 10 : null
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    if (this.file) {
      // 串行追加，避免并发写交错
      this._writing = this._writing
        .then(() => appendJsonl(this.file, entry))
        .catch(() => {})
    }
    return entry
  }

  /** 等待所有落盘完成（测试 / 卸载时用）。 */
  async flush() {
    await this._writing
  }

  /**
   * 聚合：默认看最近 24 小时。
   * @param {{sinceMs?: number, assetId?: string}} [filter]
   */
  summary({ sinceMs = 24 * 3600 * 1000, assetId = null } = {}) {
    const from = this.now() - sinceMs
    const rows = this.entries.filter((item) => {
      if (item.ts && Date.parse(item.ts) < from) return false
      if (assetId && item.assetId !== assetId) return false
      return true
    })
    const ok = rows.filter((item) => item.ok)
    const promptTokens = ok.reduce((sum, item) => sum + item.promptTokens, 0)
    const completionTokens = ok.reduce((sum, item) => sum + item.completionTokens, 0)
    const totalTokens = ok.reduce((sum, item) => sum + item.totalTokens, 0)
    const ms = ok.reduce((sum, item) => sum + item.ms, 0)
    const byAsset = new Map()
    for (const item of ok) {
      const cur = byAsset.get(item.assetId) ?? { id: item.assetId, tokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, ms: 0 }
      cur.tokens += item.totalTokens
      cur.promptTokens += item.promptTokens
      cur.completionTokens += item.completionTokens
      cur.calls += 1
      cur.ms += item.ms
      byAsset.set(item.assetId, cur)
    }
    return {
      windowHours: Math.round(sinceMs / 3600000),
      calls: rows.length,
      okCalls: ok.length,
      failedCalls: rows.length - ok.length,
      promptTokens,
      completionTokens,
      totalTokens,
      ms,
      tokensPerSec: ms > 0 ? Math.round((completionTokens / (ms / 1000)) * 10) / 10 : null,
      avgCtxPct:
        ok.length > 0
          ? Math.round((ok.reduce((sum, item) => sum + (item.ctxPct ?? 0), 0) / ok.length) * 10) / 10
          : null,
      byAsset: [...byAsset.values()].sort((a, b) => b.tokens - a.tokens),
    }
  }

  /** 最近 n 次（含失败），给趋势图和表格用。 */
  recent(n = 30) {
    return this.entries.slice(-Math.max(0, n))
  }

  /** 给 /state 的一次性快照。 */
  snapshot({ sinceMs = 24 * 3600 * 1000, recentCount = 30 } = {}) {
    return {
      summary: this.summary({ sinceMs }),
      recent: this.recent(recentCount),
      updatedAt: this.now ? new Date(this.now()).toISOString() : new Date().toISOString(),
      file: this.file || null,
    }
  }
}

/** 便于测试：把一条 usage 拆成可读字段。 */
export function describeUsage(usage) {
  if (!usage) return null
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens) || num(usage.prompt_tokens) + num(usage.completion_tokens),
  }
}

/** 默认文件位置。 */
export function usageFileOf(dataDir) {
  return dataDir ? path.join(dataDir, 'usage.jsonl') : ''
}
