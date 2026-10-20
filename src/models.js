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
