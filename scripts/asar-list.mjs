/**
 * 开发期小工具：读取 app.asar 的头部索引，按关键字列出内部文件路径。
 * 用法：node scripts/asar-list.mjs <asar路径> <关键字>
 */
import fs from 'node:fs'

const file = process.argv[2]
const keyword = (process.argv[3] ?? '').toLowerCase()
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, headerBuf, 0, jsonSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
fs.closeSync(fd)

const results = []
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, full)
    else if (full.toLowerCase().includes(keyword)) results.push(`${full}\t${value.size ?? 0}`)
  }
}
walk(header, '')
console.log(`matches=${results.length}`)
for (const line of results.slice(0, 400)) console.log(line)
