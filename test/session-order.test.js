/**
 * 两端共用的牌叠排序（src/session-order.cjs）。
 *
 * 桌面悬浮窗（pet-view.html）与网页客户端（client.core.js）都调这一份，
 * 宿主 index.js 经 createRequire 取 compareSessions 给快照排序。
 * 本文件此前没有直接单测——滞回算法只被 host-snapshot 间接盖到，
 * 而它恰恰是最容易改坏的一段（改坏了表现为堆叠卡宽度高频抖动，很难定位）。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { beforeEach, test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  orderSessions, compareSessions,
  attentionOf, completionOf, targetSessionOf, approvalOf, planReviewOf,
} = require('../src/session-order.cjs')

/** lastTopIds 是模块级状态（滞回用），用例间必须清干净，否则顺序相关。 */
function resetHysteresis() {
  orderSessions([], null)
}

function s(over) {
  return { sessionId: 's', state: 'THINKING', updatedAt: 0, ...over }
}

beforeEach(resetHysteresis)

test('tier priority: approval > plan review > ask > completion > attention > plain', () => {
  const sessions = [
    s({ sessionId: 'plain' }),
    s({ sessionId: 'attn', state: 'ERROR' }),
    s({ sessionId: 'done', completionNotification: true }),
    s({ sessionId: 'ask', ask: true }),
    s({ sessionId: 'plan', planReview: true }),
    s({ sessionId: 'appr', approval: true }),
  ]
  const order = orderSessions(sessions, null).map((e) => e.sessionId)
  assert.deepEqual(order, ['appr', 'plan', 'ask', 'done', 'attn', 'plain'])
})

test('within one tier: current session wins, then state rank, then recency', () => {
  const sessions = [
    s({ sessionId: 'old-idle', state: 'IDLE', updatedAt: 900 }),
    s({ sessionId: 'new-idle', state: 'IDLE', updatedAt: 950 }),
    s({ sessionId: 'busy', state: 'WORKING', updatedAt: 10 }),
    s({ sessionId: 'current-idle', state: 'IDLE', updatedAt: 1 }),
  ]
  const order = orderSessions(sessions, 'current-idle').map((e) => e.sessionId)
  // current 会话压过 stateRank；其后 WORKING > IDLE；同级比 updatedAt 新的在前
  assert.deepEqual(order, ['current-idle', 'busy', 'new-idle', 'old-idle'])
})

test('compareSessions is pure: no hysteresis, no state mutation', () => {
  const a = s({ sessionId: 'a', approval: true })
  const b = s({ sessionId: 'b' })
  assert.ok(compareSessions(a, b, null) < 0, '审批会话应排在前')
  assert.ok(compareSessions(b, a, null) > 0, '比较器应反对称')
  // compareSessions 不应被滞回影响：反复调用结果一致
  const first = compareSessions(b, a, null)
  for (let i = 0; i < 5; i++) assert.equal(compareSessions(b, a, null), first)
  assert.equal(orderSessions([a, b], null).length, 2, '不改变入参数组')
})

test('hysteresis keeps the top two stable when they are exactly equal rank', () => {
  // 两个同 tier、同 current、同 stateRank 的会话只差 updatedAt。
  // updatedAt 每来一个流式 chunk 就刷新，若纯按它排序，堆叠卡会来回换主卡、宽度抖动。
  const mk = (id, updatedAt) => s({ sessionId: id, state: 'WORKING', updatedAt })
  const first = orderSessions([mk('x', 100), mk('y', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(first, ['y', 'x'], '首次按 updatedAt：新会话 y 在前')

  // 第二次：x 的 updatedAt 涨到 300（纯排序会翻成 x 在前）——滞回应保持 y 在前
  const second = orderSessions([mk('x', 300), mk('y', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(second, ['y', 'x'], '完全同级时不得因 updatedAt 抖动互换前两名')
})

test('hysteresis never blocks a real tier change', () => {
  const mk = (id, updatedAt) => s({ sessionId: id, state: 'WORKING', updatedAt })
  orderSessions([mk('y', 200), mk('x', 100)], null)
  // x 收到审批 —— 层级变化必须立即上位，不能被滞回按回去
  const after = orderSessions([{ ...mk('x', 100), approval: true }, mk('y', 200)], null).map((e) => e.sessionId)
  assert.equal(after[0], 'x', '审批插队必须压过滞回')

  // 滞回只在「恰好互为倒序」时生效：前两名本来就对时不应被乱换
  resetHysteresis()
  const stable = orderSessions([mk('a', 900), mk('b', 100)], null).map((e) => e.sessionId)
  assert.deepEqual(stable, ['a', 'b'], '本就正确的前两名不得被滞回交换')
})

test('hysteresis only ever touches the top two', () => {
  const mk = (id, updatedAt) => s({ sessionId: id, state: 'WORKING', updatedAt })
  // 先建立一个 top2 = [b, a]
  orderSessions([mk('b', 300), mk('a', 200), mk('c', 100)], null)
  // a 的 updatedAt 涨过 b：纯排序会把前两名翻成 [a, b]，滞回应换回 [b, a]；
  // 第三名 c 不在交换范围内，仍按比较器留在第三。
  const held = orderSessions([mk('a', 300), mk('b', 200), mk('c', 100)], null).map((e) => e.sessionId)
  assert.deepEqual(held, ['b', 'a', 'c'], '滞回只交换前两名，第三名不受牵连')

  // 反过来：第三名 updatedAt 涨到会挤进前两名时，「前两名互为倒序」的前提不成立，
  // 滞回必须让位给比较器——c 直接升到第一位。
  const displaced = orderSessions([mk('a', 300), mk('b', 200), mk('c', 900)], null).map((e) => e.sessionId)
  assert.deepEqual(displaced, ['c', 'a', 'b'], '排名真实变化时滞回必须让位')
})

test('hysteresis keys on targetSessionId when present', () => {
  const mk = (id, target, updatedAt) => ({ sessionId: id, targetSessionId: target, state: 'WORKING', updatedAt })
  const first = orderSessions([mk('c1', 'T', 100), mk('c2', 'U', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(first, ['c2', 'c1'])
  // 子会话（targetSessionId 相同）互换时不应把不同 target 的卡片判为同一张
  const second = orderSessions([mk('c1', 'T', 900), mk('c2', 'U', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(second, ['c2', 'c1'], '滞回应按 targetSessionId 记忆')
})

test('empty and single-entry decks are returned untouched', () => {
  assert.deepEqual(orderSessions([], null), [])
  assert.deepEqual(orderSessions([s({ sessionId: 'only' })], null).map((e) => e.sessionId), ['only'])
  assert.deepEqual(orderSessions([s({ sessionId: 'only' })], 'only').map((e) => e.sessionId), ['only'])
})

test('entry predicates follow the documented flags', () => {
  assert.equal(attentionOf({ attention: true }), true)
  assert.equal(attentionOf({ state: 'WAITING' }), true, 'WAITING 即 attention，无需显式标记')
  assert.equal(attentionOf({ state: 'ERROR' }), true, 'ERROR 即 attention')
  assert.equal(attentionOf({ state: 'WORKING' }), false)
  assert.equal(completionOf({ completionNotification: true }), true)
  assert.equal(completionOf({ completionNotification: 'yes' }), false, '必须严格 === true，字符串不算')
  assert.equal(approvalOf({ approval: 1 }), false, '必须严格 === true')
  assert.equal(planReviewOf({ planReview: true }), true)
  // targetSessionId 回落：子会话的卡片指向真实会话
  assert.equal(targetSessionOf({ sessionId: 'sub-1' }), 'sub-1')
  assert.equal(targetSessionOf({ sessionId: 'sub-1', targetSessionId: 'real' }), 'real')
})
