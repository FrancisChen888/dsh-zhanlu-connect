import { LoginError } from './login-store.js'
export const LOGIN_PATH = '/plugins/dsh-zhanlu-connect/login'
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
export function createLoginHandler({ store, onChanged }) {
  return async (req, res) => {
    try {
      if (req.method === 'GET') {
        // 读取当前App并安全留档，不更改已有手动选择。
        await store.read()
        return json(res, 200, store.status())
      }
      if (req.method !== 'POST') return json(res, 405, { message: '仅支持GET或POST' })
      const origin = req.headers?.origin
      if (origin && new URL(origin).host !== req.headers?.host) return json(res, 403, { message: '不允许跨站切换登录' })
      if (!req.headers?.['content-type']?.startsWith('application/json')) return json(res, 415, { message: '需要JSON请求' })
      let raw = ''
      for await (const chunk of req) {
        raw += chunk.toString()
        if (Buffer.byteLength(raw) > 1024) return json(res, 413, { message: '请求过大' })
      }
      let body
      try { body = JSON.parse(raw) } catch { return json(res, 400, { message: '无效JSON' }) }
      if (body?.action === 'capture') await store.capture()
      else if (body?.action === 'select') await store.select(body.mode)
      else return json(res, 400, { message: '无效操作' })
      await onChanged()
      json(res, 200, { ...store.status(), message: '已更新本插件的登录选择；凭据是否有效请执行连通性检测' })
    } catch (e) {
      json(res, e instanceof LoginError ? 409 : 503, { code: e instanceof LoginError ? e.code : 'login-unavailable', message: e instanceof LoginError ? e.message : '登录凭据暂不可用，请检查湛卢App登录状态及本地存储权限' })
    }
  }
}
