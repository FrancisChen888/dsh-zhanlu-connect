// Exercise the real entry and local modules without installing DSH or using credentials.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SyntheticModule, SourceTextModule } from 'node:vm'
import { toModelInfos } from '../src/models.js'
import { LoginStore, credentialIdentity } from '../src/login-store.js'

const home = process.env.ZHANLU_TEST_HOME
assert.ok(home, 'A temporary test home is required')
const schema = new Proxy({}, { get: () => () => schema })
class OfflineLoginStore extends LoginStore {
  async read() { throw new Error('Test account is signed out') }
}
const stubs = new Map([
  ['@deepseek-ai/schemastery', { default: schema }],
  ['@deepseek-ai/dsh-home-paths', { resolveDshHome: () => home }],
  ['@deepseek-ai/dsh-llm', { resolveImageAttachmentAccess() {} }],
  ['./login-store.js', { LoginStore: OfflineLoginStore, credentialIdentity }],
  ['./adapter.js', {
    toModelInfos,
    PROVIDER_ID: 'zhanlu',
    PROVIDER_DISPLAY_NAME: '湛卢',
    createZhanluAdapter: ({ listModels }) => ({ adapter: { listModels }, invalidate() {} }),
  }],
])
const entry = new URL('../src/index.js', import.meta.url)
let source = await readFile(entry, 'utf8')
if (process.env.ZHANLU_TEST_MISSING_IMPORT === '1') {
  source = source.replace('import { normalizePlatformSelection, pickZhanluDataDir', 'import { pickZhanluDataDir')
}
const module = new SourceTextModule(source, { identifier: entry.href })
await module.link(async (specifier) => {
  const exports = stubs.get(specifier) ?? await import(new URL(specifier, entry))
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  })
})
await module.evaluate()
const routes = new Map()
const disposers = []
let adapter
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  llm: { registerAdapter(_ids, registered) { adapter = registered; return () => {} } },
  effect(fn) { disposers.push(fn()) },
  inject(_services, fn) { fn(this) },
  webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
  provide() {},
}
try {
  module.namespace.apply(ctx, { disableNetwork: true, dataDir: `${home}/missing-app`, platform: 'auto' })
  assert.equal(adapter.listModels().length, 16)
  assert.ok(adapter.listModels().every((model) => model.contextWindow === 1048576))
  for (const name of ['config', 'quota', 'status', 'login']) {
    assert.ok(routes.has(`/plugins/dsh-zhanlu-connect/${name}`), `${name} must be registered at startup`)
  }
  for (const name of ['config', 'status']) {
    const res = { writeHead(code) { this.statusCode = code }, end(body) { this.body = JSON.parse(body) } }
    await routes.get(`/plugins/dsh-zhanlu-connect/${name}`)({ method: 'GET' }, res)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    if (name === 'config') assert.ok(res.body.models.every((model) => model.defaultContextWindow === 1048576))
    else assert.equal(res.body.status.platformSelection, 'auto')
  }
} finally {
  for (const dispose of disposers.reverse()) dispose?.()
}
console.log('Entry startup, provider models, config/status responses and all four routes passed')
