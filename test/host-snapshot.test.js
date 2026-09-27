import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, applyCompletionAck, Config, CONFIG_PATCH_FIELDS, createCompletionAckHandler, createCurrentSessionStore, createPendingActionStore, createSessionCurrentHandler, createSessionOpenHandler, createSettingsScope, createStreamHub, createStateSnapshot, createThemeHandler, defaults, dropSubagentCompletions, normalizeHostTheme, publicConfig, readSessionTitle, streamClientOf } from '../src/index.js'
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

// 快照经 SSE 广播给所有订阅者（任意网页标签页、桌面窗），不得携带平台令牌；
// 令牌只经 /config（publicConfig）下发给设置页，balance 服务直读 settings.get()。
test('state snapshot never carries platformToken', () => {
  const snapshot = snapshotWith({ latest: idle, config: { platformToken: 'sk-must-not-leak' }, petId: DEFAULT_PET_ID })
  assert.equal('platformToken' in snapshot, false)
  assert.equal(JSON.stringify(snapshot).includes('sk-must-not-leak'), false, '快照序列化后不得出现令牌明文')
  // 设置页那条路仍然拿得到
  assert.equal(publicConfig({ platformToken: 'sk-ok' }).platformToken, 'sk-ok')
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
test('local POST endpoints reject bad method and unusable session ids', async () => {
  const cases = [
    {
      name: 'completion/ack',
      handler: createCompletionAckHandler({ acknowledge: () => assert.fail('must not acknowledge') }),
      badBody: {},
    },
    {
      name: 'session/open',
      handler: createSessionOpenHandler({ notify: () => assert.fail('must not notify') }),
      badBody: {},
    },
    {
      name: 'session/current',
      handler: createSessionCurrentHandler({ accept: (id) => assert.fail(`must not store ${id}`) }),
      badBody: { sessionId: 42 },
    },
  ]
  for (const { name, handler, badBody } of cases) {
    const wrongMethod = responseRecorder()
    await handler(request('GET'), wrongMethod)
    assert.equal(wrongMethod.status, 405, `${name} 应拒绝非 POST`)
    const missing = responseRecorder()
    await handler(request('POST', badBody), missing)
    assert.equal(missing.status, 400, `${name} 应拒绝不可用的 sessionId`)
  }
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

test('undelivered session-action is stashed, delivered ones are not, latest wins', async () => {
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

  // 送达的动��不暂存；未送达的只保留最新一条
  const stashed = []
  const deliveredHandler = createSessionOpenHandler({ notify: () => 2, onUndelivered: (a) => stashed.push(a) })
  await deliveredHandler(request('POST', { sessionId: 's1' }), responseRecorder())
  assert.equal(stashed.length, 0)
  await handler(request('POST', { sessionId: 'old' }), responseRecorder())
  await handler(request('POST', { sessionId: 'new' }), responseRecorder())
  assert.equal(store.take().sessionId, 'new')

  // 审批时效性强：不暂存，避免网页长时间离线后重连握手时自动批准过时请求
  const approvalRes = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: true }), approvalRes)
  assert.equal(approvalRes.status, 200)
  assert.equal(JSON.parse(approvalRes.body).delivered, false)
  assert.equal(store.take(), null)
})

// 桌宠窗口的 SSE 订阅不能算"网页在线"：否则它会把点击动作顶成已送达，
// 网页端稍后就再也收不到重放。三处（订阅识别、hub 计数、端到端）合并断言。
test('pet-window subscribers never count as delivered web clients', async () => {
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream?client=pet'), 'pet')
  // 网页端不带参数（或带其他值）照常重放
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream'), 'web')
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream?client=web'), 'web')
  // 异常 url 兜底为网页订阅者
  assert.equal(streamClientOf(undefined), 'web')

  const hub = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const pet = stubStreamRes()
  hub.add(pet, { client: 'pet' })
  hub.add(stubStreamRes())
  assert.equal(hub.size, 2)
  assert.equal(hub.notify({ kind: 'session-action', sessionId: 's1' }), 1)
  // pet 窗口仍收到帧（其页面自行忽略带 kind 的帧），但不计数
  assert.ok(pet.writes.join('').includes('"sessionId":"s1"'))
  assert.equal(hub.notify({ kind: 'session-action' }), 1)
  hub.close()

  // 端到端：只有桌宠窗口在线时 delivered=false，动作必须进暂存而不是被顶成已送达
  const petOnly = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const store = createPendingActionStore()
  const handler = createSessionOpenHandler({
    notify: (payload) => petOnly.notify(payload),
    onUndelivered: (action) => store.stash(action),
  })
  petOnly.add(stubStreamRes(), { client: 'pet' })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's9', approve: false }), res)
  assert.equal(JSON.parse(res.body).delivered, false)
  assert.equal(store.take()?.sessionId, 's9')
  petOnly.close()
})

// 桌面窗要靠宿主快照里的 currentSessionId 才知道「你在看哪个会话」。同一标签页的
// 重复上报不广播；不同标签页独立保存，隐藏页清除不能抹掉可见页，过期状态也要失效。
test('session current uplink tracks changes per browser tab and expires stale reports', async () => {
  let now = 1000
  let stored = ''
  const seen = []
  const store = createCurrentSessionStore({ ttlMs: 100, now: () => now })
  const handler = createSessionCurrentHandler({
    store,
    accept: (id, meta) => { stored = id; seen.push([id, meta.clientId, meta.changed]) },
  })
  for (const [sessionId, clientId] of [['s1', 'tab-a'], ['s1', 'tab-a'], ['s2', 'tab-b']]) {
    const res = responseRecorder()
    await handler(request('POST', { sessionId, clientId }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
  }
  now += 50
  await handler(request('POST', { sessionId: '', clientId: 'tab-a' }), responseRecorder())
  assert.equal(stored, '')
  assert.equal(store.current(), 's2', '隐藏 tab 的清除不得抹掉可见 tab')
  assert.deepEqual(seen, [
    ['s1', 'tab-a', true],
    ['s1', 'tab-a', false],
    ['s2', 'tab-b', true],
    ['', 'tab-a', true],
  ])
  now += 51
  assert.equal(store.current(), '', '过期 tab 不得继续作为当前会话')
})

test('bubble-title route serves the real shared script handler', async () => {
  const harness = routeHarness()
  try {
    const handler = harness.routes.get('/plugins/dsh-pet-remielle/bubble-title.js')
    assert.equal(typeof handler, 'function')
    const res = responseRecorder()
    await handler(request('GET'), res)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /^application\/javascript/)
    assert.match(res.body, /__rm2BubbleTitle/)
  } finally {
    harness.close()
  }
})

// 桌面悬浮窗是独立窗口，读不到宿主页面的 body[data-ds-dark-theme]——它的深色开关
// 完全依赖网页端上报的 hostTheme。归一函数是这条链路唯一的入口：'Dark' 这类大小写
// 笔误必须在这里报错，否则会安静地让两端配色不一致（不逐屏对比几乎看不出来）。
test('host theme normalization accepts only dark/light and clears on empty', () => {
  assert.equal(normalizeHostTheme('dark'), 'dark')
  assert.equal(normalizeHostTheme('light'), 'light')
  assert.equal(normalizeHostTheme(''), '')
  assert.equal(normalizeHostTheme(undefined), '')
  assert.equal(normalizeHostTheme(null), '')
  assert.throws(() => normalizeHostTheme('Dark'), /theme/)
  assert.throws(() => normalizeHostTheme(true), /theme/)
})

test('theme uplink stores, clears, reports real changes and rejects bad input', async () => {
  const seen = []
  const handler = createThemeHandler({ accept: (theme, meta) => seen.push([theme, meta.changed]) })
  for (const theme of ['dark', 'dark', 'light', '', '']) {
    const res = responseRecorder()
    await handler(request('POST', { theme }), res)
    assert.equal(res.status, 200)
  }
  assert.deepEqual(seen, [
    ['dark', true],  // 首次上报：从「不知道」到 dark 也算一次变化
    ['dark', false], // 心跳续期重复上报同一个值：不广播
    ['light', true],
    ['', true],      // 清除（网页关闭）：桌面窗要立刻回落系统主题，属于真变化
    ['', false],
  ])

  let stored = 'untouched'
  const strict = createThemeHandler({ accept: (theme) => { stored = theme } })
  const bad = responseRecorder()
  await strict(request('POST', { theme: 'Dark' }), bad)
  assert.equal(bad.status, 400)
  assert.equal(stored, 'untouched')
  const wrongMethod = responseRecorder()
  await strict(request('GET'), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

// 网页端上报的 hostTheme / currentSessionId 都是"有才发"的字段：清空后必须字段
// 缺失（而非空串），桌面窗据此回落系统主题 / 取消"正在查看哪个会话"。
test('snapshot carries reported host theme and current session only when set', () => {
  const withReports = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getTheme: () => 'dark',
    getCurrent: () => 's1',
  })()
  assert.equal(withReports.hostTheme, 'dark')
  assert.equal(withReports.currentSessionId, 's1')

  // 没有网页在线 / 上报过期：字段缺失
  const unset = snapshotWith({ latest: idle })
  assert.equal(unset.hostTheme, undefined)
  assert.equal('hostTheme' in JSON.parse(JSON.stringify(unset)), false)
  assert.equal(unset.currentSessionId, undefined)

  // 空串（清除态）同样回落为缺失
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

test('readSessionTitle prefers the service and folds the log on every fallback', () => {
  assert.equal(readSessionTitle({
    sessions: { get: (id) => (id === 's1' ? logSession('日志里的标题') : undefined) },
    sessionTitle: { get: () => ({ title: '  服务口径标题  ' }) },
  }, 's1'), '服务口径标题')

  // cordis 上服务未加载/被隔离时属性访问会抛错，可选链拦不住，必须整体兜住
  assert.equal(readSessionTitle({
    sessions: { get: () => logSession('旧标题', '日志里的标题') },
    get sessionTitle() { throw new Error('cannot get property "sessionTitle" without inject') },
  }, 's1'), '日志里的标题')

  const session = logSession('日志里的标题')
  for (const unusable of [undefined, { title: '   ' }]) {
    assert.equal(
      readSessionTitle({ sessions: { get: () => session }, sessionTitle: { get: () => unusable } }, 's1'),
      '日志里的标题',
      '服务拿不到可用标题时应回落日志',
    )
  }
})

test('readSessionTitle is undefined without a live session or a usable title', () => {
  assert.equal(readSessionTitle({ sessions: { get: () => undefined } }, 'nope'), undefined)
  assert.equal(readSessionTitle({ sessions: { get: () => logSession() } }, 's1'), undefined)
  assert.equal(readSessionTitle({ get sessions() { throw new Error('inactive context') } }, 's1'), undefined)
  assert.equal(readSessionTitle({ sessions: { get: () => ({ snapshotEvents: () => { throw new Error('boom') } }) } }, 's1'), undefined)
})

test('createSettingsScope reads volatile refs and disposes the profile presentation', async () => {  const writes = []
  const disposers = []
  let configured
  let activeOwner
  let updateListener
  const formsFiber = { name: 'settings-entry' }
  const eventFiber = { name: 'event-root' }
  const formsContext = {
    fiber: formsFiber,
    settings: {
      describe() {},
      configure(...args) {
        configured = args
        if (activeOwner === args[1]) throw new Error('already configured')
        activeOwner = args[1]
        return () => {
          if (activeOwner === args[1]) activeOwner = undefined
        }
      },
      update(...args) { writes.push(args); return Promise.resolve() },
    },
    effect(callback) { disposers.push(callback()) },
  }
  const eventContext = {
    fiber: eventFiber,
    on(name, listener) {
      assert.equal(name, 'loader/volatile-update')
      updateListener = listener
      return () => {}
    },
  }
  const config = new Config()
  assert.equal(typeof config.desktopMode.get, 'function')
  const scope = createSettingsScope(formsContext, config, eventContext)
  assert.deepEqual(configured, [{ auto: false }, eventFiber])
  assert.equal(disposers.length, 1)
  assert.equal(scope.get().desktopMode, false)
  assert.equal(typeof updateListener, 'undefined')
  scope.watch(() => {})
  assert.equal(typeof updateListener, 'function')
  disposers[0]()
  createSettingsScope(formsContext, config, eventContext)
  assert.equal(disposers.length, 2)
  disposers[1]()
  await scope.update({ desktopMode: true })
  assert.deepEqual(writes, [['dsh-pet-remielle', { desktopMode: true }]])
})

// DSH 的 settings.resolve 是 `schema(base+section)`：0.4.3 起 schema 字段带
// .volatile()，schemastery 会把每个字段解析成 cosmokit volatile 包装对象（值藏在
// wrapper.get() 里），DSH 的 scope.get()/watch 原样返回这层包装。插件若直接属性
// 访问，pets 变非数组（宠物列表清空）、usageMode 变 '[object Object]'——2026-09-26
// 真机事故。register 分支的 get/watch 必须先解包再交给插件内部。
test('createSettingsScope unwraps volatile wrappers on the DSH register path', () => {
  const section = {
    enabled: true,
    scale: 1.2,
    usageMode: 'token',
    platformToken: 'tok-123',
    desktopX: 280,
    desktopY: 482,
    activePetId: 'remielle',
    pets: [{ id: 'remielle', name: '蕾米埃尔', enabled: true }],
  }
  // 模拟 DSH：把持久化 section 灌进真实 schema，得到 wrapper 层 resolved 值
  const resolved = Config(section)
  assert.equal(typeof resolved.usageMode.get, 'function')
  let watchCallback
  const formsContext = {
    settings: {
      register(ns, schema, options) {
        assert.equal(ns, 'dsh-pet-remielle')
        return {
          get: () => resolved,
          watch(callback) { watchCallback = callback; return () => {} },
          update: () => Promise.resolve(),
        }
      },
    },
  }
  const scope = createSettingsScope(formsContext, {}, formsContext)
  const got = scope.get()
  assert.equal(got.usageMode, 'token')
  assert.equal(got.platformToken, 'tok-123')
  assert.equal(got.scale, 1.2)
  assert.equal(got.desktopX, 280)
  assert.equal(got.activePetId, 'remielle')
  assert.equal(Array.isArray(got.pets), true)
  assert.equal(got.pets.length, 1)
  assert.equal(got.pets[0].name, '蕾米埃尔')
  // 未持久化的字段回落 schema 默认值，而不是 undefined/包装对象
  assert.equal(got.bubbleScaleSync, true)
  // watch 回调同样解包：next.desktopMode === false 的判断要能成立
  const seen = []
  scope.watch((next) => seen.push(next))
  assert.equal(typeof watchCallback, 'function')
  watchCallback(resolved, resolved)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].desktopMode, false)
  assert.equal(seen[0].usageMode, 'token')
})

// 关掉「响应子 Agent」时要撤掉队列里残留的子会话完成卡：网页端那层过滤只管合成卡，
// 管不到宿主队列，否则开着开关时完成的子会话卡会一直显示下去。
test('dropSubagentCompletions prunes only queued subagent cards', () => {
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

  const none = new Map([['plain', { sessionId: 'plain' }]])
  assert.equal(dropSubagentCompletions(none, () => false), false)
  assert.deepEqual([...none.keys()], ['plain'])
  assert.equal(dropSubagentCompletions(new Map(), () => true), false)
})

// 配置字段实际散在四处：Config schema、defaults、publicConfig、config 端点白名单，
// 外加 DSH 0.1.7 的 volatile / secret / pattern 边界。任一处漏改都会让开关静默失效
// （mirror 就差点这样：它四处都在，但没有任何测试守着），因此合成一条钉住全部。
//
// meta / inner 是 schemastery 的实现细节：default、volatile、role、pattern 只能从这里
// 读，没有公开的等价 API。0.4.4「volatile 配置失效」正是被 volatile 这条抓到的，所以
// 整套断言保留——但形状一旦变化，报错必须指向「meta 形状变了」，而不是某条字段对不上，
// 故先钉一次形状本身。
test('config field lists and DSH 0.1.7 schema boundaries stay in sync', () => {
  const dict = Config.dict
  const metaOf = (field, what) => {
    assert.ok(field && (typeof field === 'object' || typeof field === 'function'), `${what}：schema 里应能取到该字段`)
    assert.ok(field.meta && typeof field.meta === 'object', `${what}：schemastery 字段应带 meta（本测试的观察窗）`)
    return field.meta
  }
  // schemastery 为了可序列化，把 pattern 存成 { source, flags } 普通对象而不是
  // RegExp 实例（实测 `meta.pattern instanceof RegExp` 为 false），所以只能取
  // .source 比字符串。
  const patternOf = (field, what) => {
    const pattern = metaOf(field, what).pattern
    assert.ok(pattern && typeof pattern === 'object' && typeof pattern.source === 'string', `${what}：schema 上应挂有正则约束（{ source, flags } 形式）`)
    return pattern.source
  }
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(dict).sort())
  for (const [key, field] of Object.entries(dict)) {
    const meta = metaOf(field, key)
    assert.deepEqual(defaults[key], meta.default, `${key} 的默认值与 schema 不一致`)
    assert.equal(meta.volatile, true, `${key} 必须是 volatile 配置字段`)
  }
  assert.equal(metaOf(Config.dict.platformToken, 'platformToken').role, 'secret', 'platformToken 必须按 secret 脱敏')
  assert.equal(patternOf(Config.dict.activePetId, 'activePetId'), PET_ID_RE.source)
  assert.equal(patternOf(Config.dict.pets?.inner?.dict?.id, 'pets[].id'), PET_ID_RE.source)

  // activePetId 与 pets 走宠物注册表端点，不进 config PATCH，也不出现在 publicConfig。
  const registryOnly = new Set(['activePetId', 'pets'])
  const expected = Object.keys(dict).filter((key) => !registryOnly.has(key)).sort()
  assert.deepEqual([...CONFIG_PATCH_FIELDS].sort(), expected)
  assert.deepEqual(Object.keys(publicConfig({})).sort(), expected)
})

// 路由注册只应依赖 webServer。
//
// 上游一度写成 ctx.inject(['webServer', 'connection'], cb)，而 cordis 的 inject
// 要求列表里**所有**服务都可用才执行回调——那个回调里包着 mount() 的全部 20 条
// webServer.register。于是在没有 connection 服务的宿主上，插件不是某个端点坏，
// 而是整张路由表都不注册：没有状态推送、没有气泡、没有设置面板，且没有任何报错。
// 那个 commit 的本意只是让 desktop url 带上进程 token，不该 gate 整张路由表。
//
// 钉的是依赖**清单**这个配置事实：把 'connection' 加回列表就报红。这里仍用源码
// 匹配而非真的 mount 一遍——mount 会读宠物注册表并起一堆异步，mock 成本高且脆；
// 而这条断言要防的正是「有人顺手把可选服务写进 inject 列表」这一种改动。
test('route registration does not depend on the optional connection service', async () => {
  const harness = routeHarness()
  try {
    assert.ok(harness.routes.size >= 10, '缺少可选 connection 时仍应完成整张路由表注册')
    assert.ok(harness.routes.has('/plugins/dsh-pet-remielle/state'))
    assert.ok(harness.routes.has('/plugins/dsh-pet-remielle/session/current'))
    const state = responseRecorder()
    await harness.routes.get('/plugins/dsh-pet-remielle/state')(request('GET'), state)
    assert.equal(state.status, 200)
  } finally {
    harness.close()
  }
})