#!/usr/bin/env node
/**
 * 可复现数字：不需要真实模型，测的是「运行时」本身的三条性质。
 *
 *   node scripts/bench.mjs            # 表格输出
 *   node scripts/bench.mjs --json     # 额外输出 JSON
 *
 * 指标：
 *   1. recovery    任务恢复率：进程崩溃（running + 步骤 running）后重新加载，多少任务能续跑
 *   2. fairness    跨会话公平性：两个会话各 5 个任务，交替推进的最大连续独占步数
 *   3. stepOverhead 单步开销：StepRunner 包一层（claim/租约/落盘/判定）的平均毫秒数
 *
 * 这三条与硬件无关，换机器结果应一致（±计时抖动）；显存估算误差需要在真机上跑 --gpu。
 */
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { TaskStore } from '../lib/tasks.js'
import { Worker } from '../lib/worker.js'
import { ensureStepRunner } from '../lib/steps.js'

const jsonOut = process.argv.includes('--json')

async function makeConfig(tag) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), `dsh-lo-bench-${tag}-`))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '' })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.hardware.probeIntervalMs = 0
  config.tasks.background = true
  config.worker.tickMs = 1
  return config
}

const fakeDecision = (delayMs = 0) => ({
  available: false,
  async executeStep(step) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return { ok: true, output: `ok:${step.goal}`, asset: step.asset || 'stub', ms: delayMs }
  },
})

function makeSteps(n, prefix = 's') {
  return Array.from({ length: n }, (_, i) => ({ goal: `${prefix}${i + 1}`, kind: 'llm' }))
}

// ---------------------------------------------------------------- 1. 恢复率
async function benchRecovery({ tasks = 20, stepsPerTask = 3, crashed = 5 } = {}) {
  const config = await makeConfig('recovery')
  const store = new TaskStore({ dir: path.join(config.dataDir, 'tasks'), config })
  await store.load()

  const created = []
  for (let i = 0; i < tasks; i += 1) {
    const task = store.create({ sessionId: `sess-${i % 2}`, goal: `任务${i}`, steps: makeSteps(stepsPerTask) })
    created.push(task)
  }
  // 模拟崩溃瞬间：前 crashed 个任务在执行中，各自第 2 步卡在 running
  for (let i = 0; i < crashed; i += 1) {
    const task = created[i]
    store.setStatus(task, 'running')
    store.beginStep(task, task.steps[1])
  }
  for (const task of created) await store.save(task)
  await new Promise((resolve) => setTimeout(resolve, 60))

  // 「重启」：新的 store 扫同一个目录
  const reloaded = new TaskStore({ dir: path.join(config.dataDir, 'tasks'), config })
  await reloaded.load()
  const restored = reloaded.list({ all: true, limit: 1000 })
  const runningTasks = restored.filter((task) => task.pauseReason === '插件重启，任务已暂停')

  // 恢复后能继续跑：取第一个 paused 任务，resume 并执行一步
  const orchestrator = new Orchestrator({ config })
  const decision = fakeDecision()
  orchestrator.steps = ensureStepRunner({ orchestrator, decision, config })
  const target = runningTasks[0]
  let resumedOk = false
  if (target) {
    orchestrator.tasks = reloaded
    reloaded.setStatus(target, 'running', 'bench resume')
    const step = reloaded.nextStep(target)
    const out = await orchestrator.steps.run(target, step, {})
    resumedOk = out.ok === true
  }

  return {
    tasks,
    crashed,
    restored: restored.length,
    pausedAfterRestart: runningTasks.length,
    recoveryRate: Number((restored.length / tasks).toFixed(4)),
    resumeWorks: resumedOk,
  }
}

// ---------------------------------------------------------------- 2. 公平性
async function benchFairness({ sessions = 2, tasksPerSession = 5, stepsPerTask = 3, delayMs = 2 } = {}) {
  const config = await makeConfig('fairness')
  const orchestrator = new Orchestrator({ config })
  await orchestrator.start()
  const decision = fakeDecision(delayMs)
  const worker = new Worker({ orchestrator, decision, config })
  orchestrator.worker = worker

  const tasks = []
  for (let s = 0; s < sessions; s += 1) {
    for (let i = 0; i < tasksPerSession; i += 1) {
      const task = orchestrator.tasks.create({
        sessionId: `sess-${s}`,
        goal: `s${s}-t${i}`,
        steps: makeSteps(stepsPerTask),
      })
      orchestrator.tasks.setStatus(task, 'running')
      await orchestrator.tasks.save(task)
      tasks.push(task)
    }
  }

  const order = []
  let guard = 0
  while (orchestrator.tasks.list({ all: true, limit: 100 }).some((task) => task.status === 'running') && guard < 5000) {
    await worker.tick()
    if (worker._lastSession) order.push(worker._lastSession)
    guard += 1
  }

  let maxRun = 0
  let run = 0
  for (let i = 0; i < order.length; i += 1) {
    if (i > 0 && order[i] === order[i - 1]) run += 1
    else run = 1
    maxRun = Math.max(maxRun, run)
  }
  const counts = order.reduce((acc, item) => {
    acc[item] = (acc[item] ?? 0) + 1
    return acc
  }, {})

  return {
    sessions,
    tasks: tasks.length,
    steps: order.length,
    maxConsecutiveSameSession: maxRun,
    stepsPerSession: counts,
    allDone: tasks.every((task) => task.status === 'done'),
  }
}

// ---------------------------------------------------------------- 3. 单步开销
async function benchStepOverhead({ iterations = 60 } = {}) {
  const config = await makeConfig('overhead')
  const orchestrator = new Orchestrator({ config })
  const decision = fakeDecision(0)
  const runner = ensureStepRunner({ orchestrator, decision, config })
  const task = orchestrator.tasks.create({
    sessionId: 'sess-overhead',
    goal: 'overhead',
    steps: makeSteps(iterations),
  })
  orchestrator.tasks.setStatus(task, 'running')
  await orchestrator.tasks.save(task)

  const started = process.hrtime.bigint()
  let count = 0
  for (let i = 0; i < iterations; i += 1) {
    const step = orchestrator.tasks.nextStep(task)
    if (!step) break
    const out = await runner.run(task, step, {})
    if (out.ok) count += 1
  }
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6
  return {
    iterations,
    executed: count,
    totalMs: Number(totalMs.toFixed(1)),
    avgMs: Number((totalMs / Math.max(1, count)).toFixed(3)),
  }
}

// ---------------------------------------------------------------- 入口
const result = {
  ts: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  recovery: await benchRecovery(),
  fairness: await benchFairness(),
  stepOverhead: await benchStepOverhead(),
}

console.log('')
console.log('dsh-local-orchestrator bench（离线，不加载模型）')
console.log('─'.repeat(64))
console.log(`任务恢复率        ${(result.recovery.recoveryRate * 100).toFixed(1)}%  ` +
  `(${result.recovery.restored}/${result.recovery.tasks} 任务，崩溃中 ${result.recovery.crashed}，` +
  `恢复后续跑 ${result.recovery.resumeWorks ? '成功' : '失败'})`)
console.log(`跨会话公平性      最大连续独占 ${result.fairness.maxConsecutiveSameSession} 步  ` +
  `(${result.fairness.sessions} 会话 / ${result.fairness.tasks} 任务 / ${result.fairness.steps} 步，` +
  `分布 ${JSON.stringify(result.fairness.stepsPerSession)})`)
console.log(`单步开销          ${result.stepOverhead.avgMs} ms/步  ` +
  `(${result.stepOverhead.executed} 步，总计 ${result.stepOverhead.totalMs}ms，含落盘)`)
console.log('─'.repeat(64))
console.log('注：这三项与硬件无关；显存估算误差需真机跑 --gpu（后续接入）。')

if (jsonOut) {
  const outDir = path.join(process.cwd(), 'bench')
  await fsp.mkdir(outDir, { recursive: true })
  const file = path.join(outDir, `bench-${Date.now()}.json`)
  await fsp.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`JSON: ${file}`)
}
