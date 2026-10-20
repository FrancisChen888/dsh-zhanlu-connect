/**
 * 湛卢数据目录的平台解析（Windows 适配）。
 *
 * 湛卢 App 在 macOS/Linux 上按 XDG 约定把数据写在 `~/.local/share/zhanlu/`
 * （尊重 `XDG_DATA_HOME`）。Windows 上没有 XDG 约定，App 的落盘位置存在
 * 几种可能（Roaming / Local / 用户目录下的 XDG 字面布局），且无法在开发期
 * 逐台核实——因此这里采用「候选目录按序探测」策略：
 *
 *   - 每个平台给出候选列表（按优先级排序）；
 *   - 解析时取第一个真的存在 `auth_zhanlu.json` 的候选；
 *   - 都不存在时回落到首选候选（保持旧版「直接拼路径」的行为与错误提示）。
 *
 * 平台选择（mac / windows）：
 *   - `auto`（默认）：按 `process.platform` 检测——win32 → windows，
 *     其余（darwin/linux）→ mac 的 XDG 布局。
 *   - 显式选择 `mac` / `windows`：固定按该平台的候选列表解析，
 *     供跨机排障（例如在 A 平台核对 B 平台的目录布局）使用。
 *
 * 全部函数都是纯逻辑（只依赖 node:os / node:path / node:fs），可被
 * `node --test` 直接加载。
 *
 * @module dsh-zhanlu-connect/platform
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/** 本插件支持的平台选择值。 */
export const PLATFORM_OPTIONS = Object.freeze(['auto', 'mac', 'windows'])

/** 平台选择的默认值：按当前系统检测。 */
export const DEFAULT_PLATFORM = 'auto'

/**
 * 判断一个值是否是合法的平台选择。
 *
 * @param {unknown} value
 * @returns {value is 'auto' | 'mac' | 'windows'}
 */
export function isValidPlatformSelection(value) {
  return typeof value === 'string' && PLATFORM_OPTIONS.includes(value)
}

/**
 * 把任意输入规整成合法的平台选择；非法值一律回落（而不是整份拒绝）。
 *
 * @param {unknown} value
 * @param {'auto' | 'mac' | 'windows'} [fallback]
 * @returns {'auto' | 'mac' | 'windows'}
 */
export function normalizePlatformSelection(value, fallback = DEFAULT_PLATFORM) {
  return isValidPlatformSelection(value) ? value : fallback
}

/**
 * 按当前系统检测平台布局。
 *
 * `win32` → windows；其余（darwin/linux）→ mac 的 XDG 布局——
 * 湛卢在 macOS/Linux 上走同一套 XDG 约定，插件沿用旧版行为。
 *
 * @param {string} [processPlatform] 注入用于测试（默认 process.platform）
 * @returns {'mac' | 'windows'}
 */
export function detectPlatform(processPlatform = process.platform) {
  return processPlatform === 'win32' ? 'windows' : 'mac'
}

/**
 * 把平台选择解析成具体平台布局：`auto` 按系统检测，显式值原样通过。
 *
 * @param {unknown} [selection] 平台选择（auto | mac | windows）
 * @param {string} [processPlatform] 注入用于测试
 * @returns {'mac' | 'windows'}
 */
export function resolvePlatform(selection = DEFAULT_PLATFORM, processPlatform = process.platform) {
  const normalized = normalizePlatformSelection(selection)
  return normalized === 'auto' ? detectPlatform(processPlatform) : normalized
}

/**
 * 给出某个平台布局下的湛卢数据目录候选列表（按优先级排序，已去重）。
 *
 * - mac（XDG 布局，覆盖 darwin/linux）：`XDG_DATA_HOME/zhanlu` 优先，
 *   回落 `~/.local/share/zhanlu`——与旧版行为一致（XDG 设置时首选它）。
 * - windows：`XDG_DATA_HOME`（若显式设置，湛卢在 Windows 上也可能跟随 XDG）、
 *   `%APPDATA%\zhanlu`（Roaming，VS Code 分支的常规数据位置）、
 *   `%LOCALAPPDATA%\zhanlu`（Local）、由 `USERPROFILE` 推导的 Roaming、
 *   用户目录下的 XDG 字面布局。
 *
 * @param {unknown} platform 平台选择（auto | mac | windows）或具体布局
 * @param {NodeJS.ProcessEnv} [env] 注入用于测试（默认 process.env）
 * @returns {string[]}
 */
export function zhanluDataDirCandidates(platform, env = process.env) {
  const resolved = resolvePlatform(platform)
  const trim = (value) => (typeof value === 'string' ? value.trim() : '')
  const out = []
  const seen = new Set()
  const push = (base) => {
    const clean = trim(base)
    if (clean.length === 0) return
    const candidate = join(clean, 'zhanlu')
    // 去重键做分隔符与大小写归一：Windows 路径大小写不敏感，且不同来源的
    // 环境变量可能混用正反斜杠（APPDATA 与由 USERPROFILE 推导的 Roaming
    // 常常是同一路径）——等价候选必须合并成一个，探测才不会重复。
    const key = candidate.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }
  if (resolved === 'windows') {
    push(env.XDG_DATA_HOME)
    push(env.APPDATA)
    push(env.LOCALAPPDATA)
    const profile = trim(env.USERPROFILE)
    if (profile.length > 0) {
      push(join(profile, 'AppData', 'Roaming'))
      push(join(profile, '.local', 'share'))
    }
    // 环境变量全部缺失（例如显式选择了 windows 但 env 被清空）时的兜底推导。
    if (out.length === 0) push(join(homedir(), 'AppData', 'Roaming'))
    return out
  }
  // mac / linux：XDG 布局；显式 XDG 优先，同时保留默认位置作为探测候选。
  const xdg = trim(env.XDG_DATA_HOME)
  if (xdg.length > 0) push(xdg)
  push(join(homedir(), '.local', 'share'))
  return out
}

/**
 * 按候选列表解析湛卢数据目录：取第一个存在 `auth_zhanlu.json` 的候选；
 * 都不存在时回落到首选候选（错误提示仍指向该路径）。
 *
 * @param {object} [options]
 * @param {unknown} [options.platform] 平台选择（auto | mac | windows）
 * @param {NodeJS.ProcessEnv} [options.env] 注入用于测试
 * @param {(candidate: string) => boolean} [options.exists] 存在性探测（默认 existsSync）
 * @returns {{ platform: 'mac' | 'windows', dataDir: string, candidates: string[] }}
 */
export function pickZhanluDataDir(options = {}) {
  const exists = typeof options.exists === 'function' ? options.exists : existsSync
  const platform = resolvePlatform(options.platform)
  const candidates = zhanluDataDirCandidates(platform, options.env)
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return { platform, dataDir: candidate, candidates }
    } catch {
      // 单个候选探测失败按不存在处理，继续下一个。
    }
  }
  return { platform, dataDir: candidates[0], candidates }
}
