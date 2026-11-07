/**
 * 开发期预览：按真实 D:\models 目录做一次资源同步，打印分类清单（不写用户数据目录）。
 * 用法：node scripts/sync-preview.mjs [dataDir]
 */
import path from 'node:path'
import { resolveConfigSync } from '../lib/config.js'
import { Catalog } from '../lib/catalog.js'
import { KIND_LABEL } from '../lib/catalog.js'

const dataDir = path.resolve(process.argv[2] ?? '.preview-sync')
const { config } = resolveConfigSync({ dataDir })
config.hardware.probeIntervalMs = 0

console.log('modelsRoot :', config.paths.modelsRoot)
console.log('comfyScripts:', config.paths.comfyScripts)
console.log('pythonPath :', config.paths.pythonPath)

const catalog = new Catalog(config)
await catalog.load()
const out = await catalog.syncEcosystem()
console.log(`\n新增 ${out.added.length} 项，共 ${out.total} 个资产\n`)

const groups = new Map()
for (const asset of catalog.list()) {
  const category = asset.category || 'other'
  if (!groups.has(category)) groups.set(category, [])
  groups.get(category).push(asset)
}
for (const [category, assets] of [...groups.entries()].sort()) {
  console.log(`【${category}】${assets.length}`)
  for (const asset of assets) {
    const kind = KIND_LABEL[asset.kind] ?? asset.kind
    const extra = asset.workflow ? ' · 工作流' : asset.script ? ' · 脚本' : ''
    console.log(`  ${asset.id.padEnd(22)} ${kind.padEnd(6)} ${asset.enabled ? '' : '(禁用) '}${asset.task}${extra}`)
  }
}
