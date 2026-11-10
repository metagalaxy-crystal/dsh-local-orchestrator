/**
 * 装配测试：用假 ctx 模拟 DSH 的插件上下文，验证
 * apply() 注册工具 / 系统提示段 / 生命周期清理都不抛异常。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { apply, inject, name } from '../lib/index.js'

function fakeCtx() {
  const registered = []
  const sections = []
  const disposers = []
  const ctx = {
    sections,
    registered,
    disposers,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const disposer = fn()
      const wrapped = typeof disposer === 'function' ? disposer : () => {}
      disposers.push(wrapped)
      return wrapped
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      context(definition) {
        sections.push(definition)
        return () => {}
      },
    },
    inject() {
      /* 测试环境没有 webServer / connection，直接跳过 */
    },
    get() {
      return undefined
    },
  }
  return ctx
}

test('apply：注册 10 个工具、一个系统提示段，并注入 fleet 简报', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-apply-'))
  const ctx = fakeCtx()
  const dispose = apply(ctx, { dataDir, prompt: { enabled: true } })

  assert.equal(name, 'dsh-local-orchestrator')
  assert.deepEqual([...inject], ['tools', 'systemPrompt'])
  assert.equal(ctx.registered.length, 10)
  assert.deepEqual(
    ctx.registered.map((tool) => tool.name).sort(),
    [
      'local_assets',
      'local_audio',
      'local_chat',
      'local_delegate',
      'local_env',
      'local_generate',
      'local_resources',
      'local_service',
      'local_step',
      'local_task',
    ],
  )
  for (const tool of ctx.registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
  }

  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'local-orchestrator:fleet')

  // 等异步初始化完成，简报应包含资源行
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const briefing = ctx.sections[0].text()
  assert.match(briefing, /CPU|本地资源/)

  // 卸载不抛
  assert.doesNotThrow(() => {
    for (const disposeOne of ctx.disposers) disposeOne()
  })
})

test('apply：重启后任务池里的未完成任务出现在本会话简报里', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-apply-task-'))
  const taskDir = path.join(dataDir, 'tasks')
  await fsp.mkdir(taskDir, { recursive: true })
  const now = new Date().toISOString()
  await fsp.writeFile(
    path.join(taskDir, 'task-seed-1.json'),
    JSON.stringify({
      id: 'task-seed-1',
      sessionId: 'sess-x',
      title: '预置任务',
      goal: '把周报压成 10 条',
      status: 'paused',
      createdAt: now,
      updatedAt: now,
      steps: [{ index: 0, goal: '第一步', kind: 'llm', status: 'pending', dependsOn: [], attempts: 0, ms: 0 }],
      budget: { maxSteps: 8, maxWallMs: 0, usedMs: 0, usedTokens: 0, requires: 0 },
      artifacts: [],
    }),
  )
  const ctx = fakeCtx()
  apply(ctx, { dataDir, prompt: { enabled: true } })
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const mine = ctx.sections[0].text({ agent: { session: { id: 'sess-x' } } })
  assert.match(mine, /本会话未完成任务/)
  assert.match(mine, /task-seed-1/)
  assert.match(mine, /预置任务/)

  // 其它会话看不到这个任务
  const other = ctx.sections[0].text({ agent: { session: { id: 'sess-y' } } })
  assert.doesNotMatch(other, /task-seed-1/)
})

test('apply：enabled=false 时不注册任何东西', async () => {
  const ctx = fakeCtx()
  apply(ctx, { dataDir: os.tmpdir(), enabled: false })
  assert.equal(ctx.registered.length, 0)
  assert.equal(ctx.sections.length, 0)
})
