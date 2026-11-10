#!/usr/bin/env node
/**
 * 不启动 DSH 也能把运行时装好（给「先配环境再装插件」的人用）。
 *
 *   node scripts/setup-runtime.mjs                    # 体检 + 打印下一步
 *   node scripts/setup-runtime.mjs --llama <dir>      # 复制 llama.cpp 到 runtime/llama
 *   node scripts/setup-runtime.mjs --comfy <dir>      # 登记 ComfyUI 目录
 *   node scripts/setup-runtime.mjs --models <dir>     # 改模型根目录
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { doctor, plan, vendorLlama, linkComfy, runtimeDirOf, pathsFromBase } from '../lib/env.js'
import { resolveConfigSync, saveConfigPatch } from '../lib/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const pick = (flag) => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : ''
}

const { config } = resolveConfigSync({})
const report = await doctor(config)
console.log(`运行时目录：${runtimeDirOf(config)}`)
for (const item of report.items) {
  const mark = item.level === 'ok' ? '✓' : item.level === 'warn' ? '!' : '✗'
  console.log(`${mark} ${item.title}：${item.detail}`)
  if (item.fix) console.log(`    → ${item.fix}`)
}

const llamaDir = pick('--llama')
const comfyDir = pick('--comfy')
const modelsDir = pick('--models')
const baseDir = pick('--base')

if (baseDir) {
  const derived = pathsFromBase(baseDir)
  await saveConfigPatch(config, { paths: derived })
  console.log(`\n基础目录已设为：${derived.base}`)
  console.log(`  模型：${derived.modelsRoot}`)
  console.log(`  llama.cpp：${derived.llamaServer}`)
  console.log(`  ComfyUI：${derived.comfyDir}`)
  console.log(`  脚本：${derived.comfyScripts}`)
  console.log(`  输出：${derived.outputRoot}`)
}

if (llamaDir) {
  const out = await vendorLlama(config, { source: llamaDir, force: args.includes('--force') })
  console.log(out.ok ? `\nllama.cpp 已就位：${out.dest}（${out.copied} 个文件）` : `\n复制失败：${out.error}`)
}
if (comfyDir) {
  const out = await linkComfy(config, comfyDir)
  console.log(out.ok ? `\nComfyUI 已登记：${out.dir}` : `\n登记失败：${out.error}`)
}
if (modelsDir) {
  await saveConfigPatch(config, { paths: { modelsRoot: modelsDir } })
  console.log(`\n模型根目录已设为：${modelsDir}`)
}

if (!llamaDir && !comfyDir && !modelsDir) {
  const steps = await plan(config)
  if (steps.steps.length > 0) {
    console.log('\n还差这些：')
    for (const step of steps.steps) console.log(`- [${step.blocked ? '必做' : '建议'}] ${step.title}\n  ${step.fix}`)
  } else {
    console.log('\n环境就绪，可以直接开 DSH。')
  }
}
