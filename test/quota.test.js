/**
 * 额度与模型目录纯逻辑单元测试。
 *
 * @module dsh-zhanlu-connect/test/quota
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { budgetPercent, parseBudget, readQuota, readTokenUsage } from '../src/quota.js'
import { describeModel, humanizeModelId, normalizeBaseURL } from '../src/gateway.js'
import { toModelInfos } from '../src/models.js'

test('budgetPercent: 边界对齐 App', () => {
  assert.equal(budgetPercent(0, 0), 0)
  assert.equal(budgetPercent(100, 0), 0)
  assert.equal(budgetPercent(100, 100), 100)
  assert.equal(budgetPercent(100, 50), 50)
  assert.equal(budgetPercent(3, 1), 33)
})

test('parseBudget: 网关预算投影', () => {
  const ok = parseBudget({ code: 200, data: { max_budget: 100, spend: 40, remaining_budget: 60 } })
  assert.equal(ok?.total, 100)
  assert.equal(ok?.remaining, 60)
  assert.equal(ok?.percent, 60)
  assert.equal(parseBudget({ code: 401 }), undefined)
  assert.equal(parseBudget({ code: 200, data: { max_budget: 10, spend: 20, remaining_budget: -1 } }), undefined)
})

test('readQuota: disableNetwork 直接短路', async () => {
  const result = await readQuota({ disableNetwork: true })
  assert.equal(result.source, 'unavailable')
  assert.equal(result.code, 'network-disabled')
})

test('readTokenUsage: 平台参数可传入，db 缺失时给出明确 message', async () => {
  const result = await readTokenUsage({ platform: 'windows', dataDir: '/nonexistent-zhanlu' })
  assert.equal(result.usedTotal, 0)
  assert.ok(result.message, '读不到 db 时应有明确 message')
})

test('readTokenUsage: 平台 getter 形式（运行时可切换）', async () => {
  const result = await readTokenUsage({ platform: () => 'mac', dataDir: '/nonexistent-zhanlu' })
  assert.equal(result.usedTotal, 0)
})

test('gateway: normalizeBaseURL 去尾斜杠', () => {
  assert.equal(normalizeBaseURL('http://x/y/'), 'http://x/y')
  assert.equal(normalizeBaseURL('http://x/y//'), 'http://x/y')
})

test('gateway: describeModel 保持 zhanlu/ 前缀与 512K 预设', () => {
  const known = describeModel('zhanlu/glm-5.3')
  assert.equal(known.id, 'zhanlu/glm-5.3')
  assert.equal(known.contextWindow, 524288)
  assert.equal(known.reasoning, true)
  const unknown = describeModel('zhanlu/brand-new-model')
  assert.equal(unknown.contextWindow, 524288)
  assert.equal(unknown.input[0], 'text')
})

test('gateway: humanizeModelId 不按点号切分版本号', () => {
  assert.equal(humanizeModelId('zhanlu/qwen3.6-plus'), 'Qwen3.6 Plus')
  assert.equal(humanizeModelId('zhanlu/glm-5.3'), 'Glm 5.3')
  assert.equal(humanizeModelId('kimi-k3'), 'Kimi K3')
})

test('models: toModelInfos 只保留带前缀的条目并按 id 排序', () => {
  const infos = toModelInfos(['zhanlu/b', 'other/x', 'zhanlu/', 'zhanlu/a', 'zhanlu/b'])
  assert.deepEqual(infos.map((m) => m.id), ['zhanlu/a', 'zhanlu/b'])
})
