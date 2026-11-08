import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

test('fallbackDirPidOf parses only canonical fallback names', () => {
  assert.equal(paths.fallbackDirPidOf('dsh-pet-remielle-4242'), 4242)
  assert.equal(paths.fallbackDirPidOf('dsh-pet-remielle-1'), 1)
  for (const name of [
    'dsh-pet-remielle', // 稳定目录本身
    'dsh-pet-remielle-', // 缺 pid
    'dsh-pet-remielle-abc',
    'dsh-pet-remielle-12x',
    'dsh-pet-remielle-0',
    'dsh-pet-remielle--1',
    'dsh-pet-remielle-007', // 非规范形式（前导零）
    'dsh-pet-remielle-1-2',
    'x-dsh-pet-remielle-1',
    'dsh-pet-remielle-99999999999999999999', // 超出安全整数
    '',
  ]) {
    assert.equal(paths.fallbackDirPidOf(name), null, `${JSON.stringify(name)} 不应被当成退避目录`)
  }
  assert.equal(paths.fallbackDirPidOf(null), null)
  assert.equal(paths.fallbackDirPidOf(undefined), null)
  assert.equal(paths.fallbackDirPidOf(123), null)
})

test('listFallbackDirs lists only existing fallback directories', () => {
  withTempRoot((root) => {
    mkdirSync(join(root, 'dsh-pet-remielle'), { recursive: true })
    mkdirSync(join(root, 'dsh-pet-remielle-101'), { recursive: true })
    mkdirSync(join(root, 'dsh-pet-remielle-202'), { recursive: true })
    // 前缀对但 pid 非法、前缀不对、以及同名的普通文件都不应入选。
    mkdirSync(join(root, 'dsh-pet-remielle-abc'), { recursive: true })
    mkdirSync(join(root, 'other-303'), { recursive: true })
    writeFileSync(join(root, 'dsh-pet-remielle-404'), 'not a dir', 'utf8')

    const listed = paths.listFallbackDirs(root)
    assert.deepEqual(listed.map((item) => item.pid), [101, 202])
    assert.deepEqual(listed.map((item) => item.name), ['dsh-pet-remielle-101', 'dsh-pet-remielle-202'])
    assert.deepEqual(
      listed.map((item) => item.dir),
      [join(root, 'dsh-pet-remielle-101'), join(root, 'dsh-pet-remielle-202')]
    )
    assert.ok(listed.every((item) => Number.isFinite(item.mtimeMs)))

    // 根目录不存在 / 指向文件：失败返回空数组，不抛。
    assert.deepEqual(paths.listFallbackDirs(join(root, 'missing')), [])
    const fileAsRoot = join(root, 'not-a-dir')
    writeFileSync(fileAsRoot, 'x', 'utf8')
    assert.deepEqual(paths.listFallbackDirs(fileAsRoot), [])
  })
})

test('staleFallbackDirs drops dead, aged and foreign dirs but never currentPid', () => {
  withTempRoot((root) => {
    const now = Date.UTC(2026, 10, 7, 9, 0, 0)
    const maxAgeMs = 6 * 60 * 60 * 1000
    const old = new Date(now - maxAgeMs - 1000)
    const fresh = new Date(now - 1000)
    const makeDir = (name, mtime) => {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      utimesSync(dir, mtime, mtime)
      return dir
    }

    // 稳定目录本身永远不在结果里（名字解析不出 pid）。
    makeDir('dsh-pet-remielle', old)
    const dead = makeDir('dsh-pet-remielle-111', fresh) // 进程已死
    const aliveFresh = makeDir('dsh-pet-remielle-222', fresh) // 活进程 → 保留
    const aliveOld = makeDir('dsh-pet-remielle-333', old) // 活进程即使目录很旧也保留（不能误删运行中的 profile）
    const own = makeDir('dsh-pet-remielle-444', old) // 本进程自己的目录
    const deadOld = makeDir('dsh-pet-remielle-555', old) // 死进程 → 报 dead

    const stale = paths.staleFallbackDirs({
      appDataDir: root,
      currentPid: 444,
      isAlive: (pid) => pid === 222 || pid === 333,
    })
    assert.deepEqual(stale, [
      { dir: dead, pid: 111, reason: 'dead' },
      { dir: deadOld, pid: 555, reason: 'dead' },
    ])
    // 保留项：活进程（无论新旧）；自己的目录无论死活都排除。
    assert.ok(!stale.some((item) => item.dir === aliveFresh || item.dir === aliveOld || item.dir === own))
  })
})

test('waitForLockRelease waits only while a live foreign pid holds the lock', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)

    // 自己的残留标记：不算占用，立即返回，不睡眠。
    paths.writeLock(lock, 100)
    let slept = 0
    assert.equal(paths.waitForLockRelease({
      lockPath: lock,
      pid: 100,
      timeoutMs: 1000,
      intervalMs: 50,
      isAlive: () => true,
      sleep: (ms) => { slept += ms },
    }), 100)
    assert.equal(slept, 0)

    // 已死占用者：同样不睡眠，把 pid 交给 resolveUserDataDir 走自愈。
    paths.writeLock(lock, 200)
    slept = 0
    assert.equal(paths.waitForLockRelease({
      lockPath: lock,
      pid: 100,
      timeoutMs: 1000,
      intervalMs: 50,
      isAlive: () => false,
      sleep: (ms) => { slept += ms },
    }), 200)
    assert.equal(slept, 0)

    // 活占用者释放：等到标记消失就返回 null。
    paths.writeLock(lock, 200)
    slept = 0
    assert.equal(paths.waitForLockRelease({
      lockPath: lock,
      pid: 100,
      timeoutMs: 1000,
      intervalMs: 50,
      isAlive: (pid) => pid === 200,
      sleep: (ms) => {
        slept += ms
        if (slept >= 100) rmSync(lock, { force: true })
      },
    }), null)
    assert.equal(slept, 100)

    // 活占用者一直不放：等满预算后返回它，调用方照常退避。
    paths.writeLock(lock, 200)
    slept = 0
    assert.equal(paths.waitForLockRelease({
      lockPath: lock,
      pid: 100,
      timeoutMs: 200,
      intervalMs: 50,
      isAlive: () => true,
      sleep: (ms) => { slept += ms },
    }), 200)
    assert.equal(slept, 200)
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
