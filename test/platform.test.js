/**
 * 平台解析单元测试（Windows 适配）。
 *
 * 全部用注入的 env / processPlatform，不依赖宿主系统。
 *
 * @module dsh-zhanlu-connect/test/platform
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  PLATFORM_OPTIONS,
  detectPlatform,
  isValidPlatformSelection,
  normalizePlatformSelection,
  pickZhanluDataDir,
  resolvePlatform,
  zhanluDataDirCandidates,
} from '../src/platform.js'

test('detectPlatform: win32 → windows，darwin/linux → mac（XDG 布局）', () => {
  assert.equal(detectPlatform('win32'), 'windows')
  assert.equal(detectPlatform('darwin'), 'mac')
  assert.equal(detectPlatform('linux'), 'mac')
})

test('resolvePlatform: auto 按系统检测，显式选择原样通过', () => {
  assert.equal(resolvePlatform('auto', 'win32'), 'windows')
  assert.equal(resolvePlatform('auto', 'darwin'), 'mac')
  assert.equal(resolvePlatform(undefined, 'win32'), 'windows')
  assert.equal(resolvePlatform('windows', 'darwin'), 'windows')
  assert.equal(resolvePlatform('mac', 'win32'), 'mac')
})

test('normalizePlatformSelection: 非法值一律回落，不做整份拒绝', () => {
  assert.equal(normalizePlatformSelection('mac'), 'mac')
  assert.equal(normalizePlatformSelection('windows'), 'windows')
  assert.equal(normalizePlatformSelection('auto'), 'auto')
  assert.equal(normalizePlatformSelection('linux'), 'auto')
  assert.equal(normalizePlatformSelection(undefined), 'auto')
  assert.equal(normalizePlatformSelection(42), 'auto')
  assert.equal(normalizePlatformSelection(null), 'auto')
  assert.equal(normalizePlatformSelection('nonsense', 'mac'), 'mac')
})

test('isValidPlatformSelection 与 PLATFORM_OPTIONS 一致', () => {
  for (const value of PLATFORM_OPTIONS) assert.equal(isValidPlatformSelection(value), true)
  assert.equal(isValidPlatformSelection('linux'), false)
})

test('mac 布局候选：XDG 优先，回落 ~/.local/share', () => {
  const withXdg = zhanluDataDirCandidates('mac', { XDG_DATA_HOME: '/tmp/custom-xdg' })
  assert.deepEqual(withXdg, [join('/tmp/custom-xdg', 'zhanlu'), join(homedir(), '.local', 'share', 'zhanlu')])
  const withoutXdg = zhanluDataDirCandidates('mac', {})
  assert.deepEqual(withoutXdg, [join(homedir(), '.local', 'share', 'zhanlu')])
})

test('windows 候选：显式 XDG 最优先，其次 APPDATA / LOCALAPPDATA / 推导路径，已去重', () => {
  const candidates = zhanluDataDirCandidates('windows', {
    APPDATA: 'C:\\Users\\a\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\a',
  })
  // 分隔符归一后比较：join 在 POSIX 宿主上会混用斜杠，语义等价即可。
  const norm = (value) => value.replace(/\\/g, '/')
  // APPDATA 与由 USERPROFILE 推导的 Roaming 相同 → 去重。
  assert.deepEqual(candidates.map(norm), [
    norm(join('C:\\Users\\a\\AppData\\Roaming', 'zhanlu')),
    norm(join('C:\\Users\\a\\AppData\\Local', 'zhanlu')),
    norm(join('C:\\Users\\a', '.local', 'share', 'zhanlu')),
  ])
})

test('windows 候选：XDG_DATA_HOME 显式设置时排在 APPDATA 之前', () => {
  const candidates = zhanluDataDirCandidates('windows', {
    XDG_DATA_HOME: 'D:\\xdg-data',
    APPDATA: 'C:\\Users\\a\\AppData\\Roaming',
  })
  assert.equal(candidates[0], join('D:\\xdg-data', 'zhanlu'))
  assert.equal(candidates[1], join('C:\\Users\\a\\AppData\\Roaming', 'zhanlu'))
})

test('windows 候选：环境变量全部缺失时仍有兜底推导', () => {
  const candidates = zhanluDataDirCandidates('windows', {})
  assert.ok(candidates.length >= 1)
  assert.equal(candidates[0], join(homedir(), 'AppData', 'Roaming', 'zhanlu'))
})

test('pickZhanluDataDir: 取第一个存在凭据的候选；都不存在回落首选', () => {
  const env = { APPDATA: 'C:\\r', LOCALAPPDATA: 'C:\\l', USERPROFILE: 'C:\\u' }
  const seeded = new Set([join('C:\\l', 'zhanlu')])
  const picked = pickZhanluDataDir({ platform: 'windows', env, exists: (dir) => seeded.has(dir) })
  assert.equal(picked.platform, 'windows')
  assert.equal(picked.dataDir, join('C:\\l', 'zhanlu'))
  assert.ok(picked.candidates.includes(join('C:\\l', 'zhanlu')))

  const fallback = pickZhanluDataDir({ platform: 'windows', env, exists: () => false })
  assert.equal(fallback.dataDir, join('C:\\r', 'zhanlu'))
})

test('pickZhanluDataDir: auto 按注入的系统检测解析', () => {
  const picked = pickZhanluDataDir({ platform: 'auto', env: { XDG_DATA_HOME: '/x' }, exists: () => true, })
  assert.equal(picked.platform, 'mac')
  assert.equal(picked.dataDir, join('/x', 'zhanlu'))
  const onWindows = pickZhanluDataDir({ platform: undefined, env: { APPDATA: 'C:\\r' }, exists: () => true })
  // 本机是 macOS：auto 解析为 mac 布局，不读 APPDATA。
  assert.equal(process.platform === 'win32' ? 'windows' : 'mac', onWindows.platform)
})

test('pickZhanluDataDir: 单个候选探测抛错按不存在处理', () => {
  const env = { APPDATA: 'C:\\r', LOCALAPPDATA: 'C:\\l' }
  let calls = 0
  const picked = pickZhanluDataDir({
    platform: 'windows',
    env,
    exists: (dir) => {
      calls += 1
      if (dir === join('C:\\r', 'zhanlu')) throw new Error('EACCES')
      return dir === join('C:\\l', 'zhanlu')
    },
  })
  assert.equal(calls >= 2, true)
  assert.equal(picked.dataDir, join('C:\\l', 'zhanlu'))
})
