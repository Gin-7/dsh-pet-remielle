import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetMessageKind, PetState } from '../src/protocol.js'
import { PetReducer, moodFor } from '../src/pet-reducer.js'

function session(id = 's1', extra = {}) {
  return { header: { id, ...extra.header }, ...extra }
}

function event(type, data = {}, seq = 1) {
  return { type, seq, data }
}

function collect(reducer, sess, events) {
  const messages = []
  for (const ev of events) {
    for (const message of reducer.handle(sess, ev)) messages.push(message)
  }
  return messages
}

function latestState(reducer, sess, events) {
  const messages = collect(reducer, sess, events)
  return messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
}

test('turn/start -> THINKING with sticker 04', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [event('turn/start')])
  assert.equal(state.state, PetState.THINKING)
  assert.equal(state.mood, '04')
})

test('assistant streaming -> sticker 01 (绘制中)', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('assistant/message', {}, 2),
  ])
  assert.equal(state.state, PetState.THINKING)
  assert.equal(state.phase, 'streaming')
  assert.equal(state.mood, '01')
})

test('assistant/chunk text-delta -> 绘制中 01, reasoning-delta -> 思考中 04', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '让me想…' } }, 2),
    event('assistant/chunk', { chunk: { type: 'text-delta', text: '好的' } }, 3),
    event('assistant/chunk', { chunk: { type: 'tool-call-delta', name: 'read' } }, 4),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  const reasoning = states[1]
  const output = states[2]
  const tool = states[3]
  assert.equal(reasoning.phase, 'think')
  assert.equal(reasoning.mood, '04')          // 思考块 → 04
  assert.equal(output.phase, 'streaming')
  assert.equal(output.mood, '01')             // 输出 → 01
  assert.equal(tool.state, PetState.WORKING)
  assert.equal(tool.mood, '02')               // 工具 → 02
})

test('tool/call -> WORKING with sticker 02 and activity', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'grep' }, 2),
  ])
  assert.equal(state.state, PetState.WORKING)
  assert.equal(state.mood, '02')
  assert.equal(state.activity, 'searching')
})

test('mid-turn attachment handles results for registered tools', () => {
  const reducer = new PetReducer()
  const sess = session()
  collect(reducer, sess, [event('tool/call', { callId: 'c1', name: 'read' }, 2)])
  assert.equal(reducer.states()[0].state, PetState.WORKING)
  collect(reducer, sess, [event('tool/result', { callId: 'c1' }, 3)])
  assert.equal(reducer.states()[0].state, PetState.THINKING)
})

test('tool/result returns to THINKING, then streaming sticker (01) returns', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'read' }, 2),
    event('tool/result', { callId: 'c1' }, 3),
    event('assistant/message', {}, 4),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(states.at(-1).state, PetState.THINKING)
  assert.equal(states.at(-1).mood, '01')
})

test('tool/result with error emits an ERROR pulse with TTL', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'bash' }, 2),
    event('tool/result', { callId: 'c1', error: { code: 'EXIT_1' } }, 3),
  ])
  const pulse = messages.find((m) => m.kind === PetMessageKind.PULSE)
  assert.ok(pulse)
  assert.equal(pulse.state, PetState.ERROR)
  assert.equal(pulse.ttlMs, 3000)
})

test('tool/result with real DSH shape (message.source.callId) clears the open tool', () => {
  const reducer = new PetReducer()
  // DSH emits tool/result with the callId at message.source.callId, not at the
  // top level. If the reducer fails to clear the open tool, later streaming
  // output would stay stuck on 摸鱼中 (02) instead of 绘制中 (01).
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'grep' }, 2),
    event('tool/result', { message: { source: { callId: 'c1' } } }, 3),
    event('assistant/message', {}, 4),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(states.at(-1).state, PetState.THINKING)
  assert.equal(states.at(-1).mood, '01')
  assert.equal(states.at(-1).phase, 'streaming')
})

test('todo/write emits a TASK message with progress', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('todo/write', {
      todos: [
        { status: 'completed', content: '第一件事' },
        { status: 'in_progress', content: '正在做第二件事' },
        { status: 'pending', content: '第三件事' },
      ],
    }, 2),
  ])
  const task = messages.find((m) => m.kind === PetMessageKind.TASK)
  assert.ok(task)
  assert.match(task.task, /正在做第二件事/)
  assert.deepEqual(task.progress, { completed: 1, total: 3, current: 2 })
})

test('turn/end blocked -> WAITING with sticker 05', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'blocked' } }, 2),
  ])
  assert.equal(state.state, PetState.WAITING)
  assert.equal(state.mood, '05')
})

test('turn/end completed -> SUCCESS pulse with IDLE resume', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'completed' } }, 2),
  ])
  const pulse = messages.find((m) => m.kind === PetMessageKind.PULSE)
  assert.ok(pulse)
  assert.equal(pulse.state, PetState.SUCCESS)
  assert.equal(pulse.mood, '03')
  assert.equal(pulse.ttlMs, 5000)
  // The host falls back to these after the overlay expires.
  assert.equal(pulse.resumeState, PetState.IDLE)
  assert.equal(pulse.resumeMood, '06')
  // Completed turns are not retained in the persistent card deck. The host
  // adds the SUCCESS card back only until the pulse TTL expires.
  assert.deepEqual(reducer.states(), [])
})

test('turn/end aborted -> IDLE (已停止)', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'aborted' } }, 2),
  ])
  assert.equal(state.state, PetState.IDLE)
  assert.equal(state.phase, 'turn-end')
  assert.deepEqual(reducer.states(), [])
})

test('states() omits multiple settled turns while retaining active work', () => {
  const reducer = new PetReducer()
  collect(reducer, session('completed'), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'completed' } }, 2),
  ])
  collect(reducer, session('stopped'), [
    event('turn/start', {}, 3),
    event('turn/end', { reason: { kind: 'aborted' } }, 4),
  ])
  collect(reducer, session('active'), [
    event('turn/start', {}, 5),
    event('tool/call', { callId: 'x', name: 'read' }, 6),
  ])
  assert.deepEqual(reducer.states().map((entry) => entry.sessionId), ['active'])
})

test('background completion emits SUCCESS while another session needs attention', () => {
  const reducer = new PetReducer()
  const waiting = session('waiting')
  const background = session('background')
  collect(reducer, waiting, [
    event('turn/start'),
    event('tool/call', { callId: 'q', name: 'ask_user_question' }, 2),
  ])
  collect(reducer, background, [event('turn/start', {}, 3)])
  const messages = collect(reducer, background, [
    event('turn/end', { reason: { kind: 'completed' } }, 4),
  ])
  assert.equal(reducer.states().find((entry) => entry.sessionId === 'waiting').state, PetState.WAITING)
  assert.ok(messages.some((message) => message.kind === PetMessageKind.PULSE && message.sessionId === 'background' && message.state === PetState.SUCCESS))
})

test('multi-session priority: WAITING beats WORKING beats THINKING', () => {
  const reducer = new PetReducer()
  const a = session('a')
  const b = session('b')
  const c = session('c')
  collect(reducer, a, [event('turn/start'), event('assistant/message', {}, 2)])
  collect(reducer, b, [event('turn/start'), event('tool/call', { callId: 'x', name: 'bash' }, 2)])
  const messages = collect(reducer, c, [event('turn/start'), event('turn/end', { reason: { kind: 'blocked' } }, 2)])
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.sessionId, 'c')
  assert.equal(state.state, PetState.WAITING)
})

test('subagents are ignored unless included', () => {
  const sub = session('sub', { header: { origin: 'subagent', delegationDepth: 1 } })
  const reducer = new PetReducer()
  assert.equal(collect(reducer, sub, [event('turn/start')]).length, 0)

  const withSub = new PetReducer({ includeSubagents: true })
  const state = latestState(withSub, sub, [event('turn/start')])
  assert.equal(state.state, PetState.THINKING)
})

test('identical consecutive events are deduplicated by signature', () => {
  const reducer = new PetReducer()
  const first = collect(reducer, session(), [event('turn/start')])
  assert.equal(first.filter((m) => m.kind === PetMessageKind.STATE).length, 1)
  const second = collect(reducer, session(), [event('turn/start')])
  assert.equal(second.length, 0)
})

test('disposeSession drops the record and re-renders', () => {
  const reducer = new PetReducer()
  const sess = session('x')
  collect(reducer, sess, [event('turn/start')])
  const messages = reducer.disposeSession(sess)
  assert.ok(messages.some((m) => m.kind === PetMessageKind.STATE))
})

test('moodFor maps phases to stickers', () => {
  assert.equal(moodFor(PetState.THINKING, 'streaming'), '01')
  assert.equal(moodFor(PetState.THINKING, 'step-start'), '04')
  assert.equal(moodFor(PetState.WORKING, 'tool-call'), '02')
  assert.equal(moodFor(PetState.WAITING, 'turn-end'), '05')
  assert.equal(moodFor(PetState.IDLE, 'turn-end'), '06')
  assert.equal(moodFor(PetState.ERROR, 'tool-error'), '02')
})

// ── chat-mode scenarios ─────────────────────────────────────────────────────
// A chat session is a read-only research front: it streams, searches/browses/
// reads, then goes IDLE while the target agent executes in the background.
// The pet needs no mode awareness — the event flow already distinguishes the
// phases — but these tests pin the chat-shaped flows so a future change to
// either side cannot silently mis-stage the pet.

test('chat research: streaming search/read flow ends IDLE with a SUCCESS pulse', () => {
  const reducer = new PetReducer()
  const chat = session('chat-1')
  const messages = collect(reducer, chat, [
    event('turn/start'),
    event('assistant/message', {}, 2),
    event('tool/call', { callId: 'c1', name: 'web_search' }, 3),
    event('tool/result', { callId: 'c1' }, 4),
    event('tool/call', { callId: 'c2', name: 'read' }, 5),
    event('tool/result', { callId: 'c2' }, 6),
    event('assistant/message', {}, 7),
    event('turn/end', { reason: { kind: 'completed' } }, 8),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(states[0].state, PetState.THINKING)
  assert.equal(states.find((m) => m.phase === 'streaming').mood, '01')
  assert.equal(states.find((m) => m.activity === 'searching').state, PetState.WORKING)
  // `turn/end completed` emits only a SUCCESS pulse; the durable state it
  // resumes to is IDLE (the pet falls back to it after the overlay TTL).
  assert.equal(states.at(-1).state, PetState.THINKING)
  const pulse = messages.find((m) => m.kind === PetMessageKind.PULSE)
  assert.equal(pulse.state, PetState.SUCCESS)
  assert.equal(pulse.resumeState, PetState.IDLE)
})

test('after delegation: the working agent outranks the idle chat session', () => {
  const reducer = new PetReducer()
  const chat = session('chat-2')
  const agent = session('agent-2')
  // Chat finishes researching and hands off (IDLE).
  collect(reducer, chat, [
    event('turn/start'),
    event('assistant/message', {}, 2),
    event('turn/end', { reason: { kind: 'completed' } }, 3),
  ])
  // The target agent starts executing in the background.
  const messages = collect(reducer, agent, [
    event('turn/start'),
    event('tool/call', { callId: 'x', name: 'bash' }, 2),
  ])
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.sessionId, 'agent-2')
  assert.equal(state.state, PetState.WORKING)
})

test('agent completes, then the review wake returns the pet to the chat session', () => {
  const reducer = new PetReducer()
  const chat = session('chat-3')
  const agent = session('agent-3')
  collect(reducer, chat, [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'completed' } }, 2),
  ])
  collect(reducer, agent, [
    event('turn/start'),
    event('tool/call', { callId: 'x', name: 'bash' }, 2),
    event('tool/result', { callId: 'x' }, 3),
    event('turn/end', { reason: { kind: 'completed' } }, 4),
  ])
  // The host injects the review request into the chat session's inbox; the
  // chat turn starts and the pet switches back to it (THINKING > IDLE).
  const messages = collect(reducer, chat, [
    event('turn/start', {}, 5),
    event('assistant/message', {}, 6),
  ])
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.sessionId, 'chat-3')
  assert.equal(state.state, PetState.THINKING)
  assert.equal(state.mood, '01')
})

test('ask_user_question tool/call -> WAITING sticker 05, result restores', () => {
  const reducer = new PetReducer()
  const sess = session()
  const messages = collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
  ])
  const waiting = messages.filter((m) => m.kind === PetMessageKind.STATE)[1]
  assert.equal(waiting.state, PetState.WAITING)
  assert.equal(waiting.mood, '05')
  assert.equal(waiting.phase, 'ask')
  assert.equal(reducer.states()[0].approval, false)
  const tail = collect(reducer, sess, [event('tool/result', { callId: 'q1' }, 3)])
  // After the answer returns, the pet goes back to THINKING.
  assert.equal(tail.filter((m) => m.kind === PetMessageKind.STATE).at(-1).state, PetState.THINKING)
})

test('approval/asked -> WAITING, approval/decided restores WORKING', () => {
  const reducer = new PetReducer()
  const sess = session('s1', { header: { cwd: 'C:\\work\\dsh-pet-remielle' } })
  const messages = collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'c', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 2),
    event('approval/asked', {
      id: 'a1',
      toolName: 'bash',
      callId: 'c',
      reason: 'escalate sandbox to danger-full-access: 同步插件',
    }, 3),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  const waiting = states.find((m) => m.phase === 'approval')
  assert.equal(waiting.state, PetState.WAITING)
  assert.equal(waiting.mood, '05')
  assert.equal(waiting.detail, 'dsh-pet-remielle · 同步插件')
  assert.equal(reducer.states()[0].approval, true)
  assert.equal(reducer.states()[0].detail, 'dsh-pet-remielle · 同步插件')
  const tail = collect(reducer, sess, [
    event('approval/decided', { id: 'a1', outcome: 'allow' }, 4),
    event('tool/result', { callId: 'c' }, 5),
  ])
  // approval/decided restores WORKING (the tool is still running)…
  const tailStates = tail.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(tailStates[0].state, PetState.WORKING)
  // …then tool/result returns to THINKING.
  assert.equal(tailStates.at(-1).state, PetState.THINKING)
})

test('concurrent question and approval waits retain their independent actions', () => {
  const reducer = new PetReducer()
  const sess = session()
  collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
  ])
  let state = reducer.states()[0]
  assert.equal(state.phase, 'approval')
  assert.equal(state.approval, true)

  collect(reducer, sess, [event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 4)])
  state = reducer.states()[0]
  assert.equal(state.state, PetState.WAITING)
  assert.equal(state.phase, 'ask')
  assert.equal(state.approval, false)

  collect(reducer, sess, [event('tool/result', { callId: 'q1' }, 5)])
  state = reducer.states()[0]
  assert.equal(state.state, PetState.THINKING)
})

test('late interaction results do not resurrect a completed turn', () => {
  const reducer = new PetReducer()
  const sess = session()
  collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
    event('turn/end', { reason: { kind: 'completed' } }, 4),
  ])
  assert.deepEqual(reducer.states(), [])
  collect(reducer, sess, [
    event('tool/result', { callId: 'q1' }, 5),
    event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 6),
  ])
  assert.deepEqual(reducer.states(), [])
})

test('states() is empty with no sessions', () => {
  const reducer = new PetReducer()
  assert.deepEqual(reducer.states(), [])
})

test('states() returns one entry per session with mood/message/detail', () => {
  const reducer = new PetReducer()
  collect(reducer, session('s1'), [
    event('turn/start'),
    event('assistant/message', {}, 2),
  ])
  const states = reducer.states()
  assert.equal(states.length, 1)
  assert.equal(states[0].sessionId, 's1')
  assert.equal(states[0].state, PetState.THINKING)
  assert.equal(states[0].mood, '01')
  assert.ok(states[0].detail)
  assert.equal(states[0].attention, false)
})

test('states() ranks attention-needing sessions on top', () => {
  const reducer = new PetReducer()
  // s1 is streaming (THINKING), s2 waits on the human (WAITING via ask).
  collect(reducer, session('s1'), [
    event('turn/start', {}, 1),
    event('assistant/message', {}, 2),
  ])
  collect(reducer, session('s2'), [
    event('turn/start', {}, 3),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 4),
  ])
  const states = reducer.states()
  assert.equal(states.length, 2)
  // WAITING (s2) must come first even though s1 was updated later.
  assert.equal(states[0].sessionId, 's2')
  assert.equal(states[0].state, PetState.WAITING)
  assert.equal(states[0].attention, true)
  assert.equal(states[1].sessionId, 's1')
  assert.equal(states[1].state, PetState.THINKING)
  assert.equal(states[1].attention, false)
})

test('states() marks ERROR as attention and sorts before WORKING', () => {
  const reducer = new PetReducer()
  collect(reducer, session('s1'), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'bash' }, 2),
  ])
  collect(reducer, session('s2'), [
    event('turn/start', {}, 3),
    event('assistant/message', {}, 4),
    event('turn/end', { reason: { kind: 'max-tokens' } }, 5),
  ])
  const states = reducer.states()
  assert.equal(states.length, 2)
  assert.equal(states[0].sessionId, 's2')
  assert.equal(states[0].state, PetState.ERROR)
  assert.equal(states[0].attention, true)
  assert.equal(states[1].sessionId, 's1')
  assert.equal(states[1].state, PetState.WORKING)
})

test('disposeSession removes the session from states()', () => {
  const reducer = new PetReducer()
  collect(reducer, session('s1'), [event('turn/start')])
  collect(reducer, session('s2'), [event('turn/start', {}, 2)])
  assert.equal(reducer.states().length, 2)
  reducer.disposeSession(session('s1'))
  const states = reducer.states()
  assert.equal(states.length, 1)
  assert.equal(states[0].sessionId, 's2')
})

