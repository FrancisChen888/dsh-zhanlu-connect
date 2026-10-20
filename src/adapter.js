/**
 * 湛卢（Zhanlu）模型提供方适配器。
 *
 * 把湛卢桌面 App 携带的模型接入 DeepSeek Harness：复用 App 已登录的网关凭据，
 * 插件自身不发起任何登录流程，也不改写湛卢的任何文件。
 *
 * ## 与 WorkBuddy Connect 的异同
 *
 * 相同：都是「读桌面 App 的落盘凭据 → 注册一个 provider」。
 *
 * 不同（决定了本插件必须自己解密、且不需要回环 shim）：
 *  1. 湛卢凭据是 AES-256-GCM 密文（`auth_zhanlu.json` + `.zhanlu-auth.key`），
 *     不像 WorkBuddy 那样是明文 JSON。见 `./credential.js`。
 *  2. 湛卢网关要求线上模型名带 `zhanlu/` 前缀，而 pi-ai 直接把 `Model.id`
 *     当线上名发送。WorkBuddy 为此起了本地回环 shim 改写请求；本插件改用
 *     pi-ai 自带的 `id`（线上名）与 `name`（显示名）二分法，把前缀留在
 *     `id` 里、显示名给人看，从而**不需要任何监听端口**。
 *
 * @module dsh-zhanlu-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { normalizeBaseURL } from './gateway.js'

/** provider 路由 id；模型在选择器里显示为 `<id>/<模型>`。 */
export const PROVIDER_ID = 'zhanlu'

/** 选择器里显示的分组名。 */
export const PROVIDER_DISPLAY_NAME = '湛卢'

/** 订阅制额度无法逐 token 计价，按零报告，避免伪造价格。 */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * 惰性 pi-ai 认证平面。
 *
 * 湛卢路由只经 `resolveApiKey` 用解密出的网关密钥鉴权，因此 pi-ai 自身的
 * 凭据生命周期与 ambient 发现**必须**一无所获——否则它可能凭空造出一份凭据，
 * 让请求带着错误的认证发出去。`PiAiAdapterOptions.auth` 是必填项，所以这里
 * 显式回答「没有存任何东西、环境里也没有」。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-zhanlu-connect: 湛卢路由不使用 pi-ai 的凭据生命周期')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/** 图片预算：与 WorkBuddy 路由一致，保留 pi-ai 的默认量级。 */
const REQUEST_IMAGE_BUDGETS = Object.freeze({
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
})

/** 流式空闲超时；内网网关首 token 可能偏慢，给足余量。 */
const STREAM_IDLE_TIMEOUT_MS = 120000

/**
 * 把一个网关模型描述转成 pi-ai 的 `Model`。
 *
 * `id` 保持网关要求的完整名（含 `zhanlu/` 前缀），因为 pi-ai 会把它原样
 * 作为请求体里的 `model` 字段发给上游；`name` 才是给人看的标签。
 *
 * @param {{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }} info
 * @param {string} baseURL 网关根地址
 * @param {string} providerId
 * @returns {object}
 */
export function toPiModel(info, baseURL, providerId) {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: `${normalizeBaseURL(baseURL)}/v1`,
    input: info.input ?? ['text'],
    ...(info.reasoning
      ? {
          reasoning: true,
          // 网关按 OpenAI 语义识别 reasoning_effort；只声明它确实接受的档位。
          thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
        }
      : { reasoning: false }),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  }
}

/**
 * 组装湛卢 provider 与它的 pi-ai 适配器。
 *
 * profile 采用手工装配而非 `dsh-llm-pi-ai` 内部的 `resolveProfiles()`：后者
 * 不在包的公开导出面上（exports map 挡住了 `lib/` 深导入、`src/` 不随包发布），
 * 因此手工装配是唯一受支持的路径——这也意味着上游每新增一个必填字段，
 * 都要在这里显式补齐。
 *
 * @param {object} params
 * @param {() => Promise<string>} params.resolveApiKey 每次请求解析当前网关密钥
 * @param {() => Array<{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean, input?: string[] }>} params.listModels
 * @param {string} params.baseURL
 * @returns {{ adapter: PiAiAdapter, invalidate: () => void }}
 */
export function createZhanluAdapter({ resolveApiKey, listModels, baseURL, resolveAttachments, resolveImageAccess }) {
  const buildModels = () => listModels().map((info) => toPiModel(info, baseURL, PROVIDER_ID))

  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: '湛卢网关密钥',
          async resolve({ credential }) {
            const apiKey = credential?.key
            if (apiKey === undefined || apiKey.length === 0) return undefined
            return { auth: { apiKey }, source: 'Zhanlu' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    // 目录会随后台刷新变化，因此每次读取都重新构建。
    getModels: () => buildModels(),
  }

  const profile = {
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-zhanlu-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map([[PROVIDER_ID, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey,
    resolveAttachments,
    resolveImageAccess,
  })

  return {
    adapter,
    /** 目录刷新后重建 profile 快照，让下一次请求看到新的模型集合。 */
    invalidate: () => {
      profiles = new Map([[PROVIDER_ID, profile]])
    },
  }
}

/**
 * 把网关返回的原始模型 id 列表转成插件使用的模型描述。
 *
 * 实现放在 `./models.js`（纯函数，可被 `node --test` 直接加载）；
 * 这里转出以保持 adapter 的既有导出面。
 */
export { toModelInfos } from './models.js'
