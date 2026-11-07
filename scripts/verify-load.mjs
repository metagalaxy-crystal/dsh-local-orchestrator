/**
 * 真机自检：在插件之外用同一套代码加载一个真实模型，打印
 * 加载耗时 / 实测显存 / 一次对话结果，然后卸载。
 *
 * 用法：node scripts/verify-load.mjs [assetId] [dataDir]
 * 例：  node scripts/verify-load.mjs nanbeige .preview
 */
import path from 'node:path'
import { resolveConfigSync } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { fmtMb } from '../lib/util.js'

const assetId = process.argv[2] ?? 'nanbeige'
const dataDir = path.resolve(process.argv[3] ?? '.preview')

const { config } = resolveConfigSync({ dataDir })
config.scheduler.idleUnloadSec = 0
config.prompt.enabled = false
config.web.enabled = false

const orchestrator = new Orchestrator({ config })
await orchestrator.start()

const asset = orchestrator.catalog.get(assetId)
if (!asset) {
  console.error(`没有资产 ${assetId}，先运行 preview-catalog.mjs 导入注册表`)
  process.exit(1)
}
console.log(`加载 ${assetId}（预计 ${asset.cost.vramMb ? fmtMb(asset.cost.vramMb) : '未知'}，端口 ${asset.port}）...`)
const started = Date.now()
const instance = await orchestrator.ensure(assetId, { reason: 'verify-load' })
console.log(`就绪：${((Date.now() - started) / 1000).toFixed(1)}s，实测显存 ${instance.vramMb ? fmtMb(instance.vramMb) : '未测到'}`)

const reply = await orchestrator.runChat(assetId, {
  messages: [{ role: 'user', content: '用一句中文介绍你自己，20 字以内。' }],
  maxTokens: 128,
  temperature: 0.5,
})
console.log('对话：', reply.ok ? `${reply.content || '(正文为空)'} / 思考 ${reply.reasoning.length} 字` : reply.error)
console.log('用量：', reply.usage)

const after = orchestrator.catalog.get(assetId)
console.log('回写画像：', { measuredVramMb: after.measured.vramMb, measuredLoadMs: after.measured.loadMs })

await orchestrator.stop(assetId, { reason: 'verify-load 结束' })
console.log('已卸载')
orchestrator.dispose()
process.exit(0)
