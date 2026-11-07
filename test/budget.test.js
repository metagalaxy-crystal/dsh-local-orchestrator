/**
 * 预算表：LLM / 工作流 / 脚本 / MCP 统一记账。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { BudgetTable, sourceOf } from '../lib/budget.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'

test('budget：登记 / 释放 / 按科目合计', () => {
  const budget = new BudgetTable({})
  budget.open({ source: 'llm', assetId: 'qwen36', vramMb: 4680 })
  budget.open({ source: 'workflow', assetId: 'minimax-h3-t2v', vramMb: 6100 })
  budget.open({ source: 'script', assetId: 'moss-tts', ramMb: 4096 })

  const committed = budget.committed()
  assert.equal(committed.vramMb, 10780)
  assert.equal(committed.ramMb, 4096)
  assert.equal(committed.bySource.llm, 4680)

  const snap = budget.snapshot({ vramUsableMb: 5100, vramReservedMb: 1400, vramTotalMb: 8151 })
  assert.equal(snap.usableMb, 5100)
  assert.equal(snap.entries.length, 3)
  assert.equal(snap.bySource.find((item) => item.source === 'workflow').vramMb, 6100)

  // 以硬件可用量为准，不重复扣减
  assert.equal(budget.check({ needVramMb: 4000, budget: { vramUsableMb: 5100 } }).ok, true)
  assert.equal(budget.check({ needVramMb: 6000, budget: { vramUsableMb: 5100 } }).ok, false)
  assert.equal(budget.check({ needVramMb: 9999, budget: {} }).ok, true)

  budget.closeByAsset('qwen36', '卸载')
  assert.equal(budget.committed().vramMb, 6100)
})

test('budget：sourceOf 按运行时 / 能力归类', () => {
  assert.equal(sourceOf({ runtime: 'llama.cpp', kind: 'llm' }), 'llm')
  assert.equal(sourceOf({ runtime: 'workflow', kind: 'video' }), 'workflow')
  assert.equal(sourceOf({ runtime: 'process', kind: 'image' }), 'workflow')
  assert.equal(sourceOf({ runtime: 'llama.cpp', serviceId: 'comfyui' }), 'workflow')
  assert.equal(sourceOf({ runtime: 'process', script: { file: 'x.py' } }), 'script')
  assert.equal(sourceOf({ runtime: 'mcp', kind: 'tool' }), 'mcp')
  assert.equal(sourceOf({ runtime: 'process', kind: 'audio-tts' }), 'script')
})

test('budget：加载登记、卸载释放（与实例生命周期对齐）', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-budget-'))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '' })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.hardware.probeIntervalMs = 0
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  await orchestrator.catalog.upsert({
    id: 'budget-mock',
    kind: 'llm',
    runtime: 'process',
    slot: 'gpu',
    port: 18579,
    launch: {
      exe: process.execPath,
      command: [path.join(process.cwd(), 'test', 'fixtures', 'mock-openai.mjs'), '18579', 'budget-mock'],
    },
    health: { path: '/v1/models', alias: 'budget-mock' },
    cost: { vramMb: null, ramMb: 512, loadMs: 1000, estimated: true },
  })

  await orchestrator.ensure('budget-mock', { reason: 'test' })
  const entry = orchestrator.budget.find('budget-mock')
  assert.ok(entry, '加载后应在预算表里有一条登记')
  assert.equal(entry.source, 'llm')

  await orchestrator.stop('budget-mock', { reason: 'test' })
  assert.equal(orchestrator.budget.find('budget-mock'), null, '卸载后应释放预算')
})
