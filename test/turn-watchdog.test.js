import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetMessageKind, PetState } from '../src/protocol.js'
import { PetReducer } from '../src/pet-reducer.js'
import {
  TURN_STALL_THRESHOLD_MS,
  TURN_WATCHDOG_INTERVAL_MS,
  createTurnWatchdog,
} from '../src/turn-watchdog.js'

// 与 pet-reducer.test.js 相同的事件构造辅助
function session(id = 's1', extra = {}) {
  return { header: { id, ...extra.header }, ...extra }
}

function event(type, data = {}, seq = 1) {
  return { type, seq, data }
}

/** 模拟 index.js 的接线：事件喂 reducer 的同时 feed 看门狗。 */
function drive(reducer, watchdog, sess, events) {
  for (const ev of events) {
    watchdog.feed(sess.header.id)
    reducer.handle(sess, ev)
  }
}

test('常量符合设计：悬挂阈值 3 分钟、扫描间隔 30 秒', () => {
  assert.equal(TURN_STALL_THRESHOLD_MS, 180_000)
  assert.equal(TURN_WATCHDOG_INTERVAL_MS, 30_000)
})

test('① THINKING 超过阈值 → tick 命中，合成 aborted 收尾为 IDLE（已停止）', () => {
  const t0 = 1_000_000
  let now = t0
  const watchdog = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  const sess = session('hung')
  drive(reducer, watchdog, sess, [
    event('turn/start'),
    event('step/start', {}, 2), // 强杀现场：事件流止于 step/start「分析阶段」
  ])
  assert.deepEqual(watchdog.tick(reducer.states(), t0 + TURN_STALL_THRESHOLD_MS - 1), [])
  assert.deepEqual(watchdog.tick(reducer.states(), t0 + TURN_STALL_THRESHOLD_MS), ['hung'])
  // index.js 的命中处理：end 条目后合成 turn/end{aborted} 复用现有收尾路径，
  // 不传 seq（record.lastSeq 保持不变；stopped 文案种子经 seedNumber 稳定回落）。
  watchdog.end('hung')
  const messages = [...reducer.handle(
    { header: { id: 'hung' } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'aborted' } } },
  )]
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.state, PetState.IDLE)
  assert.equal(state.stage, '已停止')
  assert.equal(state.message, '任务已经停下来啦')
  // 已停止的记录不再出现在牌叠里
  assert.deepEqual(reducer.states(), [])
})

test('② WAITING（等待回答/审批）超过阈值不误杀', () => {
  let now = 0
  const watchdog = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  const sess = session('asking')
  drive(reducer, watchdog, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
  ])
  assert.equal(reducer.states()[0].state, PetState.WAITING)
  now += TURN_STALL_THRESHOLD_MS * 10 // 审批与等待回答可以合法等待很久
  assert.deepEqual(watchdog.tick(reducer.states(), now), [])
})

test("①b WORKING（摸鱼中卡死）同样判悬挂", () => {
  let now = 0
  const watchdog = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  const sess = session('busy')
  drive(reducer, watchdog, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'bash' }, 2),
  ])
  now += TURN_STALL_THRESHOLD_MS
  assert.deepEqual(watchdog.tick(reducer.states(), now), ['busy'])
})

test('③ turn/end 后条目移除，不再触发；IDLE 记录即使条目残留也不命中', () => {
  let now = 0
  const watchdog = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  const sess = session('done')
  drive(reducer, watchdog, sess, [
    event('turn/start'),
    event('step/start', {}, 2),
    event('turn/end', { reason: { kind: 'completed' } }, 3),
  ])
  watchdog.end('done') // offEvent 在 turn/end 时移除条目
  now += TURN_STALL_THRESHOLD_MS * 10
  assert.deepEqual(watchdog.tick(reducer.states(), now), [])
})

test('④ 阈值内不触发；持续 feed（正常流式）永不误杀', () => {
  let now = 0
  const watchdog = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  const sess = session('live')
  drive(reducer, watchdog, sess, [event('turn/start')])
  // 多轮扫描间隔累计仍低于阈值时不触发
  now += TURN_WATCHDOG_INTERVAL_MS * 5
  watchdog.feed('live') // 流式期间 chunk 事件频繁，时间戳不断刷新
  now += TURN_STALL_THRESHOLD_MS - 1000
  assert.deepEqual(watchdog.tick(reducer.states(), now), [])
  now += 1000
  assert.deepEqual(watchdog.tick(reducer.states(), now), ['live'])
})
