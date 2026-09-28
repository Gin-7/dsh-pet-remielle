/**
 * DesktopWindow tests: Electron backend candidate discovery (env override,
 * bundled runtime, npm global, dsh root, cwd fallback), start/stop lifecycle
 * with a stubbed spawn, and the no-backend fallback.
 *
 * 关于断言风格：桌宠的渲染层是一整份 HTML 字符串 + 内联脚本，没有可在 node
 * 里驱动的 DOM，所以本文件的主手段是「读源码、匹配字面量」（177 处
 * assert.match / doesNotMatch）。这是这个场景的必然选择，不是待清理的债：
 *   · 结构类断言（「两端都调用了共享模块」「两端不得自带副本」「不得写死上移
 *     量」）防的是代码回退，正是 3b6ace9 / 704ea4e 那类改动的护栏，应保留；
 *   · 纯字面量断言（只匹配一个字符串、改个变量名就报红）若其行为已由别处覆盖
 *     （典型是 test/bubble-title.test.js 对共享纯函数的行为断言），则是重复，
 *     已删除。
 * 判断新断言该不该加：先问「它的行为是否已被 client-interactions /
 * bubble-title 等测试覆盖」，覆盖了就只留结构断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { backendCandidates, DesktopWindow, findRoot, findDshRoot } from '../src/desktop-window.js'
import { cardHeightOf } from './helpers/card-height.mjs'

/**
 * 候选发现的结构契约。
 *
 * 原先这里断言「bundled 运行时排第一」，但 bundled / npm-global / dsh-root 三个
 * 候选都要 `isUsableElectronRoot()` 判真，也就是要求那 184MB 的 Electron 运行时
 * 真的躺在磁盘上。干净 clone 与 CI 上它不存在，于是整条用例被 skip —— 看上去
 * 「跑过了」，实则零覆盖。
 *
 * 拆开看：候选**路径怎么算出来**由 test/electron-fetch.test.js 覆盖
 * （runtimeTarget / electronBinaryIn 按平台取正确文件名）；这里该管的是
 * 「凡是被选中的候选，形状是否合法」——这条不依赖本机装没装 Electron。
 */
test('every backend candidate is well-formed and points at the pet-window entry', () => {
  const saved = process.env.DSH_PET_ELECTRON
  try {
    delete process.env.DSH_PET_ELECTRON
    const list = backendCandidates({ platform: 'win32', cwd: 'C:/fairy' })
    for (const candidate of list) {
      assert.equal(candidate.kind, 'electron', '目前只支持 Electron 后端')
      assert.ok(candidate.command, '候选必须给出可执行文件路径')
      assert.ok(
        candidate.args[0].includes('pet-window.cjs'),
        `候选入口应指向 pet-window.cjs，实际 ${candidate.args[0]}`,
      )
    }
    // 本机确实装了 bundled 运行时时，顺带确认它排在最前（没装则此条自然不成立）
    if (list.some((c) => c.command.includes('electron-win32-x64'))) {
      assert.ok(list[0].command.includes('electron-win32-x64'), 'bundled 运行时应优先于 npm 全局安装')
    }
  } finally {
    if (saved !== undefined) process.env.DSH_PET_ELECTRON = saved
    else delete process.env.DSH_PET_ELECTRON
  }
})

test('backend candidates honor DSH_PET_ELECTRON first', () => {
  const saved = process.env.DSH_PET_ELECTRON
  try {
    process.env.DSH_PET_ELECTRON = 'D:/custom/electron/electron.exe'
    const list = backendCandidates({ platform: 'win32', cwd: 'C:/fairy' })
    assert.equal(list[0].command, 'D:/custom/electron/electron.exe')
  } finally {
    if (saved !== undefined) process.env.DSH_PET_ELECTRON = saved
    else delete process.env.DSH_PET_ELECTRON
  }
})

test('backend candidates on non-win32 fall back to harness electron', () => {
  const saved = process.env.DSH_PET_ELECTRON
  try {
    delete process.env.DSH_PET_ELECTRON
    const list = backendCandidates({ platform: 'darwin', cwd: 'C:/fairy' })
    assert.equal(list.some((entry) => entry.command.includes('electron-win32-x64')), false)
  } finally {
    if (saved !== undefined) process.env.DSH_PET_ELECTRON = saved
    else delete process.env.DSH_PET_ELECTRON
  }
})

test('DesktopWindow start spawns electron with env config', () => {
  let spawned = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
    backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
    parentPid: 1234,
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options }
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  assert.ok(spawned)
  assert.equal(spawned.command, 'D:/plugins/vendor/electron-win32-x64/electron.exe')
  assert.deepEqual(spawned.args, ['D:/plugins/src/pet-window.cjs'])
  assert.equal(spawned.options.windowsHide, false)
  assert.ok(spawned.options.env.DSH_PET_URL.startsWith('http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view'))
  assert.ok(spawned.options.env.DSH_PET_URL.includes('v='))
  assert.equal(spawned.options.env.DSH_WEB_URL, 'http://127.0.0.1:50336')
  assert.equal(spawned.options.env.DSH_PET_PARENT_PID, '1234')
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_NAME, undefined)
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_VALUE, undefined)
  assert.equal(window.running, true)
  window.stop()
  assert.equal(window.running, false)
})

test('DesktopWindow start passes renderer access header env when provided', () => {
  let spawned = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
    backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
    // DSH Desktop 宿主的 desktopBrowserAccess 渲染进程准入头（issue：桌面窗
    // 在 DSH Desktop 下被 403 "forbidden"）：必须原样经 env 传给窗口进程。
    rendererHeader: { name: 'x-dsh-desktop-renderer', value: 'a'.repeat(43) },
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options }
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_NAME, 'x-dsh-desktop-renderer')
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_VALUE, 'a'.repeat(43))
  window.stop()
})

test('DesktopWindow start passes DSH_WEB_URL when provided', () => {
  let spawned = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
    webUrl: 'http://127.0.0.1:50336/?token=launch-token',
    backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options }
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  assert.equal(spawned.options.env.DSH_WEB_URL, 'http://127.0.0.1:50336/?token=launch-token')
  assert.ok(spawned.options.env.DSH_PET_URL.startsWith('http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view'))
  window.stop()
})

// 位置持久化（issue #21）：有效坐标经 DSH_PET_POS_X/Y 传给子进程；缺位或
// 非 finite 时不得设置 env（子进程据此回退默认 fit / localStorage 兜底）。
test('DesktopWindow forwards persisted position via env only when both coordinates are valid', () => {
  const makeChild = () => {
    const child = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = () => { child.killed = true }
    return child
  }
  const spawnWith = (extra) => {
    let spawned = null
    const window = new DesktopWindow({
      url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
      backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
      spawnImpl: (_command, _args, options) => { spawned = { options } ; return makeChild() },
      ...extra,
    })
    window.start()
    window.stop()
    return spawned.options.env
  }
  const env = spawnWith({ posX: 120.4, posY: 88.6 })
  assert.equal(env.DSH_PET_POS_X, '120')
  assert.equal(env.DSH_PET_POS_Y, '89')
  const envHalf = spawnWith({ posX: 120, posY: null })
  assert.equal(envHalf.DSH_PET_POS_X, undefined)
  assert.equal(envHalf.DSH_PET_POS_Y, undefined)
  const envNone = spawnWith({})
  assert.equal(envNone.DSH_PET_POS_X, undefined)
  assert.equal(envNone.DSH_PET_POS_Y, undefined)
})

test('DesktopWindow without a backend stays inert', () => {
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: null,
    spawnImpl: () => { throw new Error('must not spawn') },
  })
  assert.equal(window.running, false)
  assert.equal(window.start(), undefined)
  window.stop()
})

test('DesktopWindow start is idempotent while running and fires onExit', () => {
  let calls = 0
  let exited = 0
  let childRef = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/electron.exe', args: [] },
    onExit: () => { exited += 1 },
    spawnImpl: () => {
      calls += 1
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      childRef = child
      return child
    },
  })
  window.start()
  window.start()
  assert.equal(calls, 1)
  window.stop()
  assert.equal(exited, 0)
  childRef.emit('exit')
  assert.equal(exited, 1, 'stop() 主动停掉的进程，其退出仍要通知 onExit')
})

// 旧进程的 exit 事件姗姗来迟，而用户已经重启了桌面模式：新进程正在跑，旧进程的
// 退出回调不得把它抹掉。上一版 this.child 的清理有 === child 保护、onExit 却是
// 无条件调用，于是宿主把 desktop 置空 → 宿主认为没有桌宠窗，用户再开一次就是
// 两个置顶窗，外加一个失去引用的僵尸 electron 进程。
test('a superseded window exiting late never clears the newer window', () => {
  const spawned = []
  let exited = 0
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/electron.exe', args: [] },
    onExit: () => { exited += 1 },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      spawned.push(child)
      return child
    },
  })
  window.start()
  const stale = spawned[0]
  // 旧进程没退，但调用方已经重新 start 过一次 → this.child 指向新进程
  stale.exitCode = 0
  window.start()
  assert.equal(spawned.length, 2, '前一个进程还活着时不该被判定为 running')

  stale.emit('exit')
  assert.equal(exited, 0, '被取代的旧进程退出时不得触发 onExit——那会清掉正在跑的新进程')
  assert.equal(window.running, true, '新进程应仍在运行')
})

test('onExit identifies the owning DesktopWindow instance', () => {
  let owner
  let child
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/electron.exe', args: [] },
    onExit: (instance) => { owner = instance },
    spawnImpl: () => {
      child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  child.exitCode = 0
  child.emit('exit')
  assert.equal(owner, window)
})

test('DesktopWindow reports asynchronous spawn failures through onExit once', () => {
  let exited = 0
  let childRef
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/missing/electron.exe', args: [] },
    onExit: () => { exited += 1 },
    logger: { error() {} },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      // 这个用例只走 spawn 失败 → onExit，不调 stop()，所以不挂 child.kill
      // （running getter 读 exitCode/killed，kill 方法没有调用方）
      childRef = child
      return child
    },
  })
  window.start()
  childRef.emit('error', new Error('ENOENT'))
  assert.equal(exited, 1)
  childRef.emit('exit', 1)
  assert.equal(window.running, false)
  assert.equal(exited, 1)
})

// ---------- findRoot ----------

test('findRoot walks up and finds the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fr-'))
  try {
    const root = join(dir, 'a', 'b', 'c')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'marker.txt'), '')
    assert.equal(findRoot(root, 'marker.txt'), join(dir, 'a', 'b'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findRoot returns null when marker not found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fr-'))
  try {
    mkdirSync(join(dir, 'x'), { recursive: true })
    assert.equal(findRoot(join(dir, 'x'), 'nope.txt', 3), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- findDshRoot ----------

test('findDshRoot finds a dsh-like root from argv[1]', () => {
  const saved = process.argv[1]
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dr-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'bin.js'), '')
    process.argv[1] = join(dir, 'lib', 'bin.js')
    const root = findDshRoot('C:/fallback')
    assert.equal(root, dir)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    process.argv[1] = saved
  }
})

test('findDshRoot returns fallbackCwd when no dsh root', () => {
  const saved = process.argv[1]
  try {
    process.argv[1] = '/unrelated/script.js'
    const result = findDshRoot('C:/fallback')
    assert.equal(result, 'C:/fallback')
  } finally {
    process.argv[1] = saved
  }
})
