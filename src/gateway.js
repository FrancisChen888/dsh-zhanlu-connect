/**
 * 湛卢模型网关客户端。
 *
 * 网关是 OpenAI 兼容端点：
 *   - 模型目录：`GET  {baseURL}/v1/models`
 *   - 对话：    `POST {baseURL}/v1/chat/completions`
 *
 * 探测阶段已经实测确认的行为，写进代码时不要退化：
 *   - 模型 id 在网关上**必须带 `zhanlu/` 前缀**，漏写返回 403「权限不足」。
 *   - 缺少 Authorization 头时 `/v1/models` 返回 500 auth_error（不是 401）。
 *   - 网关是内网地址（rdcloud.4c.hq.cmcc → 172.21.163.49），脱网不可达。
 *
 * @module dsh-zhanlu-connect/gateway
 */

/** 网关上模型 id 的固定前缀。 */
export const MODEL_ID_PREFIX = 'zhanlu/'

/**
 * 已知模型的容量元数据。
 *
 * 网关的 `/v1/models` 只返回 id，不带上下文窗口与输出上限，因此容量靠这张表
 * 补齐；已知与未知模型的上下文默认均为 512K（524288 tokens）。
 *
 * 2026-10-12 按用户要求统一上下文预设；这是 DSH 侧预算，不是网关已验证上限。
 * 输出上限保持原值。若实际服务容量更小，长请求可能被拒绝或超时。
 *
 * 图片能力随上游路由变化，以最近一次的**真实图片**实测矩阵为准：
 *   - 2026-10-13 实测（test/probe-matrix.mjs，真实照片）：qwen3.7-max 对任何图片
 *     输入都 400「请求消息格式错误，请检查messages结构」（含 10-12 探测原图），
 *     deepseek-v4-flash 400「当前模型不支持图片输入」——两者撤回 image 声明。
 *   - 同日实测仍支持图片：auto、kimi-k3、minimax-m3、qwen3.6-35b-a3b、
 *     qwen3.6-plus、qwen3.7-plus（后两个能描述画面细节）。
 *   - deepseek-v4-pro 收图但描述与图无关（幻觉）、glm-5.2 收图空答——
 *     「200 收下」≠「看得懂」，未经识别率验证一律维持文本声明。
 *   - 探测纪律：禁用 1×1 退化图——网关会拒收并误报「当前模型不支持图片输入」，
 *     必须用真实尺寸图片（test/assets/probe-image.png）。
 */
export const KNOWN_MODELS = Object.freeze({
  // 图片能力只为网关逐一实测答出随机码的模型声明；其余维持文本输入。
  'zhanlu/auto': { name: 'Zhanlu Auto', contextWindow: 524288, maxTokens: 32768, input: ['text', 'image'] },
  'zhanlu/deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', contextWindow: 524288, maxTokens: 65536, reasoning: true, input: ['text', 'image'] },
  'zhanlu/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', contextWindow: 524288, maxTokens: 65536, reasoning: true },
  'zhanlu/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', contextWindow: 524288, maxTokens: 65536, reasoning: true },
  'zhanlu/glm-5.3': { name: 'GLM-5.3', contextWindow: 524288, maxTokens: 32768, reasoning: true },
  'zhanlu/glm-5.3-flash': { name: 'GLM-5.3 Flash', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text', 'image'] },
  'zhanlu/glm-5.2': { name: 'GLM-5.2', contextWindow: 524288, maxTokens: 32768, reasoning: true },
  'zhanlu/glm-5.1': { name: 'GLM-5.1', contextWindow: 524288, maxTokens: 32768, reasoning: true },
  'zhanlu/glm-4.7': { name: 'GLM-4.7', contextWindow: 524288, maxTokens: 32768 },
  'zhanlu/kimi-k3': { name: 'Kimi K3', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text', 'image'] },
  'zhanlu/minimax-m3': { name: 'MiniMax M3', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text', 'image'] },
  'zhanlu/minimax-2.7': { name: 'MiniMax 2.7', contextWindow: 524288, maxTokens: 32768 },
  'zhanlu/qwen3.7-max': { name: 'Qwen3.7 Max', contextWindow: 524288, maxTokens: 32768, reasoning: true },
  'zhanlu/qwen3.7-plus': { name: 'Qwen3.7 Plus', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text', 'image'] },
  'zhanlu/qwen3.6-plus': { name: 'Qwen3.6 Plus', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text', 'image'] },
  'zhanlu/qwen3.6-35b-a3b': { name: 'Qwen3.6 35B A3B', contextWindow: 524288, maxTokens: 32768, reasoning: true, input: ['text', 'image'] },
})

/** 目录里没见过的模型也使用用户指定的 512K 上下文预设（未经容量实测）。 */
export const FALLBACK_CONTEXT_WINDOW = 524288
export const FALLBACK_MAX_TOKENS = 32768

/**
 * 网关错误，带 HTTP 状态与响应体摘要。
 *
 * `unreachable` 单独标记，因为内网不可达是**预期内的正常降级路径**，
 * 不是配置错误——UI 与日志必须能区分这两者。
 */
export class ZhanluGatewayError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status]
   * @param {string} [options.body]
   * @param {boolean} [options.unreachable]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'ZhanluGatewayError'
    this.status = options.status
    this.body = options.body
    this.unreachable = options.unreachable === true
  }
}

/**
 * 归一化网关根地址：去掉末尾斜杠。
 *
 * 探测确认网关根是 `.../aigateway`，模型路径拼在其后（`/aigateway/v1/models`），
 * 因此这里只做去尾斜杠，不自行补 `/v1`。
 *
 * @param {string} baseURL
 * @returns {string}
 */
export function normalizeBaseURL(baseURL) {
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * 用 AbortSignal 实现超时。
 *
 * 内网探测必须设短超时：DSH 启动不能被一个不可达的内网地址拖住。
 *
 * @template T
 * @param {number} ms
 * @param {(signal: AbortSignal) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withTimeout(ms, run) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把底层网络错误归类成「不可达」，供降级路径识别。
 *
 * undici 的 fetch 失败会把真实错误码包在 `cause` 里（顶层只有
 * "fetch failed"），因此 cause 也要检查——否则内网不可达时用户看到的
 * 是原始文案而不是「请确认已接入办公网或 VPN」的指引。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isNetworkError(error) {
  if (error === null || typeof error !== 'object') return false
  const code = /** @type {{ code?: string, name?: string }} */ (error).code
  const name = /** @type {{ code?: string, name?: string }} */ (error).name
  const cause = /** @type {{ cause?: unknown }} */ (error).cause
  const causeCode = cause !== null && typeof cause === 'object'
    ? /** @type {{ code?: string }} */ (cause).code
    : undefined
  const hit = (value) =>
    value === 'ENOTFOUND' ||
    value === 'ECONNREFUSED' ||
    value === 'ECONNRESET' ||
    value === 'ETIMEDOUT' ||
    value === 'EHOSTUNREACH' ||
    value === 'ENETUNREACH' ||
    value === 'EAI_AGAIN'
  return (
    name === 'AbortError' ||
    hit(code) ||
    hit(causeCode)
  )
}

/**
 * 湛卢网关客户端。
 */
export class ZhanluGatewayClient {
  /**
   * @param {object} params
   * @param {string} params.baseURL 网关根地址
   * @param {() => Promise<string>} params.resolveApiKey 每次请求解析当前密钥（支持轮换）
   * @param {number} [params.listTimeoutMs] 目录请求超时
   * @param {number} [params.probeTimeoutMs] 连通性探测超时
   * @param {number} [params.retries] 目录请求遇到网络类失败时的追加尝试次数
   * @param {typeof fetch} [params.fetchImpl] 注入用于测试
   */
  constructor({ baseURL, resolveApiKey, listTimeoutMs = 30000, probeTimeoutMs = 12000, retries = 1, fetchImpl }) {
    this.baseURL = normalizeBaseURL(baseURL)
    this.resolveApiKey = resolveApiKey
    this.listTimeoutMs = listTimeoutMs
    this.probeTimeoutMs = probeTimeoutMs
    this.retries = Number.isInteger(retries) && retries > 0 ? retries : 0
    this.fetchImpl = fetchImpl ?? globalThis.fetch
  }

  /** 网关根地址（去掉尾斜杠）。 */
  get origin() {
    return this.baseURL
  }

  /**
   * 发起一次带鉴权的网关请求。
   *
   * @param {string} path
   * @param {object} init
   * @param {number} timeoutMs
   * @returns {Promise<Response>}
   */
  async #request(path, init, timeoutMs) {
    const apiKey = await this.resolveApiKey()
    const url = `${this.baseURL}${path}`
    let response
    try {
      response = await withTimeout(timeoutMs, (signal) =>
        this.fetchImpl(url, {
          ...init,
          signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            ...(init.headers ?? {}),
          },
        }),
      )
    } catch (error) {
      if (isNetworkError(error)) {
        throw new ZhanluGatewayError(
          `无法连接湛卢网关（${this.baseURL}）：该地址是内网服务，请确认已接入办公网或 VPN`,
          { unreachable: true },
        )
      }
      throw error
    }
    return response
  }

  /**
   * 拉取模型目录（带网络重试），返回网关声明的原始模型 id。
   *
   * 该网关的目录接口时断时续：TLS 握手稳定在 ~0.1s，但相当比例的请求
   * 迟迟不回包（实测 TTFB 0.2s–6s，约四成请求 >8s 乃至长时间无响应）。
   * 单次超时会把整个状态打成「不可达」，因此对纯网络类失败追加尝试。
   *
   * @returns {Promise<string[]>}
   */
  async listModelIds() {
    return await this.#listWithRetry(this.listTimeoutMs)
  }

  /**
   * 单次目录请求。
   *
   * @param {number} timeoutMs
   * @returns {Promise<string[]>}
   */
  async #listOnce(timeoutMs) {
    const response = await this.#request('/v1/models', { method: 'GET' }, timeoutMs)
    if (!response.ok) {
      const body = await safeText(response)
      throw new ZhanluGatewayError(
        `湛卢网关模型目录请求失败（HTTP ${response.status}）${summarize(body)}`,
        { status: response.status, body },
      )
    }
    const payload = await response.json()
    const data = Array.isArray(payload?.data) ? payload.data : []
    const ids = []
    for (const entry of data) {
      const id = entry?.id
      if (typeof id === 'string' && id.length > 0) ids.push(id)
    }
    return ids
  }

  /**
   * 只在 `unreachable`（超时/连不上）时重试；HTTP 与凭据错误直接抛出，
   * 重试没有意义，还会把真正的失败原因拖成超时。
   *
   * @param {number} timeoutMs
   * @returns {Promise<string[]>}
   */
  async #listWithRetry(timeoutMs) {
    let lastError
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.#listOnce(timeoutMs)
      } catch (error) {
        lastError = error
        if (!(error instanceof ZhanluGatewayError) || error.unreachable !== true) throw error
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
        }
      }
    }
    throw lastError
  }

  /**
   * 轻量连通性探测：只读模型目录，不消耗推理额度。
   *
   * @returns {Promise<{ reachable: boolean, modelCount?: number, reason?: string, unreachable?: boolean }>}
   */
  async probe() {
    try {
      // 探测用更短的超时，但仍享受一次追加尝试：交互式检测的等待时间要可控。
      const ids = await this.#listWithRetry(this.probeTimeoutMs)
      return { reachable: true, modelCount: ids.length }
    } catch (error) {
      if (error instanceof ZhanluGatewayError) {
        return {
          reachable: false,
          reason: error.message,
          unreachable: error.unreachable === true,
        }
      }
      return { reachable: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * 读取响应体文本，失败时返回空串（诊断信息不该反过来把主流程打挂）。
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * 把响应体压成一行短摘要，避免把整段 HTML 错误页灌进日志。
 *
 * @param {string} body
 * @returns {string}
 */
export function summarize(body) {
  const text = (body ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return ''
  return `：${text.slice(0, 200)}`
}

/**
 * 模态标记后缀。
 *
 * DSH 会话区模型选择器的普通行**只渲染 `model.name`**（2026-10-13 查
 * dsh-client-ui-model-selection 源码确认：常规行无徽标/详情槽位），
 * 因此「多模态/文本」只能编进展示名。`Model.id`（线上名）不受影响，
 * 仍带 `zhanlu/` 前缀原样发给网关；按名称搜索时「多模态」可直接筛出。
 *
 * @param {string[]} input
 * @returns {string}
 */
export function modalitySuffix(input) {
  return Array.isArray(input) && input.includes('image') ? ' · 多模态' : ' · 文本'
}

/**
 * 把网关模型 id 转成展示用元数据。
 *
 * 网关只给 id，因此已知容量来自 {@link KNOWN_MODELS}，未知模型走保守回退。
 * 展示名带模态后缀（见 {@link modalitySuffix}）。
 *
 * @param {string} id 网关原始模型 id（形如 `zhanlu/deepseek-v4.1-flash`）
 * @returns {{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input: string[] }}
 */
export function describeModel(id) {
  const known = KNOWN_MODELS[id]
  if (known !== undefined) {
    const input = known.input ?? ['text']
    return {
      id,
      name: known.name + modalitySuffix(input),
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
      reasoning: known.reasoning === true,
      input,
    }
  }
  return {
    id,
    name: humanizeModelId(id) + modalitySuffix(['text']),
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
    reasoning: false,
    input: ['text'],
  }
}

/**
 * 从模型 id 生成一个可读名：去掉供应商前缀，按连字符/下划线分段并把段首字母大写。
 *
 * 刻意**不**按点号切分：`qwen3.6`、`glm-5.3` 里的点是版本号的一部分，
 * 切开会得到 `Qwen3 6` 这种读不通的名字。
 *
 * @param {string} id
 * @returns {string}
 */
export function humanizeModelId(id) {
  const bare = id.startsWith(MODEL_ID_PREFIX) ? id.slice(MODEL_ID_PREFIX.length) : id
  const words = bare.split(/[-_]/).filter((part) => part.length > 0)
  if (words.length === 0) return id
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}
