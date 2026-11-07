/**
 * 本地调度插件的 HTTP 数据面（供 Web UI / 脚本使用）。
 *
 * 设计：与传输层解耦——本文件只接受 {method, path, query, body} 返回
 * {status, body}，web.js 负责把 Node 的 req/res 适配进来。这样 API 可以直接
 * 单测，不必起 HTTP 服务。
 *
 * 路由（挂在前缀 /api/local-orchestrator 下）：
 *   GET    /state            实时快照：硬件、资产、运行实例、任务框图、IO、配置
 *   GET    /assets           资产列表
 *   POST   /assets           新增/更新资产（body.asset）
 *   DELETE /assets/{id}      删除资产（运行中会先卸载）
 *   POST   /action           动作：load/stop/restart/stop_all/reap/discover/import
 *   GET    /config           配置（apiKey 打码）
 *   PUT    /config           修改配置（hardware/scheduler/decision/prompt/tools）
 *   POST   /decision/test    试跑一次决策模型
 */
import { saveConfigPatch } from './config.js'
import { KIND_LABEL } from './catalog.js'
import { listWorkflows } from './workflows.js'
import { describeWorkflows } from './router.js'
import { nowIso } from './util.js'

/** 对外的配置视图：不泄露 apiKey，去掉内部字段。 */
export function publicConfig(config) {
  const safe = structuredClone({
    enabled: config.enabled,
    paths: config.paths,
    hardware: config.hardware,
    scheduler: config.scheduler,
    decision: config.decision,
    prompt: config.prompt,
    tools: config.tools,
    tasks: config.tasks,
    worker: config.worker,
    web: config.web,
    comfy: config.comfy,
    mcpServers: config.mcpServers,
  })
  if (safe.decision?.apiKey) safe.decision.apiKey = '***'
  safe.dataDir = config.dataDir
  return safe
}

const ok = (value) => ({ status: 200, body: { ok: true, value } })

/** 任务池对外的瘦身视图：/state 每 1.5 秒拉一次，不能把 4KB 的产出全带出去。 */
function publicTask(task) {
  const trim = (text, max = 220) => {
    const value = String(text ?? '')
    return value.length > max ? `${value.slice(0, max)}…` : value
  }
  const done = task.steps.filter((step) => ['done', 'skipped'].includes(step.status)).length
  return {
    id: task.id,
    sessionId: task.sessionId,
    title: task.title,
    status: task.status,
    autoAdvance: task.autoAdvance !== false,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    pauseReason: task.pauseReason,
    planSummary: trim(task.planSummary, 160),
    progress: { done, total: task.steps.length },
    budget: { maxSteps: task.budget?.maxSteps, usedMs: task.budget?.usedMs, maxWallMs: task.budget?.maxWallMs },
    steps: task.steps.map((step) => ({
      index: step.index,
      goal: trim(step.goal, 80),
      kind: step.kind,
      asset: step.result?.asset ?? step.asset ?? '',
      status: step.status,
      attempts: step.attempts,
      ms: step.ms,
      error: trim(step.error, 160),
      output: trim(step.result?.output, 240),
      verification: step.verification?.mode ?? null,
    })),
  }
}
const bad = (error, status = 400) => ({
  status,
  body: { ok: false, error: error instanceof Error ? error.message : String(error) },
})

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {import('./manager.js').Orchestrator} deps.orchestrator
 * @param {import('./decision.js').Decision} deps.decision
 */
export function createApi({ config, orchestrator, decision, prefs = null }) {
  const state = async () => {
    const status = await orchestrator.status()
    const assets = await orchestrator.assets({ includeHidden: true })
    // IO 轮询要控体积：只保留最近 80 条，单条截到 1600 字（完整内容在 events/日志里）。
    const io = orchestrator.tracker.ioSnapshot({ limit: 80 })
    for (const list of Object.values(io)) {
      for (const entry of list) {
        if (typeof entry.content === 'string' && entry.content.length > 1600) {
          entry.content = `${entry.content.slice(0, 1600)}…`
        }
      }
    }
    return {
      ts: nowIso(),
      // 客户端据此判断 Node 侧是否为新版本（客户端会 HMR，Node 需要重启）
      capabilities: { cancel: true, release: true, sync: true, serviceId: true, autoSelect: true, tasks: true, leases: true, worker: true, budget: true },
      hardware: status.hardware,
      budget: status.budget,
      budgetTable: status.budgetTable,
      running: status.running,
      slots: status.slots,
      queue: status.queue,
      leases: status.leases,
      worker: status.worker,
      tasks: {
        summary: status.tasks,
        items: orchestrator.tasks.list({ all: true, limit: 100 }).map(publicTask),
      },
      catalog: status.catalog,
      frameworks: status.frameworks,
      /** token 用量：最近 24h 汇总 + 最近 30 次明细（本地模型推理成本） */
      usage: orchestrator.stats.snapshot({ sinceMs: 24 * 3600 * 1000, recentCount: 30 }),
      assets,
      runs: orchestrator.tracker.snapshot({ limit: 20 }),
      io,
      workflows: await listWorkflows(config),
      workflowProfiles: describeWorkflows(orchestrator.catalog.list()),
      config: publicConfig(config),
      events: orchestrator.events.recent(20),
    }
  }

  return async function handle({ method, path, query = {}, body = {} }) {
    try {
      await orchestrator.start()

      if (method === 'GET' && (path === '/' || path === '/state')) {
        return ok(await state())
      }

      if (method === 'GET' && path === '/assets') {
        // UI 需要拿到配套组件才能嵌到主模型下面；?all=0 只看主模型
        return ok(await orchestrator.assets({ kind: query.kind, includeHidden: query.all !== '0' }))
      }

      if (method === 'GET' && path.startsWith('/assets/')) {
        const id = decodeURIComponent(path.slice('/assets/'.length))
        const asset = orchestrator.catalog.get(id)
        return asset ? ok(asset) : bad(`资产不存在：${id}`, 404)
      }

      if (method === 'POST' && path === '/assets') {
        const incoming = body?.asset
        if (!incoming || typeof incoming !== 'object' || !incoming.id) return bad('body.asset.id 必填')
        const existing = orchestrator.catalog.get(incoming.id)
        const merged = { ...(existing ?? {}), ...incoming }
        const asset = await orchestrator.catalog.upsert(merged)
        return ok({ asset, kindLabel: KIND_LABEL[asset.kind] ?? asset.kind })
      }

      if (method === 'DELETE' && path.startsWith('/assets/')) {
        const id = decodeURIComponent(path.slice('/assets/'.length))
        if (!id) return bad('缺少资产 id')
        if (orchestrator.instances.has(id)) {
          await orchestrator.stop(id, { reason: 'Web UI 删除资产' })
        }
        const removed = await orchestrator.catalog.remove(id)
        return removed ? ok({ id }) : bad(`资产不存在：${id}`, 404)
      }

      if (method === 'POST' && path === '/action') {
        const action = body?.action
        if (action === 'load') {
          const run = orchestrator.tracker.start({ kind: 'service', title: `加载 ${body.asset}` })
          try {
            const instance = await orchestrator.ensure(body.asset, { reason: 'Web UI 加载', runId: run.id })
            orchestrator.tracker.end(run.id, 'done', instance.state)
            return ok(instance)
          } catch (error) {
            orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
            throw error
          }
        }
        if (action === 'stop') {
          return ok(await orchestrator.stop(body.asset, { reason: 'Web UI 卸载' }))
        }
        if (action === 'restart') {
          const run = orchestrator.tracker.start({ kind: 'service', title: `重启 ${body.asset}` })
          try {
            await orchestrator.stop(body.asset, { reason: 'Web UI 重启' })
            const instance = await orchestrator.ensure(body.asset, { reason: 'Web UI 重启', runId: run.id })
            orchestrator.tracker.end(run.id, 'done', instance.state)
            return ok(instance)
          } catch (error) {
            orchestrator.tracker.end(run.id, 'error', error instanceof Error ? error.message : String(error))
            throw error
          }
        }
        if (action === 'stop_all') {
          return ok(await orchestrator.stopAll({ reason: 'Web UI 全部卸载' }))
        }
        if (action === 'reap') {
          return ok(await orchestrator.reapIdle())
        }
        if (action === 'release') {
          return ok(await orchestrator.releaseIdle({ minIdleSec: 0, reason: 'Web UI 释放空闲资源' }))
        }
        if (action === 'cancel') {
          if (body.runId) {
            const cancelled = orchestrator.tracker.cancel(body.runId, '用户取消')
            return cancelled ? ok({ runId: body.runId }) : bad('任务不存在或已结束', 404)
          }
          const ids = orchestrator.tracker.cancelAll('用户取消全部任务')
          return ok({ runIds: ids })
        }
        if (action === 'discover') {
          return ok(await orchestrator.catalog.discover())
        }
        if (action === 'import') {
          return ok(await orchestrator.catalog.importRegistry({ overwrite: true }))
        }
        if (action === 'sync') {
          // 同步资源：补登记新模型，并把老目录里的配套组件关系迁移过来
          return ok(await orchestrator.catalog.syncEcosystem())
        }
        if (action === 'clear_runs') {
          orchestrator.tracker.clear()
          return ok(true)
        }
        return bad(`未知 action：${action}`)
      }

      if (method === 'GET' && path === '/config') {
        return ok(publicConfig(config))
      }

      if (method === 'GET' && path === '/prefs') {
        return ok({ preferLocal: prefs ? prefs.get(query.sessionId) : false })
      }

      if (method === 'POST' && path === '/prefs') {
        if (!prefs) return bad('偏好存储不可用')
        const preferLocal = await prefs.set({ sessionId: body?.sessionId, preferLocal: body?.preferLocal === true })
        return ok({ preferLocal })
      }

      if (method === 'PUT' && path === '/config') {
        const patch = body?.patch
        if (!patch || typeof patch !== 'object') return bad('body.patch 必填')
        const allowed = ['hardware', 'scheduler', 'decision', 'prompt', 'tools', 'tasks', 'worker', 'enabled', 'comfy', 'mcpServers']
        const filtered = {}
        for (const key of allowed) {
          if (patch[key] !== undefined) filtered[key] = patch[key]
        }
        if (Object.keys(filtered).length === 0) return bad(`patch 只能包含：${allowed.join(' / ')}`)
        if (filtered.decision?.apiKey === '***') delete filtered.decision.apiKey
        await saveConfigPatch(config, filtered)
        return ok(publicConfig(config))
      }

      if (method === 'GET' && path === '/tasks') {
        return ok(orchestrator.tasks.list({ all: query.all === '1' || query.all === 'true', limit: 100 }).map(publicTask))
      }

      if (method === 'POST' && path === '/tasks') {
        // 只允许 UI 做「暂停/恢复/取消/回滚」这类不产生推理的动作；
        // 真正执行步骤（会占显存）必须由会话模型经 local_step 触发。
        const task = orchestrator.tasks.get(String(body?.taskId ?? ''))
        if (!task) return bad(`任务不存在：${body?.taskId}`, 404)
        if (body.action === 'pause') {
          orchestrator.tasks.setStatus(task, 'paused', 'Web UI 暂停')
          orchestrator.steps?.abortTask?.(task.id, 'paused')
        } else if (body.action === 'resume') {
          if (['done', 'cancelled'].includes(task.status)) return bad(`任务已 ${task.status}`)
          orchestrator.tasks.setStatus(task, 'running', 'Web UI 恢复')
        } else if (body.action === 'cancel') {
          await orchestrator.tasks.cancelTask(task, 'Web UI 取消')
        } else if (body.action === 'rollback') {
          await orchestrator.tasks.rollback(task, Number(body.toIndex ?? 1) - 1)
        } else if (body.action === 'auto') {
          task.autoAdvance = body.autoAdvance !== false
        } else {
          return bad('action 只能是 pause / resume / cancel / rollback / auto')
        }
        await orchestrator.tasks.save(task)
        return ok(task)
      }

      if (method === 'POST' && path === '/decision/test') {
        const prompt = String(body?.prompt ?? '用一句中文说明你能做什么。')
        const reply = await decision.complete({
          system: '你是本地算力调度器的决策模型，回答要简短。',
          prompt,
          maxTokens: 300,
        })
        if (!reply.ok) return bad(reply.error)
        return ok({ text: reply.text, model: reply.model ?? decision.mode })
      }

      return { status: 404, body: { ok: false, error: 'not found' } }
    } catch (error) {
      return bad(error, 500)
    }
  }
}
