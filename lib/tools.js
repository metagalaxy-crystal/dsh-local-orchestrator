/**
 * 暴露给决策模型（当前 DSH 会话模型）的工具。
 *
 * 工具刻意保持少量、语义清晰：
 * - local_resources：看算力与已加载服务
 * - local_assets：看有哪些可调度资产
 * - local_chat：把一次推理交给本地模型（自动加载/卸载）
 * - local_service：加载 / 卸载 / 重启 / 扫描 / 改配置
 * - local_delegate：一整件多步任务交给本地算力（可选决策模型规划）
 *
 * 所有工具统一返回 {ok, text}：text 直接回灌给模型，省去二次解释成本。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { KIND_LABEL } from './catalog.js'
import { saveConfigPatch } from './config.js'
import { resolveWorkflow, listWorkflows } from './workflows.js'
import { selectWorkflow } from './router.js'
import { clip, fmtMb, anySignal, existsSync } from './util.js'
import { ensureStepRunner, STEP_STATUS } from './steps.js'

/** 工具返回的固定形状。 */
function result(ok, text) {
  return { ok, text }
}

function fail(error) {
  return result(false, `错误：${error instanceof Error ? error.message : String(error)}`)
}

/** 生成 OpenAI 视觉消息内容（本地文件 → data URL）。 */
async function imageContent(prompt, imagePath) {
  const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'png'
  const mime = ext === 'jpg' ? 'jpeg' : ext
  const buffer = await fsp.readFile(imagePath)
  const url = `data:image/${mime};base64,${buffer.toString('base64')}`
  return [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url } },
  ]
}

/**
 * 把「对话里手写的资产描述」映射成 catalog 能吃的结构。
 * 只做形状归一，不做存在性校验（verify 会做）；换机器、模型散落各处时靠它登记。
 * @param {object} input
 * @returns {object}
 */
function assetInputOf(input = {}) {
  const out = { ...input }
  const id = String(input.id ?? '').trim()
  if (id) out.id = id
  if (out.name == null) out.name = out.id
  const gguf = input.gguf ?? input.launch?.gguf
  const mmproj = input.mmproj ?? input.launch?.mmproj
  if (gguf) {
    out.runtime = input.runtime ?? 'llama.cpp'
    out.launch = {
      ...(input.launch ?? {}),
      gguf: String(gguf),
      mmproj: mmproj ? String(mmproj) : null,
      ctx: input.ctx ?? input.launch?.ctx ?? null,
      exe: input.exe ?? input.launch?.exe ?? null,
    }
    out.slot = input.slot ?? 'gpu'
    out.kind = input.kind ?? 'llm'
    return out
  }
  if (input.workflow) {
    out.runtime = input.runtime ?? 'workflow'
    out.workflow = String(input.workflow)
    out.slot = input.slot ?? 'gpu'
    out.kind = input.kind ?? 'image'
    return out
  }
  if (input.script) {
    out.runtime = input.runtime ?? 'script'
    out.script = typeof input.script === 'string' ? { file: input.script, args: input.args ?? [] } : input.script
    out.slot = input.slot ?? 'gpu'
    out.kind = input.kind ?? 'audio-tts'
    return out
  }
  if (input.mcp) {
    const mcp = typeof input.mcp === 'string' ? { command: input.mcp, args: input.args ?? [] } : input.mcp
    out.runtime = 'mcp'
    out.mcp = mcp
    out.launch = { ...(input.launch ?? {}), command: [mcp.command, ...(mcp.args ?? [])] }
    out.slot = input.slot ?? 'cpu'
    out.kind = input.kind ?? 'tool'
    out.category = input.category ?? 'mcp'
    return out
  }
  if (input.exe || input.launch?.command) {
    out.runtime = input.runtime ?? 'process'
    out.slot = input.slot ?? 'gpu'
  }
  return out
}

function usageLine(reply) {
  const parts = []
  if (reply.usage?.total_tokens) parts.push(`${reply.usage.total_tokens} tokens`)
  if (Number.isFinite(reply.ms)) parts.push(`${(reply.ms / 1000).toFixed(1)}s`)
  if (reply.instance) {
    const vram = reply.instance.vramMb
    parts.push(`模型 ${reply.assetId}${vram ? `，显存 ${fmtMb(vram)}` : ''}`)
  }
  return parts.length > 0 ? `\n\n_本地执行：${parts.join(' · ')}_` : ''
}

/**
 * 取回复正文：部分小模型（或 max_tokens 太小时）把内容全写在 reasoning_content 里，
 * 正文为空。这种情况把思考内容当正文返回，并在末尾附完整思考。
 */
function replyText(reply) {
  if (reply.content) {
    return reply.reasoning
      ? `${reply.content}\n\n<details><summary>思考过程</summary>\n\n${clip(reply.reasoning, 2000)}\n\n</details>`
      : reply.content
  }
  if (reply.reasoning) {
    return `（模型只返回了思考内容，正文为空）\n\n${reply.reasoning}`
  }
  return '（模型返回了空内容；可调大 maxTokens 或换模型）'
}

function assetLine(asset, instance) {
  const cost = asset.estimateVramMb || asset.measured?.vramMb || asset.cost?.vramMb || null
  const state = instance?.state ?? asset.state ?? 'stopped'
  const slot = asset.slot === 'gpu' ? 'GPU' : 'CPU'
  const costText = cost ? `~${fmtMb(cost)}` : '显存未知'
  return `- ${asset.id}｜${KIND_LABEL[asset.kind] ?? asset.kind}｜${slot}｜${costText}｜${state}｜${asset.task || asset.name}`
}

/**
 * 构建全部工具定义。
 * @param {object} deps
 * @param {import('./manager.js').Orchestrator} deps.orchestrator
 * @param {import('./decision.js').Decision} deps.decision
 * @param {object} deps.config
 */
export function buildTools({ orchestrator, decision, config }) {
  const prefix = config.tools?.prefix ?? 'local_'
  const name = (base) => `${prefix}${base}`
  const tools = []
  /** 当前工具调用所属会话；拿不到时为 null（旧宿主/单测）。 */
  const sessionId = (exec) => exec?.agent?.id ?? null
  /** 任务池（跨会话状态机）。 */
  const store = orchestrator.tasks

  // ------------------------------------------------------------------ 状态
  tools.push({
    name: name('resources'),
    description:
      '查看本机算力与本地模型服务状态：CPU/内存/显存占用、调度预算、已加载的模型、排队请求与最近事件。' +
      '在决定是否把任务交给本地模型、或排查加载失败前先调用。',
    parameters: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: '是否附带资产清单与最近事件' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}) {
      try {
        await orchestrator.start()
        const text = [await orchestrator.statusText()]
        if (args.verbose) {
          const assets = await orchestrator.assets()
          text.push('', '资产：', ...assets.map((asset) => assetLine(asset, orchestrator.instances.get(asset.id))))
          // 用量：本地模型的推理成本（token），不是显存占用
          const usage = orchestrator.stats.summary({ sinceMs: 24 * 3600 * 1000 })
          if (usage.calls > 0) {
            text.push(
              '',
              `最近 ${usage.windowHours}h 用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} tokens` +
                (usage.tokensPerSec ? ` · ${usage.tokensPerSec} tok/s` : '') +
                (usage.avgCtxPct ? ` · 平均上下文 ${usage.avgCtxPct}%` : ''),
            )
            for (const item of usage.byAsset.slice(0, 5)) {
              text.push(`- ${item.id}：${item.calls} 次 · ${item.tokens} tokens`)
            }
          }
          const events = orchestrator.events.recent(8)
          if (events.length > 0) {
            text.push('', '最近事件：', ...events.map((event) => `- ${event.ts.slice(11, 19)} ${event.msg}`))
          }
        }
        return result(true, text.join('\n'))
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 资产
  tools.push({
    name: name('assets'),
    description:
      '列出本地可调度的资产（文本模型、多模态、向量、精排、图像/视频/语音、通用工具服务），' +
      '含类型、占用槽位、预计显存、当前状态和擅长任务。挑模型前用它确认 id。' +
      'action=add/update 可手动登记资产（换机器、模型散落在不同目录时用），action=remove 删除。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove'],
          description: '默认 list；add/update 用 asset 描述资产，remove 用 id',
        },
        kind: {
          type: 'string',
          enum: ['llm', 'vlm', 'embed', 'rerank', 'image', 'video', 'audio-tts', 'audio-asr', 'tool'],
          description: 'list 时只看某一类资产',
        },
        enabledOnly: { type: 'boolean', description: 'list 时只看启用的资产（默认 true）' },
        id: { type: 'string', description: 'remove 时必填；add 时也可直接写在这里（等价 asset.id）' },
        asset: {
          type: 'object',
          description:
            'add/update 的资产描述。最少给 id + 一种运行方式：' +
            'gguf（llama.cpp 模型文件，相对 modelsRoot 或绝对路径，可选 mmproj/ctx/exe）；' +
            'workflow（ComfyUI 工作流 JSON 绝对路径）；script（一次性脚本路径）；mcp（{command,args}）；' +
            'exe+command（通用进程）。可带 name/kind/slot/port/task/desc/enabled/pinned/components。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}) {
      try {
        await orchestrator.start()
        const action = args.action ?? 'list'
        if (action === 'remove') {
          const id = String(args.id ?? args.asset?.id ?? '').trim()
          if (!id) return result(false, 'remove 需要 id')
          const instance = orchestrator.instances.get(id)
          if (instance) await orchestrator.stop(id, { reason: '删除资产前卸载' })
          const done = await orchestrator.catalog.remove(id)
          if (!done) return result(false, `没有这个资产：${id}`)
          return result(true, `已删除资产 ${id}`)
        }
        if (action === 'add' || action === 'update') {
          const input = assetInputOf({ ...(args.asset ?? {}), id: args.asset?.id ?? args.id })
          if (!input.id) return result(false, '需要 asset.id（或用参数 id）')
          const saved = await orchestrator.catalog.upsert(input)
          const check = await orchestrator.catalog.verify(saved)
          const head = action === 'add' ? '已新增' : '已更新'
          const tail = check.ok ? '连通性通过，可以加载' : `注意：本地缺文件（${check.missing.join('、')}），修好前不会参与调度`
          return result(true, `${head}资产 ${saved.id}｜${saved.kind}｜${saved.runtime}｜${tail}`)
        }
        const rows = await orchestrator.assets({
          kind: args.kind,
          enabledOnly: args.enabledOnly !== false,
        })
        if (rows.length === 0) {
          return result(true, '没有匹配的资产。可以运行 local_service {"action":"discover"} 扫描本机模型文件，或检查 config.json 的 paths。')
        }
        const lines = [`共 ${rows.length} 个主模型（id｜类型｜槽位｜预计显存｜状态｜擅长）：`]
        for (const asset of rows) {
          lines.push(assetLine(asset, orchestrator.instances.get(asset.id)))
          if (asset.components && asset.components.length > 0) {
            lines.push(`  配套：${asset.components.map((item) => `${item.role}:${item.name}`).join('、')}`)
          }
          if (asset.healthy === false) {
            lines.push(`  ⚠ 本地缺文件：${(asset.missing || []).join('、')}`)
          }
          if (asset.fitsVram === false) lines.push('  （当前显存放不下，加载前会先淘汰其它模型）')
        }
        const componentCount = orchestrator.catalog.list().length - orchestrator.catalog.list({ includeHidden: false }).length
        if (componentCount > 0) {
          lines.push('', `另有 ${componentCount} 个配套组件（编码器 / VAE / 声码器 / mmproj）挂在主模型下，不单独列出`)
        }
        return result(true, lines.join('\n'))
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 对话
  tools.push({
    name: name('chat'),
    description:
      '在本机模型上完成一次推理（自动加载所需模型，用完可保持热态）。' +
      '适合：批量改写/摘要/分类/抽取、隐私内容、需要省钱或离线的任务。' +
      '冷启动可能要几十秒（模型从磁盘加载），热态下很快。' +
      '不指定 asset 时按能力与显存自动挑选。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要模型完成的任务或问题' },
        system: { type: 'string', description: '可选系统提示' },
        asset: { type: 'string', description: '指定资产 id（先用 local_assets 查）' },
        temperature: { type: 'number', description: '采样温度，默认 0.7' },
        maxTokens: { type: 'number', description: '最大输出 token，默认 2048' },
        json: { type: 'boolean', description: '要求返回 JSON 对象' },
        imagePath: { type: 'string', description: '可选：本地图片绝对路径（会选多模态模型）' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        if (!args.prompt) return result(false, 'prompt 不能为空')
        const kindWanted = args.imagePath ? 'vlm' : null
        let assetId = args.asset
        if (!assetId) {
          const picked = await orchestrator.pick(kindWanted ? { kind: kindWanted } : { kinds: ['llm', 'vlm'] })
          if (!picked?.asset) return result(false, '没有可用的文本模型：请先 local_service discover 或检查目录配置')
          assetId = picked.asset.id
        }
        const content = args.imagePath
          ? await imageContent(args.prompt, args.imagePath)
          : args.prompt
        const run = orchestrator.tracker.start({
          kind: 'chat',
          title: String(args.prompt).slice(0, 80),
          sessionId: sessionId(exec),
          meta: { asset: assetId, image: Boolean(args.imagePath) },
        })
        try {
          const reply = await orchestrator.runChat(assetId, {
            system: args.system,
            messages: [{ role: 'user', content }],
            temperature: args.temperature,
            maxTokens: args.maxTokens,
            json: args.json === true,
            signal: anySignal(exec?.signal, run.signal),
            reason: '工具调用 local_chat',
            runId: run.id,
          })
          if (!reply.ok) {
            orchestrator.tracker.end(run.id, 'error', reply.error)
            return result(false, `本地模型 ${assetId} 调用失败：${reply.error}`)
          }
          orchestrator.tracker.end(run.id, 'done', reply.content.slice(0, 120))
          return result(true, `${replyText(reply)}${usageLine(reply)}`)
        } catch (error) {
          orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 服务控制
  tools.push({
    name: name('service'),
    description:
      '管理本地服务生命周期：load 预加载、stop 卸载、restart 重启、stop_all 全部卸载、reap 回收空闲、' +
      'discover 扫描模型文件、import 重新导入 registry、set 修改调度配置（如 idleUnloadSec / gpuExclusive）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['load', 'stop', 'restart', 'stop_all', 'reap', 'release', 'cancel', 'discover', 'import', 'sync', 'set', 'inspect'],
          description: '要执行的操作',
        },
        asset: { type: 'string', description: '资产 id（load/stop/restart/inspect 需要）' },
        patch: {
          type: 'object',
          description: 'set 时的配置补丁，如 {"scheduler":{"idleUnloadSec":600}}',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        switch (args.action) {
          case 'load': {
            if (!args.asset) return result(false, 'load 需要 asset')
            const run = orchestrator.tracker.start({ kind: 'service', title: `加载 ${args.asset}`, sessionId: sessionId(exec) })
            try {
              const instance = await orchestrator.ensure(args.asset, {
                reason: '工具调用 local_service load',
                signal: anySignal(exec?.signal, run.signal),
                runId: run.id,
              })
              orchestrator.tracker.end(run.id, 'done', instance.state)
              const asset = orchestrator.catalog.get(args.asset)
              return result(
                true,
                `已加载 ${args.asset}（${KIND_LABEL[asset.kind] ?? asset.kind}）\n` +
                  `- 端点：http://${asset.host}:${instance.port ?? asset.port}/v1\n` +
                  `- PID：${instance.pid ?? '外部进程'}\n` +
                  `- 显存：${instance.vramMb ? fmtMb(instance.vramMb) : '未测到（非 NVIDIA 或驱动不暴露）'}\n` +
                  `- 状态：${instance.state}`,
              )
            } catch (error) {
              orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
              throw error
            }
          }
          case 'stop': {
            if (!args.asset) return result(false, 'stop 需要 asset')
            const out = await orchestrator.stop(args.asset, { reason: '工具调用 local_service stop' })
            return result(true, out.message)
          }
          case 'restart': {
            if (!args.asset) return result(false, 'restart 需要 asset')
            const run = orchestrator.tracker.start({ kind: 'service', title: `重启 ${args.asset}`, sessionId: sessionId(exec) })
            try {
              await orchestrator.stop(args.asset, { reason: '重启前卸载' })
              const instance = await orchestrator.ensure(args.asset, {
                reason: '工具调用 restart',
                signal: anySignal(exec?.signal, run.signal),
                runId: run.id,
              })
              orchestrator.tracker.end(run.id, 'done', instance.state)
              return result(true, `已重启 ${args.asset}（${instance.state}，PID ${instance.pid ?? '—'}）`)
            } catch (error) {
              orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
              throw error
            }
          }
          case 'cancel': {
            const sid = sessionId(exec)
            const cancelled = orchestrator.tracker.cancelBySession(sid, '工具调用 local_service cancel')
            const tasks = await store.cancelSession(sid, '工具调用 local_service cancel')
            if (cancelled.length === 0 && tasks.length === 0) return result(true, '本会话没有正在运行的任务')
            return result(true, `已取消 ${cancelled.length} 个运行中调用、${tasks.length} 个任务（不影响其它会话）`)
          }
          case 'stop_all': {
            const results = await orchestrator.stopAll({ reason: '工具调用 stop_all' })
            return result(true, results.length === 0 ? '没有运行中的服务' : results.map((item) => item.message).join('\n'))
          }
          case 'reap': {
            const stopped = await orchestrator.reapIdle()
            return result(true, stopped.length === 0 ? '没有需要回收的服务' : `已回收：${stopped.join('、')}`)
          }
          case 'release': {
            const stopped = await orchestrator.releaseIdle({ minIdleSec: 0, reason: '工具调用 release' })
            return result(true, stopped.length === 0 ? '没有可释放的空闲资源' : `已释放：${stopped.join('、')}`)
          }
          case 'discover': {
            const added = await orchestrator.catalog.discover()
            return result(true, added.length === 0 ? '没有发现新的 .gguf 模型' : `新登记 ${added.length} 个模型：${added.join('、')}`)
          }
          case 'import': {
            const imported = await orchestrator.catalog.importRegistry({ overwrite: true })
            return result(true, imported.length === 0 ? 'registry 没有可导入项' : `已导入 ${imported.length} 个资产：${imported.join('、')}`)
          }
          case 'sync': {
            const out = await orchestrator.catalog.syncEcosystem()
            return result(
              true,
              out.added.length === 0
                ? `资源已是最新（共 ${out.total} 个资产）`
                : `同步新增 ${out.added.length} 个资产：${out.added.join('、')}（共 ${out.total} 个）`,
            )
          }
          case 'set': {
            const patch = args.patch
            if (!patch || typeof patch !== 'object') return result(false, 'set 需要 patch 对象')
            const allowed = ['hardware', 'scheduler', 'decision', 'prompt', 'tools', 'comfy', 'mcpServers']
            const filtered = {}
            for (const key of allowed) {
              if (patch[key] !== undefined) filtered[key] = patch[key]
            }
            if (Object.keys(filtered).length === 0) {
              return result(false, `patch 只能包含：${allowed.join(' / ')}`)
            }
            await saveConfigPatch(config, filtered)
            return result(true, `配置已更新：\n${JSON.stringify(filtered, null, 2)}`)
          }
          case 'inspect': {
            if (!args.asset) return result(false, 'inspect 需要 asset')
            const asset = orchestrator.catalog.get(args.asset)
            if (!asset) return result(false, `未知资产：${args.asset}`)
            return result(true, JSON.stringify(asset, null, 2))
          }
          default:
            return result(false, `未知 action：${args.action}`)
        }
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 委派
  tools.push({
    name: name('delegate'),
    description:
      '把一整件任务交给本地算力：自动挑选模型、按需加载/卸载、必要时由决策模型拆解成多步并逐步执行。' +
      '适合明确可以离线完成的中等任务（写文案、整理资料、批量处理、看图描述）。' +
      '返回最终产出与执行摘要。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要完成的完整任务' },
        strategy: {
          type: 'string',
          enum: ['auto', 'direct', 'plan'],
          description: 'auto=有决策模型就规划，否则直接执行；direct=单模型直接做；plan=强制先规划',
        },
        kind: { type: 'string', description: '限定资产类型，如 llm / vlm' },
        asset: { type: 'string', description: '直接指定执行的资产 id' },
        maxSteps: { type: 'number', description: '规划模式下最多步骤数' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        if (!args.task) return result(false, 'task 不能为空')
        const strategy = args.strategy ?? 'auto'
        const wantPlan = strategy === 'plan' || (strategy === 'auto' && decision.available && config.decision?.planning !== false)
        const run = orchestrator.tracker.start({
          kind: 'delegate',
          title: String(args.task).slice(0, 80),
          sessionId: sessionId(exec),
          meta: { strategy, asset: args.asset ?? null },
        })

        if (!wantPlan) {
          const picked = args.asset
            ? { asset: orchestrator.catalog.get(args.asset) }
            : await orchestrator.pick(args.kind ? { kind: args.kind } : { kinds: ['llm', 'vlm'] })
          if (!picked?.asset) {
            orchestrator.tracker.end(run.id, 'error', '没有可用资产')
            return result(false, '没有可用资产，无法执行')
          }
          const reply = await orchestrator.runChat(picked.asset.id, {
            messages: [{ role: 'user', content: args.task }],
            temperature: 0.6,
            maxTokens: 4096,
            signal: anySignal(exec?.signal, run.signal),
            reason: '工具调用 local_delegate（direct）',
            runId: run.id,
          })
          if (!reply.ok) {
            orchestrator.tracker.end(run.id, 'error', reply.error)
            return result(false, `本地模型 ${picked.asset.id} 执行失败：${reply.error}`)
          }
          orchestrator.tracker.end(run.id, 'done', reply.content.slice(0, 120))
          return result(true, `${replyText(reply)}${usageLine(reply)}`)
        }

        const planned = await decision.plan(args.task, { signal: anySignal(exec?.signal, run.signal), runId: run.id })
        if (!planned.ok) {
          orchestrator.tracker.end(run.id, 'error', planned.error)
          return result(false, `规划失败：${planned.error}（可改用 strategy="direct" 直接执行）`)
        }
        const executed = await decision.execute(planned.plan, { signal: anySignal(exec?.signal, run.signal), runId: run.id })
        const lines = [`**计划**：${planned.plan.summary || '（无摘要）'}（决策模型：${planned.model}）`, '']
        for (const step of executed.steps) {
          lines.push(`${step.index + 1}. ${step.goal}${step.asset ? ` → ${step.asset}` : ''} ${step.ok ? '✅' : '❌'}`)
          lines.push(clip(step.output, 1200))
          lines.push('')
        }
        const final = [...executed.steps].reverse().find((step) => step.ok && step.output)
        lines.push('---')
        lines.push(final ? `**最终产出**\n${clip(final.output, 6000)}` : '**最终产出**：无（所有步骤均失败）')
        orchestrator.tracker.end(run.id, executed.ok ? 'done' : 'error', planned.plan.summary || '')
        return result(executed.ok, lines.join('\n'))
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 生成
  tools.push({
    name: name('generate'),
    description:
      '用 ComfyUI 生成图像/视频/音乐：不给 asset/workflow 时按 prompt 自动挑最合适的工作流' +
      '（海报→ernie、二次元→anima、通用→zimage、首帧视频→minimax-h3-i2v、音乐→acestep），' +
      '也可以显式指定 asset 或 workflow。可能耗时数分钟，期间占用 GPU 槽。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词（也会作为自动选工作流的依据）' },
        kind: { type: 'string', enum: ['image', 'video', 'music'], description: '强制产物类型（默认按 prompt 推断）' },
        workflowName: { type: 'string', description: '指定模板名（如 zimage / ernie / minimax-h3-t2v）' },
        workflow: { type: 'object', description: '直接给 ComfyUI API 格式工作流' },
        params: { type: 'object', description: '其它占位符参数，如 {"width":1024,"seed":42}' },
        asset: { type: 'string', description: '指定资产 id（默认 auto：按需求自动选）' },
        timeoutMs: { type: 'number', description: '等待上限，默认 15 分钟' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        let assetId = args.asset
        let autoPick = null
        const wantsAuto = !assetId || assetId === 'auto' || (!args.workflow && !args.workflowName && config.comfy?.autoSelect !== false)
        if (wantsAuto && !args.workflow && !(args.workflowName && !args.asset)) {
          const kind = args.kind || 'image'
          const prefer = kind === 'video'
            ? config.comfy?.videoWorkflow
            : kind === 'music'
              ? config.comfy?.audioWorkflow
              : config.comfy?.imageWorkflow
          // 只从「本地文件齐全」的资产里挑，避免选到已删除的工作流
          const candidates = await orchestrator.usableAssets({ includeHidden: true })
          autoPick = selectWorkflow(candidates, args.prompt ?? args.workflowName ?? '', { kind: args.kind, prefer })
          if (autoPick) assetId = autoPick.asset.id
        }
        assetId = assetId || 'comfyui'
        const asset = orchestrator.catalog.get(assetId)
        if (!asset) {
          return result(false, `没有生成资产：${assetId}。可用 local_service sync 同步 ComfyUI 工作流。`)
        }
        // 资产自带工作流（zimage / ernie / minimax-h3-t2v …）时不用再解析模板
        const useAssetWorkflow = Boolean(asset.workflow) && !args.workflow && !args.workflowName
        let resolved = null
        if (!useAssetWorkflow) {
          resolved = await resolveWorkflow(config, {
            workflow: args.workflow,
            workflowName: args.workflowName || config.comfy?.imageWorkflow || undefined,
            params: { prompt: args.prompt ?? '', ...(args.params ?? {}) },
          })
          if (!resolved.ok) return result(false, resolved.error)
          if (resolved.missing?.length) {
            return result(
              false,
              `工作流里还有未替换的占位符：${[...new Set(resolved.missing)].slice(0, 5).join('、')}。` +
                `请通过 params 提供对应变量，或修改模板。`,
            )
          }
        }

        const run = orchestrator.tracker.start({
          kind: 'generate',
          title: String(args.prompt ?? asset.name ?? '生成任务').slice(0, 80),
          sessionId: sessionId(exec),
          meta: { asset: assetId, workflow: resolved?.name ?? asset.id },
        })
        try {
          const out = await orchestrator.runComfy(assetId, {
            workflow: resolved?.workflow,
            params: { prompt: args.prompt, ...(args.params ?? {}) },
            timeoutMs: args.timeoutMs ?? 900000,
            signal: anySignal(exec?.signal, run.signal),
            runId: run.id,
          })
          if (!out.ok) {
            orchestrator.tracker.end(run.id, 'error', out.error)
            return result(false, `ComfyUI 生成失败：${out.error}`)
          }
          orchestrator.tracker.end(run.id, 'done', `${out.files.length} 个产物`)
          const files = out.files.map((file) => `- ${file.url}`).join('\n')
          const why = autoPick ? ` · 自动选择 ${autoPick.asset.id}（${autoPick.reason}）` : ''
          return result(true, `生成完成（${(out.ms / 1000).toFixed(1)}s，${asset.name}${why}）：\n${files}`)
        } catch (error) {
          orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 音频/一次性脚本
  tools.push({
    name: name('audio'),
    description:
      '运行本地语音/音乐脚本：tts（文本转语音）、asr（语音转写+说话人分离+SRT）、music-qc（音乐描述/质检）。' +
      '这类脚本是一次性进程，会先释放 GPU 槽再运行；结果在输出目录和日志里。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tts', 'asr', 'music-qc'], description: '要执行的任务' },
        text: { type: 'string', description: 'tts 要合成的文本' },
        audioPath: { type: 'string', description: 'asr / music-qc 的输入音频绝对路径' },
        out: { type: 'string', description: '可选输出目录/文件' },
        args: { type: 'array', items: { type: 'string' }, description: '追加给脚本的原始参数' },
        timeoutMs: { type: 'number', description: '超时，默认 15 分钟' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        // tts_run.py 是 VoxCPM2 的入口（旧目录里这条可能还叫 moss-tts，回退兼容）
        const ttsId = orchestrator.catalog.get('voxcpm2') ? 'voxcpm2' : 'moss-tts'
        const map = { tts: ttsId, asr: 'qwen3-asr', 'music-qc': 'music-qc' }
        const assetId = map[args.action]
        if (!assetId) return result(false, `未知 action：${args.action}`)
        const asset = orchestrator.catalog.get(assetId)
        if (!asset) return result(false, `没有 ${assetId} 资产：先 local_service sync 同步资源`)

        const extra = Array.isArray(args.args) ? args.args : []
        let cliArgs = []
        if (args.action === 'tts') {
          if (!args.text) return result(false, 'tts 需要 text')
          cliArgs = ['--text', String(args.text)]
          if (args.out) cliArgs.push('--out', String(args.out))
        } else {
          if (!args.audioPath) return result(false, `${args.action} 需要 audioPath`)
          cliArgs = [String(args.audioPath)]
          if (args.out) cliArgs.push(args.action === 'asr' ? '--out-dir' : '--out', String(args.out))
        }
        cliArgs.push(...extra)

        const run = orchestrator.tracker.start({
          kind: 'audio',
          title: `${args.action} · ${(args.text || args.audioPath || '').toString().slice(0, 60)}`,
          sessionId: sessionId(exec),
          meta: { asset: assetId },
        })
        try {
          const out = await orchestrator.runScript(assetId, {
            args: cliArgs,
            timeoutMs: args.timeoutMs ?? 900000,
            signal: anySignal(exec?.signal, run.signal),
            runId: run.id,
          })
          orchestrator.tracker.end(run.id, out.ok ? 'done' : 'error', out.output.slice(-120))
          if (!out.ok) {
            return result(false, `${asset.name} 执行失败（exit ${out.code}）：\n${out.output.slice(-1500)}`)
          }
          return result(
            true,
            `${asset.name} 执行完成（${(out.ms / 1000).toFixed(1)}s）。\n日志：${out.logFile}\n\n${out.output.slice(-2000)}`,
          )
        } catch (error) {
          orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 任务池
  tools.push({
    name: name('task'),
    description:
      '任务池：把一件多步任务登记下来，跨回合推进。create 只建计划并返回，不自动执行；' +
      '用 local_step run 一步一步跑（一次调用只推进一步）。失败可 retry，质量差可 rollback 到某一步重来。' +
      '任务按会话隔离：默认只列/只改当前会话的任务。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'pause', 'resume', 'cancel', 'rollback', 'replan'],
          description: '要执行的操作',
        },
        taskId: { type: 'string', description: '任务 id（create 之外必填）' },
        goal: { type: 'string', description: 'create：任务目标；不给 steps 时会用决策模型规划' },
        title: { type: 'string', description: 'create：短标题' },
        steps: {
          type: 'array',
          description: 'create：直接给步骤 [{goal, kind, asset?, dependsOn?}]；kind 可写 llm/vlm/image/video/audio-tts/audio-asr',
          items: { type: 'object' },
        },
        toIndex: { type: 'number', description: 'rollback：回滚到第几步（从 1 开始）' },
        all: { type: 'boolean', description: 'list：是否连其它会话的任务一起列（只读）' },
        background: {
          type: 'boolean',
          description: 'create：是否让后台执行环继续推进（默认跟随 config.tasks.background）',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        const sid = sessionId(exec)
        const requireTask = () => {
          if (!args.taskId) throw new Error(`${args.action} 需要 taskId`)
          const task = store.get(String(args.taskId))
          if (!task) throw new Error(`未知任务：${args.taskId}（用 local_task list 查看）`)
          if (!store.owns(task, sid)) throw new Error('该任务属于其它会话，不能操作')
          return task
        }
        const stepLines = (task) =>
          task.steps
            .map((step, i) => `${i + 1}. ${step.goal || step.kind}${step.asset ? ` → ${step.asset}` : ''}`)
            .join('\n')

        switch (args.action) {
          case 'create': {
            if (!args.goal && !(Array.isArray(args.steps) && args.steps.length > 0)) {
              return result(false, 'create 需要 goal 或 steps')
            }
            let steps = Array.isArray(args.steps) && args.steps.length > 0 ? args.steps : null
            let summary = ''
            let model = ''
            if (!steps) {
              if (decision?.available && config.decision?.planning !== false) {
                const planned = await decision.plan(args.goal, { signal: exec?.signal })
                if (planned.ok) {
                  steps = planned.plan.steps
                  summary = planned.plan.summary
                  model = planned.model ?? ''
                }
              }
              if (!steps) steps = [{ goal: args.goal, kind: 'llm', dependsOn: [] }]
            }
            const task = store.create({
              sessionId: sid,
              title: args.title || args.goal,
              goal: args.goal ?? '',
              steps,
              budget: {},
              autoAdvance: args.background,
            })
            if (summary) task.planSummary = summary
            await store.save(task)
            const bg = task.autoAdvance ? '后台自动推进' : '仅手动推进'
            return result(
              true,
              [
                `已建任务 ${task.id}（${task.steps.length} 步 · ${bg}${model ? ` · 规划：${model}` : ' · 未规划，单步执行'}）`,
                summary ? `计划：${summary}` : '',
                '',
                stepLines(task),
                '',
                `下一步：local_step {"action":"run","taskId":"${task.id}"}（一次只推进一步）`,
              ]
                .filter((line) => line !== '')
                .join('\n'),
            )
          }
          case 'list': {
            const items = store.list({ sessionId: sid, all: args.all === true, limit: 20 })
            if (items.length === 0) return result(true, '当前会话没有任务。用 local_task {"action":"create","goal":"…"} 建一个。')
            const lines = [`${items.length} 个任务：`, '']
            for (const task of items) lines.push(store.describe(task), '')
            return result(true, lines.join('\n').trim())
          }
          case 'get': {
            const task = requireTask()
            const lines = [store.describe(task, { detail: true })]
            if (task.planSummary) lines.push('', `计划：${task.planSummary}`)
            const artifacts = task.artifacts ?? []
            if (artifacts.length > 0) {
              lines.push('', `产物 ${artifacts.length} 项：`)
              for (const item of artifacts.slice(-5)) lines.push(`  - 步骤 ${item.step + 1}：${item.kind}（${item.chars} 字）`)
            }
            return result(true, lines.join('\n'))
          }
          case 'pause': {
            const task = requireTask()
            store.setStatus(task, 'paused', '手动暂停')
            await store.save(task)
            // 真正打断正在跑的那一步（否则 worker 会把这一步跑完）
            orchestrator.steps?.abortTask?.(task.id, 'paused')
            return result(true, `已暂停 ${task.id}（进度保留，可 resume）`)
          }
          case 'resume': {
            const task = requireTask()
            if (['done', 'cancelled'].includes(task.status)) return result(false, `任务已 ${task.status}，无法恢复`)
            store.setStatus(task, 'running', '手动恢复')
            await store.save(task)
            return result(true, `已恢复 ${task.id}，下一步：local_step {"action":"run","taskId":"${task.id}"}`)
          }
          case 'cancel': {
            const task = requireTask()
            if (['done', 'cancelled'].includes(task.status)) return result(true, `任务已是 ${task.status}`)
            await store.cancelTask(task, '手动取消')
            return result(true, `已取消 ${task.id}`)
          }
          case 'rollback': {
            const task = requireTask()
            const index = Math.max(1, Number(args.toIndex ?? 1)) - 1
            await store.rollback(task, index)
            return result(true, `已回滚 ${task.id} 到步骤 ${index + 1}，后续步骤重置为未执行（产物保留）`)
          }
          case 'replan': {
            const task = requireTask()
            if (!decision?.available) return result(false, '没有可用的决策模型：先把 decision.mode 设为 dsh / openai / local')
            const planned = await decision.plan(task.goal, { signal: exec?.signal })
            if (!planned.ok) return result(false, `重新规划失败：${planned.error}`)
            await store.replacePlan(task, { summary: planned.plan.summary, steps: planned.plan.steps })
            return result(
              true,
              [`已重新规划 ${task.id}（${task.steps.length} 步 · ${planned.model ?? ''}）`, '', stepLines(task)].join('\n'),
            )
          }
          default:
            return result(false, `未知 action：${args.action}`)
        }
      } catch (error) {
        return fail(error)
      }
    },
  })

  tools.push({
    name: name('step'),
    description:
      '推进任务一步：run 执行下一个可执行步骤（一次调用只做一步），返回结果与下一步预告；' +
      'retry 重跑失败步骤、skip 跳过、inspect 只看状态。任务卡住时用 local_task rollback。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'retry', 'skip', 'inspect'], description: '要执行的操作' },
        taskId: { type: 'string', description: '任务 id（local_task create 返回）' },
        index: { type: 'number', description: 'retry / skip：第几步（从 1 开始，默认第一个失败步骤）' },
        note: { type: 'string', description: 'skip 的原因（可选）' },
      },
      required: ['action', 'taskId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        await orchestrator.start()
        const sid = sessionId(exec)
        const task = store.get(String(args.taskId ?? ''))
        if (!task) return result(false, `未知任务：${args.taskId}（用 local_task list 查看）`)
        if (!store.owns(task, sid)) return result(false, '该任务属于其它会话，不能操作')

        const pickStep = () => {
          if (Number.isInteger(args.index) && args.index > 0) {
            const step = task.steps[args.index - 1]
            if (!step) throw new Error(`没有第 ${args.index} 步`)
            return step
          }
          return store.failedStep(task) ?? store.nextStep(task)
        }

        if (args.action === 'inspect') {
          return result(true, store.describe(task, { detail: true }))
        }

        if (args.action === 'retry') {
          const step = pickStep()
          if (!step) return result(false, '没有可重试的步骤')
          step.status = 'pending'
          step.attempts = 0
          step.error = null
          if (task.status === 'error') store.setStatus(task, 'running', '手动重试')
          await store.save(task)
          return result(true, `已重置步骤 ${step.index + 1}，下一步：local_step {"action":"run","taskId":"${task.id}"}`)
        }

        if (args.action === 'skip') {
          const step = pickStep()
          if (!step) return result(false, '没有可跳过的步骤')
          step.status = 'skipped'
          step.endedAt = new Date().toISOString()
          if (store.isComplete(task)) store.setStatus(task, 'done', '跳过剩余步骤')
          else if (task.status === 'error') store.setStatus(task, 'running', '跳过失败步骤')
          await store.save(task)
          return result(true, `已跳过步骤 ${step.index + 1}${args.note ? `（${args.note}）` : ''}`)
        }

        if (args.action !== 'run') return result(false, `未知 action：${args.action}`)

        // ---- run：执行一步
        if (['done', 'cancelled'].includes(task.status)) return result(false, `任务已 ${task.status}，不再执行`)
        if (task.status === 'error') {
          const failed = store.failedStep(task)
          return result(
            false,
            `任务停在失败步骤 ${failed ? failed.index + 1 : '?'}：先 local_step {"action":"retry"}，或 local_task {"action":"rollback"}`,
          )
        }
        const budget = store.checkBudget(task)
        if (!budget.ok) {
          store.setStatus(task, 'error', budget.reason)
          await store.save(task)
          return result(false, `已停止：${budget.reason}（可用 local_task rollback 或新建任务）`)
        }
        const step = store.nextStep(task)
        if (!step) {
          if (store.isComplete(task)) {
            if (task.status !== 'done') store.setStatus(task, 'done', '全部步骤完成')
            await store.save(task)
            return result(true, `任务 ${task.id} 已完成（${store.progress(task).done} 步）`)
          }
          return result(false, '没有可执行步骤：依赖未满足，检查 dependsOn 或跳过前置步骤')
        }
        if (typeof decision?.executeStep !== 'function') {
          return result(false, '执行器不可用：decision.executeStep 未装配')
        }

        // 前台执行：与 worker 共用 StepRunner（claim → 租约 → 执行 → 判定），
        // 差别只是这里等结果（最多等 5s 抢租约），worker 等下一 tick。
        const runner = ensureStepRunner({ orchestrator, decision, config })
        const out = await runner.run(task, step, { signal: exec?.signal, waitMs: 5000 })

        if (out.status === STEP_STATUS.BUSY) {
          return result(false, '资源忙：GPU 槽被别的任务占着，稍后再 local_step run 一次')
        }
        if (out.status === STEP_STATUS.SKIPPED) {
          return result(false, '这一步已被后台执行环认领，稍后用 local_task get 看结果')
        }
        if (out.status === STEP_STATUS.PAUSED || out.status === STEP_STATUS.CANCELLED) {
          return result(false, out.output || '已中断：任务保持可恢复')
        }

        const { done, total } = store.progress(task)
        const lines = [
          `▶ 任务 ${task.id} · 步骤 ${step.index + 1}/${total}${out.ok ? ' 完成' : ' 失败'}`,
          `${step.goal}${out.step?.result?.asset ? ` → ${out.step.result.asset}` : ''} · ${((out.ms ?? 0) / 1000).toFixed(1)}s`,
          '',
          clip(out.output ?? '', 800),
        ]
        if (!out.ok) {
          lines.push('', `失败原因：${clip(step.error ?? '', 300)}`)
          lines.push(step.attempts < 2 ? '已自动排入重试，再 run 一次即可。' : '已连续失败，需 retry 或 rollback。')
        } else if (out.status === STEP_STATUS.WAITING) {
          lines.push('', '这一步需要判断：可用 local_task get 查看产物，再决定继续/回滚/取消。')
        }
        const next = store.nextStep(task)
        if (next) lines.push('', `下一步：步骤 ${next.index + 1}「${next.goal}」——再调 local_step run 继续`)
        else if (store.isComplete(task)) lines.push('', `任务完成（${done}/${total} 步）`)
        return result(out.ok || out.status === STEP_STATUS.WAITING, lines.join('\n'))
      } catch (error) {
        return fail(error)
      }
    },
  })

  // ------------------------------------------------------------------ 环境（便携运行时）
  tools.push({
    name: name('env'),
    description:
      '便携运行时体检与安装：检查 llama.cpp / ComfyUI / Python / 模型目录，' +
      '并支持一键把已有 llama.cpp 复制进插件、登记 ComfyUI 路径、设置模型根目录。' +
      '报错时按返回的 fix 处理，不要读日志猜。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['doctor', 'plan', 'vendor-llama', 'link-comfy', 'set-model-root', 'set-base'],
          description:
            '默认 doctor：体检；plan：还差什么、怎么装；vendor-llama：复制 llama.cpp；link-comfy：登记 ComfyUI 目录；' +
            'set-model-root：只改模型根目录；set-base：给一个基础目录（如 D:\\models），自动派生模型/ComfyUI/llama.cpp/脚本/输出',
        },
        source: { type: 'string', description: 'vendor-llama 的来源目录（含 llama-server.exe），默认用当前 paths.llamaServer 所在目录' },
        dir: { type: 'string', description: 'link-comfy / set-model-root 的目标目录' },
        deep: { type: 'boolean', description: 'doctor 时是否统计模型目录大小（默认 false，大目录会慢）' },
        force: { type: 'boolean', description: 'vendor-llama 时覆盖已存在的文件' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}) {
      try {
        await orchestrator.start()
        const action = args.action ?? 'doctor'
        const env = await import('./env.js')

        if (action === 'doctor') {
          const report = await env.doctor(config, { deep: args.deep === true })
          const mark = { ok: '[ok]', warn: '[!]', error: '[x]' }
          const lines = [
            `运行时目录：${report.runtimeDir}`,
            ...report.items.map(
              (item) => `${mark[item.level]} ${item.title}：${item.detail}${item.fix ? `\n      → ${item.fix}` : ''}`,
            ),
            '',
            report.ready ? '可以直接跑：llama.cpp 可用' : '还有阻塞项，先按上面的 → 处理',
          ]
          return result(true, lines.join('\n'))
        }

        if (action === 'plan') {
          const steps = await env.plan(config)
          const lines = steps.steps.map((step) => `${step.blocked ? '[必做]' : '[建议]'} ${step.title}\n      ${step.fix}`)
          return result(true, [steps.ready ? '已就绪' : '还差这些：', ...lines].join('\n'))
        }

        if (action === 'vendor-llama') {
          const out = await env.vendorLlama(config, { source: args.source, force: args.force === true })
          if (!out.ok) return result(false, `复制失败：${out.error}${out.hint ? `\n→ ${out.hint}` : ''}`)
          return result(true, [`已复制 llama.cpp 到：${out.dest}`, `${out.copied} 个文件，${fmtMb(out.bytes)}`, out.hint].filter(Boolean).join('\n'))
        }

        if (action === 'link-comfy') {
          if (!args.dir) return result(false, 'link-comfy 需要 dir（ComfyUI 目录，含 main.py）')
          const out = await env.linkComfy(config, args.dir)
          if (!out.ok) return result(false, out.error)
          return result(true, `已登记 ComfyUI：${out.dir}\n指针：${out.pointer}`)
        }

        if (action === 'set-model-root') {
          if (!args.dir) return result(false, 'set-model-root 需要 dir（模型根目录）')
          await saveConfigPatch(config, { paths: { modelsRoot: String(args.dir) } })
          const ok = existsSync(String(args.dir))
          return result(true, `模型根目录已设为：${args.dir}${ok ? '' : '（注意：这个目录现在不存在）'}`)
        }

        if (action === 'set-base') {
          if (!args.dir) return result(false, 'set-base 需要 dir（基础目录，例如 D:\\models）')
          const derived = env.pathsFromBase(args.dir)
          if (!existsSync(derived.base)) {
            return result(false, `目录不存在：${derived.base}`)
          }
          await saveConfigPatch(config, { paths: derived })
          return result(
            true,
            [
              `基础目录已设为：${derived.base}`,
              `模型：${derived.modelsRoot}`,
              `llama.cpp：${derived.llamaServer}`,
              `ComfyUI：${derived.comfyDir}`,
              `脚本：${derived.comfyScripts}`,
              `输出：${derived.outputRoot}`,
              '跑一次 local_env {"action":"doctor"} 确认',
            ].join('\n'),
          )
        }

        return result(false, `未知 action：${action}`)
      } catch (error) {
        return fail(error)
      }
    },
  })

  return tools
}
