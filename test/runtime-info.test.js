/**
 * 桌面运行时信息与清理（src/runtime-info.js）。
 *
 * 这块会真的删目录，所以测试全部在 mkdtemp 临时目录里跑，绝不碰真实的
 * %APPDATA% / %LOCALAPPDATA%。重点覆盖：统计是否准确、缺失目录是否安全、
 * 清理是否只动指定目标、失败是否如实返回。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { appDataRoot, clearRuntime, measureDir, runtimeInfo, userDataDirOf } from '../src/runtime-info.js'

const roots = []
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-runtime-test-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

test('measureDir sums nested files and reports a missing directory as absent', async () => {
  const root = tempRoot()
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  writeFileSync(join(root, 'top.bin'), Buffer.alloc(10))
  writeFileSync(join(root, 'a', 'mid.bin'), Buffer.alloc(20))
  writeFileSync(join(root, 'a', 'b', 'deep.bin'), Buffer.alloc(30))

  const measured = await measureDir(root)
  assert.equal(measured.exists, true)
  assert.equal(measured.bytes, 60)
  assert.equal(measured.files, 3)

  const missing = await measureDir(join(root, 'nope'))
  assert.deepEqual({ exists: missing.exists, bytes: missing.bytes, files: missing.files }, { exists: false, bytes: 0, files: 0 })
})

test('measureDir tolerates a file where a directory was expected', async () => {
  const root = tempRoot()
  const file = join(root, 'plain.bin')
  writeFileSync(file, Buffer.alloc(7))
  const measured = await measureDir(file)
  assert.equal(measured.exists, true)
  assert.equal(measured.bytes, 7)
  assert.equal(measured.files, 1)
})

test('userDataDirOf follows the per-platform app-data root', () => {
  assert.equal(
    userDataDirOf({ platform: 'win32', env: { APPDATA: 'C:/Roaming' } }),
    join('C:/Roaming', 'dsh-pet-remielle')
  )
  assert.equal(
    userDataDirOf({ platform: 'darwin', env: { HOME: '/Users/x' } }),
    join('/Users/x', 'Library', 'Application Support', 'dsh-pet-remielle')
  )
  assert.equal(
    userDataDirOf({ platform: 'linux', env: { HOME: '/home/x' } }),
    join('/home/x', '.config', 'dsh-pet-remielle')
  )
  // XDG_CONFIG_HOME 优先于 ~/.config
  assert.equal(
    userDataDirOf({ platform: 'linux', env: { HOME: '/home/x', XDG_CONFIG_HOME: '/etc/xdg' } }),
    join('/etc/xdg', 'dsh-pet-remielle')
  )
  assert.equal(appDataRoot({ platform: 'win32', env: { APPDATA: 'D:/r' } }), 'D:/r')
})

test('runtimeInfo reports both directories with their sizes', async () => {
  const root = tempRoot()
  const cacheDir = join(root, 'cache')
  const userDataDir = join(root, 'userdata')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'electron.exe'), Buffer.alloc(100))
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'Local State'), Buffer.alloc(50))

  const info = await runtimeInfo({ cacheDir, userDataDir })
  assert.equal(info.cache.path, cacheDir)
  assert.equal(info.cache.bytes, 100)
  assert.equal(info.userData.path, userDataDir)
  assert.equal(info.userData.bytes, 50)
})

test('clearRuntime removes only the requested directory and reports what it freed', async () => {
  const root = tempRoot()
  const cacheDir = join(root, 'cache')
  const userDataDir = join(root, 'userdata')
  for (const dir of [cacheDir, userDataDir]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'file.bin'), Buffer.alloc(64))
  }

  const cacheResult = await clearRuntime({ target: 'cache', cacheDir, userDataDir })
  assert.equal(cacheResult.ok, true)
  assert.equal(cacheResult.freedBytes, 64)
  assert.equal(cacheResult.files, 1)
  // userData 必须完好：清理只针对明确目标。
  assert.equal(readFileSync(join(userDataDir, 'file.bin')).length, 64)

  const userResult = await clearRuntime({ target: 'userData', cacheDir, userDataDir })
  assert.equal(userResult.ok, true)
  assert.equal(userResult.freedBytes, 64)
})

test('clearing an absent directory is a no-op success', async () => {
  const root = tempRoot()
  const result = await clearRuntime({ target: 'cache', cacheDir: join(root, 'missing'), userDataDir: join(root, 'also-missing') })
  assert.equal(result.ok, true)
  assert.equal(result.freedBytes, 0)
  assert.equal(result.files, 0)
})

test('an unknown cleanup target is rejected without touching the disk', async () => {
  const root = tempRoot()
  const cacheDir = join(root, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'keep.bin'), Buffer.alloc(8))

  const result = await clearRuntime({ target: 'everything', cacheDir, userDataDir: join(root, 'ud') })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unknown target')
  assert.equal(readFileSync(join(cacheDir, 'keep.bin')).length, 8)
})
