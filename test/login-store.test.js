/**
 * 登录存储单元测试（含 Windows 平台行为）。
 *
 * Windows 的关键差异：mode 位是合成值（文件 0o666、目录 0o777），POSIX
 * 权限检查必须跳过，chmod 无意义——否则已保存的登录凭据在 Windows 上
 * 永远读不出来（v0.3.2 的实际 bug）。
 *
 * @module dsh-zhanlu-connect/test/login-store
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOGIN_MODES, LoginStore } from '../src/login-store.js'

/** 造一个已保存灵畿登录的快照目录（密钥 + logins.json）。 */
async function seedVault(root, { mode = 0o700 } = {}) {
  await mkdir(root, { recursive: true, mode })
  const key = Buffer.from('a'.repeat(32), 'utf8')
  await writeFile(join(root, 'vault.key'), key)
  // logins.json 的 slot 是 AES-256-GCM 密文；这里直接用 store 自己的加密路径
  // 造数据太绕，改用 captureSource + 注入 loadSource 的方式生成。
  return key
}

const ECLOUD_CREDENTIAL = () => ({
  apiKey: 'sk-ecloud-test',
  metadata: { modelBaseUrl: LOGIN_MODES.ecloud.baseUrl, userName: 'ecloud-user' },
})

test('windows 平台：跳过 POSIX 权限检查，0o755 目录的已保存登录仍可读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-vault-win-'))
  await chmod(root, 0o755)
  // 写入一份凭据（走 store 自身加密），然后把目录权限改回宽松值模拟 Windows。
  const writer = new LoginStore({ directory: root, platform: 'windows' })
  writer.loadSource = async () => ECLOUD_CREDENTIAL()
  await writer.capture()
  await chmod(root, 0o755)
  await chmod(join(root, 'vault.key'), 0o644)
  await chmod(join(root, 'logins.json'), 0o644)
  const reopened = new LoginStore({ directory: root, platform: 'windows' })
  const peeked = reopened.peek()
  assert.ok(peeked, 'windows 平台下宽松权限的快照必须仍可识别')
  assert.equal(peeked.apiKey, 'sk-ecloud-test')
  assert.equal(peeked.mode, 'ecloud')
})

test('mac 平台：保持 POSIX 权限检查，宽松权限的快照拒绝读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-vault-mac-'))
  await seedVault(root)
  const store = new LoginStore({ directory: root, platform: 'mac' })
  store.loadSource = async () => ECLOUD_CREDENTIAL()
  await store.capture()
  await chmod(root, 0o755)
  const reopened = new LoginStore({ directory: root, platform: 'mac' })
  assert.equal(reopened.peek(), null)
})

test('mac 平台：init 收紧目录到 0o700；windows 平台不 chmod', async () => {
  const macRoot = await mkdtemp(join(tmpdir(), 'zhanlu-init-mac-'))
  const macStore = new LoginStore({ directory: macRoot, platform: 'mac' })
  await macStore.init()
  const { lstatSync } = await import('node:fs')
  assert.equal(lstatSync(macRoot).mode & 0o777, 0o700)

  const winRoot = await mkdtemp(join(tmpdir(), 'zhanlu-init-win-'))
  await chmod(winRoot, 0o755)
  const winStore = new LoginStore({ directory: winRoot, platform: 'windows' })
  await winStore.init()
  assert.equal(lstatSync(winRoot).mode & 0o777, 0o755, 'windows 平台不应改动目录权限')
})

test('setPlatform: 切换平台选择并重解析布局', () => {
  const root = '/tmp/whatever'
  const store = new LoginStore({ directory: root })
  assert.equal(store.platformSelection, 'auto')
  assert.equal(store.platform, process.platform === 'win32' ? 'windows' : 'mac')
  store.setPlatform('windows')
  assert.equal(store.platformSelection, 'windows')
  assert.equal(store.platform, 'windows')
  store.setPlatform('mac')
  assert.equal(store.platform, 'mac')
  store.setPlatform('nonsense')
  assert.equal(store.platformSelection, 'auto', '非法值回落 auto')
})

test('captureSource 把平台选择传给凭据加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-vault-pass-'))
  const seen = []
  const store = new LoginStore({
    directory: root,
    dataDir: '/fake-data-dir',
    platform: 'windows',
    loadSource: async (options) => {
      seen.push(options)
      return ECLOUD_CREDENTIAL()
    },
  })
  await store.read()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].platform, 'windows')
  assert.equal(seen[0].dataDir, '/fake-data-dir')
})

test('select: 离线切换到已保存登录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-vault-sel-'))
  const store = new LoginStore({ directory: root })
  store.loadSource = async () => ECLOUD_CREDENTIAL()
  await store.capture()
  const credential = await store.select('ecloud')
  assert.equal(credential.apiKey, 'sk-ecloud-test')
  assert.equal(store.status().active, 'ecloud')
})
