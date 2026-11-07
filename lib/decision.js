/**
 * 决策模型：把「任务 → 资源计划」这一步交给指定模型。
 *
 * 四种来源（config.decision.mode）：
 * - session：不做额外调用，由当前 DSH 会话模型自己看工具、自己决策（默认）
 * - dsh：复用 DSH 已配置的 provider/model（如 deepseek-v4），适合复杂分解
 * - openai：任意 OpenAI 兼容端点（云端 API 或本地 llama-server）
 * - local：直接用本地已注册的某个模型当决策模型（省显存场景可关 planning）
 *
 * 决策只产出「计划」，执行仍由 Orchestrator 负责，保证资源约束只有一份实现。
 */
import { fetchJson } from './runtimes/process.js'
import { parseJsonLoose, clip } from './util.js'
import { resolveWorkflow } from './workflows.js'
import { selectWorkflow } from './router.js'

const PLAN_SYSTEM = `你是本地算力调度器的规划器。用户机器上的 GPU 显存有限，默认同一时刻只能加载一个吃显存的模型。
你的任务：把用户任务拆成 1~N 个步骤，给每步指定能力类型和（可选）具体资产。

规则：
- 只输出 JSON，不要解释、不要 markdown 代码块。
- 优先复用已加载的资产；能用小模型解决的不要用大模型。
- 需要图像/视频/语音的步骤，kind 分别写 image / video / audio-tts / audio-asr。
- 需要检查产物质量时，追加一个 kind=evaluate 的步骤（dependsOn 指向前一步），rubric 写清评审标准；
  verification 写 {"mode":"require"} 表示「这一步需要会话模型或人来判断」。
- asset 只能从给定资产列表里选；不确定就留空字符串，由调度器自动挑。
- 依赖关系用 dependsOn 数组表达（步骤下标，从 0 开始）；无依赖写 []。
- 最后一个步骤通常是把前序产出汇总成给用户的最终答复。

输出格式：
{"summary":"一句话计划","steps":[{"goal":"这一步要做什么、产出什么","kind":"llm","asset":"","dependsOn":[]}]}`

export class Decision {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {object|null} options.ctx DSH 上下文（dsh 模式需要 ctx.llm）
   * @param {import('./manager.js').Orchestrator} options.orchestrator
   */
  constructor({ config, ctx = null, orchestrator }) {
    this.config = config
    this.ctx = ctx
    this.orchestrator = orchestrator
  }

  get mode() {
    return this.config.decision?.mode ?? 'session'
  }

  /** 决策模型是否可用（session 模式下不需要额外模型）。 */
  get available() {
    return this.mode !== 'session'
  }

  /**
   * 调一次决策模型，返回纯文本。
   * @param {object} options
   * @param {string} options.system
   * @param {string} options.prompt
   * @param {number} [options.maxTokens]
   * @param {AbortSignal} [options.signal]
   */
  async complete({ system, prompt, maxTokens, signal }) {
    const decision = this.config.decision ?? {}
    const tokens = maxTokens ?? Number(decision.maxTokens ?? 1500)
    const temperature = Number(decision.temperature ?? 0.2)
    const messages = [{ role: 'user', content: prompt }]

    if (this.mode === 'dsh') {
      const llm = this.ctx?.get?.('llm') ?? this.ctx?.llm
      if (!llm || typeof llm.stream !== 'function') {
        return { ok: false, error: 'DSH llm 服务不可用，无法使用 dsh 决策模型' }
      }
      // 「复用当前会话的 API」：provider/model 留空就取 DSH 当前的默认选择，
      // 这样不另存 apiKey，也不会因为填了不存在的模型名而静默返回空文本。
      let provider = String(decision.provider || '').trim()
      let model = String(decision.model || '').trim()
      if (!provider || !model) {
        try {
          const selection = this.ctx?.get?.('agentDefaultModel')?.currentSelection?.()
          if (!provider && selection?.provider) provider = String(selection.provider)
          if (!model && selection?.model) model = String(selection.model)
        } catch {
          /* 老版本宿主没有这个服务，走下面的兜底 */
        }
      }
      if (!provider || !model) {
        try {
          const providers = await llm.listProviders?.()
          if (!provider && providers?.length) provider = providers[0].id
          if (provider && !model) {
            const models = await llm.listModels?.(provider)
            if (models?.length) model = models[0].id
          }
        } catch {
          /* 列不出来就让下面统一报错 */
        }
      }
      if (!provider || !model) {
        return { ok: false, error: '无法确定当前会话的 provider/model（可手动填 provider 与 model）' }
      }
      const options = {
        provider,
        model,
        system,
        messages: messages.map((message) => ({
          role: message.role,
          id: `dsh-lo-${Date.now().toString(36)}`,
          content: [{ type: 'text', text: message.content }],
          source: { kind: 'user' },
        })),
        maxTokens: tokens,
        signal,
      }
      let text = ''
      let failure = null
      let usage = null
      try {
        const stream = llm.stream(options)
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += chunk.text
          else if (chunk?.type === 'usage') usage = chunk.usage ?? null
          else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
        }
      } catch (error) {
        return { ok: false, error: `决策模型调用失败：${error instanceof Error ? error.message : String(error)}` }
      }
      if (failure) {
        return { ok: false, error: `决策模型调用失败：${failure.message ?? failure.code ?? 'unknown'}` }
      }
      // 统一成和 local 一样的 usage 形状，方便本地用量账本统计远程调用
      const normalizedUsage = usage
        ? {
            prompt_tokens: Number(usage.inputTokens ?? 0),
            completion_tokens: Number(usage.outputTokens ?? 0),
            total_tokens: Number(usage.totalTokens ?? (Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0))),
          }
        : null
      return { ok: true, text: text.trim(), model: `${provider}/${model}`, usage: normalizedUsage }
    }

    if (this.mode === 'openai') {
      const baseUrl = String(decision.baseUrl ?? '').replace(/\/+$/, '')
      if (!baseUrl) return { ok: false, error: 'decision.baseUrl 未配置' }
      const body = {
        model: decision.model || 'local',
        messages: [{ role: 'system', content: system }, ...messages],
        temperature,
        max_tokens: tokens,
        stream: false,
      }
      const result = await fetchJson(`${baseUrl}/chat/completions`, {
        method: 'POST',
        body,
        timeoutMs: 300000,
        signal,
        headers: decision.apiKey ? { authorization: `Bearer ${decision.apiKey}` } : undefined,
      })
      if (!result.ok) return { ok: false, error: result.error }
      const text = result.body?.choices?.[0]?.message?.content ?? ''
      return { ok: true, text: String(text).trim(), model: decision.model || 'openai-compatible', usage: result.body?.usage }
    }

    if (this.mode === 'local') {
      const assetId = decision.localAsset
      if (!assetId) return { ok: false, error: 'decision.localAsset 未配置' }
      const reply = await this.orchestrator.runChat(assetId, {
        system,
        messages,
        temperature,
        maxTokens: tokens,
        signal,
        // 规划/评估都要 JSON：让 llama-server 走 JSON 语法约束，小模型也能稳定吐结构
        json: true,
        reason: '决策模型调用',
      })
      if (!reply.ok) return { ok: false, error: reply.error }
      return { ok: true, text: reply.content, model: assetId, usage: reply.usage }
    }

    return { ok: false, error: `决策模型模式 ${this.mode} 不支持主动调用（session 模式由会话模型自己决策）` }
  }

  /** 可用资产清单的文本摘要（喂给规划器）。 */
  #assetBriefing() {
    const lines = []
    for (const asset of this.orchestrator.catalog.list({ enabledOnly: true })) {
      const cost = (asset.measured.vramMb || null) ?? asset.cost.vramMb
      const state = this.orchestrator.instances.get(asset.id)?.state ?? 'stopped'
      lines.push(
        `- ${asset.id}｜${asset.kind}｜${asset.task || asset.name}` +
          (cost ? `｜约 ${Math.round(cost)}MB 显存` : '') +
          `｜当前 ${state}`,
      )
    }
    return lines.join('\n') || '（没有可用资产）'
  }

  /**
   * 让决策模型产出计划。
   * @param {string} task
   * @param {{signal?: AbortSignal, runId?: string|null}} [options]
   */
  async plan(task, options = {}) {
    const maxSteps = Number(this.config.decision?.maxSteps ?? 6)
    const prompt = [
      `可用资产：\n${this.#assetBriefing()}`,
      `约束：GPU 默认互斥，最多同时一个吃显存的资产；单次最多 ${maxSteps} 步。`,
      `用户任务：${task}`,
    ].join('\n\n')
    const runId = options.runId ?? null
    const tracker = this.orchestrator.tracker
    const node = runId ? tracker.node(runId, { kind: 'decision', label: `决策模型 · ${this.mode}` }) : null
    if (node) {
      tracker.record({
        runId,
        nodeId: node.id,
        channel: 'decision',
        kind: 'request',
        title: `决策模型 · ${this.mode}`,
        content: prompt,
        meta: { model: this.config.decision?.model || this.mode },
      })
    }
    const reply = await this.complete({ system: PLAN_SYSTEM, prompt, signal: options.signal })
    if (node) {
      tracker.record({
        runId,
        nodeId: node.id,
        channel: 'decision',
        kind: reply.ok ? 'response' : 'error',
        title: reply.ok ? '规划结果' : '规划失败',
        content: reply.ok ? reply.text : reply.error,
        meta: { model: reply.model ?? this.mode },
      })
      tracker.finishNode(runId, node.id, reply.ok ? 'done' : 'error', reply.ok ? `${reply.text.length} 字` : reply.error)
    }
    if (!reply.ok) return reply
    let parsed = parseJsonLoose(reply.text)
    let rawText = reply.text
    // 本地小模型第一次经常给出「解释 + JSON」或空壳：再问一次，明确要求只输出 JSON。
    if ((!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) && this.mode === 'local') {
      const retry = await this.complete({
        system: PLAN_SYSTEM,
        prompt: `${prompt}\n\n上一次输出不是合法计划（必须是 {"summary":"…","steps":[…]}）。只输出 JSON，不要任何解释。`,
        signal: options.signal,
      })
      if (retry.ok) {
        const again = parseJsonLoose(retry.text)
        if (again && Array.isArray(again.steps) && again.steps.length > 0) {
          parsed = again
          rawText = retry.text
        } else {
          rawText = `${reply.text}\n---\n${retry.text}`
        }
      }
    }
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      // 兜底：退化成一个 LLM 步骤，至少不把任务卡死在规划阶段（会在输出里标注 degraded）
      if (this.mode === 'local') {
        return {
          ok: true,
          degraded: true,
          plan: {
            summary: '本地决策模型没给出结构化计划，退化为单步执行',
            steps: [{ index: 0, goal: String(task), kind: 'llm', asset: '', dependsOn: [], rubric: '', verification: null }],
          },
          model: reply.model,
          raw: rawText,
        }
      }
      return { ok: false, error: `决策模型未返回合法计划：${clip(rawText, 300)}` }
    }
    const steps = parsed.steps.slice(0, maxSteps).map((step, index) => ({
      index,
      goal: String(step.goal ?? '').trim(),
      kind: String(step.kind ?? 'llm'),
      asset: String(step.asset ?? ''),
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < index)
        : [],
      rubric: String(step.rubric ?? ''),
      verification: step.verification ?? null,
    })).filter((step) => step.goal !== '')
    if (steps.length === 0) return { ok: false, error: '计划里没有有效步骤' }
    return {
      ok: true,
      plan: { summary: String(parsed.summary ?? ''), steps },
      model: reply.model,
      raw: reply.text,
    }
  }

  /**
   * 执行单个步骤（local_step 与 execute 共用）。
   * 只负责「一次调用」：按需加载、推理/生成、返回结果；不碰任务状态机。
   *
   * @param {object} step 计划步骤 {index, goal, kind, asset, dependsOn}
   * @param {{results?: object[], signal?: AbortSignal, runId?: string|null}} [options]
   * @returns {Promise<{index:number, goal:string, kind:string, ok:boolean, output:string, asset?:string, usage?:object|null, ms:number}>}
   */
  async executeStep(step, options = {}) {
    const results = options.results ?? []
    const signal = options.signal
    const runId = options.runId ?? null
    const started = Date.now()

    const finish = (ok, output, extra = {}) => ({
      index: step.index,
      goal: step.goal,
      kind: step.kind,
      ok,
      output,
      ms: Date.now() - started,
      ...extra,
    })

    const deps = (step.dependsOn ?? []).map((index) => results[index]).filter(Boolean)
    const contextText = deps.map((item) => `步骤${item.index + 1}（${item.goal}）产出：${item.output}`).join('\n')

    // 生成类步骤：默认按步骤目标自动挑工作流；autoSelect=false 时退回固定模板
    if (['image', 'video', 'audio-tts', 'audio-asr'].includes(step.kind)) {
      let comfyAsset = null
      let resolved = null
      if (this.config.comfy?.autoSelect !== false) {
        const prefer =
          step.kind === 'video'
            ? this.config.comfy?.videoWorkflow
            : step.kind === 'image'
              ? this.config.comfy?.imageWorkflow
              : this.config.comfy?.audioWorkflow
        // 只从「本地文件齐全」的资产里挑，避免选到已删除的工作流
        const candidates = await this.orchestrator.usableAssets({ includeHidden: true })
        const picked = selectWorkflow(candidates, step.goal, { kind: step.kind, prefer })
        if (picked) comfyAsset = picked.asset
      }
      if (!comfyAsset) {
        const workflowName =
          step.kind === 'image'
            ? this.config.comfy?.imageWorkflow
            : step.kind === 'video'
              ? this.config.comfy?.videoWorkflow
              : this.config.comfy?.audioWorkflow
        if (!workflowName) {
          return finish(false, `没有可用的 ${step.kind} 工作流：先 local_service sync，或在「设置」里填 config.comfy.*Workflow。`)
        }
        resolved = await resolveWorkflow(this.config, { workflowName, params: { prompt: step.goal } })
        if (!resolved.ok) return finish(false, resolved.error)
        comfyAsset =
          (this.config.comfy?.asset && this.orchestrator.catalog.get(this.config.comfy.asset)) ||
          this.orchestrator.catalog.get('comfyui') ||
          (await this.orchestrator.pick({ kind: 'image' }))?.asset
      }
      if (!comfyAsset) return finish(false, '没有 ComfyUI 资产')
      try {
        const out = await this.orchestrator.runComfy(comfyAsset.id, {
          workflow: resolved?.workflow,
          params: { prompt: step.goal },
          signal,
          runId,
        })
        return finish(out.ok, out.ok ? out.files.map((file) => file.url).join('\n') : `失败：${out.error}`, {
          asset: comfyAsset.id,
        })
      } catch (error) {
        return finish(false, `失败：${error instanceof Error ? error.message : String(error)}`, { asset: comfyAsset.id })
      }
    }

    // 评估步骤：拿上游产出做客观检查 + 模型打分（可选 VLM 看真图）
    if (step.kind === 'evaluate') {
      return await this.#evaluate(step, { deps, signal, runId, finish })
    }

    if (!['llm', 'vlm'].includes(step.kind)) {
      return finish(false, `暂不支持自动执行 ${step.kind} 步骤：需要提供工作流/脚本（可用 local_service 加载对应服务后手动调用）`)
    }

    const picked = step.asset
      ? { asset: this.orchestrator.catalog.get(step.asset) }
      : await this.orchestrator.pick({ kind: step.kind === 'vlm' ? 'vlm' : undefined })
    if (!picked?.asset) return finish(false, '没有可用资产')

    const prompt = contextText ? `任务：${step.goal}\n\n前序产出：\n${contextText}` : `任务：${step.goal}`
    try {
      const reply = await this.orchestrator.runChat(picked.asset.id, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        maxTokens: 2048,
        signal,
        reason: `计划步骤 ${step.index + 1}`,
        runId,
        label: `步骤 ${step.index + 1}：${step.goal}`,
      })
      // 思考型小模型常把正文写进 reasoning_content（正文为空），不能当成功空结果返回
      const text = reply.ok
        ? reply.content
          ? reply.content
          : reply.reasoning
            ? `（模型只返回了思考内容）\n\n${clip(reply.reasoning, 1200)}`
            : '（模型返回了空内容；可调大 maxTokens 或换模型）'
        : `失败：${reply.error}`
      return finish(reply.ok, text, {
        asset: picked.asset.id,
        usage: reply.usage ?? null,
      })
    } catch (error) {
      return finish(false, `失败：${error instanceof Error ? error.message : String(error)}`, { asset: picked.asset.id })
    }
  }

  /**
   * 评估步骤：客观统计 +（可选）模型打分。
   * 产物里有图片 URL 时下载到临时文件交给 VLM，让「质量评估」不是空话。
   */
  async #evaluate(step, { deps, signal, runId, finish }) {
    const material = deps.map((item) => `步骤${item.index + 1}（${item.goal}）：\n${item.output}`).join('\n\n')
    if (!material.trim()) return finish(false, '没有可评估的上游产出（dependsOn 为空或上游无输出）')

    const urls = [...new Set(material.match(/https?:\/\/[^\s"'）)]+/g) ?? [])]
    const rubric = String(step.rubric || '完整性、与任务目标的相关性、明显缺陷')
    const picked = step.asset
      ? { asset: this.orchestrator.catalog.get(step.asset) }
      : await this.orchestrator.pick({ kinds: ['vlm', 'llm'] })
    if (!picked?.asset) return finish(false, '没有可用于评估的模型（需要 vlm / llm）')

    const prompt = [
      `请评审下面的产出是否达到任务目标。`,
      `任务：${step.goal}`,
      `评审标准：${rubric}`,
      '',
      `产出：\n${clip(material, 4000)}`,
      '',
      '只输出 JSON：{"pass":true,"score":0-100,"issues":["..."],"verdict":"一句话结论"}',
    ].join('\n')

    try {
      const reply = await this.orchestrator.runChat(picked.asset.id, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 800,
        signal,
        reason: '质量评估',
        runId,
        label: `评估步骤 ${step.index + 1}`,
      })
      if (!reply.ok) return finish(false, `评估模型失败：${reply.error}`, { asset: picked.asset.id })
      const verdict = parseJsonLoose(reply.content) ?? { pass: true, score: null, verdict: clip(reply.content, 200) }
      const issues = Array.isArray(verdict.issues) ? verdict.issues.slice(0, 8) : []
      const lines = [
        `评审：${verdict.verdict ?? (verdict.pass === false ? '不通过' : '通过')}`,
        `评分：${verdict.score ?? '—'}`,
        issues.length > 0 ? `问题：\n${issues.map((item) => `- ${item}`).join('\n')}` : '问题：无',
        `客观：${material.length} 字 · ${urls.length} 个产物链接`,
      ]
      return finish(verdict.pass !== false, lines.join('\n'), { asset: picked.asset.id, usage: reply.usage ?? null })
    } catch (error) {
      return finish(false, `评估失败：${error instanceof Error ? error.message : String(error)}`, { asset: picked.asset.id })
    }
  }

  /**
   * 按 dependsOn 顺序执行整个计划（local_delegate 用）。
   * 多步任务建议走 local_task + local_step，这样中途可暂停/恢复。
   * @param {object} plan
   * @param {{signal?: AbortSignal, runId?: string|null}} [options]
   */
  async execute(plan, options = {}) {
    const results = []
    for (const step of plan.steps) {
      if (options.signal?.aborted) {
        return { ok: false, error: '已取消', steps: results }
      }
      results.push(await this.executeStep(step, { results, signal: options.signal, runId: options.runId ?? null }))
    }
    const ok = results.length > 0 && results.every((item) => item.ok)
    return { ok, steps: results }
  }
}
