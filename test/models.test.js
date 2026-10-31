import test from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_MODELS, describeModel } from '../src/gateway.js'
import { CATALOG_FORMAT_VERSION, parseCatalog, toModelInfos } from '../src/models.js'
import { applyPreferences, normalizePreferences } from '../src/preferences.js'

test('内置目录与网关动态新模型统一使用 1M，保留原输出上限', () => {
  const models = toModelInfos([...Object.keys(KNOWN_MODELS), 'zhanlu/new-model'])
  assert.equal(models.length, Object.keys(KNOWN_MODELS).length + 1)
  for (const model of models) {
    assert.equal(model.contextWindow, 1048576, model.id)
    assert.equal(model.maxTokens, model.id.startsWith('zhanlu/deepseek-') ? 65536 : 32768, model.id)
  }
})

test('旧目录缓存启动时立即采用 1M，保留缓存目录与输出上限', () => {
  const cached = ['zhanlu/deepseek-v4-pro', 'zhanlu/new-model'].map((id) => ({
    ...describeModel(id),
    contextWindow: 524288,
  }))
  const models = parseCatalog(JSON.stringify({ version: CATALOG_FORMAT_VERSION, models: cached }))
  assert.deepEqual(models.map((model) => model.id), cached.map((model) => model.id))
  assert.deepEqual(models.map((model) => model.contextWindow), [1048576, 1048576])
  assert.deepEqual(models.map((model) => model.maxTokens), [65536, 32768])

  const preferences = normalizePreferences({
    hiddenModels: ['zhanlu/new-model'],
    contextOverrides: { 'zhanlu/deepseek-v4-pro': 262144 },
  })
  const visible = applyPreferences(models, preferences)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].contextWindow, 262144, '用户显式覆盖继续优先')
  assert.equal(applyPreferences(models, { hiddenModels: [], contextOverrides: {} })[0].contextWindow, 1048576,
    '恢复默认后使用 1M')
})

test('损坏或未知格式的目录缓存保持降级行为', () => {
  for (const raw of ['{broken', 'null', '{}', '{"version":2,"models":[]}', '{"version":1,"models":{}}']) {
    assert.deepEqual(parseCatalog(raw), [])
  }
})
