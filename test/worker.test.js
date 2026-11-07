/**
 * 后台执行环测试：自动推进、公平轮转、require 停机 + 唤醒、租约互斥、手动模式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { Worker } from '../lib/worker.js'

async function setup({ background = true, executeStep = null } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-worker-'))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '' })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.tasks.background = background
  config.hardware.probeIntervalMs = 0
  const orchestrator = new Orchestrator({ config })
  await orchestrator.start()

  const decision = {
    executeStep:
      executeStep ??
      (async (step) => ({ ok: true, output: `产出-${step.goal}`, asset: 'stub', ms: 2 })),
  }
  const wakeCalls = []
  const worker = new Worker({
    orchestrator,
    decision,
    config,
    wake: async (sessionId, payload) => {
      wakeCalls.push({ sessionId, payload })
      return true
    },
  })
  orchestrator.worker = worker
  return { orchestrator, worker, store: orchestrator.tasks, config, wakeCalls }
}

function steps(...goals) {
  return goals.map((goal) => ({ goal, kind: 'llm' }))
}

test('worker：running 的任务会被一步步跑完', async () => {
  const { orchestrator, worker, store } = await setup()
  const task = store.create({ sessionId: 's1', goal: '两步', steps: steps('一', '二') })
  store.setStatus(task, 'running')
  await store.save(task)

  await worker.tick()
  assert.equal(task.steps[0].status, 'done')
  assert.equal(task.status, 'running')

  await worker.tick()
  assert.equal(task.steps[1].status, 'done')
  assert.equal(task.status, 'done')
  orchestrator.dispose()
})

test('worker：queued（没人跑第一步）的任务不会被动', async () => {
  const { orchestrator, worker, store } = await setup()
  const task = store.create({ sessionId: 's1', goal: '没开始', steps: steps('一') })
  await worker.tick()
  assert.equal(task.steps[0].status, 'pending')
  assert.equal(task.status, 'queued')
  orchestrator.dispose()
})

test('worker：autoAdvance=false 的任务只能手动推进', async () => {
  const { orchestrator, worker, store } = await setup({ background: false })
  const task = store.create({ sessionId: 's1', goal: '手动', steps: steps('一') })
  assert.equal(task.autoAdvance, false)
  store.setStatus(task, 'running')
  await store.save(task)
  await worker.tick()
  assert.equal(task.steps[0].status, 'pending')
  orchestrator.dispose()
})

test('worker：按会话公平轮转，别的会话的任务不会被饿死', async () => {
  const { orchestrator, worker, store, config } = await setup()
  config.tasks.maxSteps = 10
  const a = store.create({ sessionId: 'sess-a', goal: 'A', steps: steps('a1', 'a2', 'a3') })
  const b = store.create({ sessionId: 'sess-b', goal: 'B', steps: steps('b1', 'b2', 'b3') })
  store.setStatus(a, 'running')
  store.setStatus(b, 'running')
  await store.save(a)
  await store.save(b)

  const order = []
  const wrapped = orchestrator.tasks
  const realCreate = wrapped
  for (let i = 0; i < 4; i += 1) {
    await worker.tick()
    const last = worker._lastSession
    order.push(last)
  }
  assert.deepEqual(order, ['sess-a', 'sess-b', 'sess-a', 'sess-b'])
  assert.equal(realCreate.get(a.id).steps[0].status, 'done')
  assert.equal(realCreate.get(b.id).steps[0].status, 'done')
  orchestrator.dispose()
})

test('worker：verification=require 时停下并唤醒所属会话', async () => {
  const { orchestrator, worker, store, wakeCalls } = await setup()
  const task = store.create({
    sessionId: 'sess-need',
    goal: '要判断的任务',
    steps: [{ goal: '出图', kind: 'llm', verification: { mode: 'require' } }],
  })
  store.setStatus(task, 'running')
  await store.save(task)

  await worker.tick()
  assert.equal(task.status, 'waiting_decision')
  assert.equal(wakeCalls.length, 1)
  assert.equal(wakeCalls[0].sessionId, 'sess-need')
  assert.match(wakeCalls[0].payload.prompt, /local_task/)

  // 冷却期内不会重复唤醒
  await worker.tick()
  assert.equal(wakeCalls.length, 1)
  orchestrator.dispose()
})

test('worker：步骤失败两次后任务 error 并唤醒', async () => {
  const { orchestrator, worker, store, wakeCalls } = await setup({
    executeStep: async () => ({ ok: false, output: 'boom', ms: 1 }),
  })
  const task = store.create({ sessionId: 'sess-fail', goal: '会失败', steps: steps('一') })
  store.setStatus(task, 'running')
  await store.save(task)

  await worker.tick() // 第一次失败 → 自动重试
  assert.equal(task.steps[0].status, 'pending')
  await worker.tick() // 第二次失败 → error
  assert.equal(task.steps[0].status, 'error')
  assert.equal(task.status, 'error')
  assert.equal(wakeCalls.length, 1)
  orchestrator.dispose()
})

test('worker：GPU 租约被占时让路，释放后继续', async () => {
  const { orchestrator, worker, store } = await setup()
  const held = orchestrator.leases.acquire({ slot: 'gpu', assetId: 'comfyui', sessionId: 'other', ttlMs: 60000 })
  assert.equal(held.ok, true)

  const task = store.create({ sessionId: 's1', goal: '等资源', steps: steps('一') })
  store.setStatus(task, 'running')
  await store.save(task)

  await worker.tick()
  assert.equal(task.steps[0].status, 'pending')
  assert.equal(task.steps[0].attempts, 0)

  orchestrator.leases.release(held.lease.id, 'test')
  await worker.tick()
  assert.equal(task.steps[0].status, 'done')
  // 步骤结束后租约已释放
  assert.equal(orchestrator.leases.active().length, 0)
  orchestrator.dispose()
})

test('worker：与 local_step 共用同一个 StepRunner', async () => {
  const { orchestrator, worker } = await setup()
  assert.equal(orchestrator.steps, worker.runner)
  assert.equal(typeof orchestrator.steps.abortTask, 'function')
  orchestrator.dispose()
})

test('worker：暂停会真正打断正在跑的步骤，且不消耗重试次数', async () => {
  const slow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 180))
    return { ok: true, output: 'late', ms: 180 }
  }
  const { orchestrator, worker, store } = await setup({ executeStep: slow })
  const task = store.create({ sessionId: 's1', goal: '慢任务', steps: steps('一') })
  store.setStatus(task, 'running')
  await store.save(task)

  const running = worker.tick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const aborted = orchestrator.steps.abortTask(task.id, 'paused')
  await running

  assert.equal(aborted, true)
  assert.equal(task.steps[0].status, 'pending')
  assert.equal(task.steps[0].attempts, 0)
  assert.equal(task.status, 'paused')
  // 租约已释放，不占着 GPU 槽
  assert.equal(orchestrator.leases.active().length, 0)
  orchestrator.dispose()
})
