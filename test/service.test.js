/**
 * 共享服务死锁回归 + 任务取消。
 *
 * 背景（2026-11-03 实测）：#ensure 已持有全局锁时又调用公开 ensure()，
 * 会等待自己持有的锁 → 工具调用永久挂起、ComfyUI 永远不会启动、取消也无反应。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { Tracker } from '../lib/tracker.js'
import { anySignal } from '../lib/util.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'mock-openai.mjs')

async function makeConfig() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-service-'))
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

test('serviceId 共享服务：ensure(工作流) 不会死锁，能拉起服务', async (t) => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  await orchestrator.catalog.upsert({
    id: 'svc',
    kind: 'image',
    slot: 'gpu',
    runtime: 'process',
    port: 18321,
    launch: { exe: process.execPath, command: [fixture, '18321', 'svc'] },
    health: { path: '/v1/models' },
  })
  // 工作流文件要真实存在：ensure 现在会先做连通性检查
  const workflowFile = path.join(config.dataDir, 'dummy.json')
  await fsp.writeFile(workflowFile, JSON.stringify({ 1: { class_type: 'X', inputs: {} } }))
  await orchestrator.catalog.upsert({
    id: 'wf-a',
    kind: 'image',
    slot: 'gpu',
    runtime: 'workflow',
    serviceId: 'svc',
    port: 8188,
    workflow: workflowFile,
  })

  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ensure 超时（疑似死锁）')), 15000)
  })
  let instance
  try {
    instance = await Promise.race([orchestrator.ensure('wf-a'), deadline])
  } finally {
    clearTimeout(timer)
  }
  assert.equal(instance.state, 'ready')
  assert.equal(instance.port, 18321)
  assert.equal(orchestrator.instances.get('svc').state, 'ready')

  // 卸载标记不应杀共享服务
  await orchestrator.stop('wf-a')
  assert.equal(orchestrator.instances.has('wf-a'), false)
  assert.equal(orchestrator.instances.get('svc').state, 'ready')
})

test('tracker：取消任务会 abort 信号并标记 cancelled', () => {
  const tracker = new Tracker()
  const run = tracker.start({ kind: 'generate', title: '出图' })
  const node = tracker.node(run.id, { kind: 'comfy', label: '提交工作流' })
  assert.equal(run.signal.aborted, false)

  const cancelled = tracker.cancel(run.id)
  assert.equal(cancelled, true)
  assert.equal(run.signal.aborted, true)
  assert.equal(run.status, 'cancelled')
  assert.equal(tracker.get(run.id).nodes[0].status, 'skipped')
  assert.equal(tracker.cancel('nope'), false)
  assert.equal(tracker.hasRunning(), false)
})

test('anySignal：任一来源取消都生效', () => {
  const a = new AbortController()
  const b = new AbortController()
  const merged = anySignal(a.signal, b.signal)
  assert.equal(merged.aborted, false)
  b.abort(new Error('cancel'))
  assert.equal(merged.aborted, true)
})

test('API：cancel 动作能取消运行中的任务', async () => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  await orchestrator.start()
  const { createApi } = await import('../lib/api.js')
  const api = createApi({ config, orchestrator, decision: { complete: async () => ({ ok: true, text: '' }) } })
  const run = orchestrator.tracker.start({ kind: 'generate', title: 't' })
  const res = await api({ method: 'POST', path: '/action', body: { action: 'cancel', runId: run.id } })
  assert.equal(res.status, 200)
  assert.equal(orchestrator.tracker.get(run.id).status, 'cancelled')
  orchestrator.dispose()
})
