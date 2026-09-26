/**
 * 共享气泡卡呈现层（网页端与桌面端同一份实现，见 src/bubble-title.cjs）。
 *
 * 这层文案以前在 client.core.js 与 pet-view.html 各写一份，审查时发现的
 * 「计划待审」提示重复项目名就是两份实现漂移的结果。这里直接对纯函数断言，
 * 不用整套 DOM stub 也能钉住文案与类名。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const card = require('../src/bubble-title.cjs')

test('plan summary is taken after the marker, never the project prefix', () => {
  assert.equal(card.planSummaryOf('· dsh-pet-remielle · 计划待审 · 推理面板改材质'), '推理面板改材质')
  assert.equal(card.planSummaryOf('· 计划待审 · 推理面板改材质'), '推理面板改材质')
  assert.equal(card.planSummaryOf('· dsh-pet-remielle · 执行阶段'), '')
  assert.equal(card.planSummaryOf(''), '')
})

test('card tip copy picks one branch per state', () => {
  assert.equal(card.tipTextOf({ planReview: true, planSummary: '推理面板改材质' }), '计划待审：推理面板改材质，点击打开同意执行/要求修改')
  assert.equal(card.tipTextOf({ planReview: true }), '计划待审，点击打开同意执行/要求修改')
  assert.equal(card.tipTextOf({ approval: true, detailShown: '· workspace · rm -rf /' }), '· workspace · rm -rf /')
  assert.equal(card.tipTextOf({ completed: true }), '完成啦~ 点击查看结果哦')
  assert.equal(card.tipTextOf({ attention: true }), '轮到你啦，点击跳到这里处理呢')
  assert.equal(card.tipTextOf({}), '点击跳到这里看一下~')
  // 待机占位卡不落到「点击跳转」兜底文案里
  assert.equal(card.tipTextOf({ idlePlaceholder: true, attention: true }), '')
})

test('card class list and row width stay inside the deck limits', () => {
  assert.equal(card.classNameOf({ completed: true }, 0), 'rm2-pet-bubble top completed')
  assert.equal(card.classNameOf({ planReview: true, summaryCount: 2 }, 1), 'rm2-pet-bubble summary-backboard')
  assert.equal(card.bubbleRowWidth(10), 277, '窄文案回落到最小宽度')
  assert.equal(card.bubbleRowWidth(3000), 440, '超宽文案收敛到上限')
})
