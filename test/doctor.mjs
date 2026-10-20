#!/usr/bin/env node
/**
 * 端到端自检（跨平台）：平台解析 → 数据目录 → 解密 → 网关连通性。
 *
 * 只读湛卢，不打印任何密钥内容（仅报告长度与形状）。
 *
 * 用法：
 *   node test/doctor.mjs [--platform auto|mac|windows] [--data-dir <dir>]
 *
 * @module dsh-zhanlu-connect/test/doctor
 */

import { pickZhanluDataDir } from '../src/platform.js'
import { loadZhanluCredential } from '../src/credential.js'
import { ZhanluGatewayClient } from '../src/gateway.js'

function parseArgs(argv) {
  const args = { platform: 'auto', dataDir: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') args.platform = argv[i + 1] ?? 'auto'
    else if (argv[i] === '--data-dir') args.dataDir = argv[i + 1]
  }
  return args
}

function shape(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `string(len=${value.length})`
  if (typeof value === 'number') return `number(${value})`
  if (typeof value === 'object') return `object(keys=${Object.keys(value).join(',')})`
  return typeof value
}

const args = parseArgs(process.argv.slice(2))
const dirProbe = pickZhanluDataDir({ platform: args.platform })
console.log(`[1/4] 平台：选择 ${args.platform} → 生效布局 ${dirProbe.platform}`)
console.log(`      数据目录候选（按优先级）：`)
for (const candidate of dirProbe.candidates) console.log(`        - ${candidate}`)
console.log(`      解析到：${args.dataDir ?? dirProbe.dataDir}`)

let credential
try {
  credential = await loadZhanluCredential({ dataDir: args.dataDir, platform: args.platform })
} catch (error) {
  console.log(`[2/4] 凭据：读取失败（${error.code ?? 'unknown'}）—— ${error.message}`)
  console.log('      提示：确认湛卢 App 已登录；Windows 上确认数据目录候选列表里有真实凭据，')
  console.log('      或用 --data-dir 显式指定，或在插件配置页选择 mac/windows。')
  process.exit(1)
}
console.log(`[2/4] 凭据：解密成功（数据目录 ${credential.dataDir}）`)
console.log(`      metadata 形状：${shape(credential.metadata)}`)
console.log(`      apiKey 形状：${shape(credential.apiKey)}（内容不打印）`)

const client = new ZhanluGatewayClient({
  baseURL: credential.metadata.modelBaseUrl,
  resolveApiKey: async () => credential.apiKey,
})
const started = Date.now()
const probe = await client.probe()
console.log(`[3/4] 网关：${credential.metadata.modelBaseUrl}`)
console.log(`      ${probe.reachable ? `可达，${Date.now() - started}ms，${probe.modelCount ?? 0} 个模型` : `不可达 —— ${probe.reason ?? ''}`}`)

if (!probe.reachable) {
  console.log('[4/4] 结论：凭据有效但网关不可达（内网地址需办公网/VPN）。')
  process.exit(2)
}
console.log('[4/4] 结论：平台解析、凭据解密与网关连通全部通过。')
