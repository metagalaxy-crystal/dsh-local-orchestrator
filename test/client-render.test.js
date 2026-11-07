/**
 * 客户端渲染结构冒烟测试：不依赖浏览器/真实 React，
 * 用最小 React 桩执行纯组件，检查各页签的关键文案与结构是否生成。
 *
 * 目的：在 DSH 重启前就能发现「组件抛异常 / 缺字段 / 渲染空树」这类问题。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

function makeReact(overrides = {}) {
  let index = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const at = index
      index += 1
      const value = Object.prototype.hasOwnProperty.call(overrides, at)
        ? overrides[at]
        : typeof initial === 'function'
          ? initial()
          : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef() {
      return { current: null }
    },
    useCallback(fn) {
      return fn
    },
    __reset() {
      index = 0
    },
    __setIndex(n) {
      index = n
    },
  }
}

function loadInternals(overrides) {
  const registrations = []
  const context = {
    window: { __ModuleLoader__: { load: (def) => registrations.push(def) } },
    console,
    setTimeout,
    clearTimeout,
    document: undefined,
  }
  vm.createContext(context)
  new vm.Script(bundle, { filename: 'client.js' }).runInContext(context)
  const react = makeReact(overrides)
  const exports = registrations[0].factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  return { internals: exports.__internals, react }
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  // 函数组件：用同一套 React 桩就地展开
  if (typeof node.type === 'function') {
    try {
      collectText(node.type(node.props), out)
    } catch (error) {
      out.push(`[render-error:${error.message}]`)
    }
    return out
  }
  if (node.children) collectText(node.children, out)
  return out
}

const state = {
  ts: new Date().toISOString(),
  hardware: {
    backend: 'nvidia-smi',
    cpu: { model: 'Test CPU', cores: 16, loadPct: 12.5 },
    memory: { totalMb: 32768, usedMb: 16000, freeMb: 16768, usedPct: 48.8 },
    vram: { totalMb: 8151, usedMb: 2300, freeMb: 5851 },
    gpus: [],
    adapters: [
      { name: 'Intel(R) UHD Graphics', vendor: 'intel', kind: 'integrated', schedulable: false },
      { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', vendor: 'nvidia', kind: 'discrete', schedulable: true, vramMb: 8151 },
    ],
  },
  budget: { vramUsableMb: 5100, vramReservedMb: 1400, vramTotalMb: 8151 },
  running: [],
  slots: { gpu: { exclusive: true, used: 0, current: null }, cpu: { used: 0, max: 2 } },
  queue: 0,
  catalog: { total: 1, enabled: 1, byKind: { llm: 1 } },
  assets: [
    {
      id: 'nanbeige',
      name: 'Nanbeige',
      kind: 'llm',
      slot: 'gpu',
      port: 8080,
      state: 'stopped',
      estimateVramMb: 2835,
      pinned: false,
      enabled: true,
      task: '轻量文本',
      framework: 'llama.cpp',
      invoke: 'local_chat {"asset":"nanbeige"}',
      components: [],
    },
    {
      id: 'zimage',
      name: 'Z-Image',
      kind: 'image',
      slot: 'gpu',
      port: 8188,
      state: 'stopped',
      estimateVramMb: 8700,
      pinned: false,
      enabled: true,
      task: '文生图',
      category: 'image',
      framework: 'comfyui',
      invoke: 'local_generate {"asset":"zimage"}',
      components: [
        { name: 'ae.safetensors', role: 'vae', file: 'ae.safetensors', exists: true },
        { name: 'qwen_3_4b.safetensors', role: 'encoder', file: 'qwen_3_4b.safetensors', exists: true },
        { name: 'gone.safetensors', role: 'encoder', file: 'gone.safetensors', exists: false },
      ],
    },
    {
      id: 'moss-tts',
      name: 'MOSS-TTS',
      kind: 'audio-tts',
      slot: 'gpu',
      port: 0,
      state: 'stopped',
      enabled: true,
      task: '中文语音合成',
      category: 'audio',
      framework: 'python',
      invoke: 'local_audio {"action":"tts"}',
      components: [],
    },
    {
      id: 'campplus',
      name: 'campplus',
      kind: 'tool',
      slot: 'gpu',
      port: 0,
      state: 'stopped',
      enabled: false,
      task: '声纹嵌入',
      category: 'audio',
      hidden: true,
      componentOf: 'moss-tts',
      role: 'speaker',
      components: [],
    },
  ],
  runs: [],
  io: { decision: [], local: [], mcp: [], system: [] },
  events: [],
  workflows: ['txt2img'],
  config: {
    scheduler: { gpuExclusive: true, idleUnloadSec: 900, maxCpuLoads: 2, loadTimeoutMs: 600000 },
    hardware: { reserveVramMb: 768, reserveRatio: 0.08 },
    decision: { mode: 'session', provider: 'deepseek', model: '', planning: true },
    comfy: { imageWorkflow: '' },
    mcpServers: [],
    prompt: { enabled: true },
  },
}

test('总览页：渲染资源卡、资产卡与关键文案', () => {
  const { internals, react } = loadInternals({ 0: state })
  react.__reset()
  const tree = internals.LocalOrchestratorView()
  const text = collectText(tree).join(' ')
  assert.match(text, /本地资源调度/)
  assert.match(text, /CPU/)
  assert.match(text, /内存/)
  assert.match(text, /显存/)
  // 显存卡要把「已用 / 可调度 / 保留」分开，避免预留被误读成占用
  assert.match(text, /已用/)
  assert.match(text, /可调度/)
  assert.match(text, /保留/)
  // 核显要单独标注，且说明不参与调度
  assert.match(text, /核显 Intel\(R\) UHD Graphics/)
  assert.match(text, /不参与调度/)
  assert.match(text, /nanbeige/)
  assert.match(text, /加载/)
})

test('任务页：RunCard 画出节点框图与进度', () => {
  const { internals } = loadInternals({})
  const run = {
    id: 'run-1',
    kind: 'delegate',
    title: '写一段产品文案',
    status: 'running',
    startedAt: Date.now() - 5000,
    ms: 5000,
    summary: '两步完成',
    nodes: [
      { id: 'n1', kind: 'decision', label: '决策模型 · session', status: 'done', ms: 800, detail: '2 步' },
      { id: 'n2', kind: 'local-llm', label: '本地推理 · nanbeige', status: 'running', ms: 1200, detail: '' },
    ],
  }
  const tree = internals.RunCard({ run })
  const text = collectText(tree).join(' ')
  assert.match(text, /写一段产品文案/)
  assert.match(text, /决策模型/)
  assert.match(text, /本地推理/)
  assert.match(text, /→/)
  assert.match(text, /1\/2 步/)
})

test('输入输出页：IoCard 展示请求/响应内容', () => {
  const { internals } = loadInternals({})
  const entry = {
    id: 'io-1',
    ts: new Date().toISOString(),
    channel: 'local',
    kind: 'request',
    title: 'nanbeige 输入',
    content: '把这段周报压成 10 条要点',
  }
  const tree = internals.IoCard({ entry })
  const text = collectText(tree).join(' ')
  assert.match(text, /nanbeige 输入/)
  assert.match(text, /把这段周报压成 10 条要点/)
  assert.match(text, /输入/)
})

test('资产页与设置页：渲染表格、模板字段', () => {
  const { internals, react } = loadInternals({})
  react.__reset()
  const assetsTree = internals.AssetsTab({
    assets: [...state.assets, {
      id: 'broken-model',
      name: 'Broken',
      kind: 'llm',
      slot: 'gpu',
      port: 8080,
      state: 'stopped',
      enabled: true,
      task: '缺文件的模型',
      framework: 'llama.cpp',
      invoke: 'local_chat {"asset":"broken-model"}',
      components: [],
      healthy: false,
      missing: ['模型文件：text/nope/x.gguf'],
    }],
    frameworks: [
      { id: 'llama.cpp', name: 'llama.cpp', path: 'D:/models/llama-server.exe', exists: true, count: 2, note: '' },
      { id: 'comfyui', name: 'ComfyUI', path: 'D:/models/ComfyUI', exists: false, count: 1, note: '' },
    ],
    onAction: () => {},
    notify: () => {},
    reload: () => {},
  })
  const assetsText = collectText(assetsTree).join(' ')
  assert.match(assetsText, /资产列表/)
  assert.match(assetsText, /nanbeige/)
  assert.match(assetsText, /编辑/)
  // 主模型 + 配套组件：框架、调用方式、组件标签都在同一张卡里
  assert.match(assetsText, /ComfyUI/)
  assert.match(assetsText, /编码器 · qwen_3_4b\.safetensors/)
  assert.match(assetsText, /VAE · ae\.safetensors/)
  assert.match(assetsText, /local_generate/)
  // 配套组件 campplus 不单独占一行，而是挂在 moss-tts 下
  assert.match(assetsText, /声纹 · campplus/)
  assert.equal((assetsText.match(/campplus/g) || []).length, 1)
  // 运行框架条 + 连通性
  assert.match(assetsText, /llama\.cpp/)
  assert.match(assetsText, /ComfyUI/)
  assert.match(assetsText, /缺 1 个文件/)
  assert.match(assetsText, /缺失：模型文件：text\/nope\/x\.gguf/)
  // 组件缺失标 ⚠；组件可自行更换
  assert.match(assetsText, /编码器 · gone\.safetensors ⚠/)
  assert.match(assetsText, /改组件/)

  react.__reset()
  const settingsTree = internals.SettingsTab({
    config: state.config,
    workflows: ['zimage', 'ernie'],
    workflowProfiles: [{ id: 'zimage', kind: 'image', strengths: '通用写实', keywords: ['写实'] }],
    onSaved: () => {},
    notify: () => {},
  })
  const settingsText = collectText(settingsTree).join(' ')
  assert.match(settingsText, /调度策略/)
  assert.match(settingsText, /决策模型/)
  assert.match(settingsText, /工作流选择/)
  assert.match(settingsText, /自动选择/)
  assert.match(settingsText, /图像工作流模板/)
  assert.match(settingsText, /zimage/)
})

test('本地优先开关：输入框旁渲染按钮', () => {
  const { internals, react } = loadInternals({})
  react.__reset()
  const tree = internals.LocalFirstToggle({ sessionId: 'session-test' })
  const text = collectText(tree).join(' ')
  assert.match(text, /本地优先/)
  assert.equal(tree.type, 'button')
})

test('任务池页：按会话分组、步骤树、执行环与租约', () => {
  // useState[0] = open（默认展开第一个任务）
  const { internals } = loadInternals({ 0: 'task-1' })
  const items = [
    {
      id: 'task-1',
      sessionId: 'sess-a',
      title: '生成海报并评估',
      status: 'running',
      autoAdvance: true,
      pauseReason: null,
      planSummary: '先出图再评估',
      progress: { done: 0, total: 2 },
      steps: [
        { index: 0, goal: '出图', kind: 'image', asset: 'zimage', status: 'running', ms: 0, attempts: 0, error: '' },
        { index: 1, goal: '评估', kind: 'evaluate', asset: '', status: 'pending', ms: 0, attempts: 0, error: '' },
      ],
    },
    {
      id: 'task-2',
      sessionId: 'sess-b',
      title: '写文案',
      status: 'waiting_decision',
      autoAdvance: false,
      pauseReason: '步骤需要判断',
      progress: { done: 1, total: 1 },
      steps: [{ index: 0, goal: '写', kind: 'llm', asset: 'lfm', status: 'done', ms: 1200, attempts: 0, error: '' }],
    },
  ]
  const tree = internals.TaskPool({
    items,
    leases: [{ slot: 'gpu', assetId: 'zimage' }],
    worker: { running: true, active: { taskId: 'task-1', stepIndex: 0, startedSec: 3 } },
    onAction: () => {},
  })
  const text = collectText(tree).join(' ')
  assert.match(text, /执行环/)
  assert.match(text, /运行中/)
  assert.match(text, /生成海报并评估/)
  assert.match(text, /sess-a/)
  assert.match(text, /zimage/)
  assert.match(text, /0\/2 步/)
  assert.match(text, /待决策/)
  assert.match(text, /步骤需要判断/)
  assert.match(text, /恢复/)
  assert.match(text, /取消/)
})

test('用量页：KPI、按资产占比、趋势与明细表', () => {
  const { internals } = loadInternals()
  const usage = {
    file: 'D:/data/usage.jsonl',
    summary: {
      windowHours: 24,
      calls: 3,
      okCalls: 3,
      failedCalls: 0,
      promptTokens: 3200,
      completionTokens: 800,
      totalTokens: 4000,
      ms: 6000,
      tokensPerSec: 133.3,
      avgCtxPct: 12.5,
      byAsset: [
        { id: 'nanbeige', tokens: 3000, promptTokens: 2400, completionTokens: 600, calls: 2, ms: 4000 },
        { id: 'minicpmv', tokens: 1000, promptTokens: 800, completionTokens: 200, calls: 1, ms: 2000 },
      ],
    },
    recent: [
      { ts: new Date().toISOString(), assetId: 'nanbeige', ok: true, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, ms: 2000, ctx: 8192, ctxPct: 18.3 },
      { ts: new Date().toISOString(), assetId: 'minicpmv', ok: true, promptTokens: 800, completionTokens: 200, totalTokens: 1000, ms: 2000, ctx: 8192, ctxPct: 12.2 },
      { ts: new Date().toISOString(), assetId: 'nanbeige', ok: true, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, ms: 2000, ctx: 8192, ctxPct: 18.3 },
    ],
  }
  const tree = internals.UsageTab({ usage, reload: () => {} })
  const text = collectText(tree).join(' ')
  assert.match(text, /本地模型用量/)
  assert.match(text, /调用次数/)
  assert.match(text, /输出速度/)
  assert.match(text, /133\.3 tok\/s/)
  assert.match(text, /平均上下文占用/)
  assert.match(text, /12\.5%/)
  assert.match(text, /按资产分配/)
  assert.match(text, /nanbeige/)
  assert.match(text, /minicpmv/)
  assert.match(text, /调用明细/)
  assert.match(text, /18\.3%/)

  const empty = collectText(internals.UsageTab({ usage: null, reload: () => {} })).join(' ')
  assert.match(empty, /还没有记录/)
})

