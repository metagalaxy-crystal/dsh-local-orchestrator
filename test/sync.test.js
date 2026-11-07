/**
 * 资源同步：按 D:\models 的分类扫描 ComfyUI 工作流 / 音频脚本 / MCP 目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Catalog, KIND_LABEL } from '../lib/catalog.js'
import { prepareWorkflow, findWorkflowFile, listWorkflows } from '../lib/workflows.js'

async function makeWorkspace() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-sync-'))
  const modelsRoot = path.join(base, 'models')
  const comfyDir = path.join(base, 'ComfyUI')
  const comfyScripts = path.join(base, 'scripts', 'comfyui')
  const dataDir = path.join(base, 'data')
  await fsp.mkdir(path.join(modelsRoot, 'text'), { recursive: true })
  await fsp.mkdir(path.join(modelsRoot, 'audio', 'MOSS-TTS'), { recursive: true })
  await fsp.mkdir(comfyDir, { recursive: true })
  await fsp.mkdir(path.join(comfyScripts, 'zimage'), { recursive: true })
  await fsp.mkdir(path.join(comfyScripts, 'minimax-h3'), { recursive: true })
  await fsp.mkdir(path.join(base, 'scripts', 'other'), { recursive: true })
  await fsp.writeFile(path.join(base, 'scripts', 'other', 'tts_run.py'), '# fake\n')
  await fsp.mkdir(path.join(base, 'tools', 'mcp-servers', 'playwright-mcp'), { recursive: true })

  const workflow = {
    _meta: { positive: '3', negative: '4', sampler: '7', latent: '6', 模型: 'Z-Image-Turbo' },
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'z-image-turbo-Q4_K_M.gguf' } },
    3: { class_type: 'TextEncodeZImageOmni', inputs: { prompt: '默认提示词' } },
    4: { class_type: 'TextEncodeZImageOmni', inputs: { prompt: '' } },
    6: { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024 } },
    7: { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 1 } },
  }
  await fsp.writeFile(path.join(comfyScripts, 'zimage', 'workflow.json'), JSON.stringify(workflow))
  await fsp.writeFile(path.join(comfyScripts, 'minimax-h3', 'workflow_t2v.json'), JSON.stringify({ _meta: { 模型: 'MiniMax-H3' }, 1: { class_type: 'X', inputs: {} } }))
  const artApps = path.join(base, 'tools', 'storytold-ArtCraft', 'apps')
  for (const app of ['deckcraft', 'photocraft']) {
    await fsp.mkdir(path.join(artApps, app), { recursive: true })
    await fsp.writeFile(path.join(artApps, app, `${app}-cli.exe`), '')
  }

  const config = DEFAULT_CONFIG({
    modelsRoot,
    llamaDir: '',
    llamaServer: '',
    registry: '',
    comfyDir,
    comfyScripts,
    pythonPath: '',
    outputRoot: path.join(base, 'output'),
    comfyPython: 'python',
  })
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.hardware.probeIntervalMs = 0
  return { base, config }
}

test('syncEcosystem：ComfyUI 工作流按 image/video 分类，共用 comfyui 服务', async () => {
  const { config } = await makeWorkspace()
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.syncEcosystem()

  const zimage = catalog.get('zimage')
  assert.ok(zimage, '应有 zimage 资产')
  assert.equal(zimage.kind, 'image')
  assert.equal(zimage.runtime, 'workflow')
  assert.equal(zimage.serviceId, 'comfyui')
  assert.ok(zimage.workflow.endsWith('workflow.json'))

  const t2v = catalog.get('minimax-h3-t2v')
  assert.ok(t2v)
  assert.equal(t2v.kind, 'video')
  assert.equal(t2v.serviceId, 'comfyui')

  assert.equal(catalog.get('comfyui').kind, 'image')
  assert.equal(KIND_LABEL.music, '音乐生成')
})

test('syncEcosystem：音频脚本与 MCP 目录登记', async () => {
  const { config } = await makeWorkspace()
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.syncEcosystem()

  // tts_run.py 是 VoxCPM2 的入口，资产 id 是 voxcpm2
  const tts = catalog.get('voxcpm2')
  assert.ok(tts)
  assert.equal(tts.kind, 'audio-tts')
  assert.equal(tts.runtime, 'script')
  assert.ok(tts.script.file.endsWith('tts_run.py'))

  const mcp = catalog.get('playwright-mcp')
  assert.ok(mcp)
  assert.equal(mcp.runtime, 'mcp')
  assert.equal(mcp.kind, 'tool')
  assert.equal(mcp.category, 'mcp')

  // ArtCraft：每个 app 单独登记（不再是一个汇总条目）
  const deck = catalog.get('deckcraft')
  assert.ok(deck, '应登记 deckcraft MCP')
  assert.equal(deck.runtime, 'mcp')
  assert.equal(deck.category, 'mcp')
  assert.match(deck.mcp.command, /deckcraft-cli\.exe$/)
  assert.equal(deck.mcp.args[0], 'mcp')
  assert.ok(catalog.get('photocraft'))
})

test('工作流名：minimax-h3-t2v 能解析到 workflow_t2v.json', async () => {
  const { config } = await makeWorkspace()
  const file = await findWorkflowFile(config, 'minimax-h3-t2v')
  assert.ok(file && file.endsWith('workflow_t2v.json'), String(file))
  const names = await listWorkflows(config)
  assert.ok(names.includes('minimax-h3-t2v'))
  assert.ok(names.includes('zimage'))
})

test('prepareWorkflow：剥掉 _meta 并注入 prompt/尺寸/seed', () => {
  const raw = {
    _meta: { positive: '3', negative: '4', sampler: '7', latent: '6' },
    3: { class_type: 'TextEncodeZImageOmni', inputs: { prompt: '默认' } },
    4: { class_type: 'TextEncodeZImageOmni', inputs: { prompt: '' } },
    6: { class_type: 'EmptySD3LatentImage', inputs: { width: 512, height: 512 } },
    7: { class_type: 'KSampler', inputs: { seed: 1, steps: 8 } },
  }
  const out = prepareWorkflow(raw, { prompt: '一只猫', negative: '低质量', width: 1024, height: 768, seed: 42, steps: 12 })
  assert.equal(out.workflow._meta, undefined)
  assert.equal(out.workflow['3'].inputs.prompt, '一只猫')
  assert.equal(out.workflow['4'].inputs.prompt, '低质量')
  assert.equal(out.workflow['6'].inputs.width, 1024)
  assert.equal(out.workflow['6'].inputs.height, 768)
  assert.equal(out.workflow['7'].inputs.seed, 42)
  assert.equal(out.workflow['7'].inputs.steps, 12)
  assert.equal(out.meta.模型, undefined)
})
