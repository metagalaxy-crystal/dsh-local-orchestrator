/**
 * 端到端集成测试：工具调用 → manager 加载/推理 → tracker 记录 → /state 输出。
 * 这条链路正是「本地调度」页签消费的数据，验证它就能证明 UI 不是空壳。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { buildTools } from '../lib/tools.js'
import { createApi } from '../lib/api.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'mock-openai.mjs')

async function makeConfig() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-int-'))
  const config = DEFAULT_CONFIG({
    modelsRoot: '', llamaDir: '', llamaServer: '', registry: '', comfyDir: '', comfyPython: 'python', outputRoot: '',
  })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.scheduler.idleUnloadSec = 0
  config.scheduler.autoTune = false
  config.hardware.probeIntervalMs = 0
  return config
}

test('工具 → 编排 → /state：load 节点、推理节点与 IO 三通道都进入快照', async (t) => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.catalog.upsert({
    id: 'mock-a',
    name: 'Mock A',
    kind: 'llm',
    runtime: 'process',
    slot: 'cpu',
    port: 18311,
    launch: { exe: process.execPath, command: [fixture, '18311', 'mock-a'] },
    health: { path: '/v1/models', alias: 'mock-a' },
    cost: { vramMb: 100, ramMb: 64, loadMs: 1000, estimated: true },
  })

  const decision = { mode: 'session', available: false, plan: async () => ({ ok: false }), execute: async () => ({ ok: false, steps: [] }) }
  const tools = buildTools({ orchestrator, decision, config })
  const chat = tools.find((tool) => tool.name === 'local_chat')
  const response = await chat.execute({ prompt: '介绍一下你自己', asset: 'mock-a' })
  assert.equal(response.ok, true)
  assert.match(response.text, /echo: 介绍一下你自己/)

  const api = createApi({ config, orchestrator, decision })
  const state = await api({ method: 'GET', path: '/state' })
  assert.equal(state.status, 200)
  const value = state.body.value

  // 资产与运行态
  assert.equal(value.assets.length, 1)
  assert.equal(value.assets[0].state, 'ready')

  // 任务框图：一个 run，两个节点（加载 + 本地推理）
  assert.equal(value.runs.length, 1)
  const run = value.runs[0]
  assert.equal(run.kind, 'chat')
  assert.equal(run.status, 'done')
  assert.deepEqual(run.nodes.map((node) => node.kind), ['load', 'local-llm'])
  assert.ok(run.nodes.every((node) => node.status === 'done'))

  // IO：本地通道有输入和输出
  const kinds = value.io.local.map((entry) => entry.kind)
  assert.ok(kinds.includes('request'))
  assert.ok(kinds.includes('response'))
  assert.match(value.io.local.find((entry) => entry.kind === 'request').content, /介绍一下你自己/)
})
