import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const paths = require('../src/pet-window-paths.cjs')

/** 每个用例一个独立临时根目录，结束后整目录删除（只删自己建的那一个）。 */
function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-paths-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('directory helpers keep the stable dir and the per-pid fallback side by side', () => {
  const root = join('C:', 'appdata')
  assert.equal(paths.baseDirOf(root), join(root, 'dsh-pet-remielle'))
  assert.equal(paths.fallbackDirOf(root, 4242), `${join(root, 'dsh-pet-remielle')}-4242`)
  // 占用标记始终落在稳定目录里：退避实例也要靠它判断稳定目录是否有人用。
  assert.equal(paths.lockPathOf(root), join(root, 'dsh-pet-remielle', 'pet-window.lock'))
})

test('resolveUserDataDir uses the stable dir when nobody holds the lock', () => {
  const root = join('C:', 'appdata')
  const choice = paths.resolveUserDataDir({ appDataDir: root, pid: 100, occupantPid: null })
  assert.equal(choice.dir, paths.baseDirOf(root))
  assert.equal(choice.fallback, false)
  assert.equal(choice.occupantPid, null)
  assert.equal(choice.ownsLock, true)
})

test('resolveUserDataDir falls back to a per-pid dir when a live foreign process holds it', () => {
  const root = join('C:', 'appdata')
  const choice = paths.resolveUserDataDir({
    appDataDir: root,
    pid: 100,
    occupantPid: 200,
    isAlive: (pid) => pid === 200,
  })
  assert.equal(choice.dir, paths.fallbackDirOf(root, 100))
  assert.equal(choice.fallback, true)
  assert.equal(choice.occupantPid, 200)
  // 退避者不碰稳定目录的标记：那个标记属于稳定目录的主人，覆盖它会让主人
  // 退出时误判「不是我的」，把坏标记永久留在盘上。
  assert.equal(choice.ownsLock, false)
})

test('resolveUserDataDir reuses the stable dir when the recorded pid is dead', () => {
  const root = join('C:', 'appdata')
  // 崩溃残留：标记还在，但进程已经不在了 → 自愈复用稳定目录，且接管标记。
  const choice = paths.resolveUserDataDir({
    appDataDir: root,
    pid: 100,
    occupantPid: 200,
    isAlive: () => false,
  })
  assert.equal(choice.dir, paths.baseDirOf(root))
  assert.equal(choice.fallback, false)
  assert.equal(choice.ownsLock, true)
})

test('resolveUserDataDir treats a stale lock written by ourselves as free', () => {
  const root = join('C:', 'appdata')
  // pid 与自己相同（上次异常退出留下的标记）不算占用：否则每次启动都会换目录。
  const choice = paths.resolveUserDataDir({
    appDataDir: root,
    pid: 100,
    occupantPid: 100,
    isAlive: () => true,
  })
  assert.equal(choice.dir, paths.baseDirOf(root))
  assert.equal(choice.ownsLock, true)
})

test('resolveUserDataDir ignores garbage occupant values', () => {
  const root = join('C:', 'appdata')
  for (const occupantPid of [0, -1, 1.5, Number.NaN, 'abc', undefined]) {
    const choice = paths.resolveUserDataDir({
      appDataDir: root,
      pid: 100,
      occupantPid,
      isAlive: () => true,
    })
    assert.equal(choice.dir, paths.baseDirOf(root), `occupantPid=${String(occupantPid)} 应视为空闲`)
    assert.equal(choice.ownsLock, true)
  }
})

test('readOccupantPid returns null for missing, corrupt or malformed locks', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)
    assert.equal(paths.readOccupantPid(lock), null, '文件不存在应视为空闲')
    mkdirSync(join(root, 'dsh-pet-remielle'), { recursive: true })
    writeFileSync(lock, 'not json', 'utf8')
    assert.equal(paths.readOccupantPid(lock), null, 'JSON 损坏应视为空闲')
    writeFileSync(lock, JSON.stringify({ pid: 'x' }), 'utf8')
    assert.equal(paths.readOccupantPid(lock), null, 'pid 非法应视为空闲')
    writeFileSync(lock, JSON.stringify({ pid: 321 }), 'utf8')
    assert.equal(paths.readOccupantPid(lock), 321)
  })
})

test('writeLock creates the stable dir and records this pid', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)
    assert.equal(paths.writeLock(lock, 777), true)
    const written = JSON.parse(readFileSync(lock, 'utf8'))
    assert.equal(written.pid, 777)
    assert.ok(Number.isFinite(written.startedAt))
    assert.equal(paths.readOccupantPid(lock), 777)
  })
})

test('releaseLock removes only a lock that still belongs to this pid', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)
    paths.writeLock(lock, 777)
    // 标记已被别的实例接手 → 绝不能删，否则接手者失去互斥保护。
    assert.equal(paths.releaseLock(lock, 888), false)
    assert.equal(paths.readOccupantPid(lock), 777, '非本人标记必须原样保留')
    assert.equal(paths.releaseLock(lock, 777), true)
    assert.equal(paths.readOccupantPid(lock), null)
    // 重复释放是幂等的（文件已经不在了）。
    assert.equal(paths.releaseLock(lock, 777), false)
  })
})
