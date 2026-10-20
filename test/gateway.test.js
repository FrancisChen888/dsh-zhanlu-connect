/**
 * 网关客户端单元测试（网络错误归类与探测）。
 *
 * @module dsh-zhanlu-connect/test/gateway
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ZhanluGatewayClient, summarize } from '../src/gateway.js'

test('probe: undici cause 包装的网络失败归类为不可达并给出内网指引', async () => {
  const fetchImpl = () => {
    const error = new TypeError('fetch failed')
    error.cause = { code: 'ENOTFOUND' }
    throw error
  }
  const client = new ZhanluGatewayClient({
    baseURL: 'http://rdcloud.example/aigateway',
    resolveApiKey: async () => 'sk-test',
    probeTimeoutMs: 200,
    retries: 0,
    fetchImpl,
  })
  const probe = await client.probe()
  assert.equal(probe.reachable, false)
  assert.equal(probe.unreachable, true)
  assert.ok(probe.reason.includes('内网服务'), '不可达原因应包含内网指引而不是原始 fetch failed')
})

test('probe: 顶层 code 的网络失败同样归类为不可达', async () => {
  const fetchImpl = () => {
    const error = new Error('connect ECONNREFUSED 1.2.3.4:80')
    error.code = 'ECONNREFUSED'
    throw error
  }
  const client = new ZhanluGatewayClient({
    baseURL: 'http://rdcloud.example/aigateway',
    resolveApiKey: async () => 'sk-test',
    probeTimeoutMs: 200,
    retries: 0,
    fetchImpl,
  })
  const probe = await client.probe()
  assert.equal(probe.reachable, false)
  assert.equal(probe.unreachable, true)
})

test('probe: HTTP 4xx 不算不可达（重试无意义）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) })
  const client = new ZhanluGatewayClient({
    baseURL: 'http://rdcloud.example/aigateway',
    resolveApiKey: async () => 'sk-test',
    probeTimeoutMs: 200,
    retries: 0,
    fetchImpl,
  })
  const probe = await client.probe()
  assert.equal(probe.reachable, false)
  assert.equal(probe.unreachable, false, 'HTTP 失败不标记 unreachable')
  assert.ok(probe.reason.includes('403'))
})

test('listModelIds: 返回网关原始 id（去重由 toModelInfos 负责）', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'zhanlu/a' }, { id: 'zhanlu/b' }, {}, { id: 'zhanlu/a' }] }),
  })
  const client = new ZhanluGatewayClient({
    baseURL: 'http://x/y',
    resolveApiKey: async () => 'sk-test',
    fetchImpl,
  })
  assert.deepEqual(await client.listModelIds(), ['zhanlu/a', 'zhanlu/b', 'zhanlu/a'])
})

test('summarize: 响应体压成一行短摘要', () => {
  assert.equal(summarize(''), '')
  assert.equal(summarize('line1\nline2  x'.repeat(50)).length <= 210, true)
})
