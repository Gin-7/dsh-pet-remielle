import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCompletionAck, createCompletionAckHandler, createSessionCurrentHandler, createSessionOpenHandler, createStateSnapshot } from '../src/index.js'
import { DEFAULT_PET_ID } from '../src/pets.js'
import { PetMessageKind, PetState, createMessage } from '../src/protocol.js'

function snapshotWith({ latest, pulse = null, config = {}, petId, getStates, getCompletions }) {
  return createStateSnapshot({
    getLatest: () => latest,
    getPulse: () => pulse,
    getConfig: () => config,
    getPetId: () => petId,
    getStates,
    getCompletions,
  })()
}

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body = String(body) },
  }
}

function request(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

const idle = createMessage(PetMessageKind.STATE, {
  sessionId: 's1',
  state: PetState.IDLE,
  mood: '06',
  phase: 'turn-end',
  message: '任务完成咯，干得漂亮',
  detail: 's1 · 本轮已完成',
})

test('snapshot carries config fields for the client', () => {
  const snapshot = snapshotWith({
    latest: idle,
    config: { enabled: true, scale: 1.25, opacity: 0.8, locked: true, desktopMode: true },
  })
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.scale, 1.25)
  assert.equal(snapshot.opacity, 0.8)
  assert.equal(snapshot.locked, true)
  assert.equal(snapshot.bubble, true)
  // 客户端统一读 showBubble 别名；顶层 updatedAt 供 idle 占位卡使用
  assert.equal(snapshot.showBubble, true)
  assert.equal(typeof snapshot.updatedAt, 'number')
  assert.equal(snapshot.desktopActive, false)
  assert.equal(snapshot.desktopMode, true)
})

test('snapshot reports the desktop window state', () => {
  const snapshot = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => undefined,
    getDesktopActive: () => true,
  })()
  assert.equal(snapshot.desktopActive, true)
})

test('snapshot defaults config when absent', () => {
  const snapshot = snapshotWith({ latest: idle })
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.scale, 1)
  assert.equal(snapshot.opacity, 1)
  assert.equal(snapshot.locked, false)
  assert.equal(snapshot.bubble, true)
})

test('snapshot exposes showBubble=false and pulse expiry', () => {
  const pulse = {
    ...createMessage(PetMessageKind.PULSE, {
      sessionId: 's1',
      state: PetState.SUCCESS,
      mood: '03',
      ttlMs: 5000,
      resumeState: PetState.IDLE,
      resumeMood: '06',
      resumeMessage: '待命中',
      resumeDetail: 'DSH',
      message: '成功',
      detail: 's1 · 本轮已完成',
    }),
    until: Date.now() + 5000,
  }
  const snapshot = snapshotWith({
    latest: idle,
    pulse,
    config: { showBubble: false },
  })
  assert.equal(snapshot.bubble, false)
  assert.ok(snapshot.pulseUntil > Date.now())
  const settled = snapshotWith({ latest: idle, config: { showBubble: false } })
  assert.equal(settled.pulseUntil, 0)
})

test('snapshot carries the active pet id', () => {
  const snapshot = snapshotWith({ latest: idle, petId: 'cirno' })
  assert.equal(snapshot.petId, 'cirno')
})

test('snapshot defaults the pet id when absent', () => {
  const snapshot = snapshotWith({ latest: idle })
  assert.equal(snapshot.petId, DEFAULT_PET_ID)
})

test('snapshot keeps the pet id stable across pulse overlays', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
  })
  const snapshot = snapshotWith({ latest: idle, pulse, petId: 'remielle' })
  assert.equal(snapshot.petId, 'remielle')
})

test('active pulse overlay wins over durable state', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    message: '这次任务搞定啦~',
    detail: 's1 · 本轮已完成',
  })
  const snapshot = snapshotWith({
    latest: idle,
    pulse: { ...pulse, until: Date.now() + 4000 },
  })
  assert.equal(snapshot.state, PetState.SUCCESS)
  assert.equal(snapshot.mood, '03')
  assert.equal(snapshot.message, '这次任务搞定啦~')
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.sessions[0].sessionId, 's1')
  assert.equal(snapshot.sessions[0].state, PetState.SUCCESS)
})

test('expired pulse falls back to durable state', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    resumeMessage: '任务完成咯，干得漂亮',
    resumeDetail: 's1 · 本轮已完成',
    message: '这次任务搞定啦~',
    detail: 's1 · 本轮已完成',
  })
  const snapshot = snapshotWith({
    latest: idle,
    pulse: { ...pulse, until: Date.now() - 1000 },
  })
  assert.equal(snapshot.state, PetState.IDLE)
  assert.equal(snapshot.mood, '06')
  assert.deepEqual(snapshot.sessions, [])
})

test('disabled config is reflected in the snapshot', () => {
  const snapshot = snapshotWith({ latest: idle, config: { enabled: false } })
  assert.equal(snapshot.enabled, false)
})

test('snapshot carries one entry per tracked session for stacked bubbles', () => {
  const states = [
    { sessionId: 's2', state: PetState.WAITING, mood: '05', phase: 'ask', message: '等你回答', detail: 's2 · 等待回答', attention: true, updatedAt: 4 },
    { sessionId: 's1', state: PetState.THINKING, mood: '01', phase: 'streaming', message: '正在输出', detail: 's1 · 输出阶段', attention: false, updatedAt: 3 },
  ]
  const snapshot = snapshotWith({ latest: idle, getStates: () => states })
  assert.deepEqual(snapshot.sessions, states)
})

test('active pulse overrides its own session entry in sessions[]', () => {
  const states = [
    { sessionId: 's2', state: PetState.WAITING, mood: '05', phase: 'ask', message: '等你回答', detail: 's2 · 等待回答', attention: true, updatedAt: 4 },
    { sessionId: 's1', state: PetState.THINKING, mood: '01', phase: 'streaming', message: '正在输出', detail: 's1 · 输出阶段', attention: false, updatedAt: 3 },
  ]
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    message: '这次任务搞定啦~',
    detail: 's1 · 本轮已完成',
  })
  const snapshot = snapshotWith({
    latest: idle,
    getStates: () => states,
    pulse: { ...pulse, until: Date.now() + 4000 },
  })
  assert.equal(snapshot.sessions.length, 2)
  const flashed = snapshot.sessions.find((entry) => entry.sessionId === 's1')
  assert.equal(flashed.state, PetState.SUCCESS)
  assert.equal(flashed.mood, '03')
  assert.equal(flashed.message, '这次任务搞定啦~')
  assert.ok(flashed.pulseUntil > Date.now())
  // The waiting session's entry is untouched.
  const waiting = snapshot.sessions.find((entry) => entry.sessionId === 's2')
  assert.equal(waiting.state, PetState.WAITING)
})

test('sessions defaults to an empty array when no states feed is provided', () => {
  const snapshot = snapshotWith({ latest: idle })
  assert.deepEqual(snapshot.sessions, [])
})

test('live session suppresses its own completion reminder', () => {
  const snapshot = snapshotWith({
    latest: idle,
    getStates: () => [{
      sessionId: 'done-1',
      state: PetState.THINKING,
      mood: '04',
      message: '后续状态',
      detail: '分析阶段',
      updatedAt: 20,
    }],
    getCompletions: () => [{
      sessionId: 'done-1',
      message: '任务已完成',
      detail: '任务已完成',
      phase: 'turn-end',
      updatedAt: 12,
    }],
  })
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.sessions[0].sessionId, 'done-1')
  assert.equal(snapshot.sessions[0].state, PetState.THINKING)
  assert.equal(snapshot.sessions.some((entry) => entry.sessionId === 'completion:done-1'), false)
})

test('completion acknowledgement deletes one reminder and broadcasts', async () => {
  const acknowledged = []
  let broadcasts = 0
  const handler = createCompletionAckHandler({
    acknowledge: (sessionId) => acknowledged.push(sessionId),
    broadcast: () => { broadcasts += 1 },
  })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 'done-1' }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(acknowledged, ['done-1'])
  assert.equal(broadcasts, 1)
})

test('completion acknowledgement forwards clearPulse only when requested', async () => {
  const acknowledged = []
  const handler = createCompletionAckHandler({
    acknowledge: (sessionId, opts) => acknowledged.push({ sessionId, opts }),
  })
  const plain = responseRecorder()
  await handler(request('POST', { sessionId: 'done-1' }), plain)
  const flagged = responseRecorder()
  await handler(request('POST', { sessionId: 'done-1', clearPulse: true }), flagged)
  assert.equal(plain.status, 200)
  assert.equal(flagged.status, 200)
  assert.deepEqual(acknowledged, [
    { sessionId: 'done-1', opts: { clearPulse: false } },
    { sessionId: 'done-1', opts: { clearPulse: true } },
  ])
})

test('applyCompletionAck clears SUCCESS pulse only when clearPulse is set', () => {
  const queue = new Map([['done-1', { sessionId: 'done-1' }]])
  const success = { sessionId: 'done-1', state: PetState.SUCCESS }
  assert.equal(applyCompletionAck(queue, success, 'done-1'), success)
  assert.equal(queue.has('done-1'), false)
  queue.set('done-1', { sessionId: 'done-1' })
  assert.equal(applyCompletionAck(queue, success, 'done-1', { clearPulse: true }), null)
})

test('applyCompletionAck does not clear an ERROR pulse', () => {
  const queue = new Map([['done-1', { sessionId: 'done-1' }]])
  const errorPulse = { sessionId: 'done-1', state: PetState.ERROR }
  assert.equal(applyCompletionAck(queue, errorPulse, 'done-1', { clearPulse: true }), errorPulse)
})

test('completion acknowledgement rejects missing session ids and non-POST methods', async () => {
  const handler = createCompletionAckHandler({ acknowledge: () => assert.fail('must not acknowledge') })
  const missing = responseRecorder()
  await handler(request('POST', {}), missing)
  assert.equal(missing.status, 400)
  const wrongMethod = responseRecorder()
  await handler(request('GET'), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('persistent completions remain in sessions after the pulse expires', () => {
  const snapshot = snapshotWith({
    latest: idle,
    getCompletions: () => [{
      sessionId: 'done-1',
      message: '任务已完成',
      detail: '任务已完成',
      phase: 'turn-end',
      updatedAt: 12,
    }],
  })
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.sessions[0].sessionId, 'completion:done-1')
  assert.equal(snapshot.sessions[0].targetSessionId, 'done-1')
  assert.equal(snapshot.sessions[0].state, PetState.SUCCESS)
  assert.equal(snapshot.sessions[0].completed, true)
  assert.equal(snapshot.sessions[0].completionNotification, true)
})

test('desktop session open notifies the browser client and reports delivery', async () => {
  const notified = []
  const handler = createSessionOpenHandler({
    notify: (payload) => { notified.push(payload); return 1 },
  })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: true }), res)
  assert.equal(res.status, 200)
  assert.equal(notified.length, 1)
  assert.equal(notified[0].kind, 'session-action')
  assert.equal(notified[0].sessionId, 's1')
  assert.equal(notified[0].approve, true)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.delivered, true)

  // 完成卡点击：completed 必须透传给网页端（决定是否顺带 ack）
  const completedRes = responseRecorder()
  await handler(request('POST', { sessionId: 's1c', approve: false, completed: true }), completedRes)
  assert.equal(notified[1].kind, 'session-action')
  assert.equal(notified[1].sessionId, 's1c')
  assert.equal(notified[1].approve, false)
  assert.equal(notified[1].completed, true)

  // 没有网页客户端订阅时（notify 返回 0）：仍 200，但 delivered=false
  const silentHandler = createSessionOpenHandler({ notify: () => 0 })
  const silentRes = responseRecorder()
  await silentHandler(request('POST', { sessionId: 's2', approve: true }), silentRes)
  assert.equal(silentRes.status, 200)
  const silentBody = JSON.parse(silentRes.body)
  assert.equal(silentBody.ok, true)
  assert.equal(silentBody.delivered, false)
})

test('desktop session open rejects missing session ids and non-POST methods', async () => {
  const handler = createSessionOpenHandler({ notify: () => assert.fail('must not notify') })
  const missing = responseRecorder()
  await handler(request('POST', {}), missing)
  assert.equal(missing.status, 400)
  const wrongMethod = responseRecorder()
  await handler(request('GET'), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('session current uplink stores and clears the reported session id', async () => {
  let stored = ''
  const handler = createSessionCurrentHandler({ accept: (id) => { stored = id } })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's1' }), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(stored, 's1')
  // 空串=清除（用户关掉所有对话/页面卸载时上报）
  const cleared = responseRecorder()
  await handler(request('POST', { sessionId: '' }), cleared)
  assert.equal(cleared.status, 200)
  assert.equal(stored, '')
})

test('session current uplink rejects non-string ids and non-POST methods', async () => {
  let stored = 'untouched'
  const handler = createSessionCurrentHandler({ accept: (id) => { stored = id } })
  const bad = responseRecorder()
  await handler(request('POST', { sessionId: 42 }), bad)
  assert.equal(bad.status, 400)
  assert.equal(stored, 'untouched')
  const wrongMethod = responseRecorder()
  await handler(request('GET'), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('snapshot carries the reported current session id', () => {
  const snapshot = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getCurrent: () => 's1',
  })()
  assert.equal(snapshot.currentSessionId, 's1')
})

test('snapshot omits currentSessionId when unset or cleared', () => {
  const unset = snapshotWith({ latest: idle })
  assert.equal(unset.currentSessionId, undefined)
  // 空串（清除态）同样回落为缺失：JSON 序列化后字段不存在
  const cleared = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getCurrent: () => '',
  })()
  assert.equal(cleared.currentSessionId, undefined)
  assert.equal('currentSessionId' in JSON.parse(JSON.stringify(cleared)), false)
})
