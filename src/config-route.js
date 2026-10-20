/**
 * 配置页的 host 侧端点。
 *
 * 浏览器半区不能直接读文件，因此由 host 暴露两个端点：
 *   - `GET  /plugins/dsh-zhanlu-connect/config` → 当前偏好 + 全部模型（含内置默认窗口）
 *   - `POST /plugins/dsh-zhanlu-connect/config` → 保存偏好，返回保存后的结果
 *
 * 与 WorkBuddy 的端点设计一致：`kind: 'exact'` 路径、`credentials: 'same-origin'`、
 * 只暴露配置所需的最小数据面，**绝不下发网关密钥**。
 *
 * @module dsh-zhanlu-connect/config-route
 */

import {
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  applyPreferences,
  normalizePreferences,
} from './preferences.js'

/** 配置端点路径。 */
export const CONFIG_PATH = '/plugins/dsh-zhanlu-connect/config'

/** 请求体上限，防止异常大的 POST 撑爆内存。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 把一个 JS 值写回 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读取请求体并解析成 JSON。
 *
 * 超限直接拒绝：配置请求本来就只有几百字节。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 组装配置端点所需的依赖。
 *
 * @typedef {object} ConfigRouteDeps
 * @property {import('./preferences.js').PreferenceStore} store 偏好存储
 * @property {() => Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>} listModels 当前全部模型（含内置默认值，未经偏好过滤）
 * @property {() => void} onChanged 偏好变化后的回调（重建 provider 快照）
 * @property {{ warn: (msg: string, err?: unknown) => void, error: (msg: string, err?: unknown) => void }} logger
 */

/**
 * 生成配置端点的请求处理器。
 *
 * GET 返回：
 *   - `models`：**全部**模型（含被隐藏的），带 `hidden` 与 `isDefaultContextWindow` 标志，
 *     供 UI 渲染完整勾选列表——若这里只返回可见模型，被隐藏的项就再也勾不回来了。
 *   - `defaults`：窗口的合法范围，供前端做输入校验。
 *
 * POST 接受 `{ hiddenModels, contextOverrides }`，规整后落盘并返回保存结果。
 *
 * @param {ConfigRouteDeps} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createConfigHandler(deps) {
  const { store, listModels, onChanged, logger } = deps

  return async function handleConfig(req, res) {
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET') {
        const all = listModels()
        const preferences = store.current
        const visible = new Set(applyPreferences(all, preferences).map((m) => m.id))
        json(res, 200, {
          models: all.map((m) => ({
            id: m.id,
            name: m.name,
            defaultContextWindow: m.contextWindow,
            // 当前生效值：有覆盖就是覆盖值，否则等于默认值。
            contextWindow: preferences.contextOverrides[m.id] ?? m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: m.reasoning,
            input: m.input ?? ['text'],
            hidden: !visible.has(m.id),
            overridden: preferences.contextOverrides[m.id] !== undefined,
          })),
          limits: { min: MIN_CONTEXT_WINDOW, max: MAX_CONTEXT_WINDOW },
          // 平台选择（v0.4.0）：auto | mac | windows，UI 渲染选择器用。
          platform: preferences.platform,
        })
        return
      }

      if (method === 'POST') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          json(res, 400, {
            error: 'invalid-body',
            message: error instanceof Error ? error.message : '请求体解析失败',
          })
          return
        }
        const normalized = normalizePreferences(body)
        await store.save(normalized)
        // 偏好变化后必须重建 provider 快照，否则选择器要等下一次目录刷新才更新。
        onChanged()
        const all = listModels()
        const visible = new Set(applyPreferences(all, normalized).map((m) => m.id))
        json(res, 200, {
          saved: true,
          hiddenCount: normalized.hiddenModels.length,
          visibleCount: visible.size,
          overrides: normalized.contextOverrides,
          platform: normalized.platform,
        })
        return
      }

      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      logger.error('dsh-zhanlu-connect: 配置端点处理失败', error)
      // 已经写过响应头就不能再写，否则 Node 会抛 ERR_HTTP_HEADERS_SENT。
      if (!res.headersSent) {
        json(res, 500, {
          error: 'internal',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
