/**
 * DesktopWindow tests: Electron backend candidate discovery (env override,
 * bundled runtime, npm global, dsh root, cwd fallback), start/stop lifecycle
 * with a stubbed spawn, and the no-backend fallback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backendCandidates, DesktopWindow, findRoot, findDshRoot } from '../src/desktop-window.js'

test('backend candidates prefer the bundled Electron on win32', () => {
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
})

test('pet-view menu expands the desktop window rightward/upward and restores on close', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 打开菜单先离屏测量再定位：扩窗 ipc 往返期间菜单不能闪现在 fixed 默认位置
  assert.match(html, /menuEl\.style\.left = '-9999px'/)
  // 扩窗需求双参：宽 = 图片右缘 + 间距 + 菜单宽 + 右侧光晕 24，高 = 菜单顶对齐
  // 图像顶（r.top）+ 底部光晕 40；任一超当前视口才发起扩窗
  assert.match(html, /var needW = Math\.round\(r\.right \+ 8 \+ mw \+ 24\)/)
  assert.match(html, /var needH = Math\.round\(r\.top \+ mh \+ 40\)/)
  assert.match(html, /\(needW > W \|\| needH > H\)/)
  assert.match(html, /menuExpand\(needW, needH\)/)
  // invoke 返回实际生效的 {width,height}（CSS px），按它布局；往返期间菜单被关则
  // 跳过；扩窗失败/无桥时回退当前窗口内的兜底布局（与网页端同一套公式）
  assert.match(html, /layoutMenu\(\(dim && Number\(dim\.width\)\) \|\| W, \(dim && Number\(dim\.height\)\) \|\| H, mw, mh, r\)/)
  assert.match(html, /layoutMenu\(W, H, mw, mh, r\)/)
  // 菜单 top 的底部钳制留白 24px
  assert.match(html, /Math\.min\(r\.top, H - mh - 24\)/)
  // 关菜单还原窗口
  assert.match(html, /menuRestore\(\)/)
  // preload 桥双参透传 CSS 宽高，与主进程 handler 成对存在
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  assert.match(preload, /menuExpand: \(width, height\) => ipcRenderer\.invoke\('menu-expand', Number\(width\) \|\| 0, Number\(height\) \|\| 0\)/)
  assert.match(preload, /menu-restore/)
  const petWindow = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.match(petWindow, /ipcMain\.handle\('menu-expand', \(_event, cssWidth, cssHeight\)/)
  assert.match(petWindow, /ipcMain\.on\('menu-restore'/)
  // 宽度只向右扩展（x 不动）：任何窗口位移都会拖动内容闪现（渲染层 flex 重排
  // 滞后 setBounds 一帧），对称扩宽必然移动 x，是开/关菜单闪现的根源
  assert.match(petWindow, /const growR = wantW > b\.width/)
  assert.match(petWindow, /Math\.min\(wantW - b\.width, wa \? \(wa\.x \+ wa\.width\) - \(b\.x \+ b\.width\) : wantW - b\.width\)/)
  // 高度只向上扩展（底缘不动）且钳制非负：窗口顶超出工作区（桌宠拖到屏幕顶端
  // 之上）时旧版算出负 growUp，窗口被压矮下移、菜单截断，关菜单还原时又要把
  // 窗口移回屏幕外被系统钳回，宠物瞬移到屏幕底部
  assert.match(petWindow, /Math\.max\(0, Math\.min\(wantH - b\.height, b\.y - wa\.y\)\)/)
  assert.match(petWindow, /const nb = \{ x: b\.x, y: b\.y - growUp, width: b\.width \+ growR, height: b\.height \+ growUp \}/)
  // 首次扩窗记录完整基线四元组，关菜单 setBounds(base) 整体还原位置尺寸
  assert.match(petWindow, /menuBase == null\) menuBase = \{ x: b\.x, y: b\.y, width: b\.width, height: b\.height \}/)
  assert.match(petWindow, /win\.setBounds\(base\)/)
  assert.match(petWindow, /getDisplayMatching/)
  // 渲染层 .pet 固定锚层：钉在窗口基准 400×520、贴视口左缘/底缘，配合「右/上
  // 扩展」实现内容屏幕位置全程恒定（不随视口伸缩重排 → 无闪现）；toast 同基准
  // 锚定（left:200px = 400 中心），不随扩窗后的视口漂移
  assert.match(html, /\.pet \{\s*\n\s*position: fixed; left: 0; bottom: 0;/)
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
