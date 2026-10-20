/**
 * 路由端点集成测试：配置端点的平台字段读写与状态端点透传。
 *
 * @module dsh-zhanlu-connect/test/routes
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigHandler } from '../src/config-route.js'
import { createStatusHandler } from '../src/status-route.js'
import { createQuotaHandler } from '../src/quota-route.js'
import { PreferenceStore } from '../src/preferences.js'
import { LoginStore, LOGIN_MODES } from '../src/login-store.js'

/** 伪造 http req/res，端点处理器直接调用。 */
function mockRes() {
  const res = {
    statusCode: 0, headers: {}, body: undefined, headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true; return this },
    end(body) { this.body = body ?? '' },
  }
  return res
}
function mockReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, url: '/plugins/dsh-zhanlu-connect/config', headers: {},
    async *[Symbol.asyncIterator]() { yield* chunks },
  }
}

test('config GET/POST：platform 字段读写往返', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhanlu-route-'))
  try {
    const store = new PreferenceStore(join(dir, '.zhanlu-preferences.json'))
    store.loadSync()
    const handler = createConfigHandler({
      store,
      listModels: () => [{ id: 'zhanlu/glm-5.3', name: 'GLM-5.3 · 文本', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text'] }],
      onChanged: () => {},
    })
    const getRes = mockRes()
    await handler(mockReq('GET'), getRes)
    assert.equal(getRes.statusCode, 200)
    const got = JSON.parse(getRes.body)
    assert.equal(got.platform, 'auto', '初始平台为 auto')

    const postRes = mockRes()
    await handler(mockReq('POST', { hiddenModels: [], contextOverrides: {}, platform: 'windows' }), postRes)
    assert.equal(postRes.statusCode, 200)
    assert.equal(JSON.parse(postRes.body).platform, 'windows')

    const regetRes = mockRes()
    await handler(mockReq('GET'), regetRes)
    assert.equal(JSON.parse(regetRes.body).platform, 'windows', '保存后的平台在 GET 中回读')

    const badRes = mockRes()
    await handler(mockReq('POST', { hiddenModels: [], contextOverrides: {}, platform: 'linux' }), badRes)
    assert.equal(JSON.parse(badRes.body).platform, 'auto', '非法平台回落 auto')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status GET：透传平台与数据目录信息', async () => {
  const handler = createStatusHandler({
    getStatus: () => ({
      platform: 'windows',
      platformSelection: 'auto',
      platformSource: 'auto',
      dataDir: 'C:\\Users\\a\\AppData\\Roaming\\zhanlu',
      dataDirCandidates: ['C:\\Users\\a\\AppData\\Roaming\\zhanlu'],
      reachable: true,
      modelCount: 3,
    }),
    refreshCatalog: async () => {},
    readIdentity: async () => ({ userName: 'tester' }),
    probeGateway: async () => ({ ok: true, latencyMs: 5, modelCount: 3 }),
  })
  const res = mockRes()
  await handler(mockReq('GET'), res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.status.platform, 'windows')
  assert.equal(body.status.dataDir, 'C:\\Users\\a\\AppData\\Roaming\\zhanlu')
})

test('quota handler：platform 以 getter 形式传给 token 统计', async () => {
  const seen = []
  const handler = createQuotaHandler({
    dataDir: '/nonexistent-zhanlu',
    platform: () => 'auto',
    getLoginRevision: () => 0,
    readQuota: async () => ({ source: 'unavailable', code: 'credential-unavailable', message: 'x', percent: 0, remaining: 0, total: 0, spent: 0, stale: false, updatedAt: null }),
    readTokenUsage: async (options) => {
      seen.push(options)
      return { usedInput: 0, usedOutput: 0, usedReasoning: 0, usedCacheRead: 0, usedCacheWrite: 0, usedTotal: 0 }
    },
  })
  const req = { method: 'GET', url: '/plugins/dsh-zhanlu-connect/quota', headers: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0].platform, 'function', 'platform 以 getter 传入，运行时可切换')
  assert.equal(seen[0].platform(), 'auto')
})

test('login store：状态包含双登录方式与已保存标记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhanlu-loginroute-'))
  try {
    const store = new LoginStore({ directory: dir, platform: 'windows' })
    assert.deepEqual(store.status().modes.map((m) => m.id), Object.keys(LOGIN_MODES))
    assert.equal(store.status().active, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
