/**
 * ComfyUI 模型名自动校正：工作流里写的是文件名，ComfyUI 列表里是带目录的相对路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { fixWorkflowNames } from '../lib/runtimes/comfy.js'

async function withObjectInfo(handler, fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/object_info') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(handler()))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn({ host: '127.0.0.1', port })
  } finally {
    server.close()
  }
}

test('fixWorkflowNames：按文件名匹配到带目录的实际模型名', async () => {
  const workflow = {
    1: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    2: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'z-image-turbo-Q4_K_M.gguf' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'ae.safetensors 是文本，不该动' } },
  }
  const out = await withObjectInfo(() => ({
    VAELoader: { input: { required: { vae_name: [['Z-Image-Turbo\\ae.safetensors', 'other.safetensors']] } } },
    UnetLoaderGGUF: { input: { required: { unet_name: [['z-image-turbo-Q4_K_M.gguf']] } } },
  }), (asset) => fixWorkflowNames(asset, workflow))
  assert.equal(out.fixes.length, 1)
  assert.equal(out.workflow['1'].inputs.vae_name, 'Z-Image-Turbo\\ae.safetensors')
  assert.equal(out.workflow['2'].inputs.unet_name, 'z-image-turbo-Q4_K_M.gguf')
  assert.equal(out.workflow['3'].inputs.text, 'ae.safetensors 是文本，不该动')
})

test('fixWorkflowNames：找不到匹配时保留原值', async () => {
  const workflow = { 1: { class_type: 'VAELoader', inputs: { vae_name: 'missing.safetensors' } } }
  const out = await withObjectInfo(() => ({
    VAELoader: { input: { required: { vae_name: [['only.safetensors']] } } },
  }), (asset) => fixWorkflowNames(asset, workflow))
  assert.equal(out.fixes.length, 0)
  assert.equal(out.workflow['1'].inputs.vae_name, 'missing.safetensors')
})
