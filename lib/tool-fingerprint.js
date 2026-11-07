/**
 * 工具指纹：判断某个 tool 的定义/实现有没有变过。
 *
 * 用于「改了工具就重新验证」：脚本 scripts/verify-tools.mjs 把指纹写进
 * docs/tool-verification.json，指纹不匹配 = 代码变过 = 需要重跑真实调用。
 *
 * 口径：名字 + 描述 + 参数 schema + execute 源码。改注释不会变，改逻辑一定变。
 */
import crypto from 'node:crypto'

/**
 * @param {{name: string, description?: string, parameters?: object, execute?: Function}} tool
 * @returns {string} sha256:xxxxxxxx（16 位前缀，够用且好读）
 */
export function fingerprintTool(tool) {
  const payload = [
    tool?.name ?? '',
    tool?.description ?? '',
    JSON.stringify(tool?.parameters ?? {}),
    String(tool?.execute ?? ''),
  ].join('\n---\n')
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)}`
}
