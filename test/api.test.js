/**
 * 数据面测试：tracker 的框图/IO 结构，以及 api.js 的路由与持久化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { createApi, publicConfig } from '../lib/api.js'
import { Tracker } from '../lib/tracker.js'

async function makeConfig() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-api-'))
  const config = DEFAULT_CONFIG({
    modelsRoot: '', llamaDir: '', llamaServer: '', registry: '', comfyDir: '', comfyPython: 'python', outputRoot: '',
  })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.scheduler.idleUnloadSec = 0
  config.hardware.probeIntervalMs = 0
  return config
}

test('tracker：节点状态、进度与 IO 分通道', () => {
  const tracker = new Tracker()
  const run = tracker.start({ kind: 'delegate', title: '写一段文案' })
  const plan = tracker.node(run.id, { kind: 'decision', label: '规划' })
  tracker.record({ runId: run.id, nodeId: plan.id, channel: 'decision', kind: 'request', title: '输入', content: '任务' })
  tracker.finishNode(run.id, plan.id, 'done', '2 步')
  const step = tracker.node(run.id, { kind: 'local-llm', label: '本地推理 · lfm' })
  tracker.record({ runId: run.id, nodeId: step.id, channel: 'local', kind: 'response', title: '输出', content: '文案' })
  tracker.finishNode(run.id, step.id, 'done', '1.2s')
  tracker.end(run.id, 'done', '完成')

  const [snap] = tracker.snapshot()
  assert.equal(snap.status, 'done')
  assert.equal(snap.nodes.length, 2)
  assert.equal(snap.nodes[0].status, 'done')
  assert.ok(snap.ms >= 0)

  const io = tracker.ioSnapshot()
  assert.equal(io.decision.length, 1)
  assert.equal(io.local.length, 1)
  assert.equal(io.mcp.length, 0)
})

test('api：state / 资产增改删 / 配置读写 / 决策自检', async (t) => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.catalog.upsert({
    id: 'mock-a', name: 'Mock A', kind: 'llm', runtime: 'process', slot: 'cpu', port: 18301,
    launch: { exe: process.execPath, command: ['noop.mjs'] },
    cost: { vramMb: 100, ramMb: 10, loadMs: 1000, estimated: true },
  })
  const decision = { mode: 'session', complete: async () => ({ ok: true, text: 'ok', model: 'stub' }) }
  const api = createApi({ config, orchestrator, decision })

  const state = await api({ method: 'GET', path: '/state' })
  assert.equal(state.status, 200)
  assert.equal(state.body.ok, true)
  assert.equal(state.body.value.assets.length, 1)
  assert.equal(state.body.value.config.decision.mode, 'session')
  assert.deepEqual(state.body.value.runs, [])
  // token 用量快照：即使还没调用过也要有结构（前端按它渲染「用量」页）
  assert.ok(state.body.value.usage, 'state 应带 usage')
  assert.equal(state.body.value.usage.summary.calls, 0)
  assert.deepEqual(state.body.value.usage.recent, [])

  const pin = await api({ method: 'POST', path: '/assets', body: { asset: { id: 'mock-a', pinned: true } } })
  assert.equal(pin.status, 200)
  assert.equal(pin.body.value.asset.pinned, true)
  assert.equal(orchestrator.catalog.get('mock-a').launch.exe, process.execPath) // 合并不丢字段

  const one = await api({ method: 'GET', path: '/assets/mock-a' })
  assert.equal(one.status, 200)
  assert.equal(one.body.value.launch.exe, process.execPath)
  assert.equal(one.body.value.pinned, true)

  const saved = await api({ method: 'PUT', path: '/config', body: { patch: { scheduler: { idleUnloadSec: 600 } } } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.value.scheduler.idleUnloadSec, 600)
  const reloaded = JSON.parse(await fsp.readFile(config.configFile, 'utf8'))
  assert.equal(reloaded.scheduler.idleUnloadSec, 600)

  const masked = publicConfig({ ...config, decision: { ...config.decision, apiKey: 'sk-test' } })
  assert.equal(masked.decision.apiKey, '***')

  const ioTest = await api({ method: 'POST', path: '/decision/test', body: { prompt: 'hi' } })
  assert.equal(ioTest.status, 200)
  assert.equal(ioTest.body.value.text, 'ok')

  const cleared = await api({ method: 'POST', path: '/action', body: { action: 'clear_runs' } })
  assert.equal(cleared.status, 200)

  const removed = await api({ method: 'DELETE', path: '/assets/mock-a' })
  assert.equal(removed.status, 200)
  assert.equal(orchestrator.catalog.get('mock-a'), null)

  const missing = await api({ method: 'GET', path: '/nope' })
  assert.equal(missing.status, 404)
})
