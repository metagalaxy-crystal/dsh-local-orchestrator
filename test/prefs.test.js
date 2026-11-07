/**
 * 「本地优先」偏好：按会话存取、持久化、API 读写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { createApi } from '../lib/api.js'
import { Prefs, LOCAL_FIRST_DIRECTIVE } from '../lib/prefs.js'

async function tempFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-prefs-'))
  return path.join(dir, 'prefs.json')
}

test('Prefs：会话级开关、全局回落、持久化', async () => {
  const file = await tempFile()
  const prefs = new Prefs(file)
  await prefs.load()

  assert.equal(prefs.get('s1'), false)
  assert.equal(await prefs.set({ sessionId: 's1', preferLocal: true }), true)
  assert.equal(prefs.get('s1'), true)
  assert.equal(prefs.get('s2'), false) // 没有会话记录时回落到全局 false

  await prefs.set({ preferLocal: true })
  assert.equal(prefs.get('s2'), true) // 全局开启后其它会话也生效

  // 重新加载：持久化生效
  const reread = new Prefs(file)
  await reread.load()
  assert.equal(reread.get('s1'), true)
  assert.equal(reread.get('s2'), true)

  // 会话级再覆盖
  await reread.set({ sessionId: 's1', preferLocal: false })
  assert.equal(reread.get('s1'), false)
  assert.equal(reread.get('s2'), true)
})

test('API：GET/POST /prefs', async (t) => {
  const config = DEFAULT_CONFIG({
    modelsRoot: '', llamaDir: '', llamaServer: '', registry: '', comfyDir: '', comfyPython: 'python', outputRoot: '',
  })
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lo-prefs-api-'))
  config.dataDir = dataDir
  config.configFile = path.join(dataDir, 'config.json')
  config.catalogFile = path.join(dataDir, 'catalog.json')
  config.eventsFile = path.join(dataDir, 'events.jsonl')
  config.logDir = path.join(dataDir, 'logs')
  config.hardware.probeIntervalMs = 0
  config.scheduler.idleUnloadSec = 0

  const orchestrator = new Orchestrator({ config })
  const prefs = new Prefs(path.join(dataDir, 'prefs.json'))
  await prefs.load()
  t.after(async () => {
    await orchestrator.stopAll().catch(() => {})
    orchestrator.dispose()
  })
  const api = createApi({ config, orchestrator, decision: { complete: async () => ({ ok: true, text: '' }) }, prefs })

  const initial = await api({ method: 'GET', path: '/prefs', query: { sessionId: 'abc' } })
  assert.equal(initial.body.value.preferLocal, false)

  const on = await api({ method: 'POST', path: '/prefs', body: { sessionId: 'abc', preferLocal: true } })
  assert.equal(on.body.value.preferLocal, true)

  const read = await api({ method: 'GET', path: '/prefs', query: { sessionId: 'abc' } })
  assert.equal(read.body.value.preferLocal, true)

  await api({ method: 'POST', path: '/prefs', body: { sessionId: 'abc', preferLocal: false } })
  const off = await api({ method: 'GET', path: '/prefs', query: { sessionId: 'abc' } })
  assert.equal(off.body.value.preferLocal, false)
})

test('LOCAL_FIRST_DIRECTIVE：包含关键工具名', () => {
  assert.match(LOCAL_FIRST_DIRECTIVE, /local_delegate/)
  assert.match(LOCAL_FIRST_DIRECTIVE, /local_generate/)
  assert.match(LOCAL_FIRST_DIRECTIVE, /local_service/)
})
