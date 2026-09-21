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
import vm from 'node:vm'
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
  assert.equal(exited, 1)
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
      child.kill = () => { child.killed = true }
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

test('pet-view ships the stacked bubble deck and a single page-switch dot', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  assert.match(html, /class="rm2-pet-bubbles"/)
  assert.match(html, /class="rm2-bubble-dot"/)
  assert.match(html, /SESSION_OPEN_ENDPOINT/)
  assert.doesNotMatch(html, /id="dot1"/)
  assert.match(html, /height:\s*91px/)
  assert.match(html, /idle-placeholder/)
  assert.match(html, /__tip\.openIdleDshPage\(window\.petBridge\)/)
  assert.match(html, /BACKBOARD_TIP_DEBOUNCE_MS = 400/)
  assert.match(html, /__tip\.createBackboardStabilizer\(/)
  // 气泡缩放口径走共享 bubbleZoomOf（同步/固定两模式），不再直接用桌宠 scale
  assert.match(html, /bubbleEl\.style\.zoom = String\(bubbleZoom\)/)
  assert.match(html, /bubbleStack\.style\.zoom = String\(bubbleZoom\)/)
  assert.match(html, /imgEl\.style\.transform = snapshot\.mirror === true \? 'scaleX\(-1\)' : ''/)
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
  assert.match(html, /__tip\.backboardTipText\(ordered\[1\]\.project, ordered\[1\]\.title\)/)
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
  // 二层露出量：常量两端同值、四个调用点都必须引用它、算式成立、卡高从 CSS 解析。
  // 卡高真值在 CSS（stub 的 offsetHeight=68 不可信），所以断言里不能写死 91——否则
  // 改 CSS 后断言照绿，就是上一轮那种"假绿"。
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const liftOf = (src) => Number(/STACK_LIFT_PX = (\d+)/.exec(src)?.[1])
  const cardHeightOf = (src) => {
    const rule = /\.rm2-pet-bubbles \.rm2-pet-bubble\s*\{[^}]*\}/.exec(src)?.[0] ?? ''
    return Number(/(?<!-)height:\s*(\d+)px/.exec(rule)?.[1])
  }
  assert.equal(liftOf(html), 80)
  assert.equal(liftOf(core), liftOf(html))
  assert.equal(cardHeightOf(html), 91)
  assert.equal(cardHeightOf(core), 91)
  assert.ok(
    Math.abs((cardHeightOf(core) - liftOf(core)) * 0.75 - 8) <= 0.5,
    `75% 档位露出应约 8px，实际 ${(cardHeightOf(core) - liftOf(core)) * 0.75}px`,
  )
  // 每端各有两处调用点（假背板分支 + 三元式分支），都必须引用常量、不得写死上移量。
  for (const [name, src] of [['client.core.js', core], ['pet-view.html', html]]) {
    const calls = [...src.matchAll(/style\.marginTop = [^\n]*/g)].map((match) => match[0])
    assert.equal(calls.length, 2, `${name} 应有两处 marginTop 调用点`)
    for (const call of calls) {
      assert.match(call, /STACK_LIFT_PX/, `${name} 的调用点必须引用常量：${call}`)
      assert.doesNotMatch(call, /'-\d+px'/, `${name} 的调用点不得写死上移量：${call}`)
    }
  }
})

test('desktop idle-bubble click defers to an open web client', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 有网页在线时不重复调 openExternal（浏览器不会复用已有标签，只会越堆越多）；
  // webClients 来自宿主快照的 SSE 订阅计数。
  assert.match(html, /if \(!\(lastSnapshot && lastSnapshot\.webClients > 0\)\) __tip\.openIdleDshPage\(window\.petBridge\)/)
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

// 位置持久化链路（issue #21）：三段各自的钥匙必须同时在场——
// 主进程建窗定位 + 渲染层拖动结束回写 + preload 通道；缺一段记忆就断。
test('pet window position persistence is wired across main, preload and renderer', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 主进程：env 坐标解析 + 建窗即定位 + 可达性钳制 + 初始位置查询
  assert.match(main, /DSH_PET_POS_X/)
  assert.match(main, /const persistedPos = Number\.isFinite\(envPosX\) && Number\.isFinite\(envPosY\)/)
  assert.match(main, /\.\.\.\(persistedPos \? \{ x: persistedPos\.x, y: persistedPos\.y \} : \{\}\)/)
  // 恢复钳制必须是「虚拟桌面并集 + 最小可见边条」而不是单屏 workArea 整窗
  // 钳制：宠物图贴窗口底部，拖到屏幕顶缘时窗口必然部分伸出屏幕外（实测
  // y=-381），整窗钳制会把它拽回 y=0，表现为位置没记忆（issue #21 追加）。
  assert.match(main, /for \(const d of screen\.getAllDisplays\(\)\)/)
  assert.match(main, /const KEEP = 80/)
  assert.match(main, /ipcMain\.handle\('get-initial-position', \(\) => persistedPos\)/)
  // 主进程兜底回写（issue #21 "有时不记忆"）：drag-end IPC 是渲染层唯一必然
  // 发出的时点，主进程在此直接 PATCH 宿主 config，渲染层 fetch 失手也有兜底。
  // 但必须以「真实拖动」（drag 非空）为前提：渲染层对任何左键抬起都发
  // drag-end，菜单贴右扩窗会左移 x，无条件回写会把扩窗坐标存档（表现为
  // y 记忆而 x 丢失，issue #21 追加反馈）。
  assert.match(main, /function persistPosition\(\)/)
  assert.match(main, /desktopX: Math\.round\(x\), desktopY: Math\.round\(y\)/)
  assert.match(main, /const wasDragging = drag !== null/)
  assert.match(main, /if \(wasDragging\) persistPosition\(\)/)
  // DSH Desktop 渲染进程准入头：宿主 env 提供头名/值时，主进程必须在建窗前
  // 给同源请求自注入（否则 DSH Desktop 未开「浏览器访问」时全部 403 forbidden）。
  assert.match(main, /DSH_PET_RENDERER_HEADER_NAME/)
  assert.match(main, /session\.defaultSession\.webRequest\.onBeforeSendHeaders/)
  // preload：两条 IPC 通道都暴露给渲染层
  assert.match(preload, /getInitialPosition: \(\) => ipcRenderer\.invoke\('get-initial-position'\)/)
  assert.match(preload, /getPosition: \(\) => ipcRenderer\.invoke\('get-position'\)/)
  // 渲染层：宿主坐标优先、localStorage 降级；拖动结束主动回写（moved 才写）
  assert.match(html, /initialPosKnown\.then/)
  assert.match(html, /function persistWindowPos\(\)/)
  assert.match(html, /desktopX: pos\.x, desktopY: pos\.y/)
  assert.match(html, /dragState && dragState\.moved && !lockedNow/)
})

// pet-window 的 userData 目录（issue #21 追加建议）：原实现落在 %TEMP%，会被
// 系统磁盘清理整目录删掉（Electron 缓存 + 渲染层 localStorage 位置兜底一起丢）；
// 直接与宿主共用默认的 %APPDATA%/Electron 又会锁住磁盘缓存、服务到陈旧响应。
// 现改用稳定目录 + 占用标记，稳定目录被活跃实例占用时退避到带 pid 的兄弟目录。
// 决策细节由单测覆盖（test/pet-window-paths.test.js），这里钉住主进程真的把这条
// 链路接上了 —— 也钉住「宿主看门狗」的判据与间隔，它是重叠窗口的另一半。
test('pet window userData is stable, host-isolated and held by one instance at a time', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /getPath\('temp'\)/, 'userData 不得再落在 %TEMP%')
  assert.match(main, /require\('\.\/pet-window-paths\.cjs'\)/)
  assert.match(main, /const appDataDir = app\.getPath\('appData'\)/)
  // 选目录前先读占用标记；选中后退避者不碰标记（ownsLock 为假），只由稳定
  // 目录的主人写、退、放。
  assert.match(main, /resolveUserDataDir\(\{/)
  assert.match(main, /readOccupantPid\(petWindowPaths\.lockPathOf\(appDataDir\)\)/)
  assert.match(main, /app\.setPath\('userData', userData\.dir\)/)
  assert.match(main, /if \(userData\.ownsLock\) petWindowPaths\.writeLock\(userData\.lockPath, process\.pid\)/)
  assert.match(main, /app\.on\('will-quit',[\s\S]{0,240}releaseLock\(userData\.lockPath, process\.pid\)/)
  // 宿主看门狗：ESRCH 才算宿主没了（EPERM = 进程仍在，当成「已退」会让桌面窗
  // 自己消失），轮询 1000ms —— 宿主退出后窗口最多滞留 1 秒，同时也把新旧实例的
  // userData 重叠窗口一起压到 1 秒内。
  assert.match(main, /const hostGone = \(\) => \{/)
  assert.match(main, /return Boolean\(error && error\.code === 'ESRCH'\)/)
  assert.match(main, /\}, 1000\)/)
  assert.doesNotMatch(main, /\}, 3000\)/, '看门狗间隔不应回到 3000ms')
})

// 右键菜单两端必须同骨架、**同顺序**、同名、同写入目标。
// 历史病：曾经网页端只有「暂停动画 / 重置位置 / 桌面悬浮模式」，桌面端只有
// 「画画 / 用量模式 / 切换到网页模式」——同一份配置在两端显示不同名字。也曾经
// 只改一端的几何/条目而另一端点没跟着改，没人发现（改动只落在一端）。
// 所以这里做三层断言，任一层破即报红：
//   ① 条目与顺序相等（不只是同一堆条目的集合）
//   ② 每项写回的配置键相同（同名条目改同一份配置，避免一端写 A 另一端写 B）
//   ③ 关键项的写入目标逐个钉死（否则两端一起写错也算“一致”）
test('in-page and desktop right-click menus keep the same rows, order and write targets', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')

  // 菜单是 IIFE 闭包，只能按相邻函数名切片取菜单构造函数体。边界失效会当场
  // 抛错（而不是静默返回空数组让后面的断言假通过）。
  const slice = (src, from, to) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a + 1)
    assert.ok(a >= 0 && b > a, `菜单切片失败，测试边界名需随源码更新：${from} .. ${to}`)
    return src.slice(a, b)
  }
  const webBody = slice(core, 'function buildMenuContent()', 'function menuBoxOf(')
  const deskBody = slice(html, 'function buildMenu() {', 'function menuBoxOf(')

  // 条目的构造函数：网页端 makeToggleRow/makeActionRow/makeSliderRow，桌面端
  // menuRow/menuSliderRow。状态行文案是动态拼接的，不属于条目。
  const WEB_ROW = /(?:makeToggleRow|makeActionRow|makeSliderRow)\(\s*'([^']+)'/g
  const DESK_ROW = /(?:menuRow|menuSliderRow)\(\s*'([^']+)'/g
  const rowsOf = (body, re) => [...body.matchAll(re)].map((m) => m[1])
  const EXPECTED = [
    '角色大小', '透明度', '左右镜像', '锁定位置',
    '暂停动画', '显示气泡', '画画', '重置位置', '桌面悬浮模式',
  ]
  assert.deepEqual(rowsOf(webBody, WEB_ROW), EXPECTED, '网页端右键菜单条目/顺序与约定不符')
  assert.deepEqual(rowsOf(deskBody, DESK_ROW), EXPECTED, '桌面端右键菜单条目/顺序与约定不符')

  // 每项写回的配置键：网页端写 patchConfig('x', v) / patchConfigFields({ x: v })，
  // 桌面端写 patchConfig({ x: v })，「显示气泡」另用 body.x = ... 追加两个子开关。
  // 取「本条目的标签到下一个条目标签」之间的片段来判定，两端因此可比。
  const writesOf = (body, re) => {
    const labels = rowsOf(body, re)
    const marks = [...body.matchAll(re)].map((m) => m.index)
    const keys = marks.map((at, i) => {
      const chunk = body.slice(at, i + 1 < marks.length ? marks[i + 1] : body.length)
      const found = new Set()
      for (const m of chunk.matchAll(/patchConfig(?:Fields)?\(\s*'([A-Za-z]+)'/g)) found.add(m[1])
      for (const m of chunk.matchAll(/patchConfig(?:Fields)?\(\s*\{([\s\S]*?)\}/g)) {
        for (const k of m[1].matchAll(/([A-Za-z]+)\s*:/g)) found.add(k[1])
      }
      for (const m of chunk.matchAll(/body = \{([\s\S]*?)\}/g)) {
        for (const k of m[1].matchAll(/([A-Za-z]+)\s*:/g)) found.add(k[1])
      }
      for (const m of chunk.matchAll(/\bbody\.([A-Za-z]+)\s*=/g)) found.add(m[1])
      return [...found].sort()
    })
    return Object.fromEntries(labels.map((l, i) => [l, keys[i]]))
  }
  const webWrites = writesOf(webBody, WEB_ROW)
  const deskWrites = writesOf(deskBody, DESK_ROW)
  for (const label of EXPECTED) {
    assert.deepEqual(deskWrites[label], webWrites[label], `「${label}」两端写回的配置键不一致`)
  }
  // 「重置位置」「画画」的写在各自的动作函数里（resetPos / playDraw / 关窗），
  // 菜单构造里不写配置——两端一致地不写，单独钉住防止以后一端偷偷改成直接写。
  assert.deepEqual(webWrites['重置位置'], [])
  assert.deepEqual(deskWrites['重置位置'], [])
  assert.deepEqual(webWrites['画画'], [])
  assert.deepEqual(deskWrites['画画'], [])
  // 关键项的写入目标逐个钉死
  assert.deepEqual(webWrites['角色大小'], ['scale'])
  assert.deepEqual(webWrites['透明度'], ['opacity'])
  assert.deepEqual(webWrites['左右镜像'], ['mirror'])
  assert.deepEqual(webWrites['锁定位置'], ['locked'])
  assert.deepEqual(webWrites['暂停动画'], ['paused'])
  assert.deepEqual(webWrites['显示气泡'], ['showBubble', 'showBubbleStatus', 'showBubbleUsage'])
  assert.deepEqual(webWrites['桌面悬浮模式'], ['desktopMode'])
  // 判定为「只留设置页」的项不得回流到任一端菜单
  assert.doesNotMatch(core, /Row\('用量模式'/)
  assert.doesNotMatch(html, /menuRow\('用量模式'|menuRow\('切换到网页模式'/)
})

// 「重置位置」必须同时覆盖页面内坐标与桌面窗坐标，并在桌面端清掉渲染层
// localStorage 兜底存档——否则下次启动渲染层会拿旧存档 moveTo，把重置撤销。
test('reset position covers both position stores and clears the localStorage fallback', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const ALL_FOUR = /\{\s*posX: null,\s*posY: null,\s*desktopX: null,\s*desktopY: null\s*\}/
  assert.match(core, ALL_FOUR, '网页端「重置位置」应清空四个坐标')
  // 设置页那枚「重置位置」按钮曾经误打 /desktop/start，按下去反而拉起桌面窗
  assert.doesNotMatch(core, /DESKTOP_ENDPOINT \+ '\/start'/)
  assert.match(html, /localStorage\.removeItem\('dsh-pet-window-pos'\)/)
  assert.match(html, /window\.petBridge\.resetPosition\(\)/)
  assert.match(preload, /resetPosition: \(\) => ipcRenderer\.invoke\('reset-position'\)/)
  assert.match(main, /ipcMain\.handle\('reset-position'/)
  assert.match(main, ALL_FOUR)
  // 菜单仍开着时点重置：必须先作废 menuBase，否则 closeMenu → menu-restore
  // 会按它把窗口搬回重置前的位置
  assert.match(main, /ipcMain\.handle\('reset-position'[\s\S]{0,200}menuBase = null/)
})

// 菜单几何参数两端必须逐项一致：网页端写在 client.core.js 的内联 CSS 字符串里，
// 桌面端写在 pet-view.html 的 <style> 里，格式不同但数值必须相同，否则同一份
// 配置在两个壳里长得不一样。顺带钉住「更窄 + 滑块对齐」这两项调整：
//   ① 菜单定宽 240px（旧实现 min-width:200px 靠内容撑，状态行一长就变宽）
//   ② 名称列 flex:1 吃掉余量 → 定宽滑块被推到行尾，两行滑块左右边缘对齐
//   ③ 名称列不许收缩（第一次收窄到 240 时把「角色大小」挤成了「角色大…」），
//      并附一条按几何参数算出来的「名称列放得下最长标签」护栏
test('menu geometry (width / row metrics / slider column) matches across both ends', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const flat = (s) => s.replace(/\s+/g, '')
  // 菜单壳规则单独取出断言定宽：min-width 在别处（气泡）也用过，不能全局匹配
  const coreMenu = (core.match(/\.rm2-pet-menu\{[^}]*\}/) || [''])[0]
  const htmlMenu = (html.match(/\.menu \{[^}]*\}/) || [''])[0]
  assert.match(coreMenu, /box-sizing:border-box;width:240px/, '网页端菜单应定宽 240px')
  assert.match(htmlMenu, /box-sizing: border-box; width: 240px/, '桌面端菜单应定宽 240px')
  assert.doesNotMatch(coreMenu, /min-width/, '网页端菜单不应再用 min-width 撑宽')
  assert.doesNotMatch(htmlMenu, /min-width/, '桌面端菜单不应再用 min-width 撑宽')
  for (const token of [
    'gap:6px;padding:7px9px', // 行间距 / 行内边距
    'flex:11auto;}', // 名称列吃余量（且不设 min-width:0 → 不收缩）
    'flex:none;width:92px', // 滑块
    'flex:none;min-width:36px;text-align:right;font-size:12px', // 百分比列
  ]) {
    assert.ok(flat(core).includes(token), `网页端菜单缺少几何参数 ${token}`)
    assert.ok(flat(html).includes(token), `桌面端菜单缺少几何参数 ${token}`)
  }
  // 可交互行的名称列必须**不可收缩**：一旦允许收缩，菜单变窄就会静默截成
  // 「角色大…」而不是暴露成溢出。截断规则只留给状态行（.rm2-pet-menu-status /
  // .menu-status），两端都要按这个归属拆开。
  assert.match(flat(core), /\.rm2-pet-menu-status>span:first-child\{min-width:0;overflow:hidden;text-overflow:ellipsis;\}/)
  assert.match(flat(html), /\.menu-status>span:first-child\{min-width:0;overflow:hidden;text-overflow:ellipsis;\}/)
  assert.doesNotMatch(flat(core), /\.rm2-pet-menu-item>span:first-child\{[^}]*min-width:0/, '可交互行不应允许收缩')
  assert.doesNotMatch(flat(html), /\.menu-item>span:first-child\{[^}]*min-width:0/, '可交互行不应允许收缩')
  // 名称列宽度必须放得下最长的滑块标签（「角色大小」4 字）：把几何参数从 CSS 里
  // 解析出来算一遍，而不是靠人肉估算——菜单再收窄、滑块再变宽，这里就会报红。
  const num = (src, re) => Number((src.match(re) || [])[1])
  const menuW = num(flat(core), /\.rm2-pet-menu\{[^}]*width:(\d+)px/)
  const menuPad = num(flat(core), /\.rm2-pet-menu\{[^}]*padding:(\d+)px/)
  const rowPad = num(flat(core), /\.rm2-pet-menu-item\{[^}]*padding:7px(\d+)px/)
  const gap = num(flat(core), /\.rm2-pet-menu-item\{[^}]*gap:(\d+)px/)
  const slider = num(flat(core), /\.rm2-pet-menu-slider\{[^}]*width:(\d+)px/)
  const pct = num(flat(core), /\.rm2-pet-menu-pct\{[^}]*min-width:(\d+)px/)
  assert.ok(menuW && menuPad && rowPad && gap && slider && pct, '未能从 CSS 解析出菜单几何参数')
  const labelRoom = menuW - 2 * 1 - 2 * menuPad - 2 * rowPad - (slider + 4) - pct - 2 * gap
  const longestSliderLabel = 4 // 「角色大小」= 4 个汉字，13px 字号下按 1em/字算
  const needed = longestSliderLabel * 13 + 6 // 留 6px 余量，避免亚像素把字挤掉
  assert.ok(labelRoom >= needed, `名称列仅 ${labelRoom}px，放不下最长的滑块标签（需 ${needed}px）`)
  // 滑块尺寸不再写在 JS 内联样式里（两端各写一份必然漂移）
  assert.doesNotMatch(core, /width:110px;margin:0 4px;accent-color/)
  assert.doesNotMatch(html, /width:110px;margin:0 4px;accent-color/)
  // 贴纸仍在解码（img 高 0）时右键：menuBoxOf 判空 → pickMenuPos 拿到 null，
  // sideMenuPos 必须自己兜底，否则读 r.right 抛错、菜单停在离屏测量位。
  assert.match(core, /if \(!r\) r = \{ top: H - 48/, '网页端 sideMenuPos 缺少空盒子兜底')
  assert.match(html, /if \(!r\) r = \{ top: B - 48/, '桌面端 sideMenuPos 缺少空盒子兜底')
})

// 暂停必须停在「当前帧」。canvas.drawImage(动态 GIF) 在 Chromium 里永远只画首帧
// （vendor/electron-win32-x64 实测：20 次采样跨 462ms 签名完全一致，且等于第 0 帧），
// 所以两端都要走 gif-frame 的取帧链路，并且保留首帧兜底（非安全上下文没有 ImageDecoder）。
test('pause freezes on the current frame through the shared gif-frame helper', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const helper = readFileSync(new URL('../src/gif-frame.cjs', import.meta.url), 'utf8')
  for (const [name, src, fallback] of [
    ['网页端', core, /snapshotFirstFrame\(\)/],
    ['桌面端', html, /snapshotPetFirstFrame\(\)/],
  ]) {
    assert.match(src, /__gifFrame\.isGif\(url\)/, `${name}应只在 GIF 上走取帧链路`)
    assert.match(src, /__gifFrame\.livedMs\(/, `${name}应先取「已播放时长」再解码`)
    assert.match(src, /\.freeze\(url, elapsed\)/, `${name}应调用 freeze 取当前帧`)
    assert.match(src, /(?:!paused|!petPaused) \|\| img\w*\.src !== url/, `${name}解出结果时要防止被按在旧帧上`)
    assert.match(src, fallback, `${name}应保留首帧快照兜底`)
    // 悬停预热：解 120–160 帧要 0.1–0.4s，不预热点下去会先看到旧帧再跳一下
    assert.match(src, /pauseRow\.addEventListener\('mouseenter'/, `${name}暂停行应有悬停预热`)
  }
  // 桌面端必须有脚本标签、宿主必须把这份脚本发出去，否则整条取帧链路静默失效
  assert.match(html, /\/plugins\/dsh-pet-remielle\/gif-frame\.js/)
  assert.match(index, /'\/plugins\/dsh-pet-remielle\/gif-frame\.js'/)
  assert.match(index, /src\/gif-frame\.cjs/)
  assert.match(helper, /function indexAt\(/)
})

/**
 * 两端深色配色必须由同一个来源触发。桌面悬浮窗是独立 Electron 窗口，读不到宿主
 * 页面的 body[data-ds-dark-theme]，只能吃网页端上报的 hostTheme——没有这条链路时
 * 它跟系统主题走，「系统深色 + DSH 浅色主题」就成了两端菜单/气泡不同色的最常见场景。
 */
function desktopThemeOf(theme, systemDark) {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const block = html.match(/var systemDarkQuery = [\s\S]*?^\s*syncHostTheme\(''\)/m)
  assert.ok(block, 'missing syncHostTheme block in pet-view.html')
  const attrs = {}
  vm.runInNewContext(`${block[0]}\nsyncHostTheme(${JSON.stringify(theme)})`, {
    document: { documentElement: { setAttribute: (key, value) => { attrs[key] = value } } },
    window: { matchMedia: () => ({ matches: systemDark, addEventListener() {} }) },
  })
  return attrs['data-host-theme']
}

test('desktop pet view takes dark from the host report and falls back to the system', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 深色规则只认属性，不许再用 prefers-color-scheme 媒体查询：媒体查询与属性同时
  // 命中时谁赢取决于源顺序，两套规则同时存在就等于把配色交给规则顺序去掷骰子。
  assert.equal(
    /@media\s*\(prefers-color-scheme:\s*dark\)/.test(html),
    false,
    'pet-view.html 不应再用深色媒体查询（改用 html[data-host-theme]，由 syncHostTheme 折算）',
  )
  for (const selector of ['.menu', '.rm2-pet-bubble', '.rm2-pet-tip', '.rm2-pet-toast']) {
    assert.ok(
      html.includes(`html[data-host-theme="dark"] ${selector} {`),
      `${selector} 缺少深色规则（应写成 html[data-host-theme="dark"] ${selector} { … }）`,
    )
  }
  // 快照字段是桌面窗唯一的宿主主题来源；离开这条 link 上面的样式就永远挂不上
  assert.match(html, /syncHostTheme\(snapshot\.hostTheme\)/)

  // 真实执行抽取出的折算逻辑：宿主上报优先，没有上报（字段缺失/空串）才看系统偏好
  assert.equal(desktopThemeOf('dark', false), 'dark', '宿主深色时不该被系统浅色翻回')
  assert.equal(desktopThemeOf('light', true), 'light', '宿主浅色时不该被系统深色翻回')
  assert.equal(desktopThemeOf('', true), 'dark', '未上报时应回落系统深色')
  assert.equal(desktopThemeOf('', false), 'light')
  assert.equal(desktopThemeOf(undefined, true), 'dark', '字段缺失（无网页在线）应回落系统深色')
  assert.equal(desktopThemeOf('Dark', true), 'dark', '非法值视为未上报')
})

test('host theme uplink is wired end to end between web client and host', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // 端点三处必须同名：常量、宿主快照读取、网页端 POST 目标
  assert.match(index, /export const THEME_ENDPOINT = '\/plugins\/dsh-pet-remielle\/theme'/)
  assert.match(index, /path: THEME_ENDPOINT/)
  assert.match(core, /var THEME_ENDPOINT = '\/plugins\/dsh-pet-remielle\/theme'/)
  // 宿主主题切换 = body 上 data-ds-dark-theme 的增删，必须监听属性变化而不是只在启动读一次
  assert.match(core, /attributeFilter: \['data-ds-dark-theme'\]/)
  // 心跳：宿主侧上报值带 TTL（页面被强杀时清空上报不会执行），只在变化时上报
  // 会让 TTL 到期后桌面窗静默回落系统主题，两端又不同色
  assert.match(core, /HOST_THEME_HEARTBEAT_MS/)
  assert.match(index, /HOST_THEME_TTL_MS/)
  // 网页关闭后清空上报，桌面窗回落系统主题
  assert.match(core, /function clearReportedHostTheme\(\)/)
  // 快照带出：桌面窗只能从快照拿主题
  assert.match(index, /hostTheme: themeOf\(\) \|\| undefined/)
  assert.match(index, /getTheme: \(\) => \(Date\.now\(\) - reportedHostThemeAt < HOST_THEME_TTL_MS/)
})

/**
 * 两端深色配色是同一套色值，却写在不同文件（网页端 CSS 在 client.core.js、
 * 桌面端在 pet-view.html），而且两边的宿主前缀与类名前缀都不同。改一端忘了另一端，
 * 从任一端截图上看都是对的——只有并排对比才发现。这里归一化后逐条比。
 */
test('both ends paint identical dark colors for the widgets they share', () => {
  const collect = (src, prefix) => {
    const map = new Map()
    // 选择器与声明都不含引号：网页端 CSS 是 JS 字符串，注释里会引用同名选择器，
    // 不加这道限制会把注释文字当成一条规则吃进来。
    const re = new RegExp(`${prefix}([^{}']+?)\\{([^{}']*)\\}`, 'g')
    for (const m of src.matchAll(re)) {
      // 空白归一化：网页端 CSS 压成一行（无空格），桌面端写了空格，纯格式差异不算漂移
      map.set(m[1].trim().replace(/\.rm2-pet-/g, '.'), m[2].replace(/\s+/g, ''))
    }
    return map
  }
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const web = collect(core, 'body\\[data-ds-dark-theme\\]')
  const desktop = collect(html, 'html\\[data-host-theme="dark"\\]')
  const shared = [...web.keys()].filter((key) => desktop.has(key))
  // 阈值护栏：归一化一旦失效（正则吃不到规则）共享集合会萎缩，比对就变成空转
  assert.ok(shared.length >= 11, `两端共享的深色规则只剩 ${shared.length} 条，归一化可能失效`)
  // 已知有意差异：桌面窗底下是真桌面，深色壳用实色；网页端用 .96 半透明（页面底不透明）
  const alphaShell = ['.bubble', '.menu', '.tip']
  const diffs = shared.filter((key) => web.get(key) !== desktop.get(key)).sort()
  assert.deepEqual(diffs.filter((key) => !alphaShell.includes(key)), [], '两端深色色值出现漂移')
  assert.deepEqual(diffs, [...alphaShell].sort(), '已知的「实色壳 vs 半透明」清单变了，需同步两端')
  // 抽样确认色值本身（防止比对逻辑失效后测试依旧全绿）
  assert.equal(desktop.get('.menu'), 'background:#48142a;border-color:rgba(255,150,185,.42);color:#ffd6e4;')
  assert.equal(web.get('.menu'), 'background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;')
  assert.equal(desktop.get('.menu-item .tick'), 'color:#ffb3c9;')
  assert.equal(desktop.get('.bubble'), 'background:#48142a;border-color:rgba(255,150,185,.42);color:#ffd6e4;')
})

/**
 * 勾选符「✓」(U+2713) 在本机走字体回退：字形盒高 19px，而标签只有 16px。
 * 不给 .tick 压行高时 line-height:normal 会把该行撑到 33px（未勾选行 30px），
 * 于是「勾上 / 取消」整行抖 3px。规则两端各写一份，改一端忘另一端就是
 * 「只有一边抖」—— 单看任一端截图都是对的，并排切换才发现。
 *
 * 实测（headless Chromium，.global_ignored/menu-row-height-probe.mjs）：
 *   baseline 行高 [30,30,30,33,30] → 加 line-height:1 后 [30,30,30,30,30]，两端一致。
 */
test('the tick glyph does not change the row height on either end', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const flat = (s) => s.replace(/\s+/g, '')
  // 行首锚定是必需的：桌面端的深色规则 `html[data-host-theme="dark"] .menu-item .tick {...}`
  // 也以同名前缀结尾，不锚定就会先匹配到它（那条只在深色下生效，浅色下照旧抖）。
  const webTick = (core.match(/^\s*'\.rm2-pet-menu-item \.tick\{([^}]*)\}',$/m) || [])[1]
  const deskTick = (html.match(/^\s*\.menu-item \.tick \{([^}]*)\}$/m) || [])[1]
  assert.ok(webTick, '网页端 .rm2-pet-menu-item .tick 规则丢失')
  assert.ok(deskTick, '桌面端 .menu-item .tick 规则丢失')
  assert.match(flat(webTick), /line-height:1;?$/, '网页端 tick 必须压掉自己的行高贡献')
  assert.match(flat(deskTick), /line-height:1;?$/, '桌面端 tick 必须压掉自己的行高贡献')
  // 基础声明逐项相等：色值 / 字重 / 行高，防止一边改了字重另一边没跟。
  assert.equal(flat(deskTick), flat(webTick), '两端 .tick 基础声明不一致')
  // 深色分支只准覆盖颜色。若有人把 line-height 写进主题分支，
  // 结果就是「深色下又开始抖」——浅色正常，最难发现。
  const darkTick = (html.match(/html\[data-host-theme="dark"\] \.menu-item \.tick \{([^}]*)\}/) || [])[1]
  assert.ok(darkTick, '桌面端深色 .tick 规则丢失')
  assert.doesNotMatch(darkTick, /line-height|font-weight/, '深色 .tick 只应覆盖颜色')
  // 勾选 span 的插入条件两端必须一致：都只在「开」时插入。
  // 桌面端旧写法（value !== null && value !== undefined）会给未勾选行插一个**空** span，
  // 而 flex 布局里空 span 照占一个 gap 位 → 名称列比网页端窄 6px。
  assert.match(flat(core), /makeRow\(label,on\?'✓':''\)/, '网页端应在「开」时插入勾选 span')
  assert.match(flat(html), /if\(value\)\{varmark=document\.createElement\('span'\)/, '桌面端应在「开」时插入勾选 span')
  assert.doesNotMatch(flat(html), /value!==null&&value!==undefined/, '未勾选行不得再插空 span（两端 DOM 结构须一致）')
})
