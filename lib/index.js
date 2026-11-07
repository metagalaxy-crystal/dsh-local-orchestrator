/**
 * dsh-local-orchestrator 入口。
 *
 * 定位：把「本地算力」变成 DSH 决策模型可调度的资源池。
 * - 记忆 / 浏览上下文 / 统计 / 会话由 DSH 已有插件负责，本插件不重复实现；
 * - 本插件只负责：算力探测、本地模型与运行时注册、按任务加载/卸载、把结果回灌给会话。
 */
import { resolveConfigSync } from './config.js'
import { Orchestrator } from './manager.js'
import { Decision } from './decision.js'
import { buildTools } from './tools.js'
import { registerWeb } from './web.js'
import { Prefs, LOCAL_FIRST_DIRECTIVE } from './prefs.js'
import { Worker } from './worker.js'
import path from 'node:path'

export const name = 'dsh-local-orchestrator'

/** 这两个服务是核心：工具注册 + 系统提示注入。llm/settings 走可选读取。 */
export const inject = ['tools', 'systemPrompt']

/**
 * @param {object} ctx DSH 插件上下文
 * @param {object} rawConfig profile 行内配置（可选）
 */
export function apply(ctx, rawConfig = {}) {
  // 任何装配异常都不能拖垮宿主：记日志后降级为「插件未启用」
  try {
    setup(ctx, rawConfig)
  } catch (error) {
    ctx.logger?.warn?.(
      `[local-orchestrator] 装配失败（插件已跳过）：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

function setup(ctx, rawConfig = {}) {
  let config
  try {
    config = resolveConfigSync(rawConfig).config
  } catch (error) {
    ctx.logger?.warn?.(`[local-orchestrator] 配置解析失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  if (config.enabled === false) {
    ctx.logger?.info?.('[local-orchestrator] 已在配置中禁用，跳过装配')
    return
  }

  const orchestrator = new Orchestrator({ config, ctx })
  const decision = new Decision({ config, ctx, orchestrator })
  // 「本地优先」开关：按会话记录，输入框旁的按钮通过 /prefs 写入
  const prefs = new Prefs(path.join(config.dataDir, 'prefs.json'))
  prefs.load().catch(() => {})

  /**
   * 唤醒任务所属会话：用宿主的持久化提醒（schedule）把一条消息投进该会话 inbox。
   * 拿不到 schedule 服务时返回 false，任务留在 waiting_decision，等下次会话自己来看。
   */
  const wakeSession = async (sessionId, payload) => {
    if (!sessionId) return false
    let schedule = null
    try {
      schedule = ctx.get?.('schedule') ?? null
    } catch {
      schedule = null
    }
    if (!schedule || typeof schedule.create !== 'function') return false
    const title = `本地任务待处理：${String(payload?.title ?? '').slice(0, 40)}`.slice(0, 60)
    try {
      await schedule.create(sessionId, {
        title,
        prompt: String(payload?.prompt ?? ''),
        after_seconds: Math.max(1, Number(config.worker?.wakeDelaySec ?? 5)),
      })
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[local-orchestrator] 唤醒会话失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const worker = new Worker({ orchestrator, decision, config, wake: wakeSession })
  orchestrator.worker = worker

  // DSH 停止回合（用户点取消/中断）时，只收尾「本会话」：取消该会话的工具 run，
  // 并把正在执行的步骤回退、任务转 paused。其它会话的任务完全不动。
  try {
    ctx.on('agent/turn-stopping', (payload) => {
      try {
        const sessionId = payload?.agent?.id ?? null
        if (!sessionId) {
          // 旧版宿主拿不到会话：退回全局取消，避免卡死
          if (orchestrator.tracker.hasRunning()) orchestrator.tracker.cancelAll('DSH 回合结束')
          return
        }
        orchestrator
          .suspendSession(sessionId, 'DSH 回合结束')
          .catch((error) =>
            ctx.logger?.warn?.(
              `[local-orchestrator] 暂停会话任务失败：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* 旧版本宿主没有该事件时忽略 */
  }

  // 异步初始化（读 catalog / registry / 采样一次硬件），不阻塞宿主启动
  orchestrator
    .start()
    .then(() => {
      try {
        worker.start()
      } catch (error) {
        ctx.logger?.warn?.(`[local-orchestrator] 后台执行环启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
      ctx.logger?.info?.(
        `[local-orchestrator] 就绪：${orchestrator.catalog.list({ enabledOnly: true }).length} 个资产，` +
          `${orchestrator.tasksSummary().total} 个历史任务，` +
          `GPU 槽${config.scheduler?.gpuExclusive === false ? '并发' : '互斥'}，` +
          `后台执行 ${worker.running ? '开' : '关'}，空闲回收 ${config.scheduler?.idleUnloadSec}s`,
      )
    })
    .catch((error) => {
      ctx.logger?.warn?.(`[local-orchestrator] 初始化失败：${error instanceof Error ? error.message : String(error)}`)
    })

  if (config.tools?.enable !== false) {
    for (const tool of buildTools({ orchestrator, decision, config })) {
      ctx.effect(() => ctx.tools.register(tool), `dsh-local-orchestrator: tool ${tool.name}`)
    }
  }

  if (config.prompt?.enabled !== false) {
    try {
      ctx.effect(
        () =>
          ctx.systemPrompt.context({
            name: 'local-orchestrator:fleet',
            order: 600,
            text: (promptContext) => {
              const base = orchestrator.cachedBriefing
              const sessionId = promptContext?.agent?.session?.id
              // 任务池：只提示本会话未结束的任务，避免上下文污染
              const pending = orchestrator.tasks
                .list({ sessionId, limit: 10 })
                .filter((task) => !['done', 'cancelled'].includes(task.status))
                .slice(0, 5)
              const lines = [base]
              if (pending.length > 0) {
                lines.push('', '本会话未完成任务（用 local_step run 推进）：')
                for (const task of pending) {
                  lines.push(`- ${task.id} [${task.status}] ${task.title.slice(0, 40)}`)
                }
              }
              if (prefs.get(sessionId)) lines.push('', LOCAL_FIRST_DIRECTIVE)
              return lines.join('\n')
            },
          }),
        'dsh-local-orchestrator: fleet briefing',
      )
    } catch (error) {
      // 宿主重复装配时同名 section 会抛 already registered，跳过即可
      if (!String(error?.message ?? '').includes('already registered')) throw error
    }
  }

  if (config.web?.enabled !== false) {
    try {
      registerWeb(ctx, { config, orchestrator, decision, prefs })
    } catch (error) {
      ctx.logger?.warn?.(
        `[local-orchestrator] Web API 注册失败（不影响工具）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  ctx.effect(() => () => {
    try {
      worker.stop()
    } catch {
      /* ignore */
    }
    try {
      orchestrator.dispose()
    } catch {
      /* ignore */
    }
  }, 'dsh-local-orchestrator: dispose')
}
