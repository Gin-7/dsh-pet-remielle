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

test('layoutPetTip expands to visible width, nowraps short copy, and slides into glow padding', () => {
  const petTip = { style: {}, offsetWidth: 200, offsetHeight: 40, textContent: '点击看余额呀~' }
  const anchor = {
    getBoundingClientRect: () => ({ left: 1100, width: 180, top: 8, bottom: 76 }),
  }
  tip.layoutPetTip(petTip, anchor, 0, 0, 1280, 800)
  assert.equal(Number.parseFloat(petTip.style.maxWidth), 420)
  assert.equal(petTip.style.whiteSpace, 'nowrap')
  assert.equal(petTip.style.wordBreak, 'normal')
  const left = Number.parseFloat(petTip.style.left)
  const top = Number.parseFloat(petTip.style.top)
  assert.ok(left >= 24, `left ${left}`)
  assert.ok(left + 200 <= 1280 - 24, `right ${left + 200}`)
  assert.ok(top >= 24, `top ${top}`)
  assert.ok(top + 40 <= 800 - 24, `bottom ${top + 40}`)
})

test('layoutPetTip nowraps backboard copy that still fits maxW', () => {
  const petTip = {
    style: {},
    offsetWidth: 360,
    offsetHeight: 40,
    textContent: '点击去看 dsh-pet-remielle · 审查提示框颜色与溢出问题 哦~',
  }
  const anchor = {
    getBoundingClientRect: () => ({ left: 100, width: 180, top: 80, bottom: 148 }),
  }
  tip.layoutPetTip(petTip, anchor, 0, 0, 1280, 800)
  assert.equal(petTip.style.whiteSpace, 'nowrap')
  assert.equal(petTip.style.wordBreak, 'normal')
})

test('layoutPetTip wraps copy wider than maxW', () => {
  const petTip = { style: {}, offsetWidth: 500, offsetHeight: 80, textContent: '工作区 · ' + '审批请求全文'.repeat(8) }
  const anchor = {
    getBoundingClientRect: () => ({ left: 100, width: 180, top: 80, bottom: 148 }),
  }
  tip.layoutPetTip(petTip, anchor, 0, 0, 1280, 800)
  assert.equal(petTip.style.whiteSpace, 'pre-wrap')
  assert.equal(petTip.style.wordBreak, 'break-all')
})

test('layoutPetTip wraps copy that already contains a newline', () => {
  const petTip = { style: {}, offsetWidth: 100, offsetHeight: 80, textContent: '第一行\n第二行' }
  const anchor = {
    getBoundingClientRect: () => ({ left: 100, width: 180, top: 80, bottom: 148 }),
  }
  tip.layoutPetTip(petTip, anchor, 0, 0, 1280, 800)
  assert.equal(petTip.style.whiteSpace, 'pre-wrap')
  assert.equal(petTip.style.wordBreak, 'break-all')
})
