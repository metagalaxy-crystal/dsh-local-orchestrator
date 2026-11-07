/**
 * GGUF 估算器测试：用本机实测标定值验证 KV / 计算缓冲模型。
 *
 * 实测基准（Nanbeige4.2-3B Q4_K_M，RTX 5060 8GB）：
 *   ctx 8192,  f16, parallel 1 → 进程占用约 3791MB（总 used 3928 − 空闲基线 137）
 *   ctx 32768, f16, parallel 1 → 进程占用约 7665MB
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { kvBytesPerToken, estimateVramMb, planLlamaParams } from '../lib/gguf.js'

const summary = {
  blockCount: 22,
  headCount: 48,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
  embeddingLength: 3072,
  contextLength: 262144,
  fileSizeMb: 2456,
}

test('kvBytesPerToken：22 层 × 8 KV 头 × 128 dim', () => {
  // 22 * (128+128) * 8 * 2 bytes = 90112 bytes/token
  assert.equal(kvBytesPerToken(summary, 'f16'), 90112)
  assert.equal(kvBytesPerToken(summary, 'q8_0'), 22 * 256 * 8 * 1.0625)
})

test('estimateVramMb：与真机实测相差 < 6%', () => {
  const at8k = estimateVramMb({ fileSizeMb: 2456, summary, ctx: 8192, ngl: 99, kvType: 'f16' })
  const at32k = estimateVramMb({ fileSizeMb: 2456, summary, ctx: 32768, ngl: 99, kvType: 'f16' })
  assert.ok(Math.abs(at8k - 3791) / 3791 < 0.06, `8192 估算 ${at8k}`)
  assert.ok(Math.abs(at32k - 7665) / 7665 < 0.06, `32768 估算 ${at32k}`)
})

test('planLlamaParams：预算不够时先量化 KV，再砍上下文', () => {
  const plan = planLlamaParams({
    launch: { ctx: 32768, ngl: 99, kvType: 'f16', rawArgs: [] },
    fileSizeMb: 2456,
    summary,
    usableVramMb: 5000,
  })
  assert.equal(plan.changed, true)
  assert.ok(plan.estimatedVramMb <= 5000 * 0.96, `估算 ${plan.estimatedVramMb}`)
  assert.ok(plan.ctx <= 32768)
  assert.ok(['q8_0', 'q4_0'].includes(plan.kvType))
})

test('planLlamaParams：预算充足时不动参数', () => {
  const plan = planLlamaParams({
    launch: { ctx: 8192, ngl: 99, kvType: 'f16', rawArgs: [] },
    fileSizeMb: 2456,
    summary,
    usableVramMb: 6000,
  })
  assert.equal(plan.changed, false)
  assert.equal(plan.ctx, 8192)
  assert.equal(plan.kvType, 'f16')
})
