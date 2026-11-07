/**
 * 本地预览：不装进 DSH，直接用真实注册表生成一份资产目录，
 * 打印每个模型的类型/槽位/预估显存，用来自检路径与估算是否合理。
 *
 * 用法：node scripts/preview-catalog.mjs [dataDir]
 */
import path from 'node:path'
import { resolveConfigSync } from '../lib/config.js'
import { Orchestrator } from '../lib/manager.js'
import { fmtMb } from '../lib/util.js'

const dataDir = path.resolve(process.argv[2] ?? '.preview')
const { config } = resolveConfigSync({ dataDir })
config.scheduler.idleUnloadSec = 0
config.prompt.enabled = false

const orchestrator = new Orchestrator({ config })
await orchestrator.start()

const snapshot = await orchestrator.hardware.sample({ force: true })
const status = await orchestrator.status()
console.log('数据目录：', dataDir)
console.log('检测路径：')
for (const [key, value] of Object.entries(config.paths)) console.log(`  ${key}: ${value || '(未检测到)'}`)
console.log('硬件：', {
  cpuCores: snapshot.cpu.cores,
  ramTotalMb: snapshot.memory.totalMb,
  gpu: snapshot.gpus.map((gpu) => `${gpu.name} ${fmtMb(gpu.totalMb)} 空闲 ${fmtMb(gpu.freeMb)}`),
})
console.log('显存预算：', status.budget)
console.log('\n资产：')
for (const asset of orchestrator.catalog.list()) {
  const cost = asset.measured.vramMb ?? asset.cost.vramMb
  console.log(
    `  ${asset.id.padEnd(10)} ${asset.kind.padEnd(8)} ${asset.slot.padEnd(4)} ` +
      `${(cost ? fmtMb(cost) : '未知').padEnd(8)} :${asset.port}  ${asset.task}`,
  )
}
orchestrator.dispose()
process.exit(0)
