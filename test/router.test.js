/**
 * 工作流自动路由：按任务描述挑模型/工作流。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inferKind, selectWorkflow, describeWorkflows } from '../lib/router.js'

function asset(id, kind, keywords, { priority = 45, enabled = true } = {}) {
  return {
    id,
    name: id,
    kind,
    runtime: 'workflow',
    enabled,
    priority,
    keywords,
    strengths: `${id} strengths`,
    task: `${id} task`,
  }
}

const assets = [
  asset('zimage', 'image', ['写实', '通用', '场景']),
  asset('ernie', 'image', ['海报', '文字', '信息图']),
  asset('anima', 'image', ['二次元', '动漫', '立绘']),
  asset('minimax-h3-t2v', 'video', ['视频', '文生视频', '音效']),
  asset('minimax-h3-i2v', 'video', ['首帧', '图生视频', '参考图']),
  asset('wan22-t2v_api', 'video', ['视频', '备选']),
  asset('acestep', 'music', ['音乐', '配乐']),
]

test('inferKind：按名词推断产物类型', () => {
  assert.equal(inferKind('做一张海报'), 'image')
  assert.equal(inferKind('生成一段赛博朋克城市视频'), 'video')
  assert.equal(inferKind('配一首轻音乐'), 'music')
  assert.equal(inferKind('随便做点什么'), null)
})

test('selectWorkflow：海报→ernie、二次元→anima、首帧→i2v、音乐→acestep', () => {
  assert.equal(selectWorkflow(assets, '做一张中文海报，标题要清晰').asset.id, 'ernie')
  assert.equal(selectWorkflow(assets, '画一个二次元少女立绘').asset.id, 'anima')
  assert.equal(selectWorkflow(assets, '用这张参考图做首帧，生成视频').asset.id, 'minimax-h3-i2v')
  assert.equal(selectWorkflow(assets, '生成一段城市夜景视频').asset.id, 'minimax-h3-t2v')
  assert.equal(selectWorkflow(assets, '配一段轻音乐').asset.id, 'acestep')
})

test('selectWorkflow：prefer 只影响无命中回落，不抢关键词', () => {
  const fallback = selectWorkflow(assets, '随便画点什么', { kind: 'image', prefer: 'anima' })
  assert.equal(fallback.asset.id, 'anima')
  const keyword = selectWorkflow(assets, '做一张中文海报', { kind: 'image', prefer: 'zimage' })
  assert.equal(keyword.asset.id, 'ernie')
})

test('selectWorkflow：无关键词命中时回落到默认，且可用 kind 强制', () => {
  const image = selectWorkflow(assets, '随便画点什么')
  assert.equal(image.kind, 'image')
  assert.equal(image.asset.id, 'zimage')

  const forced = selectWorkflow(assets, '随便做点什么', { kind: 'music' })
  assert.equal(forced.asset.id, 'acestep')

  const prefer = selectWorkflow(assets, '随便画点什么', { kind: 'image', prefer: 'anima' })
  assert.equal(prefer.asset.id, 'anima')
})

test('selectWorkflow：禁用资产不参与；describeWorkflows 只列生成类', () => {
  const disabled = [asset('off', 'image', ['海报'], { enabled: false }), ...assets]
  assert.notEqual(selectWorkflow(disabled, '海报').asset.id, 'off')
  const list = describeWorkflows(disabled)
  assert.ok(list.every((item) => item.id !== 'off'))
  assert.equal(list.find((item) => item.id === 'ernie').strengths, 'ernie strengths')
})
