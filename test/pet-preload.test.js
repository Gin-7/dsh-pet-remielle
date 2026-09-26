/**
 * 桌面悬浮窗 preload 桥（src/pet-preload.cjs）。
 *
 * 这层是渲染页与主进程之间唯一的通道，也是安全边界：contextBridge 暴露什么、
 * 每个方法往哪个 IPC 通道发、参数怎么归一化，全都在这里。此前只有
 * test/desktop-window.test.js 里三处对源码做字符串匹配——既漏掉了参数归一化
 * （`Boolean(on)`、`Number(x) || 0`），也挡不住方法被误删或被改名。
 *
 * 源码只是 require('electron') 后调一次 exposeInMainWorld，所以用 vm 注入一个
 * 假 electron 就能拿到暴露对象，直接调方法断言 IPC 通道与参数，无需任何 DOM 桩。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')

/** 加载一份 preload，捕获它暴露的 petBridge 与所有 IPC 调用。 */
function loadPreload() {
  const sent = []
  const invoked = []
  let exposed = null
  let exposedName = null
  const ipcRenderer = {
    send: (channel, ...args) => sent.push({ channel, args }),
    invoke: (channel, ...args) => {
      invoked.push({ channel, args })
      return Promise.resolve({})
    },
  }
  const contextBridge = {
    exposeInMainWorld: (name, api) => { exposedName = name; exposed = api },
  }
  const sandbox = {
    require: (name) => {
      if (name === 'electron') return { contextBridge, ipcRenderer }
      throw new Error(`unexpected require: ${name}`)
    },
    module: { exports: {} },
    console,
  }
  runInNewContext(SRC, sandbox, { filename: 'pet-preload.cjs' })
  return { bridge: exposed, exposedName, sent, invoked, lastSend: () => sent.at(-1), lastInvoke: () => invoked.at(-1) }
}

test('exposes exactly one petBridge namespace', () => {
  const { bridge, exposedName } = loadPreload()
  assert.equal(exposedName, 'petBridge', '渲染层只应看到一个 petBridge')
  assert.ok(bridge, '必须真的调了 exposeInMainWorld')
  // 方法集合是渲染层与主进程之间的契约：删一个渲染层就报 undefined，加一个
  // 就多一条没人审的通道。增删时这里会立刻指出来。
  assert.deepEqual(Object.keys(bridge).sort(), [
    'artworkClear', 'artworkClose', 'artworkFade', 'artworkOpen', 'artworkSet',
    'dragEnd', 'dragMove', 'dragStart',
    'getInitialPosition', 'getPosition', 'getWorkArea',
    'menuExpand', 'menuRestore',
    'openDshPage', 'resetPosition',
    'setClickThrough', 'setForceInteractive', 'setHitRects',
  ])
})

test('click-through and force-interactive are coerced to booleans', () => {
  const { bridge, lastSend } = loadPreload()
  for (const [method, channel] of [['setClickThrough', 'set-click-through'], ['setForceInteractive', 'force-interactive']]) {
    bridge[method](1)
    assert.deepEqual(lastSend(), { channel, args: [true] }, `${method} 应发送 true`)
    bridge[method](0)
    assert.deepEqual(lastSend(), { channel, args: [false] })
    bridge[method]('truthy string')
    assert.deepEqual(lastSend(), { channel, args: [true] }, `${method} 必须做 Boolean() 归一化，不能把字符串发给主进程`)
    bridge[method](undefined)
    assert.deepEqual(lastSend(), { channel, args: [false] })
  }
})

test('drag coordinates are coerced to finite numbers, missing becomes 0', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.dragStart(120, 240)
  assert.deepEqual(lastSend(), { channel: 'drag-start', args: [120, 240] })
  // 主进程按这些值算窗口位移，NaN/undefined 传过去会让窗口飞出屏幕外
  bridge.dragStart(undefined, null)
  assert.deepEqual(lastSend(), { channel: 'drag-start', args: [0, 0] }, '缺参必须归零而不是 NaN')
  bridge.dragStart('80', 'not-a-number')
  assert.deepEqual(lastSend(), { channel: 'drag-start', args: [80, 0] })
})

test('dragMove and dragEnd are plain signals with no payload', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.dragMove()
  assert.deepEqual(lastSend(), { channel: 'drag-move', args: [] })
  bridge.dragEnd()
  assert.deepEqual(lastSend(), { channel: 'drag-end', args: [] })
})

test('hit rects are forwarded verbatim, not normalised', () => {
  const { bridge, lastSend } = loadPreload()
  const rects = [{ x: 1, y: 2, w: 3, h: 4 }, { x: 5, y: 6, w: 7, h: 8 }]
  bridge.setHitRects(rects)
  assert.equal(lastSend().channel, 'hit-rects')
  assert.equal(lastSend().args[0], rects, '命中区是数组，必须原样透传（主进程按顺序配对比较）')
})

test('query bridges invoke their channel and return the promise', async () => {
  const { bridge, lastInvoke } = loadPreload()
  const cases = [
    ['getPosition', 'get-position'],
    ['getInitialPosition', 'get-initial-position'],
    ['resetPosition', 'reset-position'],
    ['getWorkArea', 'get-work-area'],
    ['menuRestore', 'menu-restore'],
    ['openDshPage', 'open-dsh-page'],
  ]
  for (const [method, channel] of cases) {
    const result = bridge[method]()
    assert.deepEqual(lastInvoke(), { channel, args: [] }, `${method} 应 invoke ${channel}`)
    assert.ok(result && typeof result.then === 'function', `${method} 必须把 invoke 的 promise 返回给渲染层`)
    await result
  }
})

test('menuExpand forwards four coerced coordinates', () => {
  const { bridge, lastInvoke } = loadPreload()
  bridge.menuExpand(10, 20, 30, 40)
  assert.deepEqual(lastInvoke(), { channel: 'menu-expand', args: [10, 20, 30, 40] })
  // 缺参会被主进程当 0，于是包围盒退化成左上角原点、菜单闪现在屏幕角上
  bridge.menuExpand(5, undefined, null, 'x')
  assert.deepEqual(lastInvoke(), { channel: 'menu-expand', args: [5, 0, 0, 0] })
})

test('artwork window defaults to 240x240 and coerces the rest', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.artworkOpen(400, 300)
  assert.deepEqual(lastSend(), { channel: 'artwork-open', args: [400, 300] })
  bridge.artworkOpen()
  assert.deepEqual(lastSend(), { channel: 'artwork-open', args: [240, 240] }, '缺参必须用 240 兜底')
  bridge.artworkOpen('300', 'x')
  assert.deepEqual(lastSend(), { channel: 'artwork-open', args: [300, 240] })
})

test('artwork data url is stringified, lifecycle calls carry no payload', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.artworkSet({ raw: 'data:image/png;base64,AAA' })
  assert.equal(lastSend().channel, 'artwork-set')
  assert.equal(lastSend().args[0], '[object Object]', '非字符串输入必须被 String() 兜住，不能把对象直接丢给主进程')

  for (const [method, channel] of [
    ['artworkClear', 'artwork-clear'],
    ['artworkFade', 'artwork-fade'],
    ['artworkClose', 'artwork-close'],
  ]) {
    bridge[method]()
    assert.deepEqual(lastSend(), { channel, args: [] })
  }
})
