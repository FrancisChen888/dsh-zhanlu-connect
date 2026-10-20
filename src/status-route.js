/**
 * 账号状态与连通性检测的 host 端点。
 *
 * 三个端点，全部只读、全部走同源：
 *   - `GET  /plugins/dsh-zhanlu-connect/status`  → 账号 + 网关 + 目录快照
 *   - `POST /plugins/dsh-zhanlu-connect/status`  → 执行一次主动检测（action 指定）
 *
 * POST 的 action：
 *   - `refresh`   重新拉取模型目录（换账号/换登录方式后手动刷新用）
 *   - `account`   重新读取凭据与账号身份
 *   - `connectivity` 打一次网关连通性探测（含凭据是否可解密）
 *
 * 设计原则与 config/quota 端点一致：失败不抛 5xx，而是
 * `{ ok: false, reason }`，让 UI 直接把原因显示出来。
 *
 * @module dsh-zhanlu-connect/status-route
 */

/** 状态端点路径。 */
export const STATUS_PATH = '/plugins/dsh-zhanlu-connect/status'

/** 请求体上限。 */
const MAX_BODY_BYTES = 4 * 1024

/**
 * 写一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * 读取 JSON 请求体（小体量，超限直接拒绝）。
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
 * 组装状态端点依赖。
 *
 * @typedef {object} StatusRouteDeps
 * @property {() => object} getStatus 当前状态快照（账号、地址、模型数）
 * @property {() => Promise<void>} refreshCatalog 重新拉取目录
 * @property {(dataDir?: string) => Promise<object | undefined>} readIdentity 只读身份（不解密）
 * @property {() => Promise<{ ok: boolean, latencyMs?: number, reason?: string, modelCount?: number }>} probeGateway 连通性探测
 * @property {{ warn: (msg: string, err?: unknown) => void, error: (msg: string, err?: unknown) => void, info: (msg: string) => void }} logger
 */

/**
 * 生成状态端点的请求处理器。
 *
 * @param {StatusRouteDeps} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createStatusHandler(deps) {
  const { getStatus, refreshCatalog, readIdentity, probeGateway } = deps
  // logger 是可选依赖：宿主没传（或测试故意不传）时静默降级。
  // 绝不让「记日志」本身把请求搞崩——日志失败必须比响应失败更不重要。
  const log = {
    warn: deps.logger?.warn?.bind(deps.logger) ?? (() => {}),
    error: deps.logger?.error?.bind(deps.logger) ?? (() => {}),
    info: deps.logger?.info?.bind(deps.logger) ?? (() => {}),
  }

  return async function handleStatus(req, res) {
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET') {
        json(res, 200, { ok: true, status: getStatus() })
        return
      }

      if (method === 'POST') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          json(res, 400, {
            ok: false,
            error: 'invalid-body',
            message: error instanceof Error ? error.message : '请求体解析失败',
          })
          return
        }

        const action = /** @type {Record<string, unknown>} */ (body)?.action

        if (action === 'refresh') {
          await refreshCatalog()
          json(res, 200, { ok: true, status: getStatus() })
          return
        }

        if (action === 'account') {
          // 重新读身份：换账号/换登录方式后，账号信息与网关地址都会更新。
          const info = await readIdentity()
          json(res, 200, {
            ok: true,
            identity: info ?? null,
            status: getStatus(),
          })
          return
        }

        if (action === 'connectivity') {
          const probe = await probeGateway()
          json(res, 200, { ok: probe.ok, probe, status: getStatus() })
          return
        }

        json(res, 400, { ok: false, error: 'unknown-action', message: `未知操作：${String(action)}` })
        return
      }

      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      log.error('dsh-zhanlu-connect: 状态端点处理失败', error)
      if (!res.headersSent) {
        json(res, 200, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
