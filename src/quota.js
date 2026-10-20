/** 每日额度的唯一来源是网关预算接口；本地 token 账本仅作独立参考。 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { loadZhanluCredential } from './credential.js'
import { pickZhanluDataDir } from './platform.js'

export const QUOTA_REFRESH_MS = 5 * 60 * 1000
export const BUDGET_PATH = '/gateway/api/v1/external-ide/budget-info'

/** 对齐 App：未耗尽不四舍五入成0，未满额不四舍五入成100。 */
export function budgetPercent(total, remaining) {
  if (total <= 0 || remaining <= 0) return 0
  if (remaining >= total) return 100
  return Math.max(1, Math.min(99, Math.round(remaining / total * 100)))
}

export function parseBudget(payload) {
  const data = payload?.data
  if (payload?.code !== 200 || !data) return undefined
  const { max_budget: total, spend: spent, remaining_budget: remaining } = data
  if (![total, spent, remaining].every(Number.isFinite) || total < 0 || spent < 0 ||
      remaining < 0 || remaining > total) return undefined
  return { source: 'gateway', total, spent, remaining, percent: budgetPercent(total, remaining), unit: '积分' }
}

function unavailable(code, message) { return { source: 'unavailable', code, message, stale: false } }

/** 平台选择既可以是值也可以是 getter（运行时可切换）；统一在这里解出。 */
function platformOf(value) {
  return typeof value === 'function' ? value() : value
}

/** 一次调用只查询预算，绝不发送模型请求；错误不透传上游正文/凭据。 */
export async function readQuota(options = {}) {
  if (options.disableNetwork) return unavailable('network-disabled', '已禁用网络请求，请关闭离线排障模式后重试')
  let credential
  try { credential = options.credential ?? await (options.loadCredential ?? loadZhanluCredential)({ dataDir: options.dataDir, platform: platformOf(options.platform) }) }
  catch { return unavailable('credential-unavailable', '登录凭据不可用，请在湛卢 App 中重新登录') }
  let url
  try {
    url = new URL(credential.metadata.modelBaseUrl.replace(/\/+$/, '') + BUDGET_PATH)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !credential.apiKey) throw new Error()
  } catch { return unavailable('gateway-missing', '登录凭据中缺少有效网关地址，请重新登录湛卢') }
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url.toString(), {
      method: 'GET', headers: { Authorization: `Bearer ${credential.apiKey}`, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    })
    if (!response.ok) return unavailable(`http-${response.status}`, response.status === 401 || response.status === 403
      ? '额度查询认证失败，请在湛卢 App 中重新登录后重试' : `额度服务返回 HTTP ${response.status}，请稍后重试`)
    // 预算对象很小。禁止把任意上游错误正文带到浏览器/日志。
    const text = await response.text()
    if (text.length > 65536) return unavailable('invalid-response', '额度服务响应异常，请稍后重试')
    const payload = JSON.parse(text)
    if (payload?.code === 401 || payload?.code === 403) return unavailable('auth-rejected', '额度查询认证失败，请在湛卢 App 中重新登录后重试')
    const budget = parseBudget(payload)
    return budget ? { ...budget, stale: false, updatedAt: (options.now ?? Date.now)() }
      : unavailable('invalid-response', '额度服务未返回有效预算数据，请稍后重试')
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return unavailable(timeout ? 'timeout' : 'query-failed', timeout ? '额度查询超时，请重试' : '额度查询失败，请检查网络后重试')
  }
}

/** 每个插件实例一个账号绑定缓存。两处UI及多会话共享，换账号绝不回退旧余额。 */
export function createQuotaReader(options = {}) {
  let state, sequence = 0, latestCredentialRevision = 0
  const now = options.now ?? Date.now
  return async ({ force = false } = {}) => {
    if (options.disableNetwork) { state = undefined; return readQuota(options) }
    const revision = ++sequence
    let credential
    try { credential = await (options.loadCredential ?? loadZhanluCredential)({ dataDir: options.dataDir, platform: platformOf(options.platform) }) }
    catch {
      if (revision >= latestCredentialRevision) { latestCredentialRevision = revision; state = undefined }
      return unavailable('credential-unavailable', '登录凭据不可用，请在湛卢 App 中重新登录')
    }
    const identity = createHash('sha256').update(JSON.stringify([
      credential.apiKey, credential.metadata.modelBaseUrl, credential.metadata.email, credential.metadata.telephone,
    ])).digest('hex')
    // 文件读取本身也可能乱序；旧凭据不能在较新的身份已确认后复活旧缓存。
    if (revision < latestCredentialRevision && identity !== state?.identity) return unavailable('identity-changed', '登录账号已变化，请重新查询额度')
    latestCredentialRevision = Math.max(latestCredentialRevision, revision)
    if (state?.identity !== identity) state = { identity, result: undefined, good: undefined, nextAt: 0, pending: undefined }
    const current = state
    if (current.pending) return current.pending
    if (!force && current.result && now() < current.nextAt) return { ...current.result }
    current.pending = (async () => {
      const result = await readQuota({ ...options, credential })
      if (state !== current) return unavailable('identity-changed', '登录账号已变化，请重新查询额度')
      if (result.source === 'gateway') current.good = result
      if (['http-401', 'http-403', 'auth-rejected'].includes(result.code)) current.good = undefined
      current.result = result.source === 'unavailable' && current.good
        ? { ...current.good, stale: true, code: result.code, message: result.message } : result
      current.nextAt = now() + QUOTA_REFRESH_MS
      return { ...current.result }
    })().finally(() => { current.pending = undefined })
    return current.pending
  }
}

/**
 * 读取 token_usage_ledger 的累计 token 消耗，便于插件页给出“已用”参考。
 * **不依赖** App 是否在跑；只要 db 可读。
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] 显式数据目录（优先级最高）
 * @param {unknown} [options.platform] 平台选择（auto | mac | windows）；缺省按系统检测
 * @returns {Promise<{ usedInput: number, usedOutput: number, usedReasoning: number, usedCacheRead: number, usedCacheWrite: number, usedTotal: number, message?: string }>}
 */
export async function readTokenUsage(options = {}) {
  const dataDir = options.dataDir ?? pickZhanluDataDir({ platform: platformOf(options.platform) }).dataDir
  const dbPath = join(dataDir, 'zhanlu.db')
  /** @type {import('node:sqlite').DatabaseSync | undefined} */
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return { usedInput: 0, usedOutput: 0, usedReasoning: 0, usedCacheRead: 0, usedCacheWrite: 0, usedTotal: 0, message: error?.message ?? String(error) }
  }
  try {
    const row = db.prepare(`SELECT
        COALESCE(SUM(tokens_input), 0) AS u_in,
        COALESCE(SUM(tokens_output), 0) AS u_out,
        COALESCE(SUM(tokens_reasoning), 0) AS u_reason,
        COALESCE(SUM(tokens_cache_read), 0) AS u_cr,
        COALESCE(SUM(tokens_cache_write), 0) AS u_cw,
        COALESCE(SUM(tokens_total), 0) AS u_total
      FROM token_usage_ledger`).get()
    return {
      usedInput: row?.u_in ?? 0,
      usedOutput: row?.u_out ?? 0,
      usedReasoning: row?.u_reason ?? 0,
      usedCacheRead: row?.u_cr ?? 0,
      usedCacheWrite: row?.u_cw ?? 0,
      usedTotal: row?.u_total ?? 0,
    }
  } catch (error) {
    return {
      usedInput: 0, usedOutput: 0, usedReasoning: 0, usedCacheRead: 0, usedCacheWrite: 0, usedTotal: 0,
      message: error?.message ?? String(error),
    }
  } finally {
    try { db?.close() } catch { /* 同上 */ }
  }
}

