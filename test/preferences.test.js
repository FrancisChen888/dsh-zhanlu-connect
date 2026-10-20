/**
 * 偏好存储单元测试（含平台选择字段）。
 *
 * @module dsh-zhanlu-connect/test/preferences
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PreferenceStore,
  applyPreferences,
  emptyPreferences,
  normalizePreferences,
} from '../src/preferences.js'

test('emptyPreferences 带平台字段且默认 auto', () => {
  const empty = emptyPreferences()
  assert.equal(empty.platform, 'auto')
  assert.deepEqual(empty.hiddenModels, [])
  assert.deepEqual(empty.contextOverrides, {})
})

test('normalizePreferences: 合法平台保留，非法值回落 auto', () => {
  assert.equal(normalizePreferences({ platform: 'windows' }).platform, 'windows')
  assert.equal(normalizePreferences({ platform: 'mac' }).platform, 'mac')
  assert.equal(normalizePreferences({ platform: 'auto' }).platform, 'auto')
  assert.equal(normalizePreferences({ platform: 'linux' }).platform, 'auto')
  assert.equal(normalizePreferences({}).platform, 'auto', '旧格式偏好（无 platform 字段）回落 auto')
  assert.equal(normalizePreferences(null).platform, 'auto')
  assert.equal(normalizePreferences(42).platform, 'auto')
})

test('normalizePreferences: 平台字段的坏值不影响模型显隐与窗口覆盖', () => {
  const normalized = normalizePreferences({
    platform: 'nonsense',
    hiddenModels: ['zhanlu/auto'],
    contextOverrides: { 'zhanlu/glm-5.3': 131072 },
  })
  assert.equal(normalized.platform, 'auto')
  assert.deepEqual(normalized.hiddenModels, ['zhanlu/auto'])
  assert.deepEqual(normalized.contextOverrides, { 'zhanlu/glm-5.3': 131072 })
})

test('PreferenceStore: platform 字段保存/读取往返', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhanlu-pref-'))
  const filePath = join(dir, '.zhanlu-preferences.json')
  try {
    const store = new PreferenceStore(filePath)
    store.loadSync()
    const saved = await store.save({ hiddenModels: [], contextOverrides: {}, platform: 'windows' })
    assert.equal(saved.platform, 'windows')
    const reopened = new PreferenceStore(filePath)
    const loaded = reopened.loadSync()
    assert.equal(loaded.platform, 'windows')
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(raw.platform, 'windows')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PreferenceStore: 损坏文件回落空偏好（含平台 auto）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhanlu-pref-bad-'))
  const filePath = join(dir, '.zhanlu-preferences.json')
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, '{ not json')
    const store = new PreferenceStore(filePath)
    const loaded = store.loadSync()
    assert.equal(loaded.platform, 'auto')
    assert.deepEqual(loaded.hiddenModels, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('applyPreferences: 平台字段不参与模型过滤', () => {
  const models = [
    { id: 'zhanlu/auto', name: 'Auto', contextWindow: 524288, maxTokens: 32768, reasoning: false, input: ['text'] },
    { id: 'zhanlu/glm-5.3', name: 'GLM-5.3', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text'] },
  ]
  const visible = applyPreferences(models, { hiddenModels: [], contextOverrides: {}, platform: 'windows' })
  assert.equal(visible.length, 2)
  const hidden = applyPreferences(models, { hiddenModels: ['zhanlu/auto'], contextOverrides: {}, platform: 'mac' })
  assert.equal(hidden.length, 1)
  assert.equal(hidden[0].id, 'zhanlu/glm-5.3')
})
