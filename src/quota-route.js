/** 安全的每日额度投影；预算与本地token统计是不同口径。 */
import { createQuotaReader, readTokenUsage } from './quota.js'

export const QUOTA_PATH = '/plugins/dsh-zhanlu-connect/quota'

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(payload))
}

/** GET使用5分钟账号缓存；GET ?force=1为用户显式立即查询（并发仍去重）。 */
export function createQuotaHandler(deps = {}) {
  const read = deps.readQuota ?? createQuotaReader(deps)
  const tokens = deps.readTokenUsage ?? readTokenUsage
  return async function handleQuota(req, res) {
    if (req.method !== 'GET') {
      json(res, 405, { source: 'unavailable', code: 'method-not-allowed', message: '仅支持GET查询' }, { allow: 'GET' })
      return
    }
    try {
      const force = new URL(req.url ?? QUOTA_PATH, 'http://localhost').searchParams.get('force') === '1'
      const revision = deps.getLoginRevision?.()
      // platform 可以是值或 getter（v0.4.0 平台选择运行时可切换）；readTokenUsage 内部统一解。
      const [quota, used] = await Promise.all([read({ force }), tokens({ dataDir: deps.dataDir, platform: deps.platform })])
      if (revision !== deps.getLoginRevision?.()) {
        return json(res, 200, { source: 'unavailable', code: 'identity-changed', message: '登录已切换，请重新查询额度', updatedAt: null })
      }
      json(res, 200, {
        source: quota.source, percent: quota.percent, remaining: quota.remaining,
        total: quota.total, spent: quota.spent, unit: quota.unit,
        used: { usedTotal: used.message ? undefined : used.usedTotal, available: !used.message },
        stale: quota.stale === true, code: quota.code, message: quota.message,
        updatedAt: quota.updatedAt ?? null,
      })
    } catch {
      // 不透传任意异常对象：可能含请求头、凭据或上游错误正文。
      json(res, 200, { source: 'unavailable', code: 'query-failed', message: '额度暂不可用，请稍后重试', updatedAt: null })
    }
  }
}
