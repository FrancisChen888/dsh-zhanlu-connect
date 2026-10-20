/** 两种登录的唯一凭据选择者。只读App，私有加密快照位于DSH home而非源码目录。 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, chmod, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileSync, lstatSync } from 'node:fs'
import { loadZhanluCredential } from './credential.js'
import { normalizePlatformSelection, resolvePlatform } from './platform.js'

export const LOGIN_MODES = Object.freeze({
  lingji: { label: '灵畿', baseUrl: 'http://rdcloud.4c.hq.cmcc/cmdevops-aiplus-agent-gateway/aigateway' },
  ecloud: { label: '移动云', baseUrl: 'https://ecloud.10086.cn/api/query/aigateway' },
})
export function classifyLogin(metadata) {
  const url = String(metadata?.modelBaseUrl ?? '').replace(/\/+$/, '')
  return Object.keys(LOGIN_MODES).find((mode) => LOGIN_MODES[mode].baseUrl === url)
}
export function credentialIdentity(credential) {
  return createHash('sha256').update(JSON.stringify([credential.apiKey, credential.metadata.modelBaseUrl])).digest('hex')
}
export class LoginError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const missing = () => new LoginError('login-missing', '尚未保存该登录凭据，请先在湛卢 App 登录对应账号，再点击“读取当前登录”')
function encrypt(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }
}
function decrypt(value, key) {
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.body, 'base64')), cipher.final()]).toString('utf8'))
}

export class LoginStore {
  /**
   * @param {object} params
   * @param {string} params.directory 快照目录（DSH home 下，平台无关）
   * @param {string} [params.dataDir] 湛卢数据目录显式覆盖（优先级最高）
   * @param {unknown} [params.platform] 平台选择（auto | mac | windows）；缺省按系统检测
   * @param {(options?: object) => Promise<object>} [params.loadSource] 注入用于测试
   */
  constructor({ directory, dataDir, loadSource = loadZhanluCredential, platform }) {
    this.directory = directory; this.dataDir = dataDir; this.loadSource = loadSource
    this.platformSelection = normalizePlatformSelection(platform)
    this.platform = resolvePlatform(this.platformSelection)
    this.state = { version: 1, active: null, slots: {} }; this.tail = Promise.resolve(); this.loaded = false
    this.revision = 0
  }
  /** 切换平台选择（auto | mac | windows）；只影响 App 数据目录的解析，不动快照。 */
  setPlatform(selection) {
    this.platformSelection = normalizePlatformSelection(selection)
    this.platform = resolvePlatform(this.platformSelection)
    return this.platform
  }
  // 仅为启动期模型校验提供已绑定身份；不创建文件、不解密App原文件。
  // POSIX 权限位检查只在有 POSIX 权限语义的平台上执行：Windows 的 mode 位是
  // 合成值（文件 0o666、目录 0o777），`mode & 0o077` 恒非零——照搬会让 peek()
  // 在 Windows 上永远返回 null，已保存的登录凭据全部失效（v0.3.2 的实际 bug）。
  #posixGuard(info) {
    if (this.platform === 'windows') return true
    return !(info.mode & 0o077)
  }
  peek() {
    try {
      const root = lstatSync(this.directory)
      if (!root.isDirectory() || root.isSymbolicLink() || !this.#posixGuard(root)) return null
      for (const name of ['vault.key', 'logins.json']) {
        const info = lstatSync(join(this.directory, name))
        if (!info.isFile() || info.isSymbolicLink() || !this.#posixGuard(info)) return null
      }
      const state = JSON.parse(readFileSync(join(this.directory, 'logins.json'), 'utf8'))
      if (state.version !== 1 || !Object.hasOwn(LOGIN_MODES, state.active)) return null
      const credential = decrypt(state.slots[state.active], readFileSync(join(this.directory, 'vault.key')))
      if (!credential.apiKey || classifyLogin(credential.metadata) !== state.active) return null
      return { ...credential, mode: state.active }
    } catch { return null }
  }
  serial(fn) {
    const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next
  }
  async regular(path) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new LoginError('vault-unsafe', '登录存储不是普通文件，已停止读取')
    // Windows 没有 POSIX 权限位，chmod 无意义（且在部分 ACL 下报 EPERM），跳过。
    if (this.platform === 'windows') return
    await chmod(path, 0o600)
  }
  async init() {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new LoginError('vault-unsafe', '登录存储目录不安全')
    if (this.platform !== 'windows') await chmod(this.directory, 0o700)
    const keyPath = join(this.directory, 'vault.key')
    try { await this.regular(keyPath); this.key = await readFile(keyPath) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (e) { if (e.code !== 'EEXIST') throw e }
      await this.regular(keyPath); this.key = await readFile(keyPath)
    }
    if (this.key.length !== 32) throw new LoginError('vault-invalid', '登录存储密钥无效，请检查本地存储')
    const path = join(this.directory, 'logins.json')
    try {
      await this.regular(path)
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed.version !== 1 || !parsed.slots || (parsed.active !== null && !LOGIN_MODES[parsed.active])) throw new Error()
      this.state = parsed
    } catch (e) {
      if (e.code !== 'ENOENT') throw new LoginError('vault-invalid', '登录存储损坏，已停止切换，未覆盖旧文件')
    }
    this.loaded = true
  }
  async persist(next) {
    const target = join(this.directory, 'logins.json'), tmp = `${target}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      await rename(tmp, target)
    } finally { await unlink(tmp).catch(() => {}) }
    this.state = next; this.revision++
  }
  decode(mode) {
    const slot = this.state.slots[mode]
    if (!slot) throw missing()
    try {
      const value = decrypt(slot, this.key)
      if (typeof value.apiKey !== 'string' || !value.apiKey || classifyLogin(value.metadata) !== mode) throw new Error()
      return { apiKey: value.apiKey, metadata: { ...value.metadata, modelBaseUrl: LOGIN_MODES[mode].baseUrl }, mode }
    } catch { throw new LoginError('vault-invalid', '该登录凭据无法解密或与网关不匹配，请重新读取对应登录') }
  }
  async captureSource() {
    const credential = await this.loadSource({ dataDir: this.dataDir, platform: this.platformSelection })
    const mode = classifyLogin(credential.metadata)
    if (!mode) throw new LoginError('login-unknown', '当前登录的网关不属于灵畿或移动云，未保存凭据')
    let old = null
    // 仅以刚从App成功解密、且网关已匹配的新凭据修复损坏slot；不猜测旧密文。
    try { old = this.state.slots[mode] ? this.decode(mode) : null } catch { /* 新的有效源允许修复该模式 */ }
    if (!old || credentialIdentity(old) !== credentialIdentity(credential) || JSON.stringify(old.metadata) !== JSON.stringify(credential.metadata)) {
      const next = { ...this.state, active: this.state.active ?? mode, slots: { ...this.state.slots, [mode]: { ...encrypt({ apiKey: credential.apiKey, metadata: credential.metadata }, this.key), savedAt: Date.now() } } }
      await this.persist(next)
    }
    return mode
  }
  async read() {
    return this.serial(async () => {
      await this.init()
      // App切换另一种登录时可留档，但不能覆盖用户明确选择的active。
      try { await this.captureSource() } catch (e) { if (!this.state.active || !this.state.slots[this.state.active]) throw e }
      if (!this.state.active) throw missing()
      return this.decode(this.state.active)
    })
  }
  async capture() {
    return this.serial(async () => { await this.init(); await this.captureSource(); return this.status() })
  }
  async select(mode) {
    return this.serial(async () => {
      if (!Object.hasOwn(LOGIN_MODES, mode)) throw new LoginError('login-invalid', '请选择灵畿或移动云')
      await this.init()
      try { await this.captureSource() } catch { /* 已保存凭据允许离线切换；绝不跨模式兜底 */ }
      const credential = this.decode(mode)
      if (this.state.active !== mode) await this.persist({ ...this.state, active: mode })
      return credential
    })
  }
  status() {
    return { active: this.state.active, modes: Object.entries(LOGIN_MODES).map(([id, info]) => ({ id, ...info, saved: !!this.state.slots[id], savedAt: this.state.slots[id]?.savedAt ?? null })) }
  }
}
