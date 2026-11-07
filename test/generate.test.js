/**
 * ComfyUI 工作流模板 + MCP 资源登记的测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Catalog, normalizeAsset, KIND_LABEL } from '../lib/catalog.js'
import { Orchestrator } from '../lib/manager.js'
import { fillWorkflow, resolveWorkflow, listWorkflows } from '../lib/workflows.js'

async function makeConfig(extra = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-gen-'))
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
  // 用例验证「从目录导入」，显式打开（生产默认关闭）
  config.paths.autoSync = true
  return Object.assign(config, extra)
}

test('fillWorkflow：递归替换占位符，未知变量保持原样', () => {
  const filled = fillWorkflow(
    { '1': { inputs: { text: '{{prompt}}', width: '{{width}}', keep: '{{unknown}}' } } },
    { prompt: '一只猫', width: 1024 },
  )
  assert.equal(filled['1'].inputs.text, '一只猫')
  assert.equal(filled['1'].inputs.width, '1024')
  assert.equal(filled['1'].inputs.keep, '{{unknown}}')
})

test('resolveWorkflow：从 workflows/<name>.json 加载并填充', async () => {
  const config = await makeConfig()
  const dir = path.join(config.dataDir, 'workflows')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'txt2img.json'), JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } } }))

  const list = await listWorkflows(config)
  assert.deepEqual(list, ['txt2img'])

  const resolved = await resolveWorkflow(config, { workflowName: 'txt2img', params: { seed: 42 } })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.workflow['3'].inputs.seed, '42')

  const missing = await resolveWorkflow(config, { workflowName: 'nope' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /找不到工作流模板/)
})

test('MCP：config.mcpServers 登记为 CPU 槽外部资产，ensure 不拉进程', async (t) => {
  const config = await makeConfig({
    mcpServers: [{ id: 'playwright-mcp', name: 'Playwright MCP', desc: '浏览器自动化' }],
  })
  const orchestrator = new Orchestrator({ config })
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  await orchestrator.start()
  const asset = orchestrator.catalog.get('playwright-mcp')
  assert.ok(asset)
  assert.equal(asset.kind, 'tool')
  assert.equal(asset.runtime, 'mcp')
  assert.equal(asset.slot, 'cpu')
  assert.equal(asset.pinned, true)

  const instance = await orchestrator.ensure('playwright-mcp')
  assert.equal(instance.state, 'ready')
  assert.equal(instance.external, true)
  assert.equal(instance.pid, null)
  assert.equal(orchestrator.instances.get('playwright-mcp').proc, null)

  const stopped = await orchestrator.stop('playwright-mcp')
  assert.equal(stopped.ok, true)
  assert.equal(orchestrator.instances.has('playwright-mcp'), false)
})

test('catalog：kind=tool 的端口允许为 0', () => {
  const asset = normalizeAsset({ id: 'mcp-x', kind: 'tool', runtime: 'mcp', slot: 'cpu' })
  assert.equal(asset.port, 0)
  assert.equal(KIND_LABEL.tool, '工具服务')
  assert.equal(new Catalog(DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '', comfyDir: '', comfyPython: '', outputRoot: '' })).get('missing'), null)
})
