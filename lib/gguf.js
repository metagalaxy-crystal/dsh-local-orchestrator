/**
 * GGUF 元数据解析与「按剩余显存反推加载参数」。
 *
 * 目的：文件体积只能估权重，估不出 KV cache。3B 模型在 32K 上下文下实测
 * 5.6GB（权重 2.8GB + KV/缓冲 2.8GB）就是 KV 被忽略的典型。这里直接读
 * GGUF 头里的 block_count / head_count_kv / head_dim，算出每 token 的 KV
 * 开销，再在预算内选 ctx / ngl / KV 量化。
 *
 * 只读元数据（不碰张量数据），解析到 metadata 结束为止；默认最多读 32MB。
 */
import fsp from 'node:fs/promises'

const VALUE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
}

/** KV cache 每元素的字节数（含 block 量化开销的近似）。 */
const KV_BYTES = {
  f16: 2,
  bf16: 2,
  f32: 4,
  q8_0: 1.0625,
  q5_0: 0.6875,
  q5_1: 0.75,
  q4_0: 0.5625,
  q4_1: 0.625,
}

/** 读 GGUF 元数据；失败返回 null（调用方降级到体积估算）。 */
export async function readGgufMeta(filePath, { maxBytes = 128 * 1024 * 1024 } = {}) {
  let handle
  try {
    handle = await fsp.open(filePath, 'r')
    const stat = await handle.stat()
    const readSize = Math.min(stat.size, maxBytes)
    const buf = Buffer.allocUnsafe(readSize)
    await handle.read(buf, 0, readSize, 0)

    let offset = 0
    const need = (n) => {
      if (offset + n > readSize) throw new Error('GGUF 元数据超出读取窗口')
    }
    const u32 = () => {
      need(4)
      const value = buf.readUInt32LE(offset)
      offset += 4
      return value
    }
    const u64 = () => {
      need(8)
      const value = Number(buf.readBigUInt64LE(offset))
      offset += 8
      return value
    }
    const i64 = () => {
      need(8)
      const value = Number(buf.readBigInt64LE(offset))
      offset += 8
      return value
    }
    const str = () => {
      const length = u64()
      need(length)
      const value = buf.toString('utf8', offset, offset + length)
      offset += length
      return value
    }
    const scalarSize = {
      [VALUE.UINT8]: 1,
      [VALUE.INT8]: 1,
      [VALUE.UINT16]: 2,
      [VALUE.INT16]: 2,
      [VALUE.UINT32]: 4,
      [VALUE.INT32]: 4,
      [VALUE.FLOAT32]: 4,
      [VALUE.BOOL]: 1,
      [VALUE.UINT64]: 8,
      [VALUE.INT64]: 8,
      [VALUE.FLOAT64]: 8,
    }
    /** 跳过一个大数组的元素（分词表动辄十几万条，不能物化）。 */
    const skipOne = (type) => {
      if (type === VALUE.STRING) {
        const length = u64()
        need(length)
        offset += length
        return
      }
      if (type === VALUE.ARRAY) {
        const inner = u32()
        const count = u64()
        for (let i = 0; i < count; i += 1) skipOne(inner)
        return
      }
      const size = scalarSize[type]
      if (!size) throw new Error(`无法跳过 GGUF 类型 ${type}`)
      need(size)
      offset += size
    }
    const value = (type) => {
      switch (type) {
        case VALUE.UINT8:
          need(1)
          return buf.readUInt8(offset++)
        case VALUE.INT8:
          need(1)
          return buf.readInt8(offset++)
        case VALUE.UINT16:
          need(2)
          offset += 2
          return buf.readUInt16LE(offset - 2)
        case VALUE.INT16:
          need(2)
          offset += 2
          return buf.readInt16LE(offset - 2)
        case VALUE.UINT32:
          return u32()
        case VALUE.INT32: {
          need(4)
          offset += 4
          return buf.readInt32LE(offset - 4)
        }
        case VALUE.FLOAT32: {
          need(4)
          offset += 4
          return buf.readFloatLE(offset - 4)
        }
        case VALUE.BOOL:
          need(1)
          return buf.readUInt8(offset++) !== 0
        case VALUE.STRING:
          return str()
        case VALUE.ARRAY: {
          const inner = u32()
          const count = u64()
          // 大数组（分词表等）直接跳过，只标记存在
          if (count > 100000) {
            for (let i = 0; i < count; i += 1) skipOne(inner)
            return { skipped: true, count }
          }
          const out = []
          for (let i = 0; i < count; i += 1) out.push(value(inner))
          return out
        }
        case VALUE.UINT64:
          return u64()
        case VALUE.INT64:
          return i64()
        case VALUE.FLOAT64: {
          need(8)
          offset += 8
          return buf.readDoubleLE(offset - 8)
        }
        default:
          throw new Error(`未知 GGUF 类型 ${type}`)
      }
    }

    const magic = buf.toString('ascii', 0, 4)
    if (magic !== 'GGUF') throw new Error(`不是 GGUF 文件：${magic}`)
    offset = 4
    const version = u32()
    const tensorCount = u64()
    const kvCount = u64()

    const meta = {}
    for (let i = 0; i < kvCount; i += 1) {
      const key = str()
      const type = u32()
      meta[key] = value(type)
    }
    return { version, tensorCount, kvCount, meta, fileSizeMb: Math.round(stat.size / 1024 / 1024) }
  } catch (error) {
    if (process.env.DSH_GGUF_DEBUG) console.error('[gguf]', filePath, error)
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** 从元数据提取与显存估算相关的字段。 */
export function summarize(meta) {
  const data = meta?.meta ?? {}
  const arch = data['general.architecture'] ?? 'unknown'
  const get = (suffix) => data[`${arch}.${suffix}`]
  const blockCount = Number(get('block_count') ?? 0)
  const headCount = Number(get('attention.head_count') ?? 0)
  const headCountKv = get('attention.head_count_kv')
  const embedding = Number(get('embedding_length') ?? 0)
  const keyLength = Number(get('attention.key_length') ?? 0) || (headCount > 0 ? Math.round(embedding / headCount) : 0)
  const valueLength = Number(get('attention.value_length') ?? 0) || keyLength
  return {
    architecture: arch,
    name: data['general.name'] ?? '',
    blockCount,
    headCount,
    headCountKv,
    keyLength,
    valueLength,
    embeddingLength: embedding,
    contextLength: Number(get('context_length') ?? 0),
    fileSizeMb: meta?.fileSizeMb ?? 0,
  }
}

/** 每 token 的 KV cache 字节数（支持逐层 GQA 的数组形式）。 */
export function kvBytesPerToken(summary, kvType = 'f16', parallel = 1) {
  const bytes = KV_BYTES[kvType] ?? KV_BYTES.f16
  const layers = summary.blockCount || 0
  if (layers <= 0 || summary.keyLength <= 0) return 0
  const heads = summary.headCountKv
  let perLayerTotal = 0
  for (let layer = 0; layer < layers; layer += 1) {
    const kvHeads = Array.isArray(heads) ? Number(heads[layer] ?? heads.at(-1) ?? 0) : Number(heads || summary.headCount || 0)
    perLayerTotal += (summary.keyLength + summary.valueLength) * kvHeads * bytes
  }
  return perLayerTotal * Math.max(1, parallel)
}

/**
 * 估算一次加载要占多少显存（MB）。
 * @param {object} options
 * @param {number} options.fileSizeMb 主模型文件体积
 * @param {object} options.summary summarize() 的结果
 * @param {number} options.ctx
 * @param {number} options.ngl
 * @param {string} options.kvType
 * @param {number} [options.mmprojMb]
 * @param {boolean} [options.cpuMoe] 是否把 MoE 专家权重放内存
 * @param {number} [options.parallel]
 */
export function estimateVramMb({ fileSizeMb, summary, ctx, ngl, kvType = 'f16', mmprojMb = 0, cpuMoe = false, parallel = 1 }) {
  const layers = summary?.blockCount || 0
  const share = cpuMoe ? 0.18 : layers > 0 ? Math.min(1, (ngl ?? layers) / layers) : 1
  const weights = fileSizeMb * share
  const kv = (kvBytesPerToken(summary, kvType, parallel) * ctx) / 1024 / 1024
  // 计算缓冲与 CUDA graph 的实测标定（RTX 5060 + llama.cpp b6xxx）：
  //   ctx 8192 → 约 0.6GB，ctx 32768 → 约 2.3GB；每个额外并行槽再 +0.3GB。
  const buffers = 200 + ctx * 0.067 + Math.max(0, parallel - 1) * 300
  const proj = mmprojMb * 1.05
  return Math.round(weights + kv + buffers + proj)
}

/**
 * 在预算内挑加载参数：优先 KV 量化（画质影响小），其次砍上下文，最后少卸载层。
 * @param {object} options
 * @param {object} options.launch 资产当前 launch
 * @param {number} options.fileSizeMb
 * @param {object} options.summary
 * @param {number|null} options.usableVramMb 可用显存；null 表示未知（保持原参数）
 * @param {number} [options.mmprojMb]
 * @param {number} [options.minCtx]
 */
export function planLlamaParams({ launch = {}, fileSizeMb, summary, usableVramMb, mmprojMb = 0, minCtx = 2048 }) {
  const rawArgs = Array.isArray(launch.rawArgs) ? launch.rawArgs : []
  const cpuMoe = rawArgs.includes('--cpu-moe') || rawArgs.some((arg) => arg === '--n-cpu-moe' || String(arg).startsWith('--n-cpu-moe='))
  const originalCtx = Number(launch.ctx ?? 8192)
  const originalNgl = Number(launch.ngl ?? 99)
  const originalKv = launch.kvType || 'f16'

  const estimate = (ctx, ngl, kvType) =>
    estimateVramMb({ fileSizeMb, summary, ctx, ngl, kvType, mmprojMb, cpuMoe, parallel: launch.parallel ?? 1 })

  const base = {
    ctx: originalCtx,
    ngl: originalNgl,
    kvType: originalKv,
    estimatedVramMb: estimate(originalCtx, originalNgl, originalKv),
    notes: [],
    changed: false,
  }
  if (!usableVramMb || !Number.isFinite(usableVramMb) || usableVramMb <= 0) {
    base.notes.push('显存预算未知，沿用 registry 参数')
    return base
  }
  const limit = usableVramMb * 0.95
  if (base.estimatedVramMb <= limit) {
    base.notes.push('预算内，沿用 registry 参数')
    return base
  }

  let ctx = originalCtx
  let ngl = originalNgl
  let kvType = originalKv

  // 1) KV 量化：f16 → q8_0 → q4_0
  for (const candidate of ['q8_0', 'q4_0']) {
    if (estimate(ctx, ngl, candidate) <= limit) {
      base.kvType = candidate
      base.notes.push(`KV 量化 ${originalKv} → ${candidate}`)
      base.changed = true
      base.estimatedVramMb = estimate(ctx, ngl, candidate)
      return base
    }
  }

  // 2) 砍上下文（保留至少 minCtx，且不超过模型训练上下文）
  const trained = summary?.contextLength || 0
  if (trained > 0) ctx = Math.min(ctx, trained)
  while (ctx > minCtx) {
    ctx = Math.max(minCtx, Math.floor(ctx / 2))
    if (estimate(ctx, ngl, 'q8_0') <= limit) {
      base.ctx = ctx
      base.kvType = 'q8_0'
      base.notes.push(`上下文 ${originalCtx} → ${ctx}，KV → q8_0`)
      base.changed = true
      base.estimatedVramMb = estimate(ctx, ngl, 'q8_0')
      return base
    }
  }

  // 3) 少卸载层（CPU 承担一部分权重）；MoE 场景意义不大，直接放弃
  if (!cpuMoe) {
    for (const ratio of [0.85, 0.7, 0.55]) {
      const candidate = Math.max(0, Math.floor((summary?.blockCount || 32) * ratio))
      if (estimate(ctx, candidate, 'q4_0') <= limit) {
        base.ctx = ctx
        base.ngl = candidate
        base.kvType = 'q4_0'
        base.notes.push(`上下文 ${originalCtx} → ${ctx}，卸载层 ${originalNgl} → ${candidate}，KV → q4_0`)
        base.changed = true
        base.estimatedVramMb = estimate(ctx, candidate, 'q4_0')
        return base
      }
    }
  }

  base.ctx = ctx
  base.kvType = 'q4_0'
  base.estimatedVramMb = estimate(ctx, ngl, 'q4_0')
  base.notes.push(`已压到最低档仍可能超预算（约 ${base.estimatedVramMb}MB > ${Math.round(usableVramMb)}MB）`)
  base.changed = ctx !== originalCtx || kvType !== originalKv
  return base
}
