/**
 * 配置迁移：comfyPython 写死成裸 "python" 时自动改用 .venv。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { repairComfyPython, resolveConfigSync } from '../lib/config.js'
import { existsSync } from '../lib/util.js'

test('repairComfyPython：显式路径不动，裸 python 要么保留要么指向存在的解释器', () => {
  const explicit = { paths: { comfyPython: 'D:/models/.venv/Scripts/python.exe' } }
  repairComfyPython(explicit)
  assert.equal(explicit.paths.comfyPython, 'D:/models/.venv/Scripts/python.exe')

  const bare = { paths: { comfyPython: 'python' } }
  repairComfyPython(bare)
  if (bare.paths.comfyPython !== 'python') {
    assert.ok(existsSync(bare.paths.comfyPython), `应指向真实解释器：${bare.paths.comfyPython}`)
    assert.match(bare.paths.comfyPython, /venv/i)
  }
})

test('repairComfyPython：没有 paths 时不抛', () => {
  assert.doesNotThrow(() => repairComfyPython({}))
  assert.doesNotThrow(() => repairComfyPython(null))
})

test('resolveConfigSync：行内配置优先，不被迁移覆盖', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-cfg-'))
  await fsp.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ paths: { comfyPython: 'python' } }),
    'utf8',
  )
  const { config } = resolveConfigSync({ dataDir, paths: { comfyPython: '/custom/python' } })
  assert.equal(config.paths.comfyPython, '/custom/python')
})
