/**
 * 按需求自动选工作流/资产的路由器。
 *
 * 输入一句任务描述，输出最合适的生成资产（zimage / ernie / anima / minimax-h3-* / acestep）：
 * 1. 先按任务里的名词推断要哪种产物（视频 / 音乐 / 图片）；
 * 2. 再在同类工作流里按关键词命中打分（海报→ernie、二次元→anima、首帧→i2v…）；
 * 3. 都没命中就取该类里优先级最高的（默认工作流），保证永远有结果。
 *
 * 完全本地、零模型调用；决策模型也可以直接用这个函数。
 */

const KIND_HINTS = [
  { kind: 'video', words: ['视频', '镜头', '片段', '动画', '运镜', '转场'] },
  { kind: 'music', words: ['音乐', '配乐', '歌曲', 'bgm', '旋律', '配曲', '人声'] },
  { kind: 'image', words: ['图', '海报', '插画', '封面', '画面', '立绘', '照片'] },
]

/** 从任务文本推断产物类型；没有线索时返回 null。 */
export function inferKind(task) {
  const text = String(task ?? '').toLowerCase()
  for (const hint of KIND_HINTS) {
    if (hint.words.some((word) => text.includes(word))) return hint.kind
  }
  return null
}

/**
 * 在生成类资产里挑最合适的。
 * @param {Array<object>} assets catalog.list() 的资产
 * @param {string} task 任务描述
 * @param {{kind?: string, prefer?: string}} [options]
 * @returns {{asset: object, kind: string, score: number, reason: string, matched: string[]} | null}
 */
export function selectWorkflow(assets, task, options = {}) {
  const text = String(task ?? '').toLowerCase()
  const inferred = options.kind ?? inferKind(task) ?? 'image'
  const candidates = assets.filter(
    (asset) => asset.enabled !== false && asset.runtime === 'workflow' && asset.kind === inferred,
  )
  if (candidates.length === 0) return null

  const scored = candidates.map((asset) => {
    const matched = []
    let score = Number(asset.priority ?? 0)
    for (const keyword of asset.keywords ?? []) {
      if (keyword && text.includes(String(keyword).toLowerCase())) {
        score += 10
        matched.push(keyword)
      }
    }
    return { asset, score, matched }
  })
  scored.sort((a, b) => b.score - a.score)
  let best = scored[0]
  // 没有任何关键词命中时，优先用「该类默认工作流」，而不是目录排序第一个
  if (best.matched.length === 0 && options.prefer) {
    const preferred = scored.find((item) => item.asset.id === options.prefer || item.asset.name === options.prefer)
    if (preferred) best = preferred
  }
  const reason = best.matched.length
    ? `命中关键词：${best.matched.join('、')}`
    : `${inferred} 类默认工作流`
  return { asset: best.asset, kind: inferred, score: best.score, reason, matched: best.matched }
}

/** 供 UI/提示词展示的简短画像。 */
export function describeWorkflows(assets) {
  return assets
    .filter((asset) => asset.runtime === 'workflow' && asset.enabled !== false)
    .map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      strengths: asset.strengths || asset.task,
      keywords: asset.keywords ?? [],
    }))
}
