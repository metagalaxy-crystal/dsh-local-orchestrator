/**
 * 端到端测试：用 mock OpenAI 服务代替 llama-server，验证
 * 目录加载 → 资产登记 → 加载/卸载 → GPU 互斥淘汰 → 工具输出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Catalog } from '../lib/catalog.js'
import { Orchestrator } from '../lib/manager.js'
import { buildTools } from '../lib/tools.js'
import { portAlive } from '../lib/runtimes/process.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'mock-openai.mjs')

/** 建一个隔离的数据目录 + 配置。 */
async function makeConfig(overrides = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-test-'))
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
  config.scheduler.loadTimeoutMs = 20000
  config.scheduler.stopTimeoutMs = 10000
  config.scheduler.idleUnloadSec = 0
  config.hardware.probeIntervalMs = 0
  // 这些用例验证「从目录导入」，显式打开（生产默认关闭，换机器靠手动添加）
  config.paths.autoSync = true
  Object.assign(config, overrides)
  return config
}

function mockAsset(id, port, { slot = 'gpu', priority = 50 } = {}) {
  return {
    id,
    name: `Mock ${id}`,
    kind: 'llm',
    runtime: 'process',
    slot,
    priority,
    port,
    task: '测试用回声模型',
    launch: { exe: process.execPath, command: [fixture, String(port), id] },
    health: { path: '/v1/models', alias: id },
    cost: { vramMb: null, ramMb: 64, loadMs: 1000, estimated: true },
  }
}

test('catalog：从 registry 导入并按角色推断类型/槽位', async () => {
  const config = await makeConfig()
  await fsp.writeFile(
    path.join(config.dataDir, 'models.json'),
    JSON.stringify({
      chat: { name: 'Chat', task: '聊天', gguf: 'x.gguf', server_args: ['-ngl', '99', '-c', '8192', '-t', '4'] },
      vision: { name: 'Vision', gguf: 'v.gguf', mmproj: 'mm.gguf', server_args: [] },
      embed: { name: 'Embed', role: 'embed', gguf: 'e.gguf', server_args: ['--embedding'] },
      rerank: { name: 'Rerank', role: 'rerank', gguf: 'r.gguf', server_args: [] },
    }),
  )
  config.paths.registry = path.join(config.dataDir, 'models.json')

  const catalog = new Catalog(config)
  await catalog.load()
  assert.equal(catalog.get('chat').kind, 'llm')
  assert.equal(catalog.get('chat').slot, 'gpu')
  assert.equal(catalog.get('chat').port, 8080)
  assert.equal(catalog.get('vision').kind, 'vlm')
  assert.equal(catalog.get('embed').kind, 'embed')
  assert.equal(catalog.get('embed').slot, 'cpu')
  assert.equal(catalog.get('embed').port, 8081)
  assert.equal(catalog.get('rerank').port, 8082)

  // 再 load 一次不应重复导入
  const before = catalog.list().length
  await catalog.load()
  assert.equal(catalog.list().length, before)
})

test('manager：加载 mock 服务、对话、停止并释放端口', async (t) => {
  const config = await makeConfig()
  const port = 18101
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  await orchestrator.catalog.upsert(mockAsset('mock-a', port))

  const instance = await orchestrator.ensure('mock-a', { reason: 'test' })
  assert.equal(instance.state, 'ready')
  assert.ok(await portAlive(port))

  const reply = await orchestrator.runChat('mock-a', {
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.equal(reply.ok, true)
  assert.match(reply.content, /mock-a\] echo: 你好/)

  // token 用量账本：一次对话应落一条记录，并能在 24h 汇总里看到
  const last = orchestrator.stats.recent(1)[0]
  assert.ok(last, 'runChat 应记录 usage')
  assert.equal(last.assetId, 'mock-a')
  assert.equal(last.totalTokens, (orchestrator.stats.recent(1)[0].promptTokens || 0) + (last.completionTokens || 0))
  assert.ok(orchestrator.stats.summary({ sinceMs: 24 * 3600 * 1000 }).calls >= 1)

  await orchestrator.stop('mock-a', { reason: 'test' })
  assert.equal(orchestrator.instances.has('mock-a'), false)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(await portAlive(port), false)

  orchestrator.dispose()
})

test('manager：GPU 互斥时切换资产会先卸载上一个', async (t) => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  await orchestrator.catalog.upsert(mockAsset('mock-a', 18102))
  await orchestrator.catalog.upsert(mockAsset('mock-b', 18103))

  await orchestrator.ensure('mock-a')
  await orchestrator.ensure('mock-b')
  assert.equal(orchestrator.instances.get('mock-a'), undefined)
  assert.equal(orchestrator.instances.get('mock-b').state, 'ready')

  await orchestrator.stopAll()
  orchestrator.dispose()
})

test('tools：local_resources / local_assets 返回可读文本', async () => {
  const config = await makeConfig()
  const orchestrator = new Orchestrator({ config })
  await orchestrator.catalog.upsert(mockAsset('mock-a', 18104, { slot: 'cpu' }))
  const tools = buildTools({ orchestrator, decision: { available: false, plan: async () => ({ ok: false }) }, config })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  assert.ok(byName.local_resources)
  const status = await byName.local_resources.execute({})
  assert.equal(status.ok, true)
  assert.match(status.text, /CPU/)

  const assets = await byName.local_assets.execute({})
  assert.equal(assets.ok, true)
  assert.match(assets.text, /mock-a/)

  // 对话式添加资产：只给 gguf 也能落库，连通性会如实报告缺文件
  const added = await byName.local_assets.execute({
    action: 'add',
    asset: { id: 'manual-x', kind: 'llm', gguf: 'text/nope/missing.gguf', task: '手动登记测试' },
  })
  assert.equal(added.ok, true)
  assert.match(added.text, /已新增资产 manual-x/)
  assert.match(added.text, /缺文件/)
  assert.ok(orchestrator.catalog.get('manual-x'))
  assert.equal(orchestrator.catalog.get('manual-x').runtime, 'llama.cpp')

  // 更新走同一入口
  const updated = await byName.local_assets.execute({
    action: 'update',
    asset: { id: 'manual-x', task: '改过的用途' },
  })
  assert.equal(updated.ok, true)
  assert.equal(orchestrator.catalog.get('manual-x').task, '改过的用途')

  // 删除
  const removed = await byName.local_assets.execute({ action: 'remove', id: 'manual-x' })
  assert.equal(removed.ok, true)
  assert.equal(orchestrator.catalog.get('manual-x'), null)

  orchestrator.dispose()
})

test('config：saveConfigPatch 持久化并可被重新读取', async () => {
  const { resolveConfigSync, saveConfigPatch } = await import('../lib/config.js')
  const config = await makeConfig()
  await saveConfigPatch(config, { scheduler: { idleUnloadSec: 123 } })
  const reread = resolveConfigSync({ dataDir: config.dataDir }).config
  assert.equal(reread.scheduler.idleUnloadSec, 123)
  // 未修改的默认值仍在
  assert.equal(reread.scheduler.gpuExclusive, true)
})
