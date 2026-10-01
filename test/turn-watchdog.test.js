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

// 悬挂判定：只看"事件流停住多久"，不看会话在等什么。
// 正在等回答/审批的会话可以合法等很久，绝不能被误杀。
test('turn watchdog kills stalled turns but spares sessions waiting on the human', () => {
  assert.equal(TURN_STALL_THRESHOLD_MS, 180_000)
  assert.equal(TURN_WATCHDOG_INTERVAL_MS, 30_000)

  // ① THINKING 卡死：阈值前一拍不命中，到点命中；收尾复用 turn/end{aborted}
  const t0 = 1_000_000
  let now = t0
  const stalled = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  drive(reducer, stalled, session('hung'), [
    event('turn/start'),
    event('step/start', {}, 2), // 强杀现场：事件流止于 step/start「分析阶段」
  ])
  assert.deepEqual(stalled.tick(reducer.states(), t0 + TURN_STALL_THRESHOLD_MS - 1), [])
  assert.deepEqual(stalled.tick(reducer.states(), t0 + TURN_STALL_THRESHOLD_MS), ['hung'])
  // index.js 的命中处理：end 条目后合成 turn/end{aborted} 复用现有收尾路径，
  // 不传 seq（record.lastSeq 保持不变；stopped 文案种子经 seedNumber 稳定回落）。
  stalled.end('hung')
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

  // ①b WORKING（摸鱼中卡死）同样判悬挂
  let busyNow = 0
  const busy = createTurnWatchdog({ now: () => busyNow })
  const busyReducer = new PetReducer()
  drive(busyReducer, busy, session('busy'), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'bash' }, 2),
  ])
  busyNow += TURN_STALL_THRESHOLD_MS
  assert.deepEqual(busy.tick(busyReducer.states(), busyNow), ['busy'])

  // ② WAITING（等待回答/审批）超过阈值不误杀
  let askNow = 0
  const asking = createTurnWatchdog({ now: () => askNow })
  const askReducer = new PetReducer()
  drive(askReducer, asking, session('asking'), [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
  ])
  assert.equal(askReducer.states()[0].state, PetState.WAITING)
  askNow += TURN_STALL_THRESHOLD_MS * 10
  assert.deepEqual(asking.tick(askReducer.states(), askNow), [])

  // ③ turn/end 后条目移除，不再触发
  let doneNow = 0
  const done = createTurnWatchdog({ now: () => doneNow })
  const doneReducer = new PetReducer()
  drive(doneReducer, done, session('done'), [
    event('turn/start'),
    event('step/start', {}, 2),
    event('turn/end', { reason: { kind: 'completed' } }, 3),
  ])
  done.end('done') // offEvent 在 turn/end 时移除条目
  doneNow += TURN_STALL_THRESHOLD_MS * 10
  assert.deepEqual(done.tick(doneReducer.states(), doneNow), [])

  // ④ 阈值内不触发；持续 feed（正常流式）刷新时间戳，到点才命中
  let liveNow = 0
  const live = createTurnWatchdog({ now: () => liveNow })
  const liveReducer = new PetReducer()
  drive(liveReducer, live, session('live'), [event('turn/start')])
  liveNow += TURN_WATCHDOG_INTERVAL_MS * 5
  live.feed('live') // 流式期间 chunk 事件频繁，时间戳不断刷新
  liveNow += TURN_STALL_THRESHOLD_MS - 1000
  assert.deepEqual(live.tick(liveReducer.states(), liveNow), [])
  liveNow += 1000
  assert.deepEqual(live.tick(liveReducer.states(), liveNow), ['live'])
})
