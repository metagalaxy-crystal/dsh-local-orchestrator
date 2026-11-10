/**
 * 便携运行时：doctor 的判定、vendor 的复制范围、comfy 指针的解析。
 *
 * 目标：环境问题在 doctor 里变成一条可执行的 fix，而不是让模型去读日志猜。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { doctor, vendorLlama, linkComfy, resolveComfyDir, resolveLlamaServer, runtimeDirOf } from '../lib/env.js'

async function makeWorkspace() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-env-'))
  const runtimeDir = path.join(base, 'runtime')
  const modelsRoot = path.join(base, 'models')
  const llamaSrc = path.join(base, 'llama-bin')
  const comfyDir = path.join(base, 'ComfyUI')
  await fsp.mkdir(modelsRoot, { recursive: true })
  await fsp.mkdir(llamaSrc, { recursive: true })
  await fsp.mkdir(comfyDir, { recursive: true })
  await fsp.writeFile(path.join(comfyDir, 'main.py'), 'print(1)\n')
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  await fsp.writeFile(path.join(llamaSrc, exeName), 'x')
  await fsp.writeFile(path.join(llamaSrc, 'ggml-cuda.dll'), 'y')
  await fsp.writeFile(path.join(llamaSrc, 'test-backend-ops.exe'), 'z')
  await fsp.writeFile(path.join(llamaSrc, 'llama-bench.exe'), 'z')
  const config = {
    paths: { runtimeDir, modelsRoot, llamaServer: path.join(llamaSrc, exeName), comfyDir, comfyPython: '' },
  }
  return { base, runtimeDir, modelsRoot, llamaSrc, comfyDir, config, exeName }
}

test('runtimeDirOf / resolveLlamaServer：便携副本优先于配置路径', async () => {
  const { runtimeDir, config, llamaSrc, exeName } = await makeWorkspace()
  assert.equal(runtimeDirOf(config), runtimeDir)
  assert.equal(resolveLlamaServer(config).source, 'configured')

  await vendorLlama(config, { source: llamaSrc })
  const resolved = resolveLlamaServer(config)
  assert.equal(resolved.source, 'bundled')
  assert.equal(resolved.exists, true)
  assert.ok(resolved.exe.startsWith(runtimeDir))
  assert.ok(resolved.exe.endsWith(exeName))
})

test('vendorLlama：只复制运行时文件，跳过 test- 与 bench', async () => {
  const { config, runtimeDir, llamaSrc, exeName } = await makeWorkspace()
  const out = await vendorLlama(config, { source: llamaSrc })
  assert.equal(out.ok, true)
  assert.equal(out.copied, 2) // server + dll
  const files = await fsp.readdir(path.join(runtimeDir, 'llama'))
  assert.deepEqual(files.sort(), [exeName, 'ggml-cuda.dll'].sort())
})

test('vendorLlama：来源不存在时给出可执行的 hint', async () => {
  const { config } = await makeWorkspace()
  const out = await vendorLlama(config, { source: path.join(os.tmpdir(), 'no-such-llama-dir') })
  assert.equal(out.ok, false)
  assert.match(out.hint, /vendor-llama/)
})

test('linkComfy / resolveComfyDir：只写指针，不复制源码', async () => {
  const { config, comfyDir, base } = await makeWorkspace()
  const linked = await linkComfy(config, comfyDir)
  assert.equal(linked.ok, true)
  const resolved = await resolveComfyDir({ paths: { runtimeDir: path.join(base, 'runtime') } })
  assert.equal(resolved.source, 'pointer')
  assert.equal(resolved.dir, comfyDir)

  const bad = await linkComfy(config, path.join(base, 'not-comfy'))
  assert.equal(bad.ok, false)
})

test('doctor：缺 llama 时报 error 并给 fix；补齐后 ready', async () => {
  const { config, llamaSrc } = await makeWorkspace()
  const empty = {
    paths: { ...config.paths, llamaServer: '', bundleLlama: false },
  }
  const before = await doctor(empty)
  const llamaItem = before.items.find((item) => item.id === 'llama')
  assert.equal(llamaItem.level, 'error')
  assert.match(llamaItem.fix, /vendor-llama/)
  assert.equal(before.ready, false)

  await vendorLlama(config, { source: llamaSrc })
  const after = await doctor(config)
  const llamaAfter = after.items.find((item) => item.id === 'llama')
  assert.equal(llamaAfter.level, 'ok')
  assert.equal(after.summary.error, 0)
  assert.equal(after.ready, true)
})

test('doctor：模型目录不存在时报 error，并指向 set-model-root', async () => {
  const { config } = await makeWorkspace()
  const report = await doctor({ paths: { ...config.paths, modelsRoot: path.join(os.tmpdir(), 'no-such-models') } })
  const models = report.items.find((item) => item.id === 'models')
  assert.equal(models.level, 'error')
  assert.match(models.fix, /set-model-root/)
})
