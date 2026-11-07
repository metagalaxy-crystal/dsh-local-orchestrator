/**
 * 开发期自检：验证「工作流资产 → 共享 comfyui 服务」不会死锁，且 ComfyUI 能真正起来。
 * 需要在不受工作区沙箱限制的环境运行（ComfyUI 要写自己的 __pycache__/temp）。
 * 用法：node scripts/verify-workflow.mjs [assetId]
 */
import path from 'node:path'
import { resolveConfigSync } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'

const assetId = process.argv[2] ?? 'zimage'
const dataDir = path.resolve('.preview-flow')
const { config } = resolveConfigSync({ dataDir })
config.scheduler.loadTimeoutMs = 240000
config.scheduler.autoTune = false
config.prompt.enabled = false
config.scheduler.idleUnloadSec = 0

const o = new Orchestrator({ config })
await o.start()
console.log('assets', o.catalog.list().length)
const asset = o.catalog.get(assetId)
console.log('target', assetId, asset?.runtime, '-> service', asset?.serviceId)
const t0 = Date.now()
try {
  const inst = await o.ensure(assetId, { reason: 'verify workflow' })
  console.log('READY', inst.state, 'port', inst.port, 'sec', ((Date.now() - t0) / 1000).toFixed(1))
} catch (error) {
  console.log('FAILED', error.message)
} finally {
  await o.stop(assetId).catch(() => {})
  await o.stopAll().catch(() => {})
  o.dispose()
}
process.exit(0)
