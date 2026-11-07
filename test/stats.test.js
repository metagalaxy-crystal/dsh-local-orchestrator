/**
 * token 用量账本：记录、聚合、落盘、重启后回读。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { TokenStats, describeUsage, usageFileOf } from '../lib/stats.js'

async function makeStats(now = () => Date.now()) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-usage-'))
  const stats = new TokenStats({ file: usageFileOf(dir), now })
  await stats.load()
  return { stats, dir }
}

test('record：累计 prompt/completion/total，并算上下文占比', async () => {
  const { stats } = await makeStats()
  const entry = stats.record({
    assetId: 'nanbeige',
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
    ms: 2000,
    ctx: 8192,
  })
  assert.equal(entry.totalTokens, 1500)
  assert.equal(entry.ctxPct, 18.3)
  assert.equal(entry.ok, true)
})

test('summary：只统计最近窗口，按资产聚合，速度按输出算', async () => {
  let clock = 1_000_000
  const { stats } = await makeStats(() => clock)
  stats.record({ assetId: 'a', usage: { prompt_tokens: 100, completion_tokens: 100 }, ms: 1000 })
  clock += 60_000
  stats.record({ assetId: 'a', usage: { prompt_tokens: 200, completion_tokens: 200 }, ms: 2000 })
  stats.record({ assetId: 'b', usage: { prompt_tokens: 50, completion_tokens: 50 }, ms: 1000, ok: false })
  clock += 3 * 3600 * 1000 // 3 小时后

  const day = stats.summary({ sinceMs: 24 * 3600 * 1000 })
  assert.equal(day.calls, 3)
  assert.equal(day.okCalls, 2)
  assert.equal(day.failedCalls, 1)
  assert.equal(day.promptTokens, 300)
  assert.equal(day.completionTokens, 300)
  assert.equal(day.tokensPerSec, 100) // 300 token / 3s
  assert.equal(day.byAsset[0].id, 'a')
  assert.equal(day.byAsset[0].tokens, 600)

  const short = stats.summary({ sinceMs: 60_000 })
  assert.equal(short.calls, 0)
})

test('落盘后重新 load 能读回（去掉坏行）', async () => {
  const { stats, dir } = await makeStats()
  stats.record({ assetId: 'x', usage: { prompt_tokens: 10, completion_tokens: 20 }, ms: 500 })
  await stats.flush()
  await fsp.appendFile(path.join(dir, 'usage.jsonl'), '{ broken json\n', 'utf8')

  const again = new TokenStats({ file: usageFileOf(dir) })
  await again.load()
  assert.equal(again.recent(10).length, 1)
  assert.equal(again.recent(10)[0].assetId, 'x')
  assert.equal(again.summary({ sinceMs: 24 * 3600 * 1000 }).totalTokens, 30)
})

test('内存上限：超过 limit 只保留最近的', async () => {
  const { stats } = await makeStats()
  stats.limit = 2
  for (let i = 0; i < 5; i += 1) {
    stats.record({ assetId: 'a', usage: { prompt_tokens: i, completion_tokens: 1 } })
  }
  assert.equal(stats.entries.length, 2)
  assert.equal(stats.entries[1].promptTokens, 4)
})

test('describeUsage：缺字段时回落到求和', () => {
  assert.deepEqual(describeUsage({ prompt_tokens: 3, completion_tokens: 4 }), { promptTokens: 3, completionTokens: 4, totalTokens: 7 })
  assert.equal(describeUsage(null), null)
})

test('snapshot：给 /state 的结构稳定', async () => {
  const { stats } = await makeStats()
  stats.record({ assetId: 'm', usage: { prompt_tokens: 5, completion_tokens: 5 }, ms: 100 })
  const snap = stats.snapshot({ sinceMs: 24 * 3600 * 1000, recentCount: 10 })
  assert.ok(snap.summary)
  assert.equal(snap.recent.length, 1)
  assert.equal(snap.summary.totalTokens, 10)
  assert.match(snap.updatedAt, /^\d{4}-/)
})
