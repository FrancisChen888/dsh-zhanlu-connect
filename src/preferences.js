/**
 * 用户偏好存储：模型显隐 + 逐模型上下文窗口覆盖 + 数据目录平台选择。
 *
 * 存储位置在 DSH home 下的 `.zhanlu-preferences.json`，**不写湛卢目录**——
 * 这是插件自己的产物，不该污染 App 数据目录。
 *
 * 设计要点：
 *  - 只存**用户显式改过**的东西：隐藏的模型 id 列表、被覆盖的窗口值、
 *    平台选择。其余一律回落到插件的内置默认（`gateway.js` 的 KNOWN_MODELS），
 *    这样上架新模型时它会自动出现，不需要用户先「放行」。
 *  - `platform`（v0.4.0）：mac/windows 平台选择（auto 按系统检测），
 *    决定湛卢数据目录按哪套布局解析；配置页 UI 可改，见 `./platform.js`。
 *  - 原子写：先写临时文件再 rename，避免 DSH 被强杀时留下半个 JSON。
 *  - 解析失败一律回落到空偏好，而不是让整个插件加载失败。
 *
 * @module dsh-zhanlu-connect/preferences
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePlatformSelection } from './platform.js'

/** 偏好文件格式版本；不认识的一律丢弃而不是猜测。 */
export const PREFERENCES_FORMAT_VERSION = 2

/**
 * 上下文窗口的合法范围。
 *
 * 下限取 4K（比这更小的窗口装不下系统提示词，设了也没意义）；
 * 上限取 2M（当前没有模型的窗口接近这个量级，更大的值多半是误输入）。
 */
export const MIN_CONTEXT_WINDOW = 4096
export const MAX_CONTEXT_WINDOW = 2097152

/**
 * 一份空偏好。
 *
 * @returns {{ version: number, hiddenModels: string[], contextOverrides: Record<string, number>, platform: 'auto' | 'mac' | 'windows' }}
 */
export function emptyPreferences() {
  return { version: PREFERENCES_FORMAT_VERSION, hiddenModels: [], contextOverrides: {}, platform: 'auto' }
}

/**
 * 判断一个值是否是合法的上下文窗口。
 *
 * @param {unknown} value
 * @returns {value is number}
 */
export function isValidContextWindow(value) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_CONTEXT_WINDOW &&
    value <= MAX_CONTEXT_WINDOW
  )
}

/**
 * 把任意输入规整成一份合法偏好。
 *
 * 逐字段校验：坏字段丢弃而不是整份拒绝——用户改坏一个窗口值不该让他的
 * 隐藏列表也一起失效。
 *
 * @param {unknown} raw
 * @returns {{ version: number, hiddenModels: string[], contextOverrides: Record<string, number>, platform: 'auto' | 'mac' | 'windows' }}
 */
export function normalizePreferences(raw) {
  const out = emptyPreferences()
  if (raw === null || typeof raw !== 'object') return out
  const source = /** @type {Record<string, unknown>} */ (raw)

  // 平台选择（auto | mac | windows）：非法值回落 auto，不做整份拒绝——
  // 用户改坏一个字段不该让模型显隐与窗口覆盖一起失效。
  out.platform = normalizePlatformSelection(source.platform)

  if (Array.isArray(source.hiddenModels)) {
    const seen = new Set()
    for (const id of source.hiddenModels) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.hiddenModels.push(id)
    }
  }

  const overrides = source.contextOverrides
  if (overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (overrides))) {
      if (id.length === 0) continue
      if (!isValidContextWindow(value)) continue
      out.contextOverrides[id] = value
    }
  }

  return out
}

/**
 * 偏好存储：读写同一份文件，内存里保留最近一次成功读取的值。
 */
export class PreferenceStore {
  /**
   * @param {string} filePath 偏好文件的绝对路径
   */
  constructor(filePath) {
    this.filePath = filePath
    /** @type {{ version: number, hiddenModels: string[], contextOverrides: Record<string, number>, platform: 'auto' | 'mac' | 'windows' }} */
    this.current = emptyPreferences()
    /** 是否已经从磁盘读过至少一次。 */
    this.loaded = false
  }

  /**
   * 同步载入偏好。
   *
   * **同步**的理由与目录缓存相同：宿主可能在注册后立刻读取模型集合，
   * 而异步载入会让首帧看到「未隐藏」的状态，出现一次可见的闪烁。
   *
   * @returns {{ version: number, hiddenModels: string[], contextOverrides: Record<string, number>, platform: 'auto' | 'mac' | 'windows' }}
   */
  loadSync() {
    try {
      this.current = normalizePreferences(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch {
      // 文件不存在或损坏：用空偏好，不让插件加载失败。
      this.current = emptyPreferences()
    }
    this.loaded = true
    return this.current
  }

  /**
   * 异步载入偏好（首次之外的刷新用）。
   *
   * @returns {Promise<{ version: number, hiddenModels: string[], contextOverrides: Record<string, number>, platform: 'auto' | 'mac' | 'windows' }>}
   */
  async load() {
    try {
      this.current = normalizePreferences(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch {
      this.current = emptyPreferences()
    }
    this.loaded = true
    return this.current
  }

  /**
   * 判断某个模型是否被用户隐藏。
   *
   * @param {string} modelId
   * @returns {boolean}
   */
  isHidden(modelId) {
    return this.current.hiddenModels.includes(modelId)
  }

  /**
   * 取某个模型的上下文窗口覆盖值，没有覆盖时返回 undefined。
   *
   * @param {string} modelId
   * @returns {number | undefined}
   */
  contextOverrideFor(modelId) {
    return this.current.contextOverrides[modelId]
  }

  /**
   * 写入一份新偏好。
   *
   * 先规整再落盘：调用方传来的原始对象可能含非法字段（例如非整数的窗口），
   * 规整后写盘保证磁盘上永远是合法数据。
   *
   * @param {unknown} next
   * @returns {Promise<{ version: number, hiddenModels: string[], contextOverrides: Record<string, number>, platform: 'auto' | 'mac' | 'windows' }>}
   */
  async save(next) {
    const normalized = normalizePreferences(next)
    this.current = normalized
    const tmp = `${this.filePath}.${process.pid}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    } catch (error) {
      // 写盘失败：内存里已经改了，但磁盘没落。把错误抛给调用方，
      // 由端点在响应里报告失败，而不是假装保存成功。
      throw error
    }
    return normalized
  }
}

/**
 * 把偏好套用到模型描述上，产出「最终对外可见」的模型列表。
 *
 * 两道处理：
 *  1. 被隐藏的模型**从结果里剔除**——DSH 的宿主会过滤掉没有模型的
 *     provider 分组，因此剔除等价于「在选择器里消失」。
 *  2. 被覆盖的模型使用用户设的上下文窗口；其余用内置默认。
 *
 * @param {Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>} models
 * @param {{ hiddenModels: string[], contextOverrides: Record<string, number> }} preferences
 * @returns {Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>}
 */
export function applyPreferences(models, preferences) {
  const hidden = new Set(preferences.hiddenModels ?? [])
  const overrides = preferences.contextOverrides ?? {}
  const out = []
  for (const model of models) {
    if (hidden.has(model.id)) continue
    const override = overrides[model.id]
    out.push(
      isValidContextWindow(override) && override !== model.contextWindow
        ? { ...model, contextWindow: override }
        : model,
    )
  }
  return out
}
