/**
 * 预算表：LLM、生成式工作流、一次性脚本、MCP 的统一记账。
 *
 * 定位里的一句话是「把 LLM、生成式工作流、一次性脚本统一进一张预算表」。
 * 物理上真正扣减显存的是驱动，硬件读数（hardware.sample）已经包含已加载模型；
 * 所以这张表不做二次扣减，而是回答三个问题：
 *   1. 现在卡上都被谁占着（source / assetId / holder）；
 *   2. 各部分合计多少（bySource）；
 *   3. 再来一个 N MB 的资产放不放得下（check，仍以硬件可用量为准）。
 *
 * 好处是：UI、工具、调度共用同一份账本，不会出现「管理器说占 5G、面板说 3G」。
 */
let counter = 0

function nextId() {
  counter += 1
  return `bud-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** 资产 → 预算科目。 */
export function sourceOf(asset) {
  if (!asset) return 'other'
  if (asset.runtime === 'mcp') return 'mcp'
  if (asset.runtime === 'workflow' || asset.serviceId) return 'workflow'
  if (asset.script) return 'script'
  if (asset.runtime === 'llama.cpp') return 'llm'
  // mock / 自研服务：按能力归类，避免全落到「其它」
  if (['llm', 'vlm', 'embed', 'rerank'].includes(asset.kind)) return 'llm'
  if (['image', 'video', 'music'].includes(asset.kind)) return 'workflow'
  if (String(asset.kind ?? '').startsWith('audio')) return 'script'
  return 'other'
}

const SOURCE_LABEL = {
  llm: '文本模型',
  workflow: '生成工作流',
  script: '一次性脚本',
  mcp: 'MCP 服务',
  other: '其它',
}

export class BudgetTable {
  /**
   * @param {{config?: object, hardware?: object, onEvent?: Function}} [options]
   */
  constructor({ config = {}, hardware = null, onEvent = null } = {}) {
    this.config = config
    this.hardware = hardware
    this.onEvent = onEvent
    /** @type {Map<string, object>} */
    this.entries = new Map()
  }

  #emit(kind, msg, data) {
    try {
      this.onEvent?.(kind, msg, data)
    } catch {
      /* 记账失败不能影响调度 */
    }
  }

  /**
   * 登记一个占用。
   * @param {{source?: string, assetId: string, holder?: object|null, vramMb?: number, ramMb?: number, note?: string}} input
   * @returns {object} entry
   */
  open({ source = 'other', assetId, holder = null, vramMb = 0, ramMb = 0, note = '' } = {}) {
    const entry = {
      id: nextId(),
      source,
      assetId: String(assetId ?? source),
      holder,
      vramMb: Math.max(0, Math.round(Number(vramMb) || 0)),
      ramMb: Math.max(0, Math.round(Number(ramMb) || 0)),
      note,
      since: Date.now(),
    }
    this.entries.set(entry.id, entry)
    this.#emit('budget:open', `预算登记 ${SOURCE_LABEL[source] ?? source} ${entry.assetId}（${entry.vramMb}MB 显存）`, {
      id: entry.id,
      assetId: entry.assetId,
    })
    return entry
  }

  update(id, patch = {}) {
    const entry = this.entries.get(id)
    if (!entry) return null
    Object.assign(entry, patch)
    return entry
  }

  close(id, reason = '释放') {
    const entry = this.entries.get(id)
    if (!entry) return null
    this.entries.delete(id)
    this.#emit('budget:close', `预算释放 ${entry.assetId}（${reason}）`, { id, assetId: entry.assetId })
    return entry
  }

  /** 按资产释放（同一资产可能有多条，比如脚本并发）。 */
  closeByAsset(assetId, reason = '卸载') {
    const closed = []
    for (const entry of [...this.entries.values()]) {
      if (entry.assetId === assetId) closed.push(this.close(entry.id, reason))
    }
    return closed
  }

  closeByHolder(predicate, reason = '任务结束') {
    const closed = []
    for (const entry of [...this.entries.values()]) {
      if (predicate(entry.holder)) closed.push(this.close(entry.id, reason))
    }
    return closed
  }

  find(assetId, source = null) {
    for (const entry of this.entries.values()) {
      if (entry.assetId !== assetId) continue
      if (source && entry.source !== source) continue
      return entry
    }
    return null
  }

  list() {
    return [...this.entries.values()]
  }

  /** 合计（按科目）。 */
  committed() {
    const bySource = {}
    let vramMb = 0
    let ramMb = 0
    for (const entry of this.entries.values()) {
      vramMb += entry.vramMb
      ramMb += entry.ramMb
      bySource[entry.source] = (bySource[entry.source] ?? 0) + entry.vramMb
    }
    return { vramMb, ramMb, bySource }
  }

  /**
   * 放不放得下：以硬件可用量为准（used 已包含已加载模型，所以不重复扣减）。
   * @param {{needVramMb?: number, budget?: {vramUsableMb?: number|null}}} input
   */
  check({ needVramMb = 0, budget = {} } = {}) {
    const usable = budget?.vramUsableMb ?? null
    if (usable === null) return { ok: true, needMb: needVramMb, usableMb: null }
    return { ok: needVramMb <= usable, needMb: needVramMb, usableMb: usable }
  }

  /**
   * 给 /state 与 UI 的快照。
   * @param {{vramUsableMb?: number|null, vramReservedMb?: number|null, vramTotalMb?: number|null}} [budget]
   */
  snapshot(budget = {}) {
    const committed = this.committed()
    const bySource = Object.entries(committed.bySource).map(([source, vramMb]) => ({
      source,
      label: SOURCE_LABEL[source] ?? source,
      vramMb,
      count: this.list().filter((entry) => entry.source === source).length,
    }))
    return {
      usableMb: budget?.vramUsableMb ?? null,
      reservedMb: budget?.vramReservedMb ?? null,
      totalMb: budget?.vramTotalMb ?? null,
      committedVramMb: committed.vramMb,
      committedRamMb: committed.ramMb,
      bySource,
      entries: this.list().map((entry) => ({
        id: entry.id,
        source: entry.source,
        label: SOURCE_LABEL[entry.source] ?? entry.source,
        assetId: entry.assetId,
        vramMb: entry.vramMb,
        ramMb: entry.ramMb,
        holder: entry.holder,
        sinceSec: Math.round((Date.now() - entry.since) / 1000),
      })),
    }
  }
}
