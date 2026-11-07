/**
 * 资产规范化回归测试：null 不能变成 0。
 *
 * 背景：catalog.json 里 `measured.vramMb: null`（未测量）经
 * `Number(null) === 0` 会被读成 0，导致 UI 显示「显存未知」、预算判断失真。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import {
  normalizeAsset,
  publicAsset,
  invokeOf,
  roleOfFile,
  extractWorkflowComponents,
  Catalog,
} from '../lib/catalog.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { existsSync } from '../lib/util.js'

test('normalizeAsset：null/空串保持 null，数字保留', () => {
  const asset = normalizeAsset({
    id: 'x',
    kind: 'llm',
    runtime: 'llama.cpp',
    launch: { gguf: 'a.gguf' },
    cost: { vramMb: null, ramMb: '' },
    measured: { vramMb: null, loadMs: null },
  })
  assert.equal(asset.cost.vramMb, null)
  assert.equal(asset.cost.ramMb, null)
  assert.equal(asset.measured.vramMb, null)
  assert.equal(asset.measured.loadMs, null)

  const measured = normalizeAsset({ id: 'y', measured: { vramMb: 5477, loadMs: 5400 } })
  assert.equal(measured.measured.vramMb, 5477)
  assert.equal(measured.measured.loadMs, 5400)

  // 0 是合法测量值（CPU 资产），不能被吞掉
  const zero = normalizeAsset({ id: 'z', measured: { vramMb: 0 } })
  assert.equal(zero.measured.vramMb, 0)
})

test('publicAsset：未测量时回落到估算值，而不是 0', () => {
  const asset = normalizeAsset({
    id: 'x',
    kind: 'llm',
    runtime: 'llama.cpp',
    launch: { gguf: 'a.gguf' },
    cost: { vramMb: 2835, loadMs: 45000 },
    measured: { vramMb: null },
  })
  const pub = publicAsset(asset)
  assert.equal(pub.estimateVramMb, 2835)
  assert.equal(pub.estimateLoadMs, 45000)
})

test('组件角色：按文件名识别编码器 / VAE / mmproj / 主模型', () => {
  assert.equal(roleOfFile('ae.safetensors'), 'vae')
  assert.equal(roleOfFile('qwen_image_vae.safetensors'), 'vae')
  assert.equal(roleOfFile('qwen_3_4b.safetensors'), 'encoder')
  assert.equal(roleOfFile('umt5-xxl-encoder-Q5_K_M.gguf'), 'encoder')
  assert.equal(roleOfFile('z-image-turbo-Q4_K_M.gguf'), 'model')
  assert.equal(roleOfFile('minimax_h3_fl2va_pruned_int8_convrot.safetensors'), 'model')
  assert.equal(roleOfFile('mmproj-F16.gguf'), 'mmproj')
})

test('工作流 JSON：提取权重文件作为配套组件', () => {
  const doc = {
    '3': { inputs: { ckpt_name: 'Z-Image-Turbo\\z-image-turbo-Q4_K_M.gguf' } },
    '4': { inputs: { vae_name: 'ae.safetensors' } },
    '5': { inputs: { text_encoder: 'qwen_3_4b.safetensors' } },
  }
  const comps = extractWorkflowComponents(doc)
  const byRole = Object.fromEntries(comps.map((item) => [item.role, item.name]))
  assert.equal(byRole.model, 'z-image-turbo-Q4_K_M.gguf')
  assert.equal(byRole.vae, 'ae.safetensors')
  assert.equal(byRole.encoder, 'qwen_3_4b.safetensors')
})

test('mmproj 自动登记为组件，主模型仍然可见', () => {
  const asset = normalizeAsset({
    id: 'qwen36',
    kind: 'vlm',
    runtime: 'llama.cpp',
    launch: { gguf: 'x.gguf', mmproj: 'text/qwen36/mmproj-Q8.gguf' },
  })
  assert.equal(asset.hidden, false)
  assert.equal(asset.components.length, 1)
  assert.equal(asset.components[0].role, 'mmproj')
  assert.equal(asset.components[0].name, 'mmproj-Q8.gguf')
  assert.equal(publicAsset(asset).components.length, 1)
})

test('componentOf 的资产默认隐藏，list 可切换', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-cat-'))
  const config = DEFAULT_CONFIG({ modelsRoot: '', llamaDir: '', llamaServer: '', registry: '' })
  config.dataDir = dataDir
  config.catalogFile = path.join(dataDir, 'catalog.json')
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({ id: 'moss-tts', kind: 'audio-tts', runtime: 'script', script: { file: 'x.py' } })
  await catalog.upsert({ id: 'campplus', kind: 'tool', runtime: 'script', componentOf: 'moss-tts', role: 'speaker' })

  assert.equal(catalog.list().length, 2)
  assert.equal(catalog.list({ includeHidden: false }).length, 1)
  const visible = catalog.list({ includeHidden: false })[0]
  assert.equal(visible.id, 'moss-tts')
  const child = catalog.get('campplus')
  assert.equal(child.hidden, true)
  assert.equal(child.componentOf, 'moss-tts')
})

test('invokeOf：按运行框架给出调用样例', () => {
  assert.equal(invokeOf({ id: 'zimage', kind: 'image', runtime: 'workflow' }), 'local_generate {"asset":"zimage"}')
  assert.equal(invokeOf({ id: 'qwen36', kind: 'vlm', runtime: 'llama.cpp' }), 'local_chat {"asset":"qwen36"}')
  assert.equal(invokeOf({ id: 'moss-tts', kind: 'audio-tts', runtime: 'script' }), 'local_audio {"action":"tts"}')
  assert.equal(invokeOf({ id: 'qwen3-asr', kind: 'audio-asr', runtime: 'script' }), 'local_audio {"action":"asr","audioPath":"…"}')
  assert.equal(invokeOf({ id: 'mcp-x', kind: 'tool', runtime: 'mcp' }).startsWith('（由 DSH'), true)
})

async function makeCatalogRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-cat2-'))
  const models = path.join(root, 'models')
  await fsp.mkdir(path.join(models, 'text', 'demo'), { recursive: true })
  await fsp.writeFile(path.join(models, 'text', 'demo', 'demo.gguf'), 'x')
  const config = DEFAULT_CONFIG({ modelsRoot: models, llamaDir: '', llamaServer: '', registry: '', comfyDir: '' })
  config.dataDir = path.join(root, 'data')
  config.catalogFile = path.join(config.dataDir, 'catalog.json')
  return { root, models, config }
}

test('verify：文件不存在时给出缺失清单，存在则通过', async () => {
  const { config, models } = await makeCatalogRoot()
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({ id: 'ok-model', kind: 'llm', runtime: 'llama.cpp', launch: { gguf: 'text/demo/demo.gguf' } })
  await catalog.upsert({ id: 'bad-model', kind: 'llm', runtime: 'llama.cpp', launch: { gguf: 'text/nope/none.gguf' } })

  const ok = await catalog.verify(catalog.get('ok-model'))
  assert.equal(ok.ok, true)
  const bad = await catalog.verify(catalog.get('bad-model'))
  assert.equal(bad.ok, false)
  assert.equal(bad.missing.length, 1)
  assert.match(bad.missing[0], /text\/nope\/none\.gguf/)
  // 缓存：第二次不再重复 stat 也能拿到同样结果
  assert.deepEqual(await catalog.verify(catalog.get('bad-model')), bad)
  assert.ok(existsSync(path.join(models, 'text', 'demo', 'demo.gguf')))
})

test('frameworks：列出 llama.cpp / ComfyUI / Python / MCP 与可用性', async () => {
  const { root, config } = await makeCatalogRoot()
  const llamaServer = path.join(root, 'llama-server.exe')
  await fsp.writeFile(llamaServer, 'x')
  config.paths.llamaServer = llamaServer
  config.paths.comfyDir = path.join(root, 'no-comfy')
  config.paths.pythonPath = path.join(root, 'python.exe')
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({ id: 'demo', kind: 'llm', runtime: 'llama.cpp', launch: { gguf: 'text/demo/demo.gguf' } })
  await catalog.upsert({ id: 'mcp-a', kind: 'tool', runtime: 'mcp', mcp: { command: 'x.exe', args: ['mcp'] } })

  const rows = catalog.frameworks()
  const llama = rows.find((row) => row.id === 'llama.cpp')
  assert.equal(llama.exists, true)
  assert.equal(llama.count, 1)
  const comfy = rows.find((row) => row.id === 'comfyui')
  assert.equal(comfy.exists, false)
  const python = rows.find((row) => row.id === 'python')
  assert.equal(python.exists, false)
  const mcp = rows.find((row) => row.id === 'mcp')
  assert.equal(mcp.count, 1)
})

test('repairPaths：registry 相对路径过期时按文件名找回', async () => {
  const { root, config } = await makeCatalogRoot()
  await fsp.mkdir(path.join(config.paths.modelsRoot, 'rag', 'demo'), { recursive: true })
  await fsp.writeFile(path.join(config.paths.modelsRoot, 'rag', 'demo', 'demo.gguf'), 'x')
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({ id: 'moved', kind: 'llm', runtime: 'llama.cpp', launch: { gguf: 'text/demo/demo.gguf' } })

  // text/demo/demo.gguf 其实也存在（夹具里建过）——先删掉，模拟真实过期路径
  await fsp.rm(path.join(config.paths.modelsRoot, 'text', 'demo', 'demo.gguf'), { force: true })
  const repaired = await catalog.repairPaths()
  assert.equal(repaired, true)
  assert.equal(catalog.get('moved').launch.gguf, 'rag/demo/demo.gguf')
  assert.equal((await catalog.verify(catalog.get('moved'))).ok, true)
  assert.ok(existsSync(path.join(root, 'models')))
})

test('verify：工作流组件缺失时判定不可用（wan2.2 被删的场景）', async () => {
  const { config } = await makeCatalogRoot()
  const workflowFile = path.join(config.dataDir, 'wf.json')
  await fsp.mkdir(config.dataDir, { recursive: true })
  await fsp.writeFile(workflowFile, '{}')
  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({
    id: 'wf-video',
    kind: 'video',
    runtime: 'workflow',
    workflow: workflowFile,
    components: [{ name: 'Wan2.2_VAE.safetensors', role: 'vae' }],
  })

  const before = await catalog.verify(catalog.get('wf-video'))
  assert.equal(before.ok, false)
  assert.ok(before.missing.some((item) => item.includes('Wan2.2_VAE.safetensors')))
  assert.equal(before.components[0].exists, false)

  // 把文件补回去（模型目录），重新 upsert 让缓存失效
  await fsp.mkdir(path.join(config.paths.modelsRoot, 'video'), { recursive: true })
  await fsp.writeFile(path.join(config.paths.modelsRoot, 'video', 'Wan2.2_VAE.safetensors'), 'x')
  await catalog.upsert({ ...catalog.get('wf-video') })
  const after = await catalog.verify(catalog.get('wf-video'))
  assert.equal(after.ok, true)
  assert.equal(after.components[0].exists, true)
})

test('upgradeComponents：tts_run.py 归到 voxcpm2，moss-tts 合并掉', async () => {
  const { config } = await makeCatalogRoot()
  const base = path.dirname(config.paths.modelsRoot)
  const script = path.join(base, 'scripts', 'other', 'tts_run.py')
  await fsp.mkdir(path.dirname(script), { recursive: true })
  await fsp.writeFile(script, '# fake voxcpm2 entry\n')

  const catalog = new Catalog(config)
  await catalog.load()
  await catalog.upsert({ id: 'moss-tts', kind: 'audio-tts', runtime: 'script', script: { file: script, args: [] }, enabled: true })
  await catalog.upsert({ id: 'voxcpm2', kind: 'tool', runtime: 'script', enabled: false })

  await catalog.upgradeComponents()

  assert.equal(catalog.get('moss-tts'), null, '幽灵 moss-tts 应被合并掉')
  const vox = catalog.get('voxcpm2')
  assert.equal(vox.kind, 'audio-tts')
  assert.equal(vox.name, 'VoxCPM2 TTS')
  assert.equal(vox.script.file, script)
  assert.equal(vox.enabled, true)
})

test('默认不自动同步目录：空目录 load 后没有资产，手动添加才出现', async () => {
  const { config } = await makeCatalogRoot()
  assert.equal(config.paths.autoSync, false)
  const catalog = new Catalog(config)
  await catalog.load()
  assert.equal(catalog.list().length, 0, '默认不应从目录导入任何资产')

  await catalog.upsert({
    id: 'manual-model',
    kind: 'llm',
    runtime: 'llama.cpp',
    launch: { gguf: 'text/demo/demo.gguf' },
  })
  assert.equal(catalog.list().length, 1)
  assert.equal((await catalog.verify(catalog.get('manual-model'))).ok, true)
})

test('syncEcosystem：ArtCraft 每个 app 单独登记为 MCP 资产', async () => {
  const { root, config } = await makeCatalogRoot()
  // 目录同步默认关闭，这里显式导入
  config.paths.autoSync = true
  const apps = path.join(root, 'tools', 'storytold-ArtCraft', 'apps')
  for (const name of ['cadcraft', 'wordcraft']) {
    await fsp.mkdir(path.join(apps, name), { recursive: true })
    await fsp.writeFile(path.join(apps, name, `${name}-cli.exe`), 'x')
  }
  const catalog = new Catalog(config)
  await catalog.load()

  const cad = catalog.get('cadcraft')
  assert.ok(cad, 'cadcraft 应被单独登记')
  assert.equal(cad.runtime, 'mcp')
  assert.equal(cad.category, 'mcp')
  assert.equal(cad.mcp.args[0], 'mcp')
  assert.match(cad.mcp.command, /cadcraft-cli\.exe$/)
  assert.ok(catalog.get('wordcraft'))
  // 套件汇总条目如果存在，应被隐藏而不是和 app 重复
  const suite = catalog.get('artcraft')
  if (suite) assert.equal(suite.hidden, true)
})
