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

test('pet-view ships the stacked bubble deck and a single page-switch dot', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 气泡缩放走共享 bubbleZoomOf、planReviewOf 走共享 __order、tip 文案走共享
  // bubble-title.cjs —— 它们的算术与文案分别由 test/pet-tip.test.js、
  // test/session-order.test.js、test/bubble-title.test.js 覆盖，这里只留结构护栏。
  assert.match(html, /SESSION_OPEN_ENDPOINT/)
  assert.doesNotMatch(html, /id="dot1"/, '页切换指示器应是单个 dot，不得回潮成多 id 版本')
  // 气泡卡文案/样式已抽到共享模块 bubble-title.cjs：两端只调用，不再各带一份副本。
  // 文案内容本身由 test/bubble-title.test.js 对纯函数逐条做行为断言（planSummaryOf /
  // tipTextOf），这里只钉结构——共享模块存在、两端确实调用、两端不留副本。
  // （早前这里还有两条 match(shared, /PLAN_MARKER…/) / match(shared, /…点击打开…/) 的
  // 字面量断言，与那份行为断言重复，改名即报红，已删。）
  const shared = readFileSync(new URL('../src/bubble-title.cjs', import.meta.url), 'utf8')
  // 供给端与消费端都要钉。只钉消费端（html 里的 script src）时，把宿主注册的
  // 路由 path 改坏整套测试照样全绿——而桌面窗拿不到 __bubbleTitle 会在
  // pet-view.html 的早失败守卫处抛错，整个桌宠模块死掉。gif-frame 那条测试
  // 有对称的两行（html 的 src + index 的 path），这里照抄。
  assert.match(html, /\/plugins\/dsh-pet-remielle\/bubble-title\.js/)
  const hostIndex = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(hostIndex, /'\/plugins\/dsh-pet-remielle\/bubble-title\.js'/, '宿主必须注册这条脚本路由，否则桌宠窗拿不到共享实现')
  assert.match(hostIndex, /new URL\('\.\.\/src\/bubble-title\.cjs'/, '宿主应从 src/bubble-title.cjs 读这份共享实现')
  for (const [name, src] of [['pet-view.html', html], ['client.core.js', readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')]]) {
    assert.match(src, /__bubbleTitle\.applyCardChrome\(/, `${name} 应调用共享的 applyCardChrome`)
    assert.match(src, /__bubbleTitle\.applyBackboardChrome\(/, `${name} 应调用共享的 applyBackboardChrome`)
    assert.doesNotMatch(src, /点击打开同意执行\/要求修改/, `${name} 不得自带计划待审提示副本`)
    // plan-review / approval 类名没有任何 CSS 规则消费，classNameOf 已不再产出它们；
    // 护栏钉住「不回归」：谁再往两端源码里写回 ' plan-review' 字面量，这里会报红。
    // 这里刻意断言字面量而不是某个表达式形状——classNameOf 是共享模块里的
    // `function classNameOf(view, index)` 声明，/classNameOf\s*=\s*'rm2-pet-bubble'\s*+/
    // 那类形状在任何源码里都不存在，断言永远不会失败，看着有覆盖实则零覆盖。
    assert.doesNotMatch(src, /' plan-review'/, `${name} 不得自带 plan-review 类名副本`)
  }
  assert.match(html, /clearPulse:\s*true/)
  // SSE 订阅带 ?client=pet：宿主据此把桌宠窗口排除在 session-action 重放计数之外
  // （与 index.js streamClientOf 的约定一致），否则"无网页在线"判定永远不成立。
  assert.match(html, /\/plugins\/dsh-pet-remielle\/stream\?client=pet/)
  // 桌面窗只展示提醒，不代替后台 DSH 标签页自动已读；完成状态只在该标签页
  // 切回可见、或用户显式点击完成卡时清除。
  assert.doesNotMatch(html, /autoAckedCompletions/)
  assert.doesNotMatch(html, /acknowledgeCompletion\(currentSessionId\)/)
  assert.match(html, /requestSessionOpen\(el\.targetSessionId, el\.completed\)/)
  assert.match(html, /if \(el\.completed\) acknowledgeCompletion\(el\.targetSessionId\)/)
  assert.match(html, /entry\.state === 'ERROR' && targetSessionOf\(entry\) === currentSessionId/)
  // 审批卡悬停提示的文案分支由 test/bubble-title.test.js 覆盖（tipTextOf），
  // 这里只钉住：提示改由自绘浮层承载（原生 title 不随 zoom 缩放已废弃），
  // 以及 tip 模块确实接上了。
  assert.match(html, /id="bubbleDot" title=""/)
  assert.doesNotMatch(html, /切到余额/)
  assert.match(html, /\/plugins\/dsh-pet-remielle\/pet-tip\.js/)
  assert.match(html, /__rm2PetTip/)
  assert.doesNotMatch(html, /允许一次：点击圆形勾号直接确认/)
  // 按住宠物时快照 apply 不得把 grabbing 打回 grab
  assert.match(html, /lockedNow \? 'default' : dragState \? 'grabbing' : 'grab'/)
  // 松手只信 pointerup/cancel + capture，不再用 mousemove 的 buttons 猜测
  assert.match(html, /setPointerCapture\(e\.pointerId\)/)
  assert.match(html, /addEventListener\('pointerup'/)
  assert.match(html, /addEventListener\('pointercancel'/)
  assert.doesNotMatch(html, /e\.buttons & 1/)
  // 二层露出量 = 卡高 − 上移量，两端都必须成立，所以**两端卡高都要钉住**。
  // 卡高真值在 CSS 里（harness stub 的 offsetHeight=68 只是近似值），因此从两端
  // 各自的 CSS 解析，而不是写死 91——写死的话改 CSS 后断言照绿，两端却已漂移。
  // 解析函数放在 test/helpers/card-height.mjs：两端各有一份 CSS 规则，各写一遍正则
  // 必然漂移。
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const liftOf = (src) => Number(/STACK_LIFT_PX = (\d+)/.exec(src)?.[1])
  assert.equal(liftOf(shared), 80)
  assert.doesNotMatch(html, /STACK_LIFT_PX = \d+/, 'pet-view.html 不得再自带上移量常量')
  assert.doesNotMatch(core, /STACK_LIFT_PX = \d+/, 'client.core.js 不得再自带上移量常量')
  assert.equal(cardHeightOf(html, 'pet-view.html'), 91, '桌面端卡高')
  assert.equal(cardHeightOf(core, 'client.core.js'), 91, '网页端卡高')
  // 假背板分支 + 三元式分支两处上移都必须引用常量、不得写死数值。
  const calls = [...shared.matchAll(/style\.marginTop = [^\n]*/g)].map((match) => match[0])
  assert.equal(calls.length, 2, '共享模块应有两处 marginTop 调用点')
  for (const call of calls) {
    assert.match(call, /STACK_LIFT_PX/, `调用点必须引用常量：${call}`)
    assert.doesNotMatch(call, /'-\d+px'/, `调用点不得写死上移量：${call}`)
  }
})

test('desktop idle-bubble click defers to an open web client but says so', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 有网页在线时不重复调 openExternal（浏览器不会复用已有标签，只会越堆越多）；
  // webClients 来自宿主快照的 SSE 订阅计数。
  assert.match(html, /if \(!\(lastSnapshot && lastSnapshot\.webClients > 0\)\) __tip\.openIdleDshPage\(window\.petBridge\)/)
  // 但「不打开」不等于「不响应」。原先这条路径直接 return，点击完全静默，用户分不清
  // 是卡住了还是被拦下了。必须给一句说明去哪儿看——这条判据本身还有已知缺口
  // （Chromium 的 tab discarding 会冻结后台标签页，SSE 连接不 close，订阅计数虚高），
  // 正是因为那个缺口会让用户看到「点了没反应」，提示才更不能少。
  assert.match(html, /else showTransientTip\(el\.node, /)
  assert.match(html, /function showTransientTip\(anchor, text, ms\)/, '一次性提示的辅助函数必须存在')
  // 提示用完要还原，否则会污染该卡后续的悬停 tooltip。
  assert.match(html, /if \(had\) anchor\.dataset\.rm2Tip = prev/)
  assert.match(html, /else delete anchor\.dataset\.rm2Tip/)
})

test('pet-view menu expands to the work-area box and restores on close', () => {
  // 打开菜单先离屏测量再定位：扩窗 ipc 往返期间菜单不能闪现在 fixed 默认位置。
  // 落点计算（锚角色 / 包围盒 / MENU_GLOW / 400×520 锚框）是 pet-view.html 的内部
  // 几何，随 Chromium 版与缩放口径变，不适合当断言对象。这里只钉住「主进程这一侧真的接得住」
  // ——渲染层与 preload 那一侧由 test/pet-preload.test.js 用 vm 注入假 electron 真调方法验证
  // （通道名 + 参数归一化 + promise 返回），比匹配源码字符串更强，故不再重复断言那三条。
  const petWindow = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.match(petWindow, /ipcMain\.handle\('get-work-area'/)
  assert.match(petWindow, /ipcMain\.handle\('menu-expand', async \(_event, cssLeft, cssTop, cssRight, cssBottom\)/)
  assert.match(petWindow, /ipcMain\.handle\('menu-restore'/)
  // 扩窗必须真的把窗口变大且可缩放，否则菜单定位算对了也会被窗口边界裁掉
  assert.match(petWindow, /setResizable\(true\)/)
  assert.match(petWindow, /setContentBounds\(bounds\)/)
  // uiZoom 注入：渲染层按缩放系数算坐标，主进程必须把同一个值下发
  assert.match(petWindow, /insertCSS\(`:root\{--rm2-ui-zoom:/)
})

// 位置持久化链路（issue #21）：三段各自的钥匙必须同时在场——
// 主进程建窗定位 + 渲染层拖动结束回写 + preload 通道；缺一段记忆就断。
test('pet window position persistence is wired across main, preload and renderer', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 恢复钳制必须是「虚拟桌面并集 + 最小可见边条」而不是单屏 workArea 整窗
  // 钳制：宠物图贴窗口底部，拖到屏幕顶缘时窗口必然部分伸出屏幕外（实测
  // y=-381），整窗钳制会把它拽回 y=0，表现为位置没记忆（issue #21 追加）。
  assert.match(main, /for \(const d of screen\.getAllDisplays\(\)\)/)
  assert.match(main, /ipcMain\.handle\('get-initial-position', \(\) => persistedPos\)/)
  // 主进程兜底回写（issue #21 "有时不记忆"）：drag-end IPC 是渲染层唯一必然
  // 发出的时点，主进程在此直接 PATCH 宿主 config，渲染层 fetch 失手也有兜底。
  // 但必须以「真实拖动」（drag 非空）为前提：渲染层对任何左键抬起都发
  // drag-end，菜单贴右扩窗会左移 x，无条件回写会把扩窗坐标存档（表现为
  // y 记忆而 x 丢失，issue #21 追加反馈）。
  assert.match(main, /const wasDragging = drag !== null/)
  assert.match(main, /if \(wasDragging\) persistPosition\(\)/)
  assert.match(main, /desktopX: Math\.round\(x\), desktopY: Math\.round\(y\)/)
  // DSH Desktop 渲染进程准入头：宿主 env 提供头名/值时，主进程必须在建窗前
  // 给同源请求自注入（否则 DSH Desktop 未开「浏览器访问」时全部 403 forbidden）。
  assert.match(main, /session\.defaultSession\.webRequest\.onBeforeSendHeaders/)
  // preload：两条 IPC 通道都暴露给渲染层
  assert.match(preload, /getInitialPosition: \(\) => ipcRenderer\.invoke\('get-initial-position'\)/)
  assert.match(preload, /getPosition: \(\) => ipcRenderer\.invoke\('get-position'\)/)
  // 渲染层：拖动结束才回写（moved 且未锁定），位置以宿主坐标为准
  assert.match(html, /dragState && dragState\.moved && !lockedNow/)
  assert.match(html, /desktopX: pos\.x, desktopY: pos\.y/)
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
  assert.match(main, /require\('\.\/pet-window-paths\.cjs'\)/, '选目录逻辑必须走共享模块')
  assert.match(main, /app\.setPath\('userData', userData\.dir\)/, '主进程必须真的把选定的目录设成 userData')
  // 宿主看门狗：ESRCH 才算宿主没了（EPERM = 进程仍在，当成「已退」会让桌面窗
  // 自己消失），轮询 1000ms —— 宿主退出后窗口最多滞留 1 秒。
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

  // 条目、顺序、写回的配置键全部由这一张表表达。原先条目名散在 EXPECTED、
  // 写回对比和逐项钉死里各写 2~3 遍，改一个菜单项要同步改三处；现在只改这里。
  //
  // keys 为空表示「菜单构造里不写配置」——「画画」「重置位置」的写在各自的动作
  // 函数里（playDraw / resetPos / 关窗），两端一致地不写，这里一并钉住防止以后
  // 一端偷偷改成直接写配置。
  const MENU = [
    { label: '角色大小', keys: ['scale'] },
    { label: '透明度', keys: ['opacity'] },
    { label: '左右镜像', keys: ['mirror'] },
    { label: '锁定位置', keys: ['locked'] },
    { label: '暂停动画', keys: ['paused'] },
    { label: '显示气泡', keys: ['showBubble', 'showBubbleStatus', 'showBubbleUsage'] },
    { label: '画画', keys: [] },
    { label: '重置位置', keys: [] },
    { label: '桌面悬浮模式', keys: ['desktopMode'] },
  ]

  // ① 条目与顺序：两端都必须与表一致（不只是同一堆条目，是同一顺序）
  const labels = MENU.map((row) => row.label)
  assert.deepEqual(rowsOf(webBody, WEB_ROW), labels, '网页端右键菜单条目/顺序与约定不符')
  assert.deepEqual(rowsOf(deskBody, DESK_ROW), labels, '桌面端右键菜单条目/顺序与约定不符')

  // 每项写回的配置键：网页端写 patchConfig('x', v) / patchConfigFields({ x: v })，
  // 桌面端写 patchConfig({ x: v })，「显示气泡」另用 body.x = ... 追加两个子开关。
  // 取「本条目的标签到下一个条目标签」之间的片段来判定，两端因此可比。
  const writesOf = (body, re) => {
    const rowLabels = rowsOf(body, re)
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
    return Object.fromEntries(rowLabels.map((l, i) => [l, keys[i]]))
  }
  const webWrites = writesOf(webBody, WEB_ROW)
  const deskWrites = writesOf(deskBody, DESK_ROW)

  // ② + ③ 一次循环同时钉住：两端写回同一组键、且就是约定的那组。
  // 分开写「两端一致」与「等于约定」两条断言会漏掉「两端一起写错」——
  // 而那正是历史上出过的 bug（同名条目一端写 A 一端写 B）。
  for (const { label, keys } of MENU) {
    assert.deepEqual(webWrites[label], keys, `网页端「${label}」写回的配置键`)
    assert.deepEqual(deskWrites[label], keys, `桌面端「${label}」写回的配置键`)
  }

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
  // 两端的 CSS 类名前缀不同（网页端 rm2-pet-、桌面端无），归一化后即可用同一张表比对
  const unprefix = (s) => flat(s).replace(/\.rm2-pet-/g, '.')

  // 菜单是定宽的（旧实现 min-width:200px 靠内容撑，状态行一长就变宽）；
  // 名称列 flex:1 吃掉余量 → 定宽滑块被推到行尾，两行滑块左右边缘对齐；
  // 可交互行的名称列不许收缩（第一次收窄到 240 时把「角色大小」挤成了「角色大…」），
  // 截断规则只留给状态行。
  const SHARED = [
    'gap:6px;padding:7px9px',                                    // 行间距 / 行内边距
    'flex:11auto;}',                                             // 名称列吃余量（不设 min-width:0 → 不收缩）
    'flex:none;width:92px',                                      // 滑块
    'flex:none;min-width:36px;text-align:right;font-size:12px',  // 百分比列
    '.menu-status>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;}', // 只有状态行截断
  ]
  for (const token of SHARED) {
    assert.ok(unprefix(core).includes(token), `网页端菜单缺少几何参数 ${token}`)
    assert.ok(unprefix(html).includes(token), `桌面端菜单缺少几何参数 ${token}`)
  }

  // 壳规则选择器两端不同名，单独取出来比；min-width 在气泡那边也用过，不能全局匹配
  const coreMenu = (core.match(/\.rm2-pet-menu\{[^}]*\}/) || [''])[0]
  const htmlMenu = (html.match(/\.menu \{[^}]*\}/) || [''])[0]
  assert.match(coreMenu, /box-sizing:border-box;width:240px/, '网页端菜单应定宽 240px')
  assert.match(htmlMenu, /box-sizing: border-box; width: 240px/, '桌面端菜单应定宽 240px')
  assert.doesNotMatch(coreMenu, /min-width/, '网页端菜单不应再用 min-width 撑宽')
  assert.doesNotMatch(htmlMenu, /min-width/, '桌面端菜单不应再用 min-width 撑宽')

  assert.doesNotMatch(unprefix(core), /\.menu-item>span:first-child\{[^}]*min-width:0/, '可交互行不应允许收缩')
  assert.doesNotMatch(unprefix(html), /\.menu-item>span:first-child\{[^}]*min-width:0/, '可交互行不应允许收缩')

  // 「名称列放得下最长滑块标签」那种按 13px 字号 × 字数反推的算术护栏已移除：
  // 字体度量随平台与缩放变，它既会假红也给不出真保证。名称列不可收缩才是真正
  // 防止「角色大…」截断的约束，上面已断言。

  // 滑块尺寸不再写在 JS 内联样式里（两端各写一份必然漂移）
  assert.doesNotMatch(core, /width:110px;margin:0 4px;accent-color/)
  assert.doesNotMatch(html, /width:110px;margin:0 4px;accent-color/)

  // 贴纸仍在解码（img 高 0）时右键：menuBoxOf 判空 → pickMenuPos 拿到 null，
  // sideMenuPos 必须自己兜底，否则读 r.right 抛错、菜单停在离屏测量位。
  //
  // 钉的是「两端都有兜底」，**不是「兜底值相同」**：网页端的边界就是视口（用窗口高
  // H），桌面悬浮窗要先扩窗到工作区（用工作区底 B），两个 H/B 不是同一个量。之前
  // 把它们并排断言成"一致"，固化的是巧合而不是契约——真按"统一"去改反而会引入 bug。
  assert.match(core, /if \(!r\) r = \{ top: H - 48/, '网页端 sideMenuPos 缺少空盒子兜底')
  assert.match(html, /if \(!r\) r = \{ top: B - 48/, '桌面端 sideMenuPos 缺少空盒子兜底')
})

// 气泡几何参数同样必须两端逐项一致。0.4.0 的 704ea4e 只放大了网页端一侧
// （圆点 10→13、背板 +N 同步放大），桌面端没跟着改，两端就一直漂着；而既有
// 护栏只覆盖右键菜单与深色配色，没有覆盖气泡本体，所以这次没人发现。
// 钉住真正漂移过的三组项（翻页圆点、背板 +N、圆点描边）。
// box-shadow 两端写法不同是有意的（桌面端走 --rm2-glow 主题变量，见深色配色测试），
// 不在本测试范围内。
test('bubble geometry (page dots / backboard count) matches across both ends', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const flat = (s) => s.replace(/\s+/g, '')
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 网页端写成 '.sel{…}'，桌面端写成 '.sel { … }'，\s* 兼容两者
  const ruleOf = (src, sel) => flat((src.match(new RegExp(esc(sel) + '\\s*\\{[^}]*\\}')) || [''])[0])
  for (const [sel, token] of [
    ['.rm2-bubble-dots', 'left:10px'],
    ['.rm2-bubble-dot', 'width:10px'],
    ['.rm2-bubble-dot', 'height:10px'],
    ['.rm2-bubble-dot', 'box-shadow:0 0 0 2px rgba(255,255,255,.65)'],
    ['.rm2-pet-bubble-stack-count', 'right:16px'],
    ['.rm2-pet-bubble-stack-count', 'height:8px'],
    ['.rm2-pet-bubble-stack-count', 'font-size:9px'],
    ['.rm2-pet-bubble-stack-count', 'line-height:8px'],
  ]) {
    const want = flat(token)
    assert.ok(ruleOf(core, sel).includes(want), `网页端 ${sel} 缺少几何参数 ${token}`)
    assert.ok(ruleOf(html, sel).includes(want), `桌面端 ${sel} 缺少几何参数 ${token}`)
  }
  // 气泡本体宽度上限两端也要一致（此前网页端写 453px、桌面端写 min(440px,…)）
  assert.ok(ruleOf(core, '.rm2-pet-bubble').includes(flat('max-width:min(440px,calc(100vw - 24px))')))
  assert.ok(ruleOf(html, '.rm2-pet-bubble').includes(flat('max-width: min(440px, calc(100vw - 24px))')))
})

// 暂停必须停在「当前帧」。canvas.drawImage(动态 GIF) 在 Chromium 里永远只画首帧
// （vendor/electron-win32-x64 实测：20 次采样跨 462ms 签名完全一致，且等于第 0 帧），
// 所以两端都要走 gif-frame 的取帧链路，并且保留首帧兜底（非安全上下文没有 ImageDecoder）。
test('pause freezes on the current frame through the shared gif-frame helper', () => {
  // 取帧算术本身由 test/gif-frame.test.js 覆盖；这里只钉住「两端真的接上了
  // 这条链路」与「宿主把脚本发得出去」，不重复验证实现细节。
  for (const [name, file] of [
    ['网页端', '../src/client.core.js'],
    ['桌面端', '../src/pet-view.html'],
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, /__gifFrame\.isGif\(/, `${name}应只在 GIF 上走取帧链路`)
    assert.match(src, /__gifFrame\.freeze\(/, `${name}应调用 freeze 取当前帧`)
  }
  // 桌面端必须有脚本标签、宿主必须把这份脚本发出去，否则整条取帧链路静默失效
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(html, /\/plugins\/dsh-pet-remielle\/gif-frame\.js/)
  assert.match(index, /'\/plugins\/dsh-pet-remielle\/gif-frame\.js'/)
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

// 宿主侧的存储 / 清理 / TTL / 拒绝坏值已由 test/host-snapshot.test.js 的
// 「theme uplink」与「snapshot carries reported host theme」以行为方式覆盖，
// 这里只钉住网页端独有的三件事。
test('host theme uplink is wired end to end between web client and host', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  // 端点必须与宿主导出的 THEME_ENDPOINT 同名
  assert.match(core, /var THEME_ENDPOINT = '\/plugins\/dsh-pet-remielle\/theme'/)
  // 宿主主题切换 = body 上 data-ds-dark-theme 的增删，必须监听属性变化而不是只在启动读一次
  assert.match(core, /attributeFilter: \['data-ds-dark-theme'\]/)
  // 网页关闭后清空上报，桌面窗回落系统主题
  assert.match(core, /function clearReportedHostTheme\(\)/)
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
 * 勾选符「✓」(U+2713) 走字体回退时字形盒高 19px、标签只有 16px；不给 .tick 压行高，
 * line-height:normal 会把该行撑到 33px（未勾选行 30px），于是「勾上 / 取消」整行抖 3px。
 * 规则两端各写一份，改一端忘另一端就是「只有一边抖」——单看任一端截图都是对的。
 * 行高数字本身不再断言（那是 Chromium 字体度量、会随平台变），只钉住两条不变量。
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
  assert.equal(flat(deskTick), flat(webTick), '两端 .tick 基础声明必须逐项相等，防一边改了另一边没跟')
  // 深色分支只准覆盖颜色。若有人把 line-height 写进主题分支，结果就是「深色下又开始抖」
  // ——浅色正常，最难发现。
  const darkTick = (html.match(/html\[data-host-theme="dark"\] \.menu-item \.tick \{([^}]*)\}/) || [])[1]
  assert.ok(darkTick, '桌面端深色 .tick 规则丢失')
  assert.doesNotMatch(darkTick, /line-height|font-weight/, '深色 .tick 只应覆盖颜色')
})
