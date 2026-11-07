/**
 * 客户端 bundle 冒烟测试：用 vm 捕获 __ModuleLoader__.load 的 factory，
 * 以最小 React 桩执行模块，验证导出与页签注册契约。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

function loadBundle() {
  const registrations = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          registrations.push(definition)
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    document: undefined,
  }
  vm.createContext(sandbox)
  new vm.Script(bundle, { filename: 'client.js' }).runInContext(sandbox)
  return registrations
}

test('client bundle：注册 factory 并导出 name/inject/apply', () => {
  const registrations = loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-local-orchestrator')
  assert.equal(typeof registrations[0].factory, 'function')

  const reactStub = {
    createElement: () => null,
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const exports = registrations[0].factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require: ${name}`)
  })

  assert.equal(exports.name, 'dsh-local-orchestrator')
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('client bundle：apply 注册「本地调度」页签与「本地优先」开关', () => {
  const registrations = loadBundle()
  const reactStub = {
    createElement: () => null,
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const exports = registrations[0].factory((name) => (name === 'react' ? reactStub : null))

  const registered = []
  const injected = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    slots: {
      inject(name, fn) {
        injected.push(name)
        return fn()
      },
      register(definition, component) {
        registered.push({ definition, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.deepEqual(injected.sort(), ['conversation.input.left', 'conversation.view'])
  assert.equal(registered.length, 2)
  const tab = registered.find((item) => item.definition.name === 'conversation.view')
  assert.equal(tab.definition.id, 'local-orchestrator')
  assert.equal(tab.definition.order, 45)
  assert.equal(tab.definition.label(), '本地调度')
  assert.equal(typeof tab.component, 'function')

  const toggle = registered.find((item) => item.definition.name === 'conversation.input.left')
  assert.equal(toggle.definition.id, 'local-first-toggle')
  assert.equal(typeof toggle.component, 'function')
})
