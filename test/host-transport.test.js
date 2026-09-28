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