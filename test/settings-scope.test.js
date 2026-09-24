/**
 * 设置桥接护栏（DSH 0.1.7 #677）。
 *
 * 0.1.7 移除了 `ctx.settings.register()`，改用 `describe()` / `update(ns, patch)` 寻址，
 * 且只接受带 `meta.volatile` 的 section。原先的可选调用静默退化成只读门面，于是每次
 * `settings.update(...)` 都抛 TypeError、被 /config 报成一个光秃秃的 400 又被右键菜单
 * 吞掉——「桌面悬浮模式」开关点了没反应就是这样来的。
 *
 * 这里钉住四条契约：字段都标 volatile；只面向 0.1.7+ 这一种宿主形态（没有可写服务时
 * 只读且写入抛错）；写入先就地生效再落盘；自己的信号不重读、外部变更的三个信号合成一趟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, CONFIG_PATCH_FIELDS, createSettingsScope } from '../src/index.js'

/** 每个 Config 字段都是 live 的：config PATCH 白名单 + 宠物注册表那两个。 */
const LIVE_FIELDS = [...CONFIG_PATCH_FIELDS, 'activePetId', 'pets'].sort()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 一个 0.1.7 形态的宿主：有 describe/update，没有 register。
 *
 * @param {object} [options]
 * @param {string} [options.ns] entry id（settings 命名空间）。
 * @param {boolean} [options.reject] `update()` 一律拒绝，用来验回滚。
 * @param {boolean} [options.defer] `update()` 先挂起，直到 `release()`，用来验乐观生效。
 */
function modernHost({ ns = 'dsh-pet-remielle', reject = false, defer = false } = {}) {
  // 假 entry 的 `id` getter 故意带 `include:` 前缀（真实 loader 就这么拼）：拿 `entry.id`
  // 当命名空间的写法必须在这里报红。
  const fiber = { uid: 1, entry: { id: `include:${ns}`, options: { id: ns, name: 'dsh-pet-remielle' } } }
  const listeners = new Map()
  let release
  const gate = defer ? new Promise((resolve) => { release = resolve }) : null
  const state = {
    fields: {},
    sent: [], // 每次真正调进宿主的 batch
    persisted: [], // 落盘成功的 batch
    describes: 0,
    disposers: [],
  }
  const service = {
    writable: true,
    describe() {
      state.describes += 1
      return [{
        ns,
        value: { ...state.fields },
        revision: state.persisted.length,
        schema: Config.toJSON(),
        applies: 'live',
      }]
    },
    async update(target, patch) {
      state.sent.push({ ns: target, patch })
      if (gate !== null) await gate
      if (reject) throw new Error(`Plugin entry "${target}" has no volatile fields`)
      state.persisted.push({ ns: target, patch })
      Object.assign(state.fields, patch)
      // 宿主把变更广播出去；插件靠它重读 section。
      for (const listener of listeners.get('settings/document-updated') ?? []) {
        listener(ns, state.persisted.length)
      }
    },
  }
  const ctx = {
    settings: service,
    fiber,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(event, list.filter((candidate) => candidate !== listener))
      }
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') state.disposers.push(disposer)
      return disposer
    },
  }
  return {
    ctx,
    state,
    service,
    /** 放行被 `defer` 挂住的那批落盘。 */
    release: () => release?.(),
    /** 模拟宿主自己发信号。 */
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

test('every Config field is marked volatile (the 0.1.7 write precondition)', () => {
  const fields = Object.keys(Config.dict).sort()
  assert.deepEqual(fields, LIVE_FIELDS)
  const plain = fields.filter((key) => Config.dict[key].meta.volatile !== true)
  assert.deepEqual(plain, [], 'settings.update() rejects a section whose schema has no volatile node')
  // pets 自己 volatile 就够；元素 schema 再标会撞上 schemastery 的
  //「volatile fields require a fixed object path without an enclosing volatile field」。
  const petFields = Object.keys(Config.dict.pets.inner.dict)
  const nested = petFields.filter((key) => Config.dict.pets.inner.dict[key].meta.volatile === true)
  assert.deepEqual(nested, [])
})

test('the 0.1.7 face writes through update(ns, patch) and reads the value back', async () => {
  const { ctx, state } = modernHost()
  const settings = createSettingsScope(ctx, { desktopMode: false })
  assert.equal(settings.get().desktopMode, false)

  await settings.update({ desktopMode: true })

  assert.deepEqual(state.persisted, [{ ns: 'dsh-pet-remielle', patch: { desktopMode: true } }])
  assert.equal(settings.get().desktopMode, true)
})

test('writes address the entry id the user actually configured', async () => {
  const { ctx, state } = modernHost({ ns: 'my-remielle' })
  const settings = createSettingsScope(ctx, { scale: 1 })

  await settings.update({ scale: 1.35 })

  assert.equal(state.persisted[0].ns, 'my-remielle')
  assert.equal(settings.get().scale, 1.35)
})

test('a write takes effect locally before the host has persisted it', async () => {
  const { ctx, state, release } = modernHost({ defer: true })
  const settings = createSettingsScope(ctx, { desktopMode: false })
  const seen = []
  settings.watch((next) => seen.push(next.desktopMode))

  const writing = settings.update({ desktopMode: true })
  await Promise.resolve()

  assert.equal(settings.get().desktopMode, true, 'the pet must not wait for a profile write')
  assert.deepEqual(seen, [true], 'subscribers see it before persistence finishes')
  assert.deepEqual(state.persisted, [], 'and nothing has landed yet')

  release()
  await writing
  assert.deepEqual(state.persisted, [{ ns: 'dsh-pet-remielle', patch: { desktopMode: true } }])
})

test('a burst of writes coalesces, newest state winning', async () => {
  const { ctx, state, release } = modernHost({ defer: true })
  const settings = createSettingsScope(ctx, { scale: 1 })

  const first = settings.update({ scale: 1.1 })
  // update() 先让出一轮事件循环再落盘（好让广播先出去），所以等第一批发进宿主。
  while (state.sent.length === 0) await sleep(1)

  const second = settings.update({ scale: 1.2 })
  const third = settings.update({ scale: 1.3 })
  await sleep(1)

  assert.equal(state.sent.length, 1, 'the queue holds at most one batch while a write is in flight')
  assert.equal(settings.get().scale, 1.3, 'every caller sees its own value immediately')

  release()
  await Promise.all([first, second, third])

  assert.deepEqual(
    state.persisted.map((row) => row.patch),
    [{ scale: 1.1 }, { scale: 1.3 }],
    'the burst that piles up behind the in-flight write collapses into one follow-up batch',
  )
})

test('a continuous burst is not persisted until it quiets down', async () => {
  const { ctx, state } = modernHost()
  const settings = createSettingsScope(ctx, { scale: 1 })

  const writes = []
  for (let i = 0; i < 5; i++) {
    writes.push(settings.update({ scale: 1 + i * 0.05 }))
    await sleep(40) // 比静默窗口密：拖动滑块时客户端就是 100ms 一推
  }

  assert.deepEqual(state.persisted, [], 'a drag must not write the profile while it is still moving')
  assert.equal(settings.get().scale, 1.2, 'but the pet already followed every step')

  await Promise.all(writes)
  assert.deepEqual(
    state.persisted.map((row) => row.patch),
    [{ scale: 1.2 }],
    'one profile write for the whole gesture',
  )
})

test('a superseded write resolves without holding the request open', async () => {
  const { ctx, state, release } = modernHost({ defer: true })
  const settings = createSettingsScope(ctx, { scale: 1 })

  const first = settings.update({ scale: 1.1 })
  while (state.sent.length === 0) await sleep(5) // 第一批已交给宿主，并被 defer 挂住

  const second = settings.update({ scale: 1.2 })
  const race = await Promise.race([second.then(() => 'resolved'), sleep(60).then(() => 'pending')])
  assert.equal(race, 'resolved', 'a value that is already superseded must not wait for a disk write')
  assert.equal(settings.get().scale, 1.2)

  release()
  await Promise.all([first, second])
  assert.deepEqual(state.persisted.map((row) => row.patch), [{ scale: 1.1 }, { scale: 1.2 }])
})

test('watch fires for own writes and for an external change', async () => {
  const { ctx, state, emit } = modernHost()
  const settings = createSettingsScope(ctx, { scale: 1 })
  const seen = []
  const off = settings.watch((next) => seen.push(next.scale))

  await settings.update({ scale: 1.5 })
  // 宿主自己的设置页（或遗留 settings.yaml 导入）改了同一个 section
  state.fields.scale = 1.8
  emit('settings/document-updated', 'dsh-pet-remielle', 9)
  await sleep(120)

  assert.deepEqual(seen, [1.5, 1.8])

  off()
  await settings.update({ scale: 2 })
  assert.deepEqual(seen, [1.5, 1.8], 'a disposed watcher must stay disposed')
})

test('our own write never re-reads the profile', async () => {
  const { ctx, state } = modernHost()
  const settings = createSettingsScope(ctx, { scale: 1 })
  const before = state.describes
  assert.equal(before, 1, 'the scope reads the section once at mount')

  await settings.update({ scale: 1.5 })
  // 自己那次写入会连发 document-updated + 两个 config-reload；都得被忽略。
  await sleep(120)

  assert.equal(state.describes, before, 'no describe() for a change this plugin just made')
})

test('an external change is re-read once, however many signals it fires', async () => {
  const { ctx, state, emit } = modernHost()
  const settings = createSettingsScope(ctx, { scale: 1 })
  const seen = []
  settings.watch((next) => seen.push(next.scale))
  const before = state.describes

  state.fields.scale = 1.8
  emit('settings/document-updated', 'dsh-pet-remielle', 4)
  emit('app-boot/config-reload')
  emit('app-boot/config-reload')
  await sleep(120)

  assert.equal(state.describes, before + 1, 'three signals, one re-read')
  assert.deepEqual(seen, [1.8])
})

test('the host document broadcast ignores other namespaces', async () => {
  const { ctx, state, emit } = modernHost()
  state.fields.scale = 1
  const settings = createSettingsScope(ctx, { scale: 1 })
  const seen = []
  settings.watch((next) => seen.push(next.scale))

  state.fields.scale = 1.9
  emit('settings/document-updated', 'some-other-plugin', 3)
  await sleep(120)

  assert.deepEqual(seen, [])
  assert.equal(settings.get().scale, 1)
})

test('a rejected write rolls the optimistic change back and propagates', async () => {
  const { ctx } = modernHost({ reject: true })
  const settings = createSettingsScope(ctx, { desktopMode: false })

  await assert.rejects(() => settings.update({ desktopMode: true }), /no volatile fields/)
  assert.equal(settings.get().desktopMode, false, 'a refused write must not stay applied')
})

test('a fallback namespace is used when the Loader row cannot be read', async () => {
  const { ctx, state } = modernHost()
  delete ctx.fiber.entry

  const settings = createSettingsScope(ctx, { scale: 1 })
  await settings.update({ scale: 1.4 })

  assert.equal(state.persisted[0].ns, 'dsh-pet-remielle', 'falls back to the id this package ships')
})

test('a host with no writable settings service stays read-only and says so', async () => {
  const ctx = { settings: {}, fiber: { uid: 3 }, on: () => () => {} }
  const settings = createSettingsScope(ctx, { desktopMode: false })

  assert.equal(settings.get().desktopMode, false)
  await assert.rejects(() => settings.update({ desktopMode: true }), /needs the DSH settings service/)
})
