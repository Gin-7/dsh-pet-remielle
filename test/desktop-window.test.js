/**
 * DesktopWindow tests: Electron backend candidate discovery (env override,
 * bundled runtime, npm global, dsh root, cwd fallback), start/stop lifecycle
 * with a stubbed spawn, and the no-backend fallback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backendCandidates, DesktopWindow, findRoot, findDshRoot } from '../src/desktop-window.js'

test('backend candidates prefer the bundled Electron on win32', (t) => {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'electron-win32-x64', 'electron.exe')
  if (!existsSync(bundled)) {
    t.skip('bundled Electron runtime not present')
    return
  }
  const saved = process.env.DSH_PET_ELECTRON
  try {
    delete process.env.DSH_PET_ELECTRON
    const list = backendCandidates({ platform: 'win32', cwd: 'C:/fairy' })
    assert.ok(list.length >= 1)
    assert.equal(list[0].kind, 'electron')
    assert.ok(list[0].command.includes('electron-win32-x64'))
    assert.ok(list[0].args[0].includes('pet-window.cjs'))
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
  assert.equal(spawned.options.env.DSH_PET_PARENT_PID, '1234')
  assert.equal(window.running, true)
  window.stop()
  assert.equal(window.running, false)
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

test('pet-view ships the stacked bubble deck and a single page-switch dot', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  assert.match(html, /class="rm2-pet-bubbles"/)
  assert.match(html, /class="rm2-bubble-dot"/)
  assert.match(html, /SESSION_OPEN_ENDPOINT/)
  assert.doesNotMatch(html, /id="dot1"/)
  assert.match(html, /height:\s*68px/)
  assert.match(html, /idle-placeholder/)
  assert.match(html, /clearPulse:\s*true/)
  // SSE 订阅带 ?client=pet：宿主据此把桌宠窗口排除在 session-action 重放计数之外
  // （与 index.js streamClientOf 的约定一致），否则"无网页在线"判定永远不成立。
  assert.match(html, /\/plugins\/dsh-pet-remielle\/stream\?client=pet/)
  // 当前会话完成卡自动 ack（与网页端 client.core.js 语义同构）：
  // updateBubbles 在数据层对全量 ordered 检查（完成卡被压到背板之下同样生效），
  // autoAckedCompletions 标记保证同一轮只 POST 一次，完成消失后删除标记
  // （否则同会话第二轮完成不再自动 ack）。
  assert.match(html, /completionOf\(entry\) && targetSessionOf\(entry\) === currentSessionId/)
  assert.match(html, /autoAckedCompletions\.set\(currentSessionId, true\)/)
  assert.match(html, /autoAckedCompletions\.delete\(currentSessionId\)/)
  assert.match(html, /entry\.state === 'ERROR' && targetSessionOf\(entry\) === currentSessionId/)
  // 审批卡悬停提示用第二行全文（工作区 · preview），不是固定操作说明；
  // 自绘浮层 .rm2-pet-tip 承载提示（原生 title 不随 zoom 缩放已废弃），title 置空
  assert.match(html, /approval \? \(detailShown \|\| ''\)/)
  assert.match(html, /dataset\.rm2Tip = entry\.idlePlaceholder/)
  assert.match(html, /点击跳到这里看一下~/)
  assert.match(html, /完成啦~ 点击查看结果哦/)
  assert.match(html, /轮到你啦，点击跳到这里处理呢/)
  assert.match(html, /id="bubbleDot" title=""/)
  assert.doesNotMatch(html, /切到余额/)
  assert.match(html, /\/plugins\/dsh-pet-remielle\/pet-tip\.js/)
  assert.match(html, /__rm2PetTip/)
  assert.match(html, /function syncDotTip\(/)
  assert.match(html, /function onDotLeave\(/)
  assert.match(html, /bubbleDot\.addEventListener\('mouseenter'/)
  assert.match(html, /rm2-pet-tip/)
  assert.match(html, /__tip\.layoutPetTip\(petTip, anchor/)
  assert.match(html, /function layoutPetTip\(/)
  assert.match(html, /getWorkArea\(\)\.then/)
  // 桌面 tip 不用网页 8/24 大粉影；阴影走 --rm2-glow（负 spread，避免透明窗 Bloom）
  assert.doesNotMatch(html, /\.rm2-pet-tip[\s\S]{0,400}box-shadow:\s*0 8px 24px rgba\(190/)
  assert.match(html, /--rm2-ui-zoom: 1;/)
  assert.match(html, /--rm2-glow:/)
  assert.match(html, /box-shadow: var\(--rm2-glow\)/)
  assert.match(html, /calc\(-3px \/ var\(--rm2-ui-zoom\)\)/)
  assert.doesNotMatch(html, /允许一次：点击圆形勾号直接确认/)
  // 按住宠物时快照 apply 不得把 grabbing 打回 grab
  assert.match(html, /lockedNow \? 'default' : dragState \? 'grabbing' : 'grab'/)
  // 松手只信 pointerup/cancel + capture，不再用 mousemove 的 buttons 猜测
  assert.match(html, /setPointerCapture\(e\.pointerId\)/)
  assert.match(html, /addEventListener\('pointerup'/)
  assert.match(html, /addEventListener\('pointercancel'/)
  assert.doesNotMatch(html, /e\.buttons & 1/)
})

test('pet-view menu expands to the work-area box and restores on close', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 打开菜单先离屏测量再定位：扩窗 ipc 往返期间菜单不能闪现在 fixed 默认位置
  assert.match(html, /menuEl\.style\.left = '-9999px'/)
  // 落点平时锚角色，与气泡相交才走包围盒；扩窗包围盒含 MENU_GLOW，needT 钳 ≥0
  assert.match(html, /var MENU_GLOW = 20/)
  assert.match(html, /function pickMenuPos\(/)
  assert.match(html, /function clusterRect\(/)
  assert.match(html, /function sideMenuPos\(/)
  assert.match(html, /needT = Math\.round\(Math\.max\(0, pos\.top - MENU_GLOW\)\)/)
  assert.match(html, /menuExpand\(needL, needT, needR, needB\)/)
  assert.match(html, /getWorkArea\(\)/)
  assert.match(html, /applyPetShift\(dim && dim\.dx, dim && dim\.dy\)/)
  assert.match(html, /window\.__rm2ApplyPetShift = applyPetShift/)
  assert.match(html, /layoutMenu\(W2, H2, mw, mh\)/)
  assert.match(html, /layoutMenu\(W, H, mw, mh\)/)
  assert.match(html, /Math\.min\(r\.top, B - mh - 4\)/)
  assert.match(html, /menuRestore\(\)/)
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  assert.match(preload, /getWorkArea: \(\) => ipcRenderer\.invoke\('get-work-area'\)/)
  assert.match(preload, /ipcRenderer\.invoke\(\s*'menu-expand'/)
  assert.match(preload, /menuRestore: \(\) => ipcRenderer\.invoke\('menu-restore'\)/)
  const petWindow = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.match(petWindow, /ipcMain\.handle\('get-work-area'/)
  assert.match(petWindow, /ipcMain\.handle\('menu-expand', async \(_event, cssLeft, cssTop, cssRight, cssBottom\)/)
  assert.match(petWindow, /ipcMain\.handle\('menu-restore'/)
  assert.match(petWindow, /const dx = Math\.round\(-x \/ uiZoom\)/)
  assert.match(petWindow, /win\.setOpacity\(0\)/)
  assert.match(petWindow, /__rm2ApplyPetShift/)
  assert.match(petWindow, /setResizable\(true\)/)
  assert.match(petWindow, /setContentBounds\(bounds\)/)
  assert.match(petWindow, /menuBase == null\) menuBase = \{ x: b\.x, y: b\.y, width: b\.width, height: b\.height \}/)
  assert.match(petWindow, /applyBounds\(base\)/)
  assert.match(petWindow, /getDisplayMatching/)
  assert.match(petWindow, /insertCSS\(`:root\{--rm2-ui-zoom:\$\{uiZoom\};\}`\)/)
  // .pet 顶左锚 400×520：向右/下扩原点不动；toast 仍锚 400 盒中心
  assert.match(html, /\.pet \{\s*\n\s*position: fixed; left: 0; top: 0;/)
  assert.match(html, /width: 400px; height: 520px;/)
  assert.match(html, /position: fixed; left: 200px;/)
})

test('pet-view toasts an in-bubble hint when the approval broadcast is not delivered', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // delivered=false（无网页客户端接收审批广播）时弹气泡内 toast 提示重试，
  // 取代旧的 console.warn（用户不可见）
  assert.match(html, /data\.delivered === false/)
  assert.match(html, /delivered === false\) \{\s*showToast\(\)/)
  assert.match(html, /function showToast\(\)/)
  // toast 单例节点挂 body，类名 rm2-pet-toast
  assert.match(html, /rm2-pet-toast/)
  // 旧 console.warn 文案已彻底删除
  assert.doesNotMatch(html, /允许一次未生效/)
  // 蕾米埃尔风格文案池（随机取一条，首个逗号前片段加粗）
  assert.match(html, /var TOAST_TEXTS = \[/)
  assert.match(html, /呜…允许一次没有送到呢/)
})
