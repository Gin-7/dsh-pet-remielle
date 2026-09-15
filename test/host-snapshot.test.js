import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCompletionAck, Config, CONFIG_PATCH_FIELDS, createCompletionAckHandler, createPendingActionStore, createSessionCurrentHandler, createSessionOpenHandler, createStreamHub, createStateSnapshot, defaults, dropSubagentCompletions, publicConfig, readSessionTitle, streamClientOf } from '../src/index.js'
import { DEFAULT_PET_ID } from '../src/pets.js'
import { PetMessageKind, PetState, createMessage } from '../src/protocol.js'

function snapshotWith({ latest, pulse = null, config = {}, petId, getStates, getCompletions, getCurrent }) {
  return createStateSnapshot({
    getLatest: () => latest,
    getPulse: () => pulse,
    getConfig: () => config,
    getPetId: () => petId,
    getStates,
    getCompletions,
    getCurrent,
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

function stubStreamRes() {
  const writes = []
  const res = {
    writes,
    write(chunk) { writes.push(String(chunk)); return true },
    end() {},
    on() { return res },
  }
  return res
}

const idle = createMessage(PetMessageKind.STATE, {
  sessionId: 's1',
  state: PetState.IDLE,
  mood: '06',
  phase: 'turn-end',
  message: '任务完成咯，干得漂亮',
  detail: 's1 · 本轮已完成',
})

test('snapshot fills session title from getSessionTitle when missing', () => {
  const snapshot = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getStates: () => [{
      sessionId: 's1',
      state: PetState.THINKING,
      mood: '04',
      message: '让我想想最优解是什么',
      project: 'dsh-pet-remielle',
      updatedAt: 1,
    }],
    getSessionTitle: (sessionId) => sessionId === 's1' ? '审查提示框颜色与溢出问题' : undefined,
  })()
  assert.equal(snapshot.sessions[0].title, '审查提示框颜色与溢出问题')
  assert.equal(snapshot.sessions[0].project, 'dsh-pet-remielle')
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

test('snapshot sessions follow session-order: approval > ask > completion > current > recency', () => {
  const snapshot = snapshotWith({
    latest: idle,
    getCurrent: () => 'cur',
    getStates: () => [
      { sessionId: 'think', state: PetState.THINKING, attention: false, updatedAt: 9 },
      { sessionId: 'cur', state: PetState.WORKING, attention: false, updatedAt: 1 },
      { sessionId: 'ask', state: PetState.WAITING, ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'appr', state: PetState.WAITING, approval: true, attention: true, updatedAt: 3 },
    ],
    getCompletions: () => [{
      sessionId: 'done',
      message: '任务已完成',
      detail: '任务已完成',
      phase: 'turn-end',
      updatedAt: 8,
    }],
  })
  assert.deepEqual(snapshot.sessions.map((entry) => entry.sessionId), [
    'appr',
    'ask',
    'completion:done',
    'cur',
    'think',
  ])
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

test('undelivered session-action is stashed for replay when no web client is online', async () => {
  const store = createPendingActionStore()
  const handler = createSessionOpenHandler({
    notify: () => 0,
    onUndelivered: (action) => store.stash(action),
  })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: false, completed: true }), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).delivered, false)
  // 完整动作被暂存：SSE 订阅处 take() 后原样下发，网页端 applySnapshot 可直接消费
  assert.deepEqual(store.take(), {
    protocolVersion: 1,
    kind: 'session-action',
    sessionId: 's1',
    approve: false,
    completed: true,
  })
  // take 即清空：不重复重放
  assert.equal(store.take(), null)
})

test('delivered session-action is not stashed and only the latest one is kept', async () => {
  const stashed = []
  const deliveredHandler = createSessionOpenHandler({ notify: () => 2, onUndelivered: (a) => stashed.push(a) })
  const okRes = responseRecorder()
  await deliveredHandler(request('POST', { sessionId: 's1' }), okRes)
  assert.equal(stashed.length, 0)

  const store = createPendingActionStore()
  const handler = createSessionOpenHandler({ notify: () => 0, onUndelivered: (a) => store.stash(a) })
  await handler(request('POST', { sessionId: 'old' }), responseRecorder())
  await handler(request('POST', { sessionId: 'new' }), responseRecorder())
  // 只保留最新一条
  assert.equal(store.take().sessionId, 'new')
})

test('pending action store starts empty and clears after take', () => {
  const store = createPendingActionStore()
  assert.equal(store.take(), null)
  store.stash({ sessionId: 's1' })
  assert.equal(store.take().sessionId, 's1')
  assert.equal(store.take(), null)
})

test('approval actions are never stashed for delayed replay', async () => {
  const store = createPendingActionStore()
  const handler = createSessionOpenHandler({ notify: () => 0, onUndelivered: (a) => store.stash(a) })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: true }), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).delivered, false)
  // 审批时效性强：不暂存，避免网页长时间离线后重连握手时自动批准过时请求
  assert.equal(store.take(), null)
})

test('pending replay skips pet-window subscribers (?client=pet)', () => {
  // 桌宠窗口订阅带 ?client=pet 且丢弃带 kind 的帧，绝不能让它抢收重放
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream?client=pet'), 'pet')
  // 网页端不带参数（或带其他值）照常重放
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream'), 'web')
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream?client=web'), 'web')
  // 异常 url 兜底为网页订阅者
  assert.equal(streamClientOf(undefined), 'web')
})

test('hub notify counts only web clients as delivered', () => {
  const hub = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const pet = stubStreamRes()
  const web = stubStreamRes()
  hub.add(pet, { client: 'pet' })
  hub.add(web)
  assert.equal(hub.size, 2)
  // 桌宠常驻订阅不再把 session-action 顶成“已送达”
  assert.equal(hub.notify({ kind: 'session-action', sessionId: 's1' }), 1)
  // pet 窗口仍收到帧（其页面自行忽略带 kind 的帧），但不计数
  assert.ok(pet.writes.join('').includes('"sessionId":"s1"'))
  assert.equal(hub.notify({ kind: 'session-action' }), 1)
  hub.close()
})

test('desktop-only subscription keeps the click fallback alive end to end', async () => {
  const store = createPendingActionStore()
  const hub = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const handler = createSessionOpenHandler({
    notify: (payload) => hub.notify(payload),
    onUndelivered: (action) => store.stash(action),
  })
  // 只有桌宠窗口在线：delivered=false，动作必须进暂存而不是被顶成已送达
  hub.add(stubStreamRes(), { client: 'pet' })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's9', approve: false }), res)
  assert.equal(JSON.parse(res.body).delivered, false)
  assert.equal(store.take()?.sessionId, 's9')
  hub.close()
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

// 会话标题读取：sessionTitle 服务口径优先，服务不可用时回落会话日志折取
// （宿主 Session 的公开 API 是 snapshotEvents()，不是 session.events）。

function logSession(...titles) {
  return { snapshotEvents: () => titles.map((title) => ({ type: 'session/title', data: { title } })) }
}

test('readSessionTitle prefers the sessionTitle service and trims it', () => {
  const ctx = {
    sessions: { get: (id) => (id === 's1' ? logSession('日志里的标题') : undefined) },
    sessionTitle: { get: () => ({ title: '  服务口径标题  ' }) },
  }
  assert.equal(readSessionTitle(ctx, 's1'), '服务口径标题')
})

test('readSessionTitle folds the session log when the service throws', () => {
  // cordis 上服务未加载/被隔离时属性访问会抛错，可选链拦不住，必须整体兜住
  const ctx = {
    sessions: { get: () => logSession('旧标题', '日志里的标题') },
    get sessionTitle() { throw new Error('cannot get property "sessionTitle" without inject') },
  }
  assert.equal(readSessionTitle(ctx, 's1'), '日志里的标题')
})

test('readSessionTitle folds the session log when the service has no usable title', () => {
  const session = logSession('日志里的标题')
  assert.equal(
    readSessionTitle({ sessions: { get: () => session }, sessionTitle: { get: () => undefined } }, 's1'),
    '日志里的标题',
  )
  assert.equal(
    readSessionTitle({ sessions: { get: () => session }, sessionTitle: { get: () => ({ title: '   ' }) } }, 's1'),
    '日志里的标题',
  )
})

test('readSessionTitle is undefined without a live session or without any title', () => {
  assert.equal(readSessionTitle({ sessions: { get: () => undefined } }, 'nope'), undefined)
  assert.equal(readSessionTitle({ sessions: { get: () => logSession() } }, 's1'), undefined)
  assert.equal(readSessionTitle({ get sessions() { throw new Error('inactive context') } }, 's1'), undefined)
})

test('readSessionTitle survives a throwing snapshotEvents()', () => {
  const session = { snapshotEvents: () => { throw new Error('boom') } }
  assert.equal(readSessionTitle({ sessions: { get: () => session } }, 's1'), undefined)
})

// 配置的字段清单散在 Config schema、defaults、publicConfig 三处，加字段时最容易漏改
// 其中一处。这里钉住「schema 字段集 == defaults 字段集」且「默认值逐一相等」。
test('defaults mirrors the Config schema fields and their defaults', () => {
  const dict = Config.dict
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(dict).sort())
  for (const [key, field] of Object.entries(dict)) {
    assert.deepEqual(defaults[key], field.meta?.default, `${key} 的默认值与 schema 不一致`)
  }
})

// 关掉「响应子 Agent」时要撤掉队列里残留的子会话完成卡：网页端那层过滤只管合成卡，
// 管不到宿主队列，否则开着开关时完成的子会话卡会一直显示下去。
test('dropSubagentCompletions drops subagent cards and keeps the rest', () => {
  const queue = new Map([
    ['sub', { sessionId: 'sub' }],
    ['plain', { sessionId: 'plain' }],
    ['gone', { sessionId: 'gone' }],
  ])
  // 判定走宿主记账（已 dispose 的子会话照样认得），不依赖 live Session——
  // 所以 'gone' 也能被清掉，普通会话保持不动。
  const subagents = new Set(['sub', 'gone'])
  assert.equal(dropSubagentCompletions(queue, (id) => subagents.has(id)), true)
  assert.deepEqual([...queue.keys()], ['plain'])
})

test('dropSubagentCompletions is a no-op without queued subagent cards', () => {
  const queue = new Map([['plain', { sessionId: 'plain' }]])
  assert.equal(dropSubagentCompletions(queue, () => false), false)
  assert.deepEqual([...queue.keys()], ['plain'])
  // 判定函数抛错只跳过该条，不影响其他条目
  const throwing = new Map([['a', {}], ['b', {}]])
  assert.equal(dropSubagentCompletions(throwing, (id) => {
    if (id === 'a') throw new Error('boom')
    return true
  }), true)
  assert.deepEqual([...throwing.keys()], ['a'])
  assert.equal(dropSubagentCompletions(new Map(), () => true), false)
})

// 配置字段实际散在四处：Config schema、defaults、publicConfig、config 端点白名单。
// 上面那条只钉住前两处，这里把后两处也钉上——否则下一个人加字段漏改白名单时，
// 开关会静默失效而测试全绿（mirror 就差点这样：它四处都在，但没有任何测试守着）。
test('patch allowlist and publicConfig cover every user-facing config field', () => {
  // activePetId 与 pets 走宠物注册表端点，不进 config PATCH，也不出现在 publicConfig。
  const registryOnly = new Set(['activePetId', 'pets'])
  const expected = Object.keys(Config.dict).filter((key) => !registryOnly.has(key)).sort()
  assert.deepEqual([...CONFIG_PATCH_FIELDS].sort(), expected)
  assert.deepEqual(Object.keys(publicConfig({})).sort(), expected)
})
