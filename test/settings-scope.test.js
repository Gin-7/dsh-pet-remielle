/**
 * 设置桥接护栏（DSH 0.1.7 #677）。
 *
 * 背景：0.1.7 移除了 `ctx.settings.register()`，命名空间改由「持有 Config schema 的
 * Loader entry」派生，服务改用 `describe()` / `update(ns, patch)` 寻址。本插件当时写的是
 *
 *   ctx.settings?.register?.(PLUGIN_KEY, Config, { base, applies: 'live' })
 *     ?? localSettingsScope(base)
 *
 * 可选调用在 0.1.7+ 上返回 undefined，于是每一处 `settings.update(...)` 都变成
 * `TypeError: settings.update is not a function`：/config 路由把它报成一个光秃秃的
 * 400，右键菜单的 `patchConfig` 又 `.catch(function(){})` 静默吞掉。表现就是
 * 「桌面悬浮模式」开关点了没反应，宿主侧 desktopMode 永远停在 false，连
 * `{ kind: 'download', phase: 'confirm' }` 那个 Electron 下载确认框都不会弹。
 *
 * 这里钉住两件事，缺一个上面那条路就会重新断掉：
 *   1. Config 每个字段都带 `meta.volatile` —— 0.1.7 的 `settings.update()` 会拒绝一个
 *      没有任何 volatile 节点的 section（`has no volatile fields`），这是写入的前提；
 *   2. `createSettingsScope` 在「还有 register 的旧宿主」与「只有 describe/update 的
 *      0.1.7+ 宿主」两种形态下都真的写得进去，而且失败是抛出来的、不是被吞掉的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, CONFIG_PATCH_FIELDS, createSettingsScope } from '../src/index.js'

/** 每个 Config 字段都是 live 的：config PATCH 白名单 + 宠物注册表那两个。 */
const LIVE_FIELDS = [...CONFIG_PATCH_FIELDS, 'activePetId', 'pets'].sort()

/** 一个 0.1.7 形态的宿主：有 describe/update，没有 register。 */
function modernHost({ ns = 'dsh-pet-remielle', reject = false } = {}) {
  const fiber = { uid: 1 }
  const state = { fields: {}, updates: [], listeners: new Map() }
  const service = {
    writable: true,
    describe() {
      return [{
        ns,
        value: { ...state.fields },
        revision: state.updates.length,
        schema: Config.toJSON(),
        applies: 'live',
      }]
    },
    async update(target, patch) {
      if (reject) throw new Error(`Plugin entry "${target}" has no volatile fields`)
      state.updates.push({ ns: target, patch })
      Object.assign(state.fields, patch)
      // 宿主把变更广播出去；插件靠它重读 section。
      for (const listener of state.listeners.get('settings/document-updated') ?? []) {
        listener(ns, state.updates.length)
      }
    },
  }
  const ctx = {
    settings: service,
    fiber,
    loader: { entries: () => [{ options: { id: ns, name: 'dsh-pet-remielle' }, fiber, disabled: false }] },
    on(event, listener) {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {
        state.listeners.set(event, list.filter((candidate) => candidate !== listener))
      }
    },
  }
  return { ctx, state, service }
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

  assert.deepEqual(state.updates, [{ ns: 'dsh-pet-remielle', patch: { desktopMode: true } }])
  assert.equal(settings.get().desktopMode, true)
})

test('writes address the entry id the user actually configured', async () => {
  const { ctx, state } = modernHost({ ns: 'my-remielle' })
  const settings = createSettingsScope(ctx, { scale: 1 })

  await settings.update({ scale: 1.35 })

  assert.equal(state.updates[0].ns, 'my-remielle')
  assert.equal(settings.get().scale, 1.35)
})

test('watch fires for own writes and for the host document broadcast', async () => {
  const { ctx, state } = modernHost()
  const settings = createSettingsScope(ctx, { scale: 1 })
  const seen = []
  const off = settings.watch((next) => seen.push(next.scale))

  await settings.update({ scale: 1.5 })
  // 宿主自己的设置页（或遗留 settings.yaml 导入）改了同一个 section
  state.fields.scale = 1.8
  for (const listener of state.listeners.get('settings/document-updated') ?? []) listener('dsh-pet-remielle', 9)

  assert.deepEqual(seen, [1.5, 1.8])

  off()
  await settings.update({ scale: 2 })
  assert.deepEqual(seen, [1.5, 1.8], 'a disposed watcher must stay disposed')
})

test('the host document broadcast ignores other namespaces', () => {
  const { ctx, state } = modernHost()
  state.fields.scale = 1
  const settings = createSettingsScope(ctx, { scale: 1 })
  const seen = []
  settings.watch((next) => seen.push(next.scale))

  state.fields.scale = 1.9
  for (const listener of state.listeners.get('settings/document-updated') ?? []) listener('some-other-plugin', 3)

  assert.deepEqual(seen, [])
  assert.equal(settings.get().scale, 1)
})

test('a rejected write propagates instead of looking applied', async () => {
  const { ctx } = modernHost({ reject: true })
  const settings = createSettingsScope(ctx, { desktopMode: false })

  await assert.rejects(() => settings.update({ desktopMode: true }), /no volatile fields/)
  assert.equal(settings.get().desktopMode, false, 'a refused write must not touch the cached section')
})

test('a pre-0.1.7 host still gets the namespace-scoped face', async () => {
  const fiber = { uid: 2 }
  const registered = []
  const scoped = {
    get: () => ({ desktopMode: false }),
    update: async () => {},
    watch: () => () => {},
  }
  const ctx = {
    settings: {
      register(ns, schema, options) {
        registered.push({ ns, options })
        return scoped
      },
    },
    fiber,
    loader: { entries: () => [] },
    on: () => () => {},
  }

  const settings = createSettingsScope(ctx, { desktopMode: false })

  assert.equal(settings, scoped)
  assert.equal(registered[0].ns, 'dsh-pet-remielle')
  assert.equal(registered[0].options.base.desktopMode, false)
})

test('a host with no usable settings service stays read-only and says so', async () => {
  const ctx = { settings: {}, fiber: { uid: 3 }, loader: { entries: () => [] }, on: () => () => {} }
  const settings = createSettingsScope(ctx, { desktopMode: false })

  assert.equal(settings.get().desktopMode, false)
  await assert.rejects(() => settings.update({ desktopMode: true }), /settings service is not available/)
})
