import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, applyCompletionAck, clientConfig, Config, CONFIG_PATCH_FIELDS, createCompletionAckHandler, createConfigHandler, createCurrentSessionStore, createPendingActionStore, createSessionCurrentHandler, createSessionOpenHandler, createSettingsScope, createStreamHub, createStateSnapshot, createThemeHandler, defaults, dropSubagentCompletions, normalizeHostTheme, publicConfig, readSessionTitle, streamClientOf } from '../src/index.js'
import { DEFAULT_PET_ID, PET_ID_RE } from '../src/pets.js'
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

function routeHarness() {
  const routes = new Map()
  const cleanups = []
  const webServer = {
    port: 3080,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const httpCtx = {
    webServer,
    get() { return undefined },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const ctx = {
    logger: { error() {}, warn() {} },
    inject(names, callback) {
      if (names.length === 1 && names[0] === 'settings') callback(ctx)
      else if (names.length === 1 && names[0] === 'webServer') callback(httpCtx)
    },
    on() { return () => {} },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  apply(ctx)
  return {
    routes,
    close() { for (const cleanup of cleanups.reverse()) cleanup() },
  }
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

// 快照顶层字段：配置、桌面窗状态、宠物 id、网页订阅数都在这里定型。
// 缺省值与覆盖值放在一起断言，避免分散在十条一行的用例里。
test('snapshot top-level fields follow config, desktop state and pet registry', () => {
  const full = snapshotWith({
    latest: idle,
    config: { enabled: true, scale: 1.25, opacity: 0.8, locked: true, desktopMode: true },
    petId: 'cirno',
  })
  assert.equal(full.enabled, true)
  assert.equal(full.scale, 1.25)
  assert.equal(full.opacity, 0.8)
  assert.equal(full.locked, true)
  assert.equal(full.bubble, true)
  // 客户端统一读 showBubble 别名；顶层 updatedAt 供 idle 占位卡使用
  assert.equal(full.showBubble, true)
  assert.equal(typeof full.updatedAt, 'number')
  assert.equal(full.desktopActive, false)
  assert.equal(full.desktopMode, true)
  assert.equal(full.petId, 'cirno')

  const bare = snapshotWith({ latest: idle })
  assert.equal(bare.enabled, true)
  assert.equal(bare.scale, 1)
  assert.equal(bare.opacity, 1)
  assert.equal(bare.locked, false)
  assert.equal(bare.bubble, true)
  assert.equal(bare.petId, DEFAULT_PET_ID)

  assert.equal(snapshotWith({ latest: idle, config: { enabled: false } }).enabled, false)
  // 桌面窗窗口开着时宿主才报 desktopActive
  assert.equal(createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => undefined,
    getDesktopActive: () => true,
  })().desktopActive, true)
  // 没有网页在线 / 上报过期时，缺省必须是 0 而不是 undefined
  assert.equal(createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getWebClients: () => 3,
  })().webClients, 3)
  assert.equal(bare.webClients, 0)
})

// 快照和 /config 都不得回传令牌明文；设置页只拿到 configured 标志，更新仍由 PATCH 写入。
test('state snapshot never carries platformToken', () => {
  const snapshot = snapshotWith({ latest: idle, config: { platformToken: 'sk-must-not-leak' }, petId: DEFAULT_PET_ID })
  assert.equal('platformToken' in snapshot, false)
  assert.equal(JSON.stringify(snapshot).includes('sk-must-not-leak'), false, '快照序列化后不得出现令牌明文')
  assert.equal(publicConfig({ platformToken: 'sk-ok' }).platformToken, 'sk-ok')
  assert.equal(clientConfig({ platformToken: 'sk-ok' }).platformTokenConfigured, true)
  assert.equal('platformToken' in clientConfig({ platformToken: 'sk-ok' }), false)
})

test('config route keeps platformToken write-only while preserving patch updates', async () => {
  const updates = []
  const settings = {
    get: () => ({ enabled: true, platformToken: 'sk-never-echo' }),
    update: async (patch) => { updates.push(patch) },
  }
  const handler = createConfigHandler(settings)
  const get = responseRecorder()
  await handler(request('GET'), get)
  const got = JSON.parse(get.body)
  assert.equal(get.status, 200)
  assert.equal(got.platformTokenConfigured, true)
  assert.equal('platformToken' in got, false)
  assert.equal(JSON.stringify(got).includes('sk-never-echo'), false)

  const patch = responseRecorder()
  await handler(request('PATCH', { platformToken: 'sk-replaced' }), patch)
  const updated = JSON.parse(patch.body)
  assert.deepEqual(updates, [{ platformToken: 'sk-replaced' }])
  assert.equal(updated.platformTokenConfigured, true)
  assert.equal('platformToken' in updated, false)

  const remoteHost = responseRecorder()
  const remoteRequest = request('GET')
  remoteRequest.headers.host = 'evil.example:3080'
  await handler(remoteRequest, remoteHost)
  assert.equal(remoteHost.status, 403)
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
  // 宠物 id 由注册表给，不随 pulse 覆盖而漂移
  assert.equal(snapshotWith({
    latest: idle,
    pulse: createMessage(PetMessageKind.PULSE, { sessionId: 's1', state: PetState.SUCCESS, mood: '03', ttlMs: 5000 }),
    petId: 'remielle',
  }).petId, 'remielle')
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

  // 过期后回落到持久状态，且不留下任何会话卡
  const expired = snapshotWith({ latest: idle, pulse: { ...pulse, until: Date.now() - 1000 } })
  assert.equal(expired.state, PetState.IDLE)
  assert.equal(expired.mood, '06')
  assert.deepEqual(expired.sessions, [])
})

/**
 * 快照的 sessions[] 顺序。
 *
 * 分工：优先级表本身只由 test/session-order.test.js 定义一处（它直接测
 * compareSessions）。这里是**接线护栏**——输入刻意排成 think/cur/plan/ask/appr，
 * 断言 createStateSnapshot 真的按共享比较器排过（完全不排序就会挂），而不是把
 * 规则再表述一遍。另外它还独占地覆盖一件 session-order 单测碰不到的事：
 * 完成通知进入 sessions[] 时会被加 `completion:` 前缀，且排在 attention 之前。
 */
test('snapshot sessions follow session-order: approval > plan review > ask > completion > current > recency', () => {
  const snapshot = snapshotWith({
    latest: idle,
    getCurrent: () => 'cur',
    getStates: () => [
      { sessionId: 'think', state: PetState.THINKING, attention: false, updatedAt: 9 },
      { sessionId: 'cur', state: PetState.WORKING, attention: false, updatedAt: 1 },
      { sessionId: 'plan', state: PetState.WAITING, planReview: true, attention: true, updatedAt: 4 },
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
    'plan',
    'ask',
    'completion:done',
    'cur',
    'think',
  ])
})

test('snapshot sessions[] mirrors tracked sessions, pulses and completions', () => {
  // 缺省：没有 states 时是空数组（客户端按数组存在与否区分"无会话"和"空快照"）
  assert.deepEqual(snapshotWith({ latest: idle }).sessions, [])

  const states = [
    { sessionId: 's2', state: PetState.WAITING, mood: '05', phase: 'ask', message: '等你回答', detail: 's2 · 等待回答', attention: true, updatedAt: 4 },
    { sessionId: 's1', state: PetState.THINKING, mood: '01', phase: 'streaming', message: '正在输出', detail: 's1 · 输出阶段', attention: false, updatedAt: 3 },
  ]
  assert.deepEqual(snapshotWith({ latest: idle, getStates: () => states }).sessions, states)

  // 活跃 pulse 覆盖同名会话的 entry，其他会话不动
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
  const flashed = snapshotWith({ latest: idle, getStates: () => states, pulse: { ...pulse, until: Date.now() + 4000 } }).sessions
  assert.equal(flashed.length, 2)
  const own = flashed.find((entry) => entry.sessionId === 's1')
  assert.equal(own.state, PetState.SUCCESS)
  assert.equal(own.mood, '03')
  assert.equal(own.message, '这次任务搞定啦~')
  assert.ok(own.pulseUntil > Date.now())
  assert.equal(flashed.find((entry) => entry.sessionId === 's2').state, PetState.WAITING)

  // 队列里的完成卡合成 completion:<id> 条目，pulse 过期后仍然留着
  const completion = {
    sessionId: 'done-1',
    message: '任务已完成',
    detail: '任务已完成',
    phase: 'turn-end',
    updatedAt: 12,
  }
  const done = snapshotWith({ latest: idle, getCompletions: () => [completion] }).sessions
  assert.equal(done.length, 1)
  assert.equal(done[0].sessionId, 'completion:done-1')
  assert.equal(done[0].targetSessionId, 'done-1')
  assert.equal(done[0].state, PetState.SUCCESS)
  assert.equal(done[0].completed, true)
  assert.equal(done[0].completionNotification, true)

  // 会话自己又活过来了：同一会话的完成提醒必须撤掉，不能重复占一张卡
  const live = snapshotWith({
    latest: idle,
    getStates: () => [{ sessionId: 'done-1', state: PetState.THINKING, mood: '04', message: '后续状态', detail: '分析阶段', updatedAt: 20 }],
    getCompletions: () => [completion],
  }).sessions
  assert.equal(live.length, 1)
  assert.equal(live[0].sessionId, 'done-1')
  assert.equal(live[0].state, PetState.THINKING)
  assert.equal(live.some((entry) => entry.sessionId === 'completion:done-1'), false)
})

/**
 * 宿主合成的两类卡——活跃脉冲覆盖出来的条目、队列里的完成提醒——必须显式带齐
 * approval / ask / planReview 三个 flag。
 *
 * 此前只给前两个。**行为上没有任何差别**：消费端一律判 `=== true`
 * （session-order.cjs 的 planReviewOf 就是 `entry.planReview === true`），缺字段与
 * `false` 严格等价，排序结果逐位相同。所以这条不是回归护栏，是**形状护栏**：
 * 三处合成点（脉冲覆盖、完成提醒、快照兜底）必须显式写出同一组 flag，这样后来人
 * 新增一种卡时能照着抄，而不必去猜"漏了会不会坏"——答案是不会坏，但不一致的
 * 字段集合会让读代码的人怀疑自己看漏了什么。
 */
test('synthesized cards carry the full flag set', () => {
  const pulseCard = snapshotWith({
    latest: idle,
    pulse: { ...createMessage(PetMessageKind.PULSE, { sessionId: 's1', state: PetState.WAITING, mood: '05', ttlMs: 5000 }), until: Date.now() + 4000 },
  }).sessions
  const completionCard = snapshotWith({
    latest: idle,
    getCompletions: () => [{ sessionId: 'done-1', message: '任务已完成', detail: '任务已完成', phase: 'turn-end', updatedAt: 12 }],
  }).sessions
  assert.equal(pulseCard.length, 1)
  assert.equal(completionCard.length, 1)
  for (const entry of [...pulseCard, ...completionCard]) {
    const where = entry.sessionId
    assert.equal(entry.approval, false, `${where} 应显式带 approval:false`)
    assert.equal(entry.ask, false, `${where} 应显式带 ask:false`)
    assert.equal(entry.planReview, false, `${where} 应显式带 planReview:false`)
  }
})

test('completion acknowledgement deletes one reminder, broadcasts, and forwards clearPulse', async () => {
  const acknowledged = []
  let broadcasts = 0
  const handler = createCompletionAckHandler({
    acknowledge: (sessionId, opts) => acknowledged.push({ sessionId, opts }),
    broadcast: () => { broadcasts += 1 },
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
  assert.equal(broadcasts, 2, '每次确认都要广播一次')
})

test('applyCompletionAck only clears a SUCCESS pulse when clearPulse is set', () => {
  const queue = new Map([['done-1', { sessionId: 'done-1' }]])
  const success = { sessionId: 'done-1', state: PetState.SUCCESS }
  assert.equal(applyCompletionAck(queue, success, 'done-1'), success)
  assert.equal(queue.has('done-1'), false)
  queue.set('done-1', { sessionId: 'done-1' })
  assert.equal(applyCompletionAck(queue, success, 'done-1', { clearPulse: true }), null)
  // ERROR 卡是"还没处理完"，确认完成提醒不得把它一起抹掉
  queue.set('done-1', { sessionId: 'done-1' })
  const errorPulse = { sessionId: 'done-1', state: PetState.ERROR }
  assert.equal(applyCompletionAck(queue, errorPulse, 'done-1', { clearPulse: true }), errorPulse)
})

// 三个本地 POST 端点同一条契约：非法方法回 405、缺 id 回 400，且都不得触发副作用。
