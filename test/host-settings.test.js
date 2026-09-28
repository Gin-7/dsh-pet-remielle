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

test('dropSubagentCompletions skips ids whose classifier throws', () => {
  const queue = new Map([
    ['broken', { sessionId: 'broken' }],
    ['sub', { sessionId: 'sub' }],
    ['plain', { sessionId: 'plain' }],
  ])
  assert.equal(dropSubagentCompletions(queue, (id) => {
    if (id === 'broken') throw new Error('classifier unavailable')
    return id === 'sub'
  }), true)
  assert.deepEqual([...queue.keys()], ['broken', 'plain'])
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
