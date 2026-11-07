/**
 * 工具指纹与 Python UTF-8 环境：改工具后「只有指纹变了才需要重验」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { fingerprintTool } from '../lib/tool-fingerprint.js'
import { PYTHON_UTF8_ENV, isPythonCommand } from '../lib/util.js'

const tool = {
  name: 'demo',
  description: '演示工具',
  parameters: { type: 'object', properties: { a: { type: 'string' } } },
  execute: function execute(args) {
    return args
  },
}

test('fingerprintTool：相同定义指纹稳定，改描述/参数/实现都会变', () => {
  const base = fingerprintTool(tool)
  assert.match(base, /^sha256:[0-9a-f]{16}$/)
  assert.equal(fingerprintTool({ ...tool }), base)

  const renamed = fingerprintTool({ ...tool, name: 'demo2' })
  const described = fingerprintTool({ ...tool, description: '改过的描述' })
  const paramed = fingerprintTool({ ...tool, parameters: { type: 'object', properties: {} } })
  const coded = fingerprintTool({
    ...tool,
    execute: function execute() {
      return null
    },
  })

  for (const fp of [renamed, described, paramed, coded]) {
    assert.notEqual(fp, base)
  }
  assert.equal(new Set([base, renamed, described, paramed, coded]).size, 5)
})

test('isPythonCommand：识别解释器与 .py 脚本', () => {
  assert.equal(isPythonCommand('D:\\models\\.venv\\Scripts\\python.exe', ['main.py']), true)
  assert.equal(isPythonCommand('python', []), true)
  assert.equal(isPythonCommand('python3', []), true)
  assert.equal(isPythonCommand('D:\\x\\llama-server.exe', ['-m', 'a.gguf']), false)
  assert.equal(isPythonCommand('node', ['script.py']), true)
})

test('PYTHON_UTF8_ENV：固定 UTF-8 口径', () => {
  assert.equal(PYTHON_UTF8_ENV.PYTHONIOENCODING, 'utf-8')
  assert.equal(PYTHON_UTF8_ENV.PYTHONUTF8, '1')
})
