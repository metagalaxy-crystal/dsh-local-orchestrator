/**
 * 本地决策模型：JSON 约束 + 一次重试 + 退化单步兜底。
 *
 * 背景：nanbeige 3B 直接产 JSON 计划经常「解释 + JSON」或空壳，不重试就会让任务卡在规划阶段。
 * 这里不连真模型，用桩来固定这三个行为的边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Decision } from '../lib/decision.js'

function makeDecision(replies) {
  const calls = []
  const orchestrator = {
    catalog: {
      list: () => [{ id: 'nanbeige', kind: 'llm', enabled: true, task: '小模型', measured: {}, cost: {}, instances: {} }],
      get: () => null,
    },
    tracker: { node: () => null, record: () => {}, finishNode: () => {} },
    instances: new Map(),
    async runChat(assetId, options) {
      calls.push({ assetId, options })
      const next = replies.shift()
      if (typeof next === 'function') return next(options)
      return { ok: true, content: next, usage: { total_tokens: 10 } }
    },
  }
  const config = { decision: { mode: 'local', localAsset: 'nanbeige', maxTokens: 500, maxSteps: 4 } }
  return { decision: new Decision({ config, orchestrator }), calls }
}

test('本地决策模型：第一次输出非 JSON，重试后拿到合法计划', async () => {
  const { decision, calls } = makeDecision([
    '好的，我来规划一下：先写文案。',
    JSON.stringify({ summary: '两步', steps: [{ goal: '写文案', kind: 'llm', asset: '', dependsOn: [] }, { goal: '润色', kind: 'llm', asset: '', dependsOn: [0] }] }),
  ])
  const plan = await decision.plan('写一段产品文案')
  assert.equal(plan.ok, true)
  assert.equal(plan.degraded, undefined)
  assert.equal(plan.plan.steps.length, 2)
  assert.equal(plan.plan.steps[1].dependsOn[0], 0)
  assert.equal(calls.length, 2)
  // 两次调用都要带 JSON 约束，小模型才稳
  assert.equal(calls[0].options.json, true)
  assert.equal(calls[1].options.json, true)
})

test('本地决策模型：两次都不合法时退化为单步，而不是失败', async () => {
  const { decision } = makeDecision(['no json', 'still no json'])
  const plan = await decision.plan('整理一下下载目录')
  assert.equal(plan.ok, true)
  assert.equal(plan.degraded, true)
  assert.equal(plan.plan.steps.length, 1)
  assert.equal(plan.plan.steps[0].goal, '整理一下下载目录')
  assert.equal(plan.plan.steps[0].kind, 'llm')
})

test('本地决策模型：调用本身失败仍返回错误（不吞掉）', async () => {
  const { decision } = makeDecision([() => ({ ok: false, error: '模型未加载' })])
  const plan = await decision.plan('随便')
  assert.equal(plan.ok, false)
  assert.match(plan.error, /模型未加载/)
})

// ---------------------------------------------------------------- dsh（当前会话的 DeepSeek）
function makeDshDecision({ selection = { provider: 'deepseek', model: 'deepseek-v4' }, chunks = [], providers = null } = {}) {
  const seen = []
  const llm = {
    async listProviders() {
      return providers ?? [{ id: 'deepseek', name: 'DeepSeek' }]
    },
    async listModels(provider) {
      return [{ provider, id: 'fallback-model', name: 'fallback' }]
    },
    async *stream(options) {
      seen.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => selection },
  }
  const ctx = { get: (name) => services[name] ?? null, llm }
  const orchestrator = {
    catalog: { list: () => [], get: () => null },
    tracker: { node: () => null, record: () => {}, finishNode: () => {} },
    instances: new Map(),
  }
  const config = { decision: { mode: 'dsh', maxTokens: 400 } }
  return { decision: new Decision({ config, ctx, orchestrator }), seen }
}

test('dsh 模式：provider/model 留空时复用会话默认选择（不另配密钥）', async () => {
  const { decision, seen } = makeDshDecision({
    chunks: [
      { type: 'text-delta', text: '{"summary":"ok",' },
      { type: 'text-delta', text: '"steps":[{"goal":"写","kind":"llm","dependsOn":[]}]}' },
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const plan = await decision.plan('写点东西')
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.steps.length, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'deepseek')
  assert.equal(seen[0].model, 'deepseek-v4')
  assert.equal(plan.model, 'deepseek/deepseek-v4')
})

test('dsh 模式：流里 finish=error 时返回错误，而不是空计划', async () => {
  const { decision } = makeDshDecision({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: '401 unauthorized', code: 'auth' } } }],
  })
  const plan = await decision.plan('随便')
  assert.equal(plan.ok, false)
  assert.match(plan.error, /401 unauthorized/)
})

test('dsh 模式：拿不到会话默认模型时回落到第一个 provider/model', async () => {
  const { decision, seen } = makeDshDecision({
    selection: null,
    chunks: [
      { type: 'text-delta', text: '{"summary":"s","steps":[{"goal":"g","kind":"llm","dependsOn":[]}]}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const plan = await decision.plan('任务')
  assert.equal(plan.ok, true)
  assert.equal(seen[0].provider, 'deepseek')
  assert.equal(seen[0].model, 'fallback-model')
})
