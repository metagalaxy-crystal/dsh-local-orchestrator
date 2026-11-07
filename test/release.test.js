/**
 * 任务结束自动释放：tracker 状态 + releaseIdle 行为 + 调度触发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { Tracker } from '../lib/tracker.js'

async function makeConfig(extra = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-release-'))
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
  return Object.assign(config, extra)
}

function fakeInstance(orchestrator, id, { pinned = false } = {}) {
  const asset = orchestrator.catalog.get(id)
  asset.pinned = pinned
  const instance = {
    asset,
    port: asset.port,
    state: 'ready',
    pid: null,
    proc: null,
    adopted: true,
    startedAt: Date.now() - 60_000,
    lastUsedAt: Date.now() - 60_000,
    vramMb: 100,
  }
  orchestrator.instances.set(id, instance)
  return instance
}

test('tracker：hasRunning 反映任务状态', () => {
  const tracker = new Tracker()
  assert.equal(tracker.hasRunning(), false)
  const run = tracker.start({ kind: 'chat', title: 't' })
  assert.equal(tracker.hasRunning(), true)
  tracker.end(run.id, 'done')
  assert.equal(tracker.hasRunning(), false)
})

test('releaseIdle：释放未 pinned 的实例，保留 pinned 与 MCP', async (t) => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  for (const id of ['a', 'b', 'c']) {
    await orchestrator.catalog.upsert({
      id,
      kind: id === 'c' ? 'tool' : 'llm',
      runtime: id === 'c' ? 'mcp' : 'process',
      slot: 'cpu',
      port: id === 'c' ? 0 : 18400 + id.charCodeAt(0),
      launch: { exe: process.execPath, command: ['noop.mjs'] },
    })
  }
  fakeInstance(orchestrator, 'a')
  fakeInstance(orchestrator, 'b', { pinned: true })
  fakeInstance(orchestrator, 'c')

  const stopped = await orchestrator.releaseIdle({ minIdleSec: 0 })
  assert.deepEqual(stopped.sort(), ['a'])
  assert.equal(orchestrator.instances.has('a'), false)
  assert.equal(orchestrator.instances.has('b'), true) // pinned 保留
  assert.equal(orchestrator.instances.has('c'), true) // MCP 外部服务保留
})

test('releaseIdle：minIdleSec 未到不释放', async () => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  await orchestrator.start()
  await orchestrator.catalog.upsert({ id: 'x', kind: 'llm', runtime: 'process', slot: 'cpu', port: 18450, launch: { exe: process.execPath, command: ['noop.mjs'] } })
  fakeInstance(orchestrator, 'x')
  orchestrator.instances.get('x').lastUsedAt = Date.now()
  const stopped = await orchestrator.releaseIdle({ minIdleSec: 60 })
  assert.deepEqual(stopped, [])
  orchestrator.dispose()
})

test('任务结束：releaseAfterTaskSec 后自动释放，新任务会取消', async (t) => {
  const config = await makeConfig()
  config.scheduler.releaseAfterTaskSec = 0.15
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  await orchestrator.catalog.upsert({ id: 'x', kind: 'llm', runtime: 'process', slot: 'cpu', port: 18451, launch: { exe: process.execPath, command: ['noop.mjs'] } })
  fakeInstance(orchestrator, 'x')

  const run = orchestrator.tracker.start({ kind: 'chat', title: 't' })
  // 有任务在跑时不释放
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(orchestrator.instances.has('x'), true)

  orchestrator.tracker.end(run.id, 'done')
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(orchestrator.instances.has('x'), false)
})
