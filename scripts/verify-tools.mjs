#!/usr/bin/env node
/**
 * 工具注册表 + 验证台账。
 *
 * 问题：改了某个 tool 的实现之后，怎么知道「哪些工具需要重新跑一遍真实调用」？
 * 做法：给每个工具算一个指纹（名字 + 描述 + 参数 schema + execute 源码），存进
 * docs/tool-verification.json；指纹变了就标记为「待验证」。
 *
 * 用法：
 *   node scripts/verify-tools.mjs                      # 报告：哪些已验证、哪些改了要重验
 *   node scripts/verify-tools.mjs --json               # 机器可读
 *   node scripts/verify-tools.mjs --mark local_chat=pass --evidence "热态 1.1s"
 *   node scripts/verify-tools.mjs --mark local_step=pending --note "已修，待重启复验"
 *
 * 状态：
 *   pass     真实调用通过（附证据）
 *   fail     真实调用失败（附错误）
 *   blocked  环境阻塞（如 ComfyUI 起不来），工具本身没被测到
 *   pending  已改代码但还没重跑
 *
 * 注意：本脚本只做「指纹 + 台账」，不会真的调用工具——真实调用只能由会话模型在
 * 宿主里发起（工具 execute 需要 orchestrator 运行时）。
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTools } from '../lib/tools.js'
import { fingerprintTool as fingerprint } from '../lib/tool-fingerprint.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ledgerFile = path.join(here, '..', 'docs', 'tool-verification.json')
const pkg = JSON.parse(await fsp.readFile(path.join(here, '..', 'package.json'), 'utf8'))

/** 只要能构造出工具定义即可；execute 里才会用到 orchestrator 的真实能力。 */
const stub = {
  orchestrator: { tasks: null, catalog: null, instances: new Map(), tracker: null },
  decision: { available: false, executeStep: null },
  config: { tools: { prefix: 'local_' }, decision: {}, comfy: {} },
}

function parseArgs(argv) {
  const marks = []
  const options = { json: false, strict: false, from: '', evidence: '', note: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--from') options.from = argv[++i] ?? ''
    else if (arg === '--mark') marks.push(argv[++i])
    else if (arg === '--evidence') options.evidence = argv[++i] ?? ''
    else if (arg === '--note') options.note = argv[++i] ?? ''
  }
  return { marks, options }
}

async function readLedger() {
  try {
    return JSON.parse(await fsp.readFile(ledgerFile, 'utf8'))
  } catch {
    return { pluginVersion: pkg.version, updatedAt: null, tools: {} }
  }
}

async function writeLedger(ledger) {
  ledger.pluginVersion = pkg.version
  ledger.updatedAt = new Date().toISOString()
  await fsp.mkdir(path.dirname(ledgerFile), { recursive: true })
  await fsp.writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

const STATUS_LABEL = {
  pass: '✅ 通过',
  fail: '❌ 失败',
  blocked: '🚫 阻塞',
  pending: '⏳ 待验',
  stale: '⚠️ 已修改',
  never: '· 未验证',
}

const tools = buildTools(stub)
const { marks, options } = parseArgs(process.argv.slice(2))
const ledger = await readLedger()

// ---- 记录验证结果（--mark 单条，或 --from 文件批量，避免命令行传中文乱码）
const entries = []
if (options.from) {
  const batch = JSON.parse(await fsp.readFile(options.from, 'utf8'))
  for (const item of Array.isArray(batch) ? batch : batch.tools ?? []) {
    if (!item?.name || !item?.status) continue
    entries.push({ name: item.name, status: item.status, evidence: item.evidence ?? '', note: item.note ?? '' })
  }
}
for (const mark of marks) {
  const [name, status] = String(mark).split('=')
  entries.push({ name, status, evidence: options.evidence, note: options.note })
}
if (entries.length > 0) {
  for (const entry of entries) {
    const tool = tools.find((item) => item.name === entry.name)
    if (!tool) {
      console.error(`未知工具：${entry.name}`)
      process.exitCode = 1
      continue
    }
    if (!['pass', 'fail', 'blocked', 'pending'].includes(entry.status)) {
      console.error(`状态只能是 pass/fail/blocked/pending：${entry.name}=${entry.status}`)
      process.exitCode = 1
      continue
    }
    ledger.tools[entry.name] = {
      status: entry.status,
      fingerprint: fingerprint(tool),
      verifiedAt: new Date().toISOString(),
      // 每次记录都是一次新的验证：证据/备注以本次为准，不继承旧状态
      evidence: entry.evidence,
      note: entry.note,
      pluginVersion: pkg.version,
    }
    console.log(`已记录 ${entry.name} → ${entry.status}`)
  }
  await writeLedger(ledger)
}

// ---- 报告
const rows = tools.map((tool) => {
  const entry = ledger.tools[tool.name] ?? null
  const current = fingerprint(tool)
  const changed = entry && entry.fingerprint !== current
  const status = !entry ? 'never' : changed ? 'stale' : entry.status
  return {
    name: tool.name,
    status,
    changed,
    verifiedAt: entry?.verifiedAt ?? null,
    fingerprint: current,
    evidence: entry?.evidence ?? '',
    note: entry?.note ?? '',
  }
})

if (options.json) {
  console.log(JSON.stringify({ pluginVersion: pkg.version, updatedAt: ledger.updatedAt, tools: rows }, null, 2))
} else {
  console.log('')
  console.log(`dsh-local-orchestrator 工具验证台账（插件 ${pkg.version}，共 ${rows.length} 个工具）`)
  console.log('─'.repeat(96))
  const width = Math.max(...rows.map((row) => row.name.length)) + 2
  for (const row of rows) {
    const when = row.verifiedAt ? row.verifiedAt.slice(0, 16).replace('T', ' ') : '—'
    const label = STATUS_LABEL[row.status] ?? row.status
    const extra = row.note || row.evidence
    console.log(
      `${row.name.padEnd(width)}${label.padEnd(12)}${when.padEnd(18)}${extra ? ` ${extra}` : ''}`,
    )
  }
  console.log('─'.repeat(96))
  const need = rows.filter((row) => ['never', 'stale', 'pending', 'fail', 'blocked'].includes(row.status))
  if (need.length === 0) {
    console.log('全部工具在当前指纹下都有通过记录。')
  } else {
    console.log(`需要（重新）验证：${need.map((row) => row.name).join('、')}`)
    console.log('验证后记录：node scripts/verify-tools.mjs --mark <工具>=pass --evidence "…"')
  }
  if (ledger.updatedAt) console.log(`台账更新时间：${ledger.updatedAt}`)
}

// --strict：有未验证/已修改/失败的工具就返回非 0（CI 或提交前闸门）
if (options.strict) {
  const pending = rows.filter((row) => ['never', 'stale', 'pending', 'fail', 'blocked'].includes(row.status))
  if (pending.length > 0) {
    console.error(`\n[--strict] ${pending.length} 个工具没有当前指纹下的通过记录：${pending.map((row) => row.name).join('、')}`)
    process.exitCode = 1
  }
}
