import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('真实入口能够启动 provider 并注册配置、额度、状态和登录路由', async () => {
  const home = await mkdtemp(join(tmpdir(), 'zhanlu-startup-'))
  try {
    const args = ['--experimental-vm-modules', fileURLToPath(new URL('./startup-smoke.mjs', import.meta.url))]
    const options = { env: { ...process.env, ZHANLU_TEST_HOME: home, ZHANLU_TEST_MISSING_IMPORT: '0' }, encoding: 'utf8', timeout: 15000 }
    const result = spawnSync(process.execPath, args, options)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const broken = spawnSync(process.execPath, args, {
      ...options, env: { ...options.env, ZHANLU_TEST_MISSING_IMPORT: '1' },
    })
    assert.notEqual(broken.status, 0, '缺少平台导入时，启动检查必须失败')
    assert.match(broken.stderr, /normalizePlatformSelection is not defined/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
