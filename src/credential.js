/**
 * 湛卢（Zhanlu）凭据读取与解密。
 *
 * 湛卢把网关凭据以 AES-256-GCM 密文写在数据目录的
 * `auth_zhanlu.json`，主密钥是同目录的
 * `.zhanlu-auth.key`（32 字节原始密钥，权限 600）。
 *
 * 数据目录按平台解析（见 `./platform.js`）：macOS/Linux 走 XDG 布局，
 * Windows 依次探测 `%APPDATA%` / `%LOCALAPPDATA%` 等候选；可用
 * `platform` 选择显式指定 mac/windows，用 `dataDir` 直接指定目录。
 *
 * 密文写法（对齐湛卢 `zl` 内 `Dm6` 实现）：
 *   - algorithm  : aes-256-gcm
 *   - key        : .zhanlu-auth.key 的 32 字节原始内容（不做 KDF、不派生）
 *   - iv         : metadata.iv，base64，12 字节
 *   - authTag    : metadata.tag，base64，16 字节
 *   - AAD        : 无
 *   - ciphertext : 顶层 key 字段，base64
 *   - 版本标记   : metadata.cipherVersion === 'zhanlu-auth-v1'
 *
 * 关键点：ciphertext 与 authTag 必须分开传入，把 tag 拼进密文会导致
 * `unable to authenticate data`。这一点在探测阶段踩过坑，勿改回。
 *
 * @module dsh-zhanlu-connect/credential
 */

import { createDecipheriv } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_PLATFORM, resolvePlatform, zhanluDataDirCandidates } from './platform.js'

/** 本模块认识的密文版本；其他版本一律拒绝而不是猜测。 */
export const CIPHER_VERSION = 'zhanlu-auth-v1'

/** 主密钥长度（AES-256）。 */
const MASTER_KEY_BYTES = 32

/** GCM 规范 IV 长度。 */
const GCM_IV_BYTES = 12

/** GCM 认证标签长度。 */
const GCM_TAG_BYTES = 16

/** 记录湛卢凭据的文件名。 */
export const AUTH_FILENAME = 'auth_zhanlu.json'

/** 记录主密钥的文件名。 */
export const MASTER_KEY_FILENAME = '.zhanlu-auth.key'

/**
 * 湛卢数据目录（首选候选）。
 *
 * 按平台候选列表解析（见 {@link zhanluDataDirCandidates}）：macOS/Linux 走
 * XDG 布局并尊重 `XDG_DATA_HOME`；Windows 依次候选 `%APPDATA%` 等位置。
 * 这里返回**首选候选**（不探测存在性）——只展示路径、不读凭据的场景用它；
 * 真正读取凭据时走 {@link loadZhanluCredential} 的按序探测。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {unknown} [platform] 平台选择（auto | mac | windows）；缺省按系统检测
 * @returns {string}
 */
export function zhanluDataDir(env = process.env, platform = DEFAULT_PLATFORM) {
  return zhanluDataDirCandidates(resolvePlatform(platform), env)[0]
}

/**
 * 按候选列表解析出实际可用的数据目录。
 *
 * `dataDir` 显式指定时原样使用（测试与手工排障用）；否则按平台候选列表
 * 探测：取第一个存在 `auth_zhanlu.json` 的候选，都不存在时回落首选候选，
 * 让错误提示指向最可能的位置而不是含糊的「没找到」。
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] 覆盖数据目录（优先级最高）
 * @param {unknown} [options.platform] 平台选择（auto | mac | windows）
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<string>}
 */
async function resolveAuthDataDir(options = {}) {
  if (options.dataDir !== undefined && options.dataDir.length > 0) return options.dataDir
  const env = options.env ?? process.env
  const platform = resolvePlatform(options.platform)
  const candidates = zhanluDataDirCandidates(platform, env)
  for (const candidate of candidates) {
    try {
      await access(join(candidate, AUTH_FILENAME))
      return candidate
    } catch {
      // 该候选没有凭据文件，继续下一个；都不存在时回落首选。
    }
  }
  return candidates[0]
}

/**
 * 凭据不可用的原因，用封闭枚举表达。
 *
 * 界面与日志按 code 分支，不去匹配 message 文案——文案会改，code 不会。
 *
 * @typedef {'no-auth-file'
 *   | 'no-master-key'
 *   | 'master-key-bad-length'
 *   | 'malformed-auth-file'
 *   | 'not-encrypted'
 *   | 'unsupported-cipher-version'
 *   | 'decrypt-failed'
 *   | 'signed-out'} ZhanluCredentialFailureCode
 */

/** 读取凭据失败时抛出的错误，带稳定 code 与可读原因。 */
export class ZhanluCredentialError extends Error {
  /**
   * @param {ZhanluCredentialFailureCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ZhanluCredentialError'
    this.code = code
  }
}

/**
 * 判断一个解析后的凭据对象是否是加密形态。
 *
 * 与湛卢 `reA()` 的判据一致：cipherVersion 必须恰好等于本版本，
 * 且 iv/tag 都是非空字符串。
 *
 * @param {unknown} metadata
 * @returns {boolean}
 */
export function isEncryptedCredential(metadata) {
  if (metadata === null || typeof metadata !== 'object') return false
  const m = /** @type {Record<string, unknown>} */ (metadata)
  return (
    m.cipherVersion === CIPHER_VERSION &&
    typeof m.iv === 'string' &&
    m.iv.length > 0 &&
    typeof m.tag === 'string' &&
    m.tag.length > 0
  )
}

/**
 * 用主密钥解开一段 `zhanlu-auth-v1` 密文。
 *
 * @param {object} params
 * @param {Buffer} params.masterKey 32 字节原始密钥
 * @param {string} params.ciphertextBase64 顶层 key 字段
 * @param {string} params.ivBase64 metadata.iv
 * @param {string} params.tagBase64 metadata.tag
 * @returns {string} 明文
 */
export function decryptCredential({ masterKey, ciphertextBase64, ivBase64, tagBase64 }) {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new ZhanluCredentialError(
      'master-key-bad-length',
      `${MASTER_KEY_FILENAME} must be ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`,
    )
  }
  const iv = Buffer.from(ivBase64, 'base64')
  const tag = Buffer.from(tagBase64, 'base64')
  if (iv.length !== GCM_IV_BYTES) {
    throw new ZhanluCredentialError('decrypt-failed', `iv must be ${GCM_IV_BYTES} bytes, got ${iv.length}`)
  }
  if (tag.length !== GCM_TAG_BYTES) {
    throw new ZhanluCredentialError('decrypt-failed', `auth tag must be ${GCM_TAG_BYTES} bytes, got ${tag.length}`)
  }
  let plain
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertextBase64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    // 把底层 OpenSSL 文案统一成稳定 code，调用方只认 code。
    throw new ZhanluCredentialError(
      'decrypt-failed',
      `无法解密湛卢凭据（主密钥与密文不匹配或密文已损坏）: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (plain.trim().length === 0) {
    throw new ZhanluCredentialError('signed-out', '解密结果为空，湛卢凭据无效')
  }
  return plain
}

/**
 * 读取并解密湛卢网关凭据。
 *
 * 只读，不改动湛卢任何文件。失败一律抛 {@link ZhanluCredentialError}，
 * 调用方据 code 决定降级行为。
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] 覆盖数据目录（测试用；优先级最高）
 * @param {unknown} [options.platform] 平台选择（auto | mac | windows）；缺省按系统检测
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{ apiKey: string, metadata: Record<string, unknown>, dataDir: string, authPath: string }>}
 */
export async function loadZhanluCredential(options = {}) {
  const dataDir = await resolveAuthDataDir(options)
  const authPath = join(dataDir, AUTH_FILENAME)
  const keyPath = join(dataDir, MASTER_KEY_FILENAME)

  let raw
  try {
    raw = await readFile(authPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new ZhanluCredentialError('no-auth-file', `未找到湛卢凭据文件：${authPath}`)
    }
    throw new ZhanluCredentialError(
      'malformed-auth-file',
      `读取湛卢凭据失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ZhanluCredentialError(
      'malformed-auth-file',
      `湛卢凭据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new ZhanluCredentialError('malformed-auth-file', '湛卢凭据顶层不是对象')
  }
  const record = /** @type {Record<string, unknown>} */ (parsed)
  const metadata = record.metadata
  if (metadata === null || typeof metadata !== 'object') {
    throw new ZhanluCredentialError('malformed-auth-file', '湛卢凭据缺少 metadata')
  }
  const meta = /** @type {Record<string, unknown>} */ (metadata)

  // 未登录时湛卢把 login 置为 false；此时既不该报解密失败，也不该发请求。
  if (record.login === false) {
    throw new ZhanluCredentialError('signed-out', '湛卢处于未登录状态（login=false）')
  }

  if (!isEncryptedCredential(meta)) {
    const version = meta.cipherVersion
    if (typeof version === 'string' && version.length > 0 && version !== CIPHER_VERSION) {
      throw new ZhanluCredentialError(
        'unsupported-cipher-version',
        `不支持的凭据密文版本：${version}（本插件只认识 ${CIPHER_VERSION}）`,
      )
    }
    throw new ZhanluCredentialError(
      'not-encrypted',
      '湛卢凭据不是预期的加密形态（缺少 cipherVersion/iv/tag）',
    )
  }

  const ciphertext = record.key
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new ZhanluCredentialError('malformed-auth-file', '湛卢凭据缺少密文 key 字段')
  }

  let masterKey
  try {
    masterKey = await readFile(keyPath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new ZhanluCredentialError('no-master-key', `未找到湛卢主密钥：${keyPath}`)
    }
    throw new ZhanluCredentialError(
      'no-master-key',
      `读取湛卢主密钥失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const apiKey = decryptCredential({
    masterKey,
    ciphertextBase64: ciphertext,
    ivBase64: /** @type {string} */ (meta.iv),
    tagBase64: /** @type {string} */ (meta.tag),
  })

  return { apiKey, metadata: meta, dataDir, authPath }
}

/**
 * 只读取湛卢网关地址与账号信息，不解密凭据。
 *
 * 用于离线降级路径：即使网关不可达也应当能显示账号身份与失败原因。
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] 覆盖数据目录（优先级最高）
 * @param {unknown} [options.platform] 平台选择（auto | mac | windows）；缺省按系统检测
 * @returns {Promise<{ modelBaseUrl?: string, marketplaceBaseUrl?: string, userName?: string, email?: string, telephone?: string, organization?: string, team?: string, loginType?: string } | undefined>}
 */
export function projectZhanluIdentity(meta) {
  if (meta === null || typeof meta !== 'object') return undefined
  const out = {}
  for (const key of ['modelBaseUrl', 'marketplaceBaseUrl', 'userName', 'email', 'telephone',
    'organization', 'team', 'loginType', 'loginEnv', 'accountSpace']) {
    const value = meta[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

export async function readZhanluIdentity(options = {}) {
  const dataDir = await resolveAuthDataDir(options)
  try {
    const raw = await readFile(join(dataDir, AUTH_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    const meta = parsed?.metadata
    return projectZhanluIdentity(meta)
  } catch {
    return undefined
  }
}
