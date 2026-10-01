import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const tip = require('../src/pet-tip.cjs')

test('dot tip copy follows the bubble page', () => {
  assert.equal(tip.dotTipText(0), '点击看余额呀~')
  assert.equal(tip.dotTipText(1), '点击回状态呀~')
})

test('backboard tip joins workspace and conversation title without brackets', () => {
  assert.equal(tip.backboardTipText('dsh-pet-remielle', '审查提示框颜色与溢出问题'), '点击去看 dsh-pet-remielle · 审查提示框颜色与溢出问题 哦~')
  assert.equal(tip.backboardTipText('dsh-pet-remielle', ''), '点击去看 dsh-pet-remielle 哦~')
  assert.equal(tip.backboardTipText('', '审查提示框颜色与溢出问题'), '点击去看 审查提示框颜色与溢出问题 哦~')
  assert.equal(tip.backboardTipText('same', 'same'), '点击去看 same 哦~')
  assert.equal(tip.backboardTipText('', ''), '点击跳到这里看一下~')
})

test('backboard stabilizer debounces paired target and tip without stale commits', () => {
  const timers = new Map()
  let nextTimer = 0
  const committed = []
  const schedule = (listener) => {
    const id = ++nextTimer
    timers.set(id, listener)
    return id
  }
  const cancel = (id) => timers.delete(id)
  const flush = () => {
    const queued = [...timers.values()]
    timers.clear()
    for (const listener of queued) listener()
  }
  const stabilizer = tip.createBackboardStabilizer(
    (target, text) => committed.push({ target, text }),
    400,
    schedule,
    cancel,
  )

  stabilizer.update('A', '提示 A')
  stabilizer.update('B', '提示 B')
  stabilizer.update('A', '提示 A')
  flush()
  assert.deepEqual(committed, [{ target: 'A', text: '提示 A' }])
  assert.equal(stabilizer.target(), 'A')
  assert.equal(stabilizer.tip(), '提示 A')

  stabilizer.update('B', '提示 B')
  stabilizer.update('C', '提示 C')
  flush()
  assert.deepEqual(committed, [
    { target: 'A', text: '提示 A' },
    { target: 'C', text: '提示 C' },
  ])
})

test('desktop idle action opens DSH only when the bridge exposes it', () => {
  let calls = 0
  assert.equal(tip.openIdleDshPage({ openDshPage() { calls += 1 } }), true)
  assert.equal(calls, 1)
  assert.equal(tip.openIdleDshPage({}), false)
  assert.equal(tip.openIdleDshPage(null), false)
})

test('bubbleZoomOf honours the sync/fixed modes and clamps malformed input', () => {
  // 默认（字段缺失）回落旧口径 zoom = scale，与 0.3.6 行为一致；显式同步开关（true）与缺失等价
  assert.equal(tip.bubbleZoomOf({ scale: 1.2 }), 1.2)
  assert.equal(tip.bubbleZoomOf({ scale: 1.5, bubbleScaleRatio: 1 }), 1.5)
  assert.equal(tip.bubbleZoomOf({ scale: 1.5, bubbleScaleRatio: 0.8 }), 1.2)
  assert.equal(tip.bubbleZoomOf({ scale: 0.5, bubbleScaleRatio: 2 }), 1)
  assert.equal(tip.bubbleZoomOf({ scale: 1.5, bubbleScaleSync: true, bubbleScaleRatio: 0.8 }), 1.2)
  // 固定模式与桌宠 scale 无关；缺 fixed 字段回落 1（基准大小），不偷用 scale
  assert.equal(tip.bubbleZoomOf({ scale: 1.8, bubbleScaleSync: false, bubbleFixedSize: 0.8 }), 0.8)
  assert.equal(tip.bubbleZoomOf({ scale: 0.5, bubbleScaleSync: false, bubbleFixedSize: 1.5 }), 1.5)
  assert.equal(tip.bubbleZoomOf({ scale: 1.8, bubbleScaleSync: false }), 1)
  // 畸形快照与上下限钳位
  assert.equal(tip.bubbleZoomOf(null), 1)
  assert.equal(tip.bubbleZoomOf({}), 1)
  assert.equal(tip.bubbleZoomOf({ scale: 'abc' }), 1)
  assert.equal(tip.bubbleZoomOf({ scale: 2, bubbleScaleRatio: 2 }), 3) // 4 → 钳到上限 3
  assert.equal(tip.bubbleZoomOf({ scale: 0.5, bubbleScaleRatio: 0.5 }), 0.3) // 0.25 → 钳到下限 0.3
  assert.equal(tip.bubbleZoomOf({ scale: 1, bubbleScaleSync: false, bubbleFixedSize: 99 }), 3)
  assert.equal(tip.bubbleZoomOf({ scale: 1, bubbleScaleSync: false, bubbleFixedSize: 'x' }), 1)
})

test('applyDotTip writes overlay text and clears native title', () => {
  const dot = { dataset: {}, title: '切到余额' }
  const shown = []
  tip.applyDotTip(dot, 0, null, (anchor) => shown.push(anchor))
  assert.equal(dot.dataset.rm2Tip, '点击看余额呀~')
  assert.equal(dot.title, '')
  assert.deepEqual(shown, [])
  tip.applyDotTip(dot, 1, dot, (anchor) => shown.push(anchor))
  assert.equal(dot.dataset.rm2Tip, '点击回状态呀~')
  assert.deepEqual(shown, [dot])
})

test('onDotLeave keeps, restores the card, or hides', () => {
  const dot = { dataset: { rm2Tip: '点击看余额呀~' } }
  const dots = { parentNode: null }
  const card = {
    dataset: { rm2Tip: '点击跳到这里看一下~' },
    contains(node) { return node === card },
  }
  dots.parentNode = card
  const shown = []
  const hidden = []
  const show = (anchor) => shown.push(anchor)
  const hide = () => hidden.push(true)

  tip.onDotLeave({ relatedTarget: dots }, dot, dots, show, hide)
  assert.deepEqual(shown, [])
  assert.deepEqual(hidden, [])
  tip.onDotLeave({ relatedTarget: dot }, dot, dots, show, hide)
  assert.deepEqual(shown, [])
  assert.deepEqual(hidden, [])

  tip.onDotLeave({ relatedTarget: card }, dot, dots, show, hide)
  assert.deepEqual(shown, [card])
  assert.deepEqual(hidden, [])

  tip.onDotLeave({}, dot, dots, show, hide)
  assert.deepEqual(hidden, [true])
})

// 浮层定位与换行：先按单行量自然宽，超出可见 maxW 或文案自带换行才换行；
// 盒子始终钳在可见区域内并留 24px 光晕。
test('layoutPetTip clamps into the visible area and only wraps when needed', () => {
  const at = (left, top) => ({ getBoundingClientRect: () => ({ left, width: 180, top, bottom: top + 68 }) })
  const place = (text, offsetWidth, offsetHeight, anchor) => {
    const petTip = { style: {}, offsetWidth, offsetHeight, textContent: text }
    tip.layoutPetTip(petTip, anchor, 0, 0, 1280, 800)
    return petTip
  }

  // 贴右边界的短文案：撑到可见宽度上限、不拆字、整体滑进光晕
  const edge = place('点击看余额呀~', 200, 40, at(1100, 8))
  assert.equal(Number.parseFloat(edge.style.maxWidth), 420)
  assert.equal(edge.style.whiteSpace, 'nowrap')
  assert.equal(edge.style.wordBreak, 'normal')
  const left = Number.parseFloat(edge.style.left)
  const top = Number.parseFloat(edge.style.top)
  assert.ok(left >= 24, `left ${left}`)
  assert.ok(left + 200 <= 1280 - 24, `right ${left + 200}`)
  assert.ok(top >= 24, `top ${top}`)
  assert.ok(top + 40 <= 800 - 24, `bottom ${top + 40}`)

  // 放得下的背板长文案同样不换行
  const backboard = place('点击去看 dsh-pet-remielle · 审查提示框颜色与溢出问题 哦~', 360, 40, at(100, 80))
  assert.equal(backboard.style.whiteSpace, 'nowrap')
  assert.equal(backboard.style.wordBreak, 'normal')

  // 超出 maxW 的审批全文：换行并允许任意断点
  const wide = place('工作区 · ' + '审批请求全文'.repeat(8), 500, 80, at(100, 80))
  assert.equal(wide.style.whiteSpace, 'pre-wrap')
  assert.equal(wide.style.wordBreak, 'break-all')

  // 文案自带换行：直接换行，不再等宽度超限
  const multiline = place('第一行\n第二行', 100, 80, at(100, 80))
  assert.equal(multiline.style.whiteSpace, 'pre-wrap')
  assert.equal(multiline.style.wordBreak, 'break-all')
})
