/**
 * 取 GIF 当前帧的纯函数与降级行为。
 * 冻结链路本身（ImageDecoder 取帧）依赖安全上下文，只能在真实 Chromium 里跑，
 * 见 .global_ignored/electron-gif-freeze-probe.cjs；这里守住可离线复现的部分：
 * 帧号推算、时长汇总、URL 判定，以及 WebCodecs 不可用时不抛错、安静降级。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const gif = require('../src/gif-frame.cjs')

test('totalDuration sums positive finite frame delays only', () => {
  assert.equal(gif.totalDuration([30, 30, 30]), 90)
  assert.equal(gif.totalDuration([]), 0)
  assert.equal(gif.totalDuration(null), 0)
  assert.equal(gif.totalDuration([30, 'x', -5, 0, Number.NaN, 20]), 50)
})

test('indexAt maps elapsed ms onto the frame that is on screen', () => {
  const d = [30, 30, 30, 30] // 120ms 一轮，每帧 30ms
  assert.equal(gif.indexAt(d, 0), 0, '刚起播是首帧')
  assert.equal(gif.indexAt(d, 29), 0)
  assert.equal(gif.indexAt(d, 30), 1, '跨过第一帧时长才换帧')
  assert.equal(gif.indexAt(d, 31), 1)
  assert.equal(gif.indexAt(d, 119), 3)
})

test('indexAt wraps around and tolerates odd input（贴纸实测 30ms/帧、120 与 160 帧）', () => {
  const d = new Array(120).fill(30) // 06.gif：120 帧 = 3.6s 一轮
  assert.equal(gif.indexAt(d, 120 * 30), 0, '整轮后回到首帧')
  assert.equal(gif.indexAt(d, 120 * 30 + 45), 1)
  assert.equal(gif.indexAt(d, 3600 * 3 + 45), 1, '多轮后仍按整轮取模')
  assert.equal(gif.indexAt(d, -15), 119, '负时刻回绕到上一轮末帧')
  assert.equal(gif.indexAt(d, Number.NaN), 0)
  assert.equal(gif.indexAt(d, undefined), 0)
  assert.equal(gif.indexAt([], 5), 0)
  assert.equal(gif.indexAt([0, 0], 5), 0, '全 0 时长不能除零')
})

test('indexAt honours uneven frame delays', () => {
  const d = [10, 50, 200, 40] // 一轮 300ms
  assert.equal(gif.indexAt(d, 0), 0)
  assert.equal(gif.indexAt(d, 10), 1)
  assert.equal(gif.indexAt(d, 59), 1)
  assert.equal(gif.indexAt(d, 60), 2)
  assert.equal(gif.indexAt(d, 259), 2)
  assert.equal(gif.indexAt(d, 260), 3)
  assert.equal(gif.indexAt(d, 299), 3)
  assert.equal(gif.indexAt(d, 300), 0)
})

test('isGif only accepts gif urls so PNG 贴纸走首帧兜底', () => {
  assert.equal(gif.isGif('/plugins/dsh-pet-remielle/assets/remielle/06.gif'), true)
  assert.equal(gif.isGif('https://host/pet.GIF?t=1'), true)
  assert.equal(gif.isGif('/plugins/dsh-pet-remielle/assets/remielle/pics/1.png'), false)
  assert.equal(gif.isGif('data:image/png;base64,AAAA'), false)
  assert.equal(gif.isGif(''), false)
  assert.equal(gif.isGif(null), false)
})

test('freeze/warm/timeline degrade to null when WebCodecs is unavailable', async () => {
  // Node 没有 ImageDecoder：这条断言同时覆盖「纯 http 局域网地址」那种非安全上下文
  assert.equal(gif.supported(), false)
  assert.equal(await gif.freeze('https://host/06.gif', 1234), null)
  assert.equal(await gif.warm('https://host/06.gif'), null)
  assert.equal(await gif.timeline('https://host/06.gif'), null)
  assert.equal(await gif.freeze('https://host/pics/1.png', 10), null, '非 GIF 直接让位兜底')
})

test('watch/livedMs stay inert without a real image element', () => {
  assert.equal(gif.livedMs(null), 0)
  assert.equal(gif.livedMs({}), 0)
  gif.watch(null) // 不应抛错
  gif.watch({})
})
