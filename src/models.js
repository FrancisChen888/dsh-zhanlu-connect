/**
 * 模型目录的纯转换逻辑。
 *
 * 单独成模块的原因：这些函数不依赖任何宿主提供的包（`@earendil-works/pi-ai`
 * 等），因此可以被 `node --test` 直接加载。`adapter.js` 会 import 宿主包，
 * 在没有 DSH 运行时时无法解析——把纯逻辑放在这里，测试才能真正跑起来。
 *
 * @module dsh-zhanlu-connect/models
 */

import { MODEL_ID_PREFIX, describeModel } from './gateway.js'

/**
 * 把网关返回的原始模型 id 列表转成插件使用的模型描述。
 *
 * 只保留带 `zhanlu/` 前缀的条目：网关的 `/v1/models` 已经是该前缀下的目录，
 * 但这里仍显式过滤，避免将来网关把非本路由的模型混进同一响应。
 *
 * @param {string[]} ids
 * @returns {Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input: string[] }>}
 */
export function toModelInfos(ids) {
  const seen = new Set()
  const out = []
  for (const id of ids) {
    if (typeof id !== 'string' || !id.startsWith(MODEL_ID_PREFIX)) continue
    // 只有前缀本身（`zhanlu/`）不是合法模型，丢掉。
    if (id.length <= MODEL_ID_PREFIX.length) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(describeModel(id))
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** 缓存格式版本；不认识的一律丢弃而不是猜测。 */
export const CATALOG_FORMAT_VERSION = 1

/**
 * 把缓存文件的内容解析成模型描述数组。
 *
 * 解析逻辑在这里集中一次，供同步与异步两条读取路径共用，避免两处判据漂移。
 *
 * @param {string} raw
 * @returns {Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>}
 */
export function parseCatalog(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed?.version !== CATALOG_FORMAT_VERSION) return []
  if (!Array.isArray(parsed.models)) return []
  const out = []
  for (const entry of parsed.models) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const info = describeModel(entry.id)
    out.push({
      id: entry.id,
      // 名称、模态与默认窗口以代码为准：旧缓存的 512K 不能覆盖升级后的 1M。
      // 用户显式窗口设置保存在 preferences，稍后由 applyPreferences 单独套用。
      name: info.name,
      contextWindow: info.contextWindow,
      maxTokens: Number.isFinite(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : 32768,
      reasoning: entry.reasoning === true,
      // 模态能力一律以代码里的 KNOWN_MODELS 为准，不信任缓存：
      // 上游能力会变化（2026-10-13 实测 qwen3.7-max 等 4 个模型图片输入被网关 400 拒收），
      // 若缓存优先，代码里的能力修正会被旧缓存静默覆盖，bug 永不愈合。
      input: info.input,
    })
  }
  return out
}
