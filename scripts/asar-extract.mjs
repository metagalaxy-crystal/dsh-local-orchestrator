/**
 * 开发期小工具：从 app.asar 里按内部路径提取单个文件。
 * 用法：node scripts/asar-extract.mjs <asar> <内部路径> <输出文件>
 */
import fs from 'node:fs'
import path from 'node:path'

const [file, internal, out] = process.argv.slice(2)
if (!file || !internal || !out) {
  console.error('用法：node scripts/asar-extract.mjs <asar> <内部路径> <输出文件>')
  process.exit(1)
}
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, headerBuf, 0, jsonSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))

let node = header
for (const part of internal.split('/')) {
  node = node.files?.[part]
  if (!node) {
    console.error(`找不到：${internal}`)
    process.exit(2)
  }
}
if (node.files) {
  console.error('这是目录，不是文件')
  process.exit(3)
}
const dataOffset = 16 + jsonSize
const start = dataOffset + Number(node.offset ?? 0)
const buf = Buffer.alloc(node.size)
fs.readSync(fd, buf, 0, node.size, start)
fs.closeSync(fd)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, buf)
console.log(`extracted ${internal} -> ${out} (${node.size} bytes)`)
