/**
 * 任务池测试：状态机、按会话隔离、持久化恢复、预算熔断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { TaskStore } from '../lib/tasks.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { buildTools } from '../lib/tools.js'

async function makeStore(config = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-tasks-'))
  const store = new TaskStore({ dir, config: { tasks: { maxSteps: 8, maxWallMin: 30, keepFinished: 100 } } })
  await store.load()
  return { store, dir }
}

function steps(...goals) {
  return goals.map((goal, index) => ({ goal, kind: 'llm', dependsOn: index === 0 ? [] : [index - 1] }))
}

test('tasks：按会话隔离，list 只返回自己的任务', async () => {
  const { store } = await makeStore()
  const a = store.create({ sessionId: 'sess-a', goal: 'A 的任务', steps: steps('a1', 'a2') })
  const b = store.create({ sessionId: 'sess-b', goal: 'B 的任务', steps: steps('b1') })

  assert.equal(store.list({ sessionId: 'sess-a' }).length, 1)
  assert.equal(store.list({ sessionId: 'sess-a' })[0].id, a.id)
  assert.equal(store.list({ sessionId: 'sess-b' })[0].id, b.id)
  assert.equal(store.list({ all: true }).length, 2)

  assert.equal(store.owns(a, 'sess-a'), true)
  assert.equal(store.owns(a, 'sess-b'), false)
})

test('tasks：迁移校验，非法迁移直接报错', async () => {
  const { store } = await makeStore()
  const task = store.create({ sessionId: 's', goal: 'g', steps: steps('one') })
  assert.throws(() => store.setStatus(task, 'waiting_decision'), /不能从 queued 迁移到 waiting_decision/)
  store.setStatus(task, 'running')
  store.setStatus(task, 'done')
  assert.throws(() => store.setStatus(task, 'running'), /不能从 done 迁移到 running/)
})

test('tasks：重启恢复，running 降级为 paused、执行中步骤回到 pending', async () => {
  const { store, dir } = await makeStore()
  const task = store.create({ sessionId: 's', goal: 'g', steps: steps('one', 'two') })
  store.beginStep(task, task.steps[0])
  await store.save(task)

  const reloaded = new TaskStore({ dir, config: {} })
  await reloaded.load()
  const restored = reloaded.get(task.id)
  assert.equal(restored.status, 'paused')
  assert.equal(restored.steps[0].status, 'pending')
  assert.match(restored.pauseReason, /重启/)
})

test('tasks：suspendSession 只回退本会话在执行中的步骤', async () => {
  const { store } = await makeStore()
  const a = store.create({ sessionId: 'sess-a', goal: 'A', steps: steps('a1') })
  const b = store.create({ sessionId: 'sess-b', goal: 'B', steps: steps('b1') })
  store.beginStep(a, a.steps[0])
  store.beginStep(b, b.steps[0])

  const touched = await store.suspendSession('sess-a', 'DSH 回合结束')
  assert.deepEqual(touched, [a.id])
  assert.equal(a.status, 'paused')
  assert.equal(a.steps[0].status, 'pending')
  // B 完全不受影响
  assert.equal(b.status, 'running')
  assert.equal(b.steps[0].status, 'running')
})

test('tasks：cancelSession 只取消本会话任务', async () => {
  const { store } = await makeStore()
  const a = store.create({ sessionId: 'sess-a', goal: 'A', steps: steps('a1') })
  const b = store.create({ sessionId: 'sess-b', goal: 'B', steps: steps('b1') })
  const cancelled = await store.cancelSession('sess-a', '用户取消')
  assert.deepEqual(cancelled, [a.id])
  assert.equal(store.get(a.id).status, 'cancelled')
  assert.equal(store.get(b.id).status, 'queued')
})

test('tasks：失败步骤先自动重试一次，第二次失败任务转 error', async () => {
  const { store } = await makeStore()
  const task = store.create({ sessionId: 's', goal: 'g', steps: steps('one') })
  const step = task.steps[0]
  store.beginStep(task, step)
  store.finishStep(task, step, { ok: false, output: 'boom' })
  assert.equal(step.status, 'pending')
  assert.equal(step.attempts, 1)

  store.beginStep(task, step)
  store.finishStep(task, step, { ok: false, output: 'boom again' })
  assert.equal(step.status, 'error')
  assert.equal(task.status, 'error')
})

test('tasks：完成全部步骤后任务自动 done', async () => {
  const { store } = await makeStore()
  const task = store.create({ sessionId: 's', goal: 'g', steps: steps('one') })
  store.beginStep(task, task.steps[0])
  store.finishStep(task, task.steps[0], { ok: true, output: '结果' })
  assert.equal(task.status, 'done')
  assert.equal(store.isComplete(task), true)
  assert.equal(task.artifacts.length, 1)
})

test('tools：local_task / local_step 串起来跑完一个两步任务', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-tasktools-'))
  const config = DEFAULT_CONFIG({
    modelsRoot: '',
    llamaDir: '',
    llamaServer: '',
    registry: '',
    comfyDir: '',
    comfyPython: 'python',
    outputRoot: '',
  })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.hardware.probeIntervalMs = 0
  const orchestrator = new Orchestrator({ config })

  const calls = []
  const decision = {
    available: false,
    executeStep: async (step) => {
      calls.push(step.index)
      return { ok: true, output: `产出-${step.goal}`, asset: 'stub', ms: 3 }
    },
  }
  const tools = Object.fromEntries(
    buildTools({ orchestrator, decision, config }).map((tool) => [tool.name, tool]),
  )
  const exec = { agent: { id: 'sess-a' }, signal: undefined }

  const created = await tools.local_task.execute(
    { action: 'create', goal: '两步任务', steps: steps('第一步', '第二步') },
    exec,
  )
  assert.equal(created.ok, true)
  const taskId = created.text.match(/已建任务 (\S+?)（/)[1]

  const first = await tools.local_step.execute({ action: 'run', taskId }, exec)
  assert.equal(first.ok, true, first.text)

  const second = await tools.local_step.execute({ action: 'run', taskId }, exec)
  assert.equal(second.ok, true, second.text)
  assert.deepEqual(calls, [0, 1])

  const done = orchestrator.tasks.get(taskId)
  assert.equal(done.status, 'done')

  // 其它会话看不到，也不能操作
  const other = { agent: { id: 'sess-b' } }
  const listB = await tools.local_task.execute({ action: 'list' }, other)
  assert.match(listB.text, /没有任务/)
  const runB = await tools.local_step.execute({ action: 'run', taskId }, other)
  assert.equal(runB.ok, false)
  assert.match(runB.text, /属于其它会话/)

  orchestrator.dispose()
})

test('tools：local_service cancel 只取消本会话的 run', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-cancel-'))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '' })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.hardware.probeIntervalMs = 0
  const orchestrator = new Orchestrator({ config })
  const tools = Object.fromEntries(
    buildTools({ orchestrator, decision: { available: false }, config }).map((tool) => [tool.name, tool]),
  )
  const runA = orchestrator.tracker.start({ kind: 'chat', title: 'A', sessionId: 'sess-a' })
  const runB = orchestrator.tracker.start({ kind: 'chat', title: 'B', sessionId: 'sess-b' })

  const out = await tools.local_service.execute({ action: 'cancel' }, { agent: { id: 'sess-a' } })
  assert.equal(out.ok, true)
  assert.equal(runA.status, 'cancelled')
  assert.equal(runB.status, 'running')
  orchestrator.dispose()
})

test('tools：预算上限会停下任务而不是无限跑', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-taskbudget-'))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '' })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.tasks.maxSteps = 1
  const orchestrator = new Orchestrator({ config })
  const decision = {
    available: false,
    executeStep: async (step) => ({ ok: true, output: 'ok', ms: 1 }),
  }
  const tools = Object.fromEntries(
    buildTools({ orchestrator, decision, config }).map((tool) => [tool.name, tool]),
  )
  const exec = { agent: { id: 'sess-a' } }
  const created = await tools.local_task.execute(
    { action: 'create', goal: 'g', steps: steps('一', '二') },
    exec,
  )
  const taskId = created.text.match(/已建任务 (\S+?)（/)[1]
  await tools.local_step.execute({ action: 'run', taskId }, exec)
  const blocked = await tools.local_step.execute({ action: 'run', taskId }, exec)
  assert.equal(blocked.ok, false)
  assert.match(blocked.text, /步数上限/)
  orchestrator.dispose()
})
