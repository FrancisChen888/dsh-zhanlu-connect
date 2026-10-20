/**
 * 凭据读取与解密单元测试（含 Windows 平台候选解析）。
 *
 * 全部在临时目录里造密文，不触碰真实湛卢数据。
 *
 * @module dsh-zhanlu-connect/test/credential
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTH_FILENAME,
  MASTER_KEY_FILENAME,
  ZhanluCredentialError,
  loadZhanluCredential,
  zhanluDataDir,
} from '../src/credential.js'

const GATEWAY = 'https://ecloud.10086.cn/api/query/aigateway'

/** 在目录里造一份 `zhanlu-auth-v1` 形态的凭据；明文用假密钥。 */
async function seedZhanluDir(dir, { login = true } = {}) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update('sk-test-12345', 'utf8'), cipher.final()])
  await writeFile(join(dir, MASTER_KEY_FILENAME), key)
  await writeFile(join(dir, AUTH_FILENAME), JSON.stringify({
    login,
    key: ciphertext.toString('base64'),
    metadata: {
      modelBaseUrl: GATEWAY,
      userName: 'tester',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      cipherVersion: 'zhanlu-auth-v1',
    },
  }))
}

test('zhanluDataDir: mac 布局尊重 XDG_DATA_HOME', () => {
  assert.equal(zhanluDataDir({ XDG_DATA_HOME: '/tmp/xdg' }, 'mac'), join('/tmp/xdg', 'zhanlu'))
  assert.equal(zhanluDataDir({}, 'mac'), join(homedir(), '.local', 'share', 'zhanlu'))
})

test('zhanluDataDir: windows 布局首选 APPDATA', () => {
  const dir = zhanluDataDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'windows')
  assert.equal(dir, join('C:\\Users\\a\\AppData\\Roaming', 'zhanlu'))
})

test('zhanluDataDir: 缺省平台按系统检测', () => {
  const dir = zhanluDataDir({ XDG_DATA_HOME: '/tmp/xdg' })
  const expected = process.platform === 'win32' ? join('/tmp/xdg', 'zhanlu') : join('/tmp/xdg', 'zhanlu')
  assert.equal(dir, expected)
})

test('loadZhanluCredential: 显式 dataDir 优先级最高', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-cred-'))
  const dir = join(root, 'data')
  await mkdir(dir, { recursive: true })
  await seedZhanluDir(dir)
  const credential = await loadZhanluCredential({ dataDir: dir })
  assert.equal(credential.apiKey, 'sk-test-12345')
  assert.equal(credential.metadata.modelBaseUrl, GATEWAY)
  assert.equal(credential.dataDir, dir)
})

test('loadZhanluCredential: windows 平台从 APPDATA 候选解析', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-win-'))
  const appdata = join(root, 'AppData', 'Roaming')
  await mkdir(join(appdata, 'zhanlu'), { recursive: true })
  await seedZhanluDir(join(appdata, 'zhanlu'))
  const credential = await loadZhanluCredential({
    platform: 'windows',
    env: { APPDATA: appdata, LOCALAPPDATA: join(root, 'AppData', 'Local'), USERPROFILE: root },
  })
  assert.equal(credential.apiKey, 'sk-test-12345')
  assert.equal(credential.dataDir, join(appdata, 'zhanlu'))
})

test('loadZhanluCredential: mac 平台从 XDG 候选解析', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-mac-'))
  const xdg = join(root, 'xdg')
  await mkdir(join(xdg, 'zhanlu'), { recursive: true })
  await seedZhanluDir(join(xdg, 'zhanlu'))
  const credential = await loadZhanluCredential({ platform: 'mac', env: { XDG_DATA_HOME: xdg } })
  assert.equal(credential.apiKey, 'sk-test-12345')
  assert.equal(credential.dataDir, join(xdg, 'zhanlu'))
})

test('loadZhanluCredential: 无任何候选存在时回落首选并报 no-auth-file', async () => {
  await assert.rejects(
    () => loadZhanluCredential({ platform: 'windows', env: { APPDATA: '/nonexistent-appdata' } }),
    (error) => error instanceof ZhanluCredentialError && error.code === 'no-auth-file',
  )
})

test('loadZhanluCredential: login=false 报 signed-out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhanlu-out-'))
  await seedZhanluDir(root, { login: false })
  await assert.rejects(
    () => loadZhanluCredential({ dataDir: root }),
    (error) => error instanceof ZhanluCredentialError && error.code === 'signed-out',
  )
})
