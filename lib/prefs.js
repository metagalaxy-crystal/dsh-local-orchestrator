/**
 * 用户偏好：目前只有「本地优先」开关。
 *
 * 语义：在输入框旁点「本地优先」后，本轮及后续轮次的系统提示里会注入一段
 * 指令，要求模型优先把任务交给 local_delegate / local_chat / local_generate，
 * 本地确实做不了时才用云端能力。
 *
 * 作用域：优先按会话 id 记录（每个会话独立开关）；拿不到 sessionId 时记全局。
 * 持久化到 <dataDir>/prefs.json，重启后保留。
 */
import { readJsonSafe, writeJsonAtomic, nowIso } from './util.js'

export class Prefs {
  constructor(file) {
    this.file = file
    this.sessions = {}
    this.global = { preferLocal: false }
    this.loaded = false
  }

  async load() {
    const data = await readJsonSafe(this.file, null)
    if (data && typeof data === 'object') {
      if (data.sessions && typeof data.sessions === 'object') this.sessions = data.sessions
      if (data.global && typeof data.global === 'object') this.global = { preferLocal: data.global.preferLocal === true }
    }
    this.loaded = true
    return this
  }

  async save() {
    // 只保留最近的 80 个会话，避免文件无限增长
    const entries = Object.entries(this.sessions).sort((a, b) => (b[1]?.updatedAt ?? '').localeCompare(a[1]?.updatedAt ?? ''))
    if (entries.length > 80) this.sessions = Object.fromEntries(entries.slice(0, 80))
    await writeJsonAtomic(this.file, { global: this.global, sessions: this.sessions })
  }

  /** 读取某会话的「本地优先」状态（没有记录时回落到全局）。 */
  get(sessionId) {
    if (sessionId && Object.prototype.hasOwnProperty.call(this.sessions, sessionId)) {
      return this.sessions[sessionId].preferLocal === true
    }
    return this.global.preferLocal === true
  }

  async set({ sessionId, preferLocal } = {}) {
    if (sessionId) {
      this.sessions[sessionId] = { preferLocal: preferLocal === true, updatedAt: nowIso() }
    } else {
      this.global = { preferLocal: preferLocal === true }
    }
    await this.save()
    return this.get(sessionId)
  }
}

/** 开启「本地优先」时注入给模型的指令。 */
export const LOCAL_FIRST_DIRECTIVE = [
  '【本地优先模式（用户已在输入框开启）】',
  '本任务请优先使用本地资源：',
  '- 文本/整理/摘要/看图：先考虑 local_delegate 或 local_chat；',
  '- 出图/视频：用 local_generate（工作流已配置时）；',
  '- 查询资源、加载与卸载：local_resources / local_service。',
  '只有本地确实无法完成或质量明显不够时，才改用云端能力；结束后如不再需要，可调用 local_service release 释放显存。',
].join('\n')
