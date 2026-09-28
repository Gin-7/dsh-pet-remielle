import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// 平台集成测试：需要真实子进程来验证退出 PID；受限沙箱中应由 CI 运行。
const require = createRequire(import.meta.url)
const paths = require('../../src/pet-window-paths.cjs')

/** 每个用例一个独立临时根目录，结束后整目录删除（只删自己建的那一个）。 */
function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-paths-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('isProcessAlive rejects junk input and reports ESRCH as dead / EPERM as alive', () => {
  assert.equal(paths.isProcessAlive(0), false)
  assert.equal(paths.isProcessAlive(-5), false)
  assert.equal(paths.isProcessAlive(Number.NaN), false)
  assert.equal(paths.isProcessAlive(process.pid), true, '自己的 pid 必然存活')

  // 拿一个确定已退出的真实 pid（spawnSync 返回时子进程已结束）。不用固定大数字：
  // 不同平台/容器里它可能落在合法范围内，断言会随机翻红。
  const exited = spawnSync(process.execPath, ['-e', '0'])
  assert.ok(Number.isInteger(exited.pid) && exited.pid > 0)
  assert.equal(paths.isProcessAlive(exited.pid), false)

  // EPERM = 进程存在但无权发信号（DSH Desktop 的 NodeService 宿主就是这种）。
  // 真实场景难构造，直接替换 process.kill 的返回值来钉住这条分支。
  const original = process.kill
  process.kill = () => {
    const error = new Error('operation not permitted')
    error.code = 'EPERM'
    throw error
  }
  try {
    assert.equal(paths.isProcessAlive(1234), true, 'EPERM 必须视为存活，否则会误杀活着的宿主')
  } finally {
    process.kill = original
  }
})
