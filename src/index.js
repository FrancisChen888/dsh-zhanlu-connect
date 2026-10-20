/**
 * DSH 湛卢连接器：把湛卢桌面 App 的模型接入 DeepSeek Harness。
 *
 * 设计约束（按重要性排序）：
 *  1. **绝不阻塞 DSH 启动**。湛卢网关是内网服务，脱网时启动必须照常完成，
 *     插件只把路由标记为「暂不可用」，等网络恢复后由下一次刷新自愈。
 *  2. **只读湛卢**。不写湛卢的任何文件、不启动它的进程。
 *  3. **凭据轮换即时生效**。密钥按请求解析（`resolveApiKey`），湛卢重新登录
 *     后无需重启 DSH。
 *
 * @module dsh-zhanlu-connect
 */

import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { createZhanluAdapter, toModelInfos, PROVIDER_ID, PROVIDER_DISPLAY_NAME } from './adapter.js'
import { projectZhanluIdentity, AUTH_FILENAME } from './credential.js'
import { ZhanluGatewayClient, FALLBACK_CONTEXT_WINDOW, describeModel, normalizeBaseURL, KNOWN_MODELS } from './gateway.js'
import { PreferenceStore, applyPreferences } from './preferences.js'
import { pickZhanluDataDir, resolvePlatform } from './platform.js'
import { CONFIG_PATH, createConfigHandler } from './config-route.js'
import { QUOTA_PATH, createQuotaHandler } from './quota-route.js'
import { STATUS_PATH, createStatusHandler } from './status-route.js'
import { LoginStore, credentialIdentity } from './login-store.js'
import { LOGIN_PATH, createLoginHandler } from './login-route.js'

/** cordis 插件名。 */
export const name = 'llm-zhanlu'

/**
 * 依赖声明。
 *
 * 只列 `llm`：没有它就注册不了 provider，插件没有存在意义。
 *
 * `webServer` **刻意不列在这里**——cordis 的 `inject` 是「必需服务」列表，
 * 声明了却缺失会让整个插件停在 pending（模型功能一起失效），而纯 headless
 * 组合本来就没有 HTTP 服务器。配置端点改用 `ctx.inject(['webServer'], cb)`
 * 延迟挂载：服务在时注册路由，不在时静默跳过。
 */
export const inject = ['llm']

/** 目录缓存文件名（写在 DSH home 下，不写湛卢目录）。 */
export const CATALOG_FILENAME = '.zhanlu-catalog.json'

/** 用户偏好文件名（模型显隐与上下文窗口覆盖）。 */
export const PREFERENCES_FILENAME = '.zhanlu-preferences.json'

/** 缓存格式版本；不认识的一律丢弃而不是猜测。 */
const CATALOG_FORMAT_VERSION = 1

/**
 * 湛卢网关默认地址。
 *
 * 仅作为**兜底**：凭据文件（`auth_zhanlu.json`）的 `metadata.modelBaseUrl`
 * 才是第一来源。登录方式变化时（例如切到公网 ecloud），地址由凭据自带，
 * 这里写死的旧内网地址只在凭据缺失或没带地址时兜底。
 */
export const DEFAULT_BASE_URL =
  'http://rdcloud.4c.hq.cmcc/cmdevops-aiplus-agent-gateway/aigateway'

/** 后台目录刷新间隔。 */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000

/** 首次刷新失败后的重试间隔（内网掉线是常态，退避短一些便于自愈）。 */
const RETRY_INTERVAL_MS = 2 * 60 * 1000

/**
 * 插件配置。
 *
 * 所有字段都有安全默认值：零配置即可工作，网络地址也可覆盖以便换环境。
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).description('兼容旧配置；登录选择生效后使用对应固定网关'),
  dataDir: z.string().description('湛卢数据目录；留空则按平台候选解析（优先级最高，设置后固定用该目录）'),
  platform: z.union(['auto', 'mac', 'windows']).default('auto').description('湛卢数据目录平台；auto 按当前系统检测（v0.4.0 Windows 适配）'),
  refreshIntervalMs: z.number().default(REFRESH_INTERVAL_MS).description('目录后台刷新间隔（毫秒）'),
  disableNetwork: z.boolean().default(false).description('只读本地缓存、完全不请求网关（离线排障用）'),
})

/**
 * 目录缓存的磁盘路径。
 *
 * 缓存放在 DSH home 而不是湛卢目录：这是插件自己的产物，不该污染 App 数据目录。
 *
 * @returns {string}
 */
export function catalogPath(identity) {
  if (identity && !/^[a-f0-9]{64}$/.test(identity)) throw new Error('Invalid catalog identity')
  return join(resolveDshHome(), identity ? `.zhanlu-catalog-${identity}.json` : CATALOG_FILENAME)
}

/**
 * 把缓存文件的内容解析成模型描述数组。
 *
 * 解析逻辑在这里集中一次，供同步与异步两条读取路径共用，避免两处判据漂移。
 *
 * @param {string} raw
 * @returns {Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>}
 */
function parseCatalog(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed?.version !== CATALOG_FORMAT_VERSION) return []
  if (!Array.isArray(parsed.models)) return []
  const out = []
  for (const entry of parsed.models) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    out.push({
      id: entry.id,
      // 展示名与模态同以代码为准：缓存里的名字可能是旧版命名（无模态后缀）。
      name: describeModel(entry.id).name,
      contextWindow:
        Number.isFinite(entry.contextWindow) && entry.contextWindow > 0
          ? entry.contextWindow
          : FALLBACK_CONTEXT_WINDOW,
      maxTokens: Number.isFinite(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : 32768,
      reasoning: entry.reasoning === true,
      // 模态能力一律以代码里的 KNOWN_MODELS 为准，不信任缓存：
      // 上游能力会变化（2026-10-13 实测 qwen3.7-max 等 4 个模型图片输入被网关 400 拒收），
      // 若缓存优先，代码里的能力修正会被旧缓存静默覆盖，bug 永不愈合。
      input: describeModel(entry.id).input,
    })
  }
  return out
}

/**
 * 同步读取上次成功拉取的目录。
 *
 * **必须同步**：宿主在插件注册后立刻用当前模型集合校验默认模型（`agent-default-model`），
 * 而网关拉取是异步的。若注册时模型集合为空，校验会以 `UNKNOWN_MODEL` 失败，
 * 湛卢分组要等下一次刷新才出现。先同步载入磁盘缓存即可让首个校验就通过；
 * 真实的网络刷新随后覆盖它。
 *
 * @returns {Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>}
 */
export function readCatalogCacheSync(identity) {
  try {
    return parseCatalog(readFileSync(catalogPath(identity), 'utf8'))
  } catch {
    return []
  }
}

/**
 * 读取上次成功拉取的目录。
 *
 * 缓存只用于「这次拉不到时兜底」，从不阻止一次真实拉取——湛卢的模型上架会变，
 * 缓存不能被当成新鲜数据。
 *
 * @returns {Promise<Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>>}
 */
export async function readCatalogCache(identity) {
  try {
    return parseCatalog(await readFile(catalogPath(identity), 'utf8'))
  } catch {
    return []
  }
}

/**
 * 原子写入目录缓存。
 *
 * 先写临时文件再 rename：避免 DSH 被强杀时留下半个 JSON 让下次启动解析失败。
 *
 * @param {Array<object>} models
 * @returns {Promise<void>}
 */
export async function writeCatalogCache(models, identity) {
  const target = catalogPath(identity)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    await mkdir(resolveDshHome(), { recursive: true })
    await writeFile(tmp, JSON.stringify({ version: CATALOG_FORMAT_VERSION, models }, null, 2), 'utf8')
    await rename(tmp, target)
  } catch {
    // 缓存写不进去只影响下次兜底，不影响本次会话，因此不向上抛。
  }
}

/**
 * 插件主体。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const resolved = config ?? {}
  const refreshIntervalMs = resolved.refreshIntervalMs ?? REFRESH_INTERVAL_MS
  const dataDir = resolved.dataDir && resolved.dataDir.length > 0 ? resolved.dataDir : undefined

  // 平台选择（v0.4.0）：patch 配置显式指定（非 auto）时优先，其次配置页里
  // 用户选择的偏好，都缺省时按当前系统检测。优先加载偏好（同步）：LoginStore
  // 需要按它解析湛卢数据目录。
  const configPlatform = normalizePlatformSelection(resolved.platform)
  const preferences = new PreferenceStore(join(resolveDshHome(), PREFERENCES_FILENAME))
  preferences.loadSync()
  const currentPlatformSelection = () => {
    if (configPlatform !== 'auto') return configPlatform
    return normalizePlatformSelection(preferences.current.platform)
  }

  const logins = new LoginStore({ directory: join(resolveDshHome(), 'zhanlu-logins'), dataDir, platform: currentPlatformSelection() })
  const initialCredential = logins.peek()
  let loginEpoch = 0
  let activeIdentity = initialCredential ? credentialIdentity(initialCredential) : null

  /**
   * 当前生效的网关地址。
   *
   * 唯一选择者为 LoginStore：手动选择持久化，两种方式各自绑定固定网关和凭据。
   * 未有快照时从App当前登录初始化；旧baseUrl只作为未鉴权启动期的兼容值。
   * 每次解析凭据后与所选网关同步；地址变化重建provider。
   * 目录/探测每次使用URL与密钥的一次性快照，不再复用可变全局client。
   */
  let effectiveBaseUrl = initialCredential?.metadata.modelBaseUrl ?? resolved.baseUrl ?? DEFAULT_BASE_URL
  /** 生效地址的来源，供状态页展示是「凭据自带」还是「配置指定」。 */
  let baseUrlSource = initialCredential ? 'login' : resolved.baseUrl ? 'config' : 'default'

  /** 最近一次成功加载的凭据快照（账号信息 + 网关地址），供状态端点使用。 */
  let credentialSnapshot = null

  /**
   * 最近一次读到的账号身份（不解密）。
   *
   * 与 credentialSnapshot 分开：离线排障（disableNetwork）或凭据解密失败时，
   * `loadCredential` 不会被调用，但账号姓名/组织仍应能在设置页显示。
   */
  let identitySnapshot = null

  /** 是否已因地址变化重建过 client/provider。 */
  function rebuildTransportIfChanged(nextUrl) {
    const next = normalizeBaseURL(nextUrl)
    if (next.length === 0 || next === effectiveBaseUrl) return
    effectiveBaseUrl = next
    baseUrlSource = 'credential'
    // provider的baseURL是构造期参数，地址变化整体重建；调用方同步凭据快照。
    rebuildAdapter(effectiveBaseUrl)
    ctx.logger.info(`dsh-zhanlu-connect: 网关地址已随凭据切换为 ${effectiveBaseUrl}`)
  }

  /**
   * 读取凭据，并把凭据自带的网关地址同步进传输层。
   *
   * 每次请求都重新读盘：换账号/换登录方式后不必重启插件即可生效。
   *
   * @returns {Promise<{ apiKey: string, metadata: Record<string, unknown> }>}
   */
  async function loadCredential() {
    const result = await logins.read()
    const nextIdentity = credentialIdentity(result)
    credentialSnapshot = result
    identitySnapshot = result.metadata
    if (nextIdentity !== activeIdentity) {
      const firstLoad = activeIdentity === null
      activeIdentity = nextIdentity
      loginEpoch++
      // 不复用另一套登录/账号的目录。首次启动暂用公开的代码预置描述，
      // 只供宿主同步校验模型ID；不代表已认证/当前网关目录，不沿用旧账号缓存。
      models = readCatalogCacheSync(activeIdentity)
      usingBootstrap = firstLoad && models.length === 0
      if (usingBootstrap) models = toModelInfos(Object.keys(KNOWN_MODELS))
      status = { reachable: false, reason: usingBootstrap ? '使用公开预置模型，尚未验证当前登录目录' : '登录已切换，请检测连通性或刷新目录', modelCount: usingBootstrap ? 0 : models.length }
      const nextUrl = normalizeBaseURL(result.metadata.modelBaseUrl)
      if (nextUrl !== effectiveBaseUrl) rebuildTransportIfChanged(nextUrl)
      else rebuildAdapter(nextUrl)
      baseUrlSource = 'login'
    }
    return result
  }

  /**
   * 当前目录。
   *
   * 同步载入磁盘缓存作为**初始值**，而不是空数组：宿主会在注册后立刻用当前
   * 模型集合校验默认模型，空集合会让湛卢分组延迟一个刷新周期才出现。缓存来自
   * 上一次成功拉取，随后由异步刷新覆盖成最新状态。
   */
  const startupCatalog = activeIdentity ? readCatalogCacheSync(activeIdentity) : []
  let usingBootstrap = startupCatalog.length === 0
  let models = startupCatalog.length ? startupCatalog : toModelInfos(Object.keys(KNOWN_MODELS))
  // 没有身份缓存时是公开预置目录，不是“旧账号的可用模型”；鉴权仍必须解析所选凭据。

  /**
   * 用户偏好（模型显隐 + 上下文窗口覆盖 + 平台选择）。
   *
   * 已在上方同步载入（平台解析先于 LoginStore 构造）：偏好决定哪些模型
   * 出现在选择器里，异步载入会让首帧短暂显示全部模型，出现可见闪烁。
   */

  /** 最近一次刷新结果，用于诊断与状态展示。 */
  let status = {
    reachable: false,
    reason: startupCatalog.length ? '已载入当前登录缓存，正在刷新' : '使用公开预置模型供启动校验，尚未验证当前登录目录',
    modelCount: startupCatalog.length,
  }


  /** provider 当前释放函数；地址重建时先释放旧的再注册新的。 */
  let releaseAdapter = null
  /** 目录变化后通知宿主重建快照。 */
  let invalidate = () => {}
  /** 当前生效的适配器；重建时整体替换。 */
  let adapter = null

  /**
   * 用给定地址重建 provider 适配器并重新注册。
   *
   * 地址变化（换登录方式）时必须调用：`baseURL` 是 adapter 构造期参数，
   * 不重建就会继续打旧地址。
   *
   * @param {string} baseURL
   */
  function rebuildAdapter(baseURL) {
    releaseAdapter?.()
    const built = createZhanluAdapter({
      baseURL,
      resolveApiKey: async () => {
        const credential = await loadCredential()
        // 旧adapter若在切换后才解析鉴权，必须失败，不能把新密钥发送到旧网关。
        if (normalizeBaseURL(credential.metadata.modelBaseUrl) !== normalizeBaseURL(baseURL)) {
          throw new Error('登录方式已切换，请重试本次请求')
        }
        return credential.apiKey
      },
      // 与官方 pi-ai 接线一致：通过宿主持久化附件服务读取图片并解析访问权限。
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
      // 把偏好套用在最外层：provider 只看到「用户想要的模型集合与窗口」。
      listModels: () => applyPreferences(models, preferences.current),
    })
    adapter = built.adapter
    invalidate = built.invalidate
    releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  }

  // ---- provider 注册：先于任何网络请求，保证启动不被内网拖住 ----
  rebuildAdapter(effectiveBaseUrl)
  ctx.effect(() => () => {
    releaseAdapter?.()
  })

  // ---- 配置页端点：偏好读写 ----
  // 用 ctx.inject 延迟挂载可选服务：宿主有 webServer 时注册路由，
  // 没有时（纯 headless 组合）此回调不执行，插件照常提供模型。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact', path: LOGIN_PATH,
      handler: createLoginHandler({ store: logins, onChanged: async () => {
        await loadCredential()
        // 切换成功不等于认证成功；目录探测在后台进行，UI可显式检测。
        await refreshCatalog()
      } }),
    }), 'dsh-zhanlu-connect: 登录方式端点')
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: createConfigHandler({
          store: preferences,
          // 这里给**全部**模型（含被隐藏的）：UI 需要渲染完整勾选列表，
          // 否则被隐藏的项再也勾不回来。
          listModels: () => models,
          onChanged: () => {
            // 平台选择（v0.4.0）随偏好一起保存；变化时切换 LoginStore 的
            // 数据目录解析并立即重拉目录/凭据，失败不阻塞保存响应。
            const nextSelection = currentPlatformSelection()
            if (nextSelection !== logins.platformSelection) {
              const effective = logins.setPlatform(nextSelection)
              ctx.logger.info(`dsh-zhanlu-connect: 湛卢数据目录平台已切换为 ${nextSelection}（${effective} 布局）`)
              void refreshCatalog()
            }
            invalidate()
          },
          logger: ctx.logger,
        }),
      })
      return () => dispose()
    }, 'dsh-zhanlu-connect: 配置端点')
    // 每日额度端点：凭据网关是唯一来源，5分钟账号绑定缓存；离线模式不联网。
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: QUOTA_PATH,
        handler: createQuotaHandler({ dataDir, loadCredential,
          platform: currentPlatformSelection,
          getLoginRevision: () => loginEpoch, disableNetwork: resolved.disableNetwork === true }),
      })
      return () => dispose()
    }, 'dsh-zhanlu-connect: 配额端点')
    // 状态端点：账号信息、生效网关地址、目录快照，以及三个主动检测动作。
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: createStatusHandler({
          getStatus: () => snapshotStatus(),
          refreshCatalog: async () => {
            await refreshCatalog()
          },
          readIdentity: async () => {
            const credential = await loadCredential()
            return projectZhanluIdentity(credential.metadata)
          },
          probeGateway: async () => {
            // 离线排障模式下禁止发任何网络请求，直接说明原因。
            if (resolved.disableNetwork === true) {
              return { ok: false, reason: '已禁用网络请求（离线排障模式），无法执行连通性检测' }
            }
            // 主动探测：凭据解析 + 打一次 /v1/models，量出延迟。
            // 凭据解析失败（未登录/密钥不匹配）也算检测不通过，原因直接回给 UI。
            const started = Date.now()
            try {
              const credential = await loadCredential()
              const epoch = loginEpoch
              const requestClient = new ZhanluGatewayClient({ baseURL: credential.metadata.modelBaseUrl,
                resolveApiKey: async () => credential.apiKey })
              const result = await requestClient.probe()
              const latencyMs = Date.now() - started
              if (epoch !== loginEpoch) return { ok: false, latencyMs, reason: '登录已切换，请重新检测' }
              if (result.reachable) {
                ctx.logger.info(
                  `dsh-zhanlu-connect: 连通性检测通过，${latencyMs}ms，${result.modelCount ?? 0} 个模型`,
                )
                return { ok: true, latencyMs, modelCount: result.modelCount ?? 0 }
              }
              return {
                ok: false,
                latencyMs,
                reason: result.reason ?? '网关未返回可用结果',
                unreachable: result.unreachable === true,
              }
            } catch (error) {
              const latencyMs = Date.now() - started
              const message = error instanceof Error ? error.message : String(error)
              const code =
                typeof error === 'object' && error !== null
                  ? /** @type {{ code?: string }} */ (error).code
                  : undefined
              return { ok: false, latencyMs, reason: message, code }
            }
          },
          logger: ctx.logger,
        }),
      })
      return () => dispose()
    }, 'dsh-zhanlu-connect: 状态端点')
  })

  /**
   * 刷新模型目录。
   *
   * 失败时保留上一次成功的目录（内存里的，若为空则读磁盘缓存），
   * 让「曾经可用、现在断网」的场景仍能显示模型并给出明确错误，
   * 而不是把整个分组静默清空。
   *
   * @returns {Promise<void>}
   */
  let catalogRequest = 0

  /**
   * 网络类失败后的短重试。
   *
   * 网关目录接口时断时续：一次失败就把状态打到「不可达」，而下一个定时
   * 周期在 30 分钟后——界面会长时间停在红灯。这里在失败后 60 秒补一次，
   * 成功即取消；重试本身不覆盖在进行中的刷新（`catalogRequest` 兜底）。
   */
  const RETRY_DELAY_MS = 60_000
  let retryTimer
  function clearRetry() {
    if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
  }
  function scheduleRetry() {
    if (retryTimer !== undefined) return
    retryTimer = setTimeout(() => { retryTimer = undefined; void refreshCatalog() }, RETRY_DELAY_MS)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  async function refreshCatalog() {
    const request = ++catalogRequest
    let epoch
    try {
      const credential = await loadCredential()
      epoch = loginEpoch
      const identity = activeIdentity
      if (resolved.disableNetwork === true) {
        clearRetry()
        status = { reachable: false, reason: usingBootstrap ? '已禁用网络请求，公开预置模型尚未验证' : '已禁用网络请求，使用当前登录缓存', modelCount: usingBootstrap ? 0 : models.length }
        invalidate(); return
      }
      // URL和密钥绑定一次快照；异步请求不再引用可能被切换的全局client。
      const requestClient = new ZhanluGatewayClient({ baseURL: credential.metadata.modelBaseUrl,
        resolveApiKey: async () => credential.apiKey })
      const ids = await requestClient.listModelIds()
      if (epoch !== loginEpoch || request !== catalogRequest) return
      const infos = toModelInfos(ids)
      models = infos
      usingBootstrap = false
      status = { reachable: true, reason: infos.length ? '' : '网关未返回任何 zhanlu/ 模型', modelCount: infos.length }
      clearRetry()
      invalidate()
      await writeCatalogCache(infos, identity)
    } catch (error) {
      if (request !== catalogRequest || (epoch !== undefined && epoch !== loginEpoch)) return
      // 只保留当前身份缓存，不回落旧登录的全局目录，也不透传上游响应正文。
      status = { reachable: false, reason: usingBootstrap ? '当前登录目录刷新失败；仅显示公开预置模型，尚未验证可用性' : '当前登录目录刷新失败，请检查网络或重新登录', modelCount: usingBootstrap ? 0 : models.length,
        unreachable: error?.unreachable === true }
      ctx.logger.warn('dsh-zhanlu-connect: 当前登录目录刷新失败')
      // 只有网络类失败才值得 60 秒后再试；凭据/HTTP 错误重试无意义。
      if (error?.unreachable === true) scheduleRetry()
    }
  }

  // ---- 首次刷新：不 await，绝不阻塞启动 ----
  // 首次异步读取所选凭据并拉取目录；不覆盖手动登录选择。
  void refreshCatalog()

  // ---- 后台定时刷新 ----
  const timer = setInterval(() => {
    void refreshCatalog()
  }, Math.max(60_000, refreshIntervalMs))
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => { clearInterval(timer); clearRetry() })

  /**
   * 当前状态的只读快照。
   *
   * 账号信息优先取凭据 metadata（解密成功时字段最全），回落到
   * {@link identitySnapshot}（离线或解密失败时至少有姓名/组织/登录方式）。
   * `credentialLoaded` 让 UI 能区分「没读到凭据」与「读到了但网关不可达」。
   *
   * @returns {object}
   */
  function snapshotStatus() {
    const meta = /** @type {Record<string, unknown>} */ (credentialSnapshot?.metadata ?? {})
    const identity = identitySnapshot ?? {}
    const pick = (key) => {
      const fromMeta = meta[key]
      if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta
      const fromIdentity = /** @type {Record<string, unknown>} */ (identity)[key]
      if (typeof fromIdentity === 'string' && fromIdentity.length > 0) return fromIdentity
      return undefined
    }
    // 平台与数据目录（v0.4.0）：生效布局、用户选择、来源，以及按候选探测的
    // 实际数据目录——UI 据此展示解析到了哪套布局、哪个目录。
    const selection = currentPlatformSelection()
    const dirProbe = dataDir !== undefined
      ? { dataDir, candidates: [dataDir] }
      : pickZhanluDataDir({ platform: selection })
    const preferencePlatform = normalizePlatformSelection(preferences.current.platform)
    return {
      baseUrl: effectiveBaseUrl,
      baseUrlSource,
      login: logins.status(),
      catalogSource: usingBootstrap ? 'bootstrap' : status.reachable ? 'gateway' : 'identity-cache',
      /** 生效的平台布局（mac | windows）。 */
      platform: resolvePlatform(selection),
      /** 平台选择的原始值（auto | mac | windows），供 UI 渲染选择器。 */
      platformSelection: selection,
      /** 平台选择来源：插件配置固定 > 配置页偏好 > 按系统检测。 */
      platformSource: configPlatform !== 'auto' ? 'config' : preferencePlatform !== 'auto' ? 'preference' : 'auto',
      /** 湛卢数据目录：显式配置优先，否则按平台候选探测（首个存在凭据的候选）。 */
      dataDir: dirProbe.dataDir,
      dataDirCandidates: dirProbe.candidates,
      ...status,
      /** 账号信息：凭据 metadata 优先，identity 兜底，缺字段时为 undefined。 */
      account: {
        userName: pick('userName'),
        organization: pick('organization'),
        team: pick('team'),
        loginType: pick('loginType'),
        loginEnv: pick('loginEnv'),
        email: pick('email'),
        telephone: pick('telephone'),
        accountSpace: pick('accountSpace'),
      },
      /** 凭据是否已加载成功（解密路径）。false 不等于「未登录」。 */
      credentialLoaded: credentialSnapshot !== null,
      /** 是否读到了账号身份（不解密）。 */
      identityLoaded: identitySnapshot !== null,
      /** 选择器里实际可见的模型。 */
      models: applyPreferences(models, preferences.current).map((m) => m.id),
      /** 被偏好隐藏的模型。 */
      hidden: [...preferences.current.hiddenModels],
      /** 用户改过上下文窗口的模型。 */
      contextOverrides: { ...preferences.current.contextOverrides },
    }
  }

  /** 供状态查询使用的快照。 */
  ctx.provide?.('zhanluStatus', () => snapshotStatus())
}
