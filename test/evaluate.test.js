/**
 * P3：评估步骤（evaluate）与资产依赖/峰值显存。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { Decision } from '../lib/decision.js'
import { Catalog } from '../lib/catalog.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

async function makeConfig() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-p3-'))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '', comfyDir: '' })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  return config
}

/** 只实现 executeStep 依赖的那几个方法。 */
function fakeOrchestrator({ reply } = {}) {
  const calls = []
  return {
    calls,
    catalog: { list: () => [], get: () => null },
    async pick() {
      return { asset: { id: 'qwen25vl', kind: 'vlm' } }
    },
    async runChat(id, options) {
      calls.push({ id, prompt: options.messages?.[0]?.content })
      return {
        ok: true,
        content: reply ?? JSON.stringify({ pass: true, score: 88, issues: ['饱和度偏高'], verdict: '基本可用' }),
        usage: { total_tokens: 120 },
      }
    },
  }
}

test('evaluate：解析模型 JSON 结论，输出评分与问题', async () => {
  const config = await makeConfig()
  const orchestrator = fakeOrchestrator()
  const decision = new Decision({ config, ctx: null, orchestrator })
  const out = await decision.executeStep(
    { index: 1, goal: '评审海报', kind: 'evaluate', dependsOn: [0], rubric: '文字是否清晰' },
    { results: [{ index: 0, goal: '出海报', ok: true, output: 'http://127.0.0.1:8188/view?filename=a.png' }] },
  )
  assert.equal(out.ok, true)
  assert.match(out.output, /评分：88/)
  assert.match(out.output, /饱和度偏高/)
  assert.equal(out.asset, 'qwen25vl')
  assert.match(orchestrator.calls[0].prompt, /文字是否清晰/)
})

test('evaluate：模型判不通过时步骤失败', async () => {
  const config = await makeConfig()
  const orchestrator = fakeOrchestrator({ reply: '{"pass":false,"score":30,"issues":["文字糊了"],"verdict":"不可用"}' })
  const decision = new Decision({ config, ctx: null, orchestrator })
  const out = await decision.executeStep(
    { index: 1, goal: '评审', kind: 'evaluate', dependsOn: [0] },
    { results: [{ index: 0, goal: '出图', ok: true, output: 'http://x/a.png' }] },
  )
  assert.equal(out.ok, false)
  assert.match(out.output, /不可用/)
})

test('evaluate：没有上游产出时直接失败，不浪费模型调用', async () => {
  const config = await makeConfig()
  const orchestrator = fakeOrchestrator()
  const decision = new Decision({ config, ctx: null, orchestrator })
  const out = await decision.executeStep({ index: 0, goal: '评审', kind: 'evaluate', dependsOn: [] }, { results: [] })
  assert.equal(out.ok, false)
  assert.match(out.output, /没有可评估的上游产出/)
  assert.equal(orchestrator.calls.length, 0)
})

test('catalog：peakVramMb 只升不降，group / requires 透传', async () => {
  const config = await makeConfig()
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({
    id: 'minimax-h3-t2v',
    kind: 'video',
    runtime: 'workflow',
    serviceId: 'comfyui',
    group: 'minimax-h3',
    requires: [{ asset: 'comfyui', role: 'framework' }],
    cost: { vramMb: 1000, loadMs: 1000 },
  })

  const asset = catalog.get('minimax-h3-t2v')
  assert.equal(asset.group, 'minimax-h3')
  assert.equal(asset.requires[0].asset, 'comfyui')
  assert.equal(asset.requires[0].role, 'framework')

  await catalog.noteLoad('minimax-h3-t2v', { vramMb: 5200, loadMs: 800 })
  assert.equal(catalog.get('minimax-h3-t2v').peakVramMb, 5200)
  // 下一次占用更低，峰值不回退（预算按最坏情况）
  await catalog.noteLoad('minimax-h3-t2v', { vramMb: 3800, loadMs: 700 })
  assert.equal(catalog.get('minimax-h3-t2v').peakVramMb, 5200)
})
