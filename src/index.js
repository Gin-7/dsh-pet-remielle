/**
 * dsh-pet-remielle host half.
 *
 * Design:
 *  - listens to the real `session/event` / `session/disposed` bus (global
 *    scope, so it sees every session, not only scoped ones);
 *  - feeds events into the pure PetReducer, which emits typed messages;
 *  - keeps the latest state plus any active PULSE overlay, and serves them
 *    to the browser client over the webServer HTTP endpoints;
 *  - registers a persisted schemastery config namespace with live watch;
 *  - hosts a multi-pet registry (assets/pets/<id>/01..06.gif) with its own
 *    Settings section UI: enable/disable pets, rename, pick the active pet.
 *
 * No child process is spawned: the pet renders in the DSH web page, which
 * polls the state endpoint, or in an optional desktop floating window.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { PetReducer } from './pet-reducer.js'
import { PetMessageKind, PetState, createMessage } from './protocol.js'
import { DesktopWindow } from './desktop-window.js'
import { ensureElectronRuntime } from './electron-fetch.mjs'
import {
  CHECK_ENDPOINT, UPDATE_ENDPOINT, INFO_ENDPOINT,
  checkHandler, updateHandler, infoHandler, setSelfUpdateHooks, killActiveUpdate,
} from './self-update.js'
import {
  DEFAULT_PET_ID,
  DEFAULT_PETS,
  PET_MOODS,
  PET_MOOD_EXT,
  PET_MANIFEST,
  buildRegistry,
  isValidPetId,
  parseAssetPath,
  parsePetManifest,
  upsertPet,
} from './pets.js'
import { createBalanceService, normalizeUsageMode } from './balance.js'
import { statusCopy } from './status-copy.js'

export const name = 'dsh-pet-remielle'
export const inject = ['sessions', 'credentials']
export const CONFIG_ENDPOINT = '/plugins/dsh-pet-remielle/config'
export const STATE_ENDPOINT = '/plugins/dsh-pet-remielle/state'
export const STREAM_ENDPOINT = '/plugins/dsh-pet-remielle/stream'
export const COMPLETION_ACK_ENDPOINT = '/plugins/dsh-pet-remielle/completion/ack'
export const SESSION_OPEN_ENDPOINT = '/plugins/dsh-pet-remielle/session/open'
export const SESSION_CURRENT_ENDPOINT = '/plugins/dsh-pet-remielle/session/current'
export const PETS_ENDPOINT = '/plugins/dsh-pet-remielle/pets'
export const ASSETS_PREFIX = '/plugins/dsh-pet-remielle/assets'
export const PET_VIEW_ENDPOINT = '/plugins/dsh-pet-remielle/pet-view'
export const DESKTOP_ENDPOINT = '/plugins/dsh-pet-remielle/desktop'
export const PLUGIN_KEY = 'dsh-pet-remielle'
export const BALANCE_ENDPOINT = '/plugins/dsh-pet-remielle/balance'

const petEntry = Schema.object({
  id: Schema.string().required().description('宠物 id（assets/pets/<id> 目录名）'),
  name: Schema.string().required().description('宠物显示名'),
  enabled: Schema.boolean().default(true).description('是否启用该宠物'),
})

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用桌宠'),
  scale: Schema.number().min(0.5).max(2).step(0.05).default(1).role('slider').description('角色大小'),
  opacity: Schema.number().min(0.3).max(1).step(0.05).default(1).role('slider').description('透明度'),
  locked: Schema.boolean().default(false).description('锁定位置（禁止拖动）'),
  paused: Schema.boolean().default(false).description('暂停动画'),
  hidden: Schema.boolean().default(false).description('隐藏桌宠'),
  includeSubagents: Schema.boolean().default(false).description('允许子 Agent 抢占宠物状态'),
  showBubble: Schema.boolean().default(true).description('在宠物上方显示状态气泡（阶段/待办/进度）'),
  showBubbleStatus: Schema.boolean().default(true).description('气泡中显示会话状态（任务阶段/进度）'),
  showBubbleUsage: Schema.boolean().default(false).description('气泡中显示 DeepSeek 余额/今日已用'),
  usageMode: Schema.string().default('ledger').description('今日已用统计模式：小鲸鱼记账（ledger，免令牌）或 实时·令牌（token，需平台会话令牌）'),
  platformToken: Schema.string().default('').description('DEEPSEEK_PLATFORM_TOKEN 平台会话令牌（实时·令牌模式需要，留空时回落到 DSH 凭据服务）'),
  desktopMode: Schema.boolean().default(false).description('桌面悬浮模式：用独立置顶窗口显示宠物（打开时如无 Electron 会自动下载运行时，下载失败则回落页面内）'),
  posX: Schema.number().default(null).description('宠物 X 位置（null = 使用默认位置）'),
  posY: Schema.number().default(null).description('宠物 Y 位置（null = 使用默认位置）'),
  activePetId: Schema.string().default(DEFAULT_PET_ID).description('当前展示的宠物'),
  pets: Schema.array(petEntry).default([{ id: DEFAULT_PET_ID, name: '蕾米埃尔', enabled: true }]).description('宠物注册表'),
}).description('由 DeepSeek Harness 会话事件驱动的多宠物 Web 桌宠')

const defaults = Object.freeze({
  enabled: true,
  scale: 1,
  opacity: 1,
  locked: false,
  paused: false,
  hidden: false,
  includeSubagents: false,
  showBubble: true,
  showBubbleStatus: true,
  showBubbleUsage: false,
  usageMode: 'ledger',
  platformToken: '',
  desktopMode: false,
  posX: null,
  posY: null,
  activePetId: DEFAULT_PET_ID,
  pets: DEFAULT_PETS,
})

function publicConfig(config = {}) {
  return {
    enabled: config.enabled ?? defaults.enabled,
    scale: config.scale ?? defaults.scale,
    opacity: config.opacity ?? defaults.opacity,
    locked: config.locked ?? defaults.locked,
    paused: config.paused ?? defaults.paused,
    hidden: config.hidden ?? defaults.hidden,
    includeSubagents: config.includeSubagents ?? defaults.includeSubagents,
    showBubble: config.showBubble ?? defaults.showBubble,
    showBubbleStatus: config.showBubbleStatus ?? defaults.showBubbleStatus,
    showBubbleUsage: config.showBubbleUsage ?? defaults.showBubbleUsage,
    usageMode: normalizeUsageMode(config.usageMode),
    platformToken: config.platformToken ?? defaults.platformToken,
    desktopMode: config.desktopMode ?? defaults.desktopMode,
    posX: config.posX ?? defaults.posX,
    posY: config.posY ?? defaults.posY,
  }
}

function localSettingsScope(value) {
  return {
    get: () => value,
    watch: () => () => {},
  }
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Loopback + same-origin guard shared by every host endpoint. */
function localOnly(req, res) {
  if (!isLoopback(req.socket?.remoteAddress)) {
    jsonResponse(res, 403, { error: 'local access only' })
    return false
  }
  const origin = req.headers?.origin
  if (origin) {
    let originHost
    try { originHost = new URL(origin).host } catch {}
    if (!originHost || originHost !== req.headers.host) {
      jsonResponse(res, 403, { error: 'origin mismatch' })
      return false
    }
  }
  return true
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 8192) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('patch must be an object')
  return value
}

export function createConfigHandler(settings) {
  const allowed = new Set(['enabled', 'scale', 'opacity', 'locked', 'paused', 'hidden', 'includeSubagents', 'showBubble', 'showBubbleStatus', 'showBubbleUsage', 'usageMode', 'platformToken', 'desktopMode', 'posX', 'posY'])
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method === 'GET') {
      jsonResponse(res, 200, settings.get())
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const value = await readJsonBody(req)
      if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('patch contains an unknown setting')
      await settings.update(value)
      jsonResponse(res, 200, settings.get())
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function applyCompletionAck(completionQueue, pulse, sessionId, { clearPulse = false } = {}) {
  completionQueue.delete(sessionId)
  if (clearPulse && pulse?.sessionId === sessionId && pulse.state === PetState.SUCCESS) return null
  return pulse
}

export function createCompletionAckHandler({ acknowledge, broadcast = () => {} }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) throw new Error('sessionId must be a non-empty string')
      acknowledge(sessionId, { clearPulse: body.clearPulse === true })
      broadcast()
      jsonResponse(res, 200, { ok: true })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Slot for the latest undelivered session-action: when no web client was
 * online (`delivered === 0`), a desktop bubble-card click would be silently
 * lost. The action is stashed here and replayed exactly once to the next SSE
 * subscriber (stream handshake), so the browser still lands on the chat.
 */
export function createPendingActionStore() {
  let pending = null
  return {
    stash: (action) => { pending = action },
    /** Take-and-clear: returns the stashed action or null. */
    take: () => { const action = pending; pending = null; return action },
  }
}

/**
 * Subscriber type from a stream request url. The desktop pet window
 * identifies itself with ?client=pet; everything else (including malformed
 * urls) is treated as a web client.
 * @param reqUrl - raw request url (path + query).
 */
export function streamClientOf(reqUrl) {
  try {
    return new URL(reqUrl ?? '/', 'http://localhost').searchParams.get('client') === 'pet' ? 'pet' : 'web'
  } catch {
    return 'web'
  }
}

export function createSessionOpenHandler({ notify, onUndelivered }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) throw new Error('sessionId must be a non-empty string')
      const action = {
        protocolVersion: 1,
        kind: 'session-action',
        sessionId,
        approve: body.approve === true,
        // 完成卡点击：网页端需要 completed 决定是否顺带 ack
        completed: body.completed === true,
      }
      // delivered=false：当前没有任何网页客户端订阅 SSE，桌面“允许一次”的
      // 广播无人接收——调用方可以此区分成功与静默丢失。
      const delivered = notify(action) > 0
      // 没人在线：暂存最新一条，下一个 SSE 订阅者握手时重放（拉起兜底）。
      // approve:true 不暂存——审批动作时效性强，网页长时间离线后重连时
      // 自动批准可能已过时的请求，风险大于收益；宁可不重放（桌面端可重新
      // 发起），也不延迟执行。跳转类（approve:false）无此风险，照常暂存。
      if (!delivered && !action.approve && typeof onUndelivered === 'function') onUndelivered(action)
      jsonResponse(res, 200, { ok: true, delivered })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Web-client current-session uplink: POST { sessionId } (empty string clears).
 * Fire-and-forget — the host only remembers the id; the next snapshot or SSE
 * push carries it to every client, so no broadcast happens here.
 */
export function createSessionCurrentHandler({ accept }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      if (typeof body.sessionId !== 'string') throw new Error('sessionId must be a string')
      accept(body.sessionId)
      jsonResponse(res, 200, { ok: true })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Scan assets/pets/ for pet directories and their GIF files.
 * @param root - the absolute assets/pets directory.
 * @returns discovery entries `[{ id, gifs }]`.
 */
export async function scanPetDirs(root) {
  let names
  try {
    names = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.isDirectory() || !isValidPetId(entry.name)) continue
    const dir = join(root, entry.name)
    let gifs = []
    let manifest = { pics: 0 }
    try {
      const files = await readdir(dir)
      gifs = files.filter((f) => f.endsWith(PET_MOOD_EXT))
      if (files.includes(PET_MANIFEST)) {
        manifest = parsePetManifest(await readFile(join(dir, PET_MANIFEST), 'utf8'))
      }
      // 自动统计作品图数量：pics/<n>.png 有多少张就画多少张，
      // 直接往 pics/ 文件夹放图即可，无需手动改 pet-manifest.json。
      let pics = 0
      try {
        pics = (await readdir(join(dir, 'pics'))).filter((f) => /^\d{1,3}\.png$/i.test(f)).length
      } catch { /* 无 pics 目录 */ }
      if (pics > 0) manifest.pics = pics
    } catch {
      gifs = []
    }
    out.push({ id: entry.name, gifs, manifest })
  }
  return out
}

/**
 * The pets endpoint: GET the merged registry view; PATCH /pets/<id> with
 * `{ enabled?, name?, active? }` to enable/disable, rename, or activate one
 * pet. All mutations go through settings.update, so they persist and the
 * settings watch refreshes the registry.
 */
export function createPetsHandler({ settings, refreshRegistry }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const rest = pathname.slice(PETS_ENDPOINT.length)
    if (req.method === 'GET') {
      if (rest !== '' && rest !== '/') {
        jsonResponse(res, 404, { error: 'not found' })
        return
      }
      jsonResponse(res, 200, { ok: true, ...(await refreshRegistry()) })
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    const id = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : null
    if (!id || !isValidPetId(id)) {
      jsonResponse(res, 404, { error: 'unknown pet' })
      return
    }
    try {
      const value = await readJsonBody(req)
      if (Object.keys(value).some((key) => !['enabled', 'name', 'active'].includes(key))) {
        throw new Error('patch contains an unknown field')
      }
      const current = settings.get()
      const next = { ...current, pets: upsertPet(current.pets ?? [], { id, ...value }) }
      if (value.active === true) next.activePetId = id
      await settings.update(next)
      jsonResponse(res, 200, { ok: true, ...(await refreshRegistry()) })
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Serve one pet's mood sticker: GET /assets/<petId>/<mood>.gif.
 * `parseAssetPath` is the traversal gate; missing files answer 404.
 */
export function createAssetsHandler(petsRoot) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'GET') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const parsed = parseAssetPath(pathname, ASSETS_PREFIX)
    if (!parsed) {
      jsonResponse(res, 404, { error: 'not found' })
      return
    }
    let file
    let type
    if (parsed.kind === 'pic') {
      file = join(petsRoot, parsed.petId, 'pics', `${parsed.index}.png`)
      type = 'image/png'
    } else {
      file = join(petsRoot, parsed.petId, `${parsed.mood}${PET_MOOD_EXT}`)
      type = 'image/gif'
    }
    try {
      const data = await readFile(file)
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=3600',
        'content-length': data.length,
      })
      res.end(data)
    } catch {
      jsonResponse(res, 404, { error: 'not found' })
    }
  }
}

/**
 * Build the pet snapshot served to the browser: the active PULSE overlay
 * wins while its deadline is live, otherwise the reducer's latest state.
 * `petId` (the active pet) rides along so the client can resolve sticker
 * URLs; it resolves through the registry, not the raw config.
 */
export function createStateSnapshot({ getLatest, getPulse, getConfig, getPetId, getDesktopActive, getActivePet, getStates, getCompletions, getCurrent }) {
  const petIdOf = typeof getPetId === 'function' ? getPetId : () => DEFAULT_PET_ID
  const desktopActiveOf = typeof getDesktopActive === 'function' ? getDesktopActive : () => false
  const activePetOf = typeof getActivePet === 'function' ? getActivePet : () => undefined
  const statesOf = typeof getStates === 'function' ? getStates : () => []
  const completionsOf = typeof getCompletions === 'function' ? getCompletions : () => []
  const currentOf = typeof getCurrent === 'function' ? getCurrent : () => undefined
  return () => {
    const config = publicConfig(getConfig())
    const now = Date.now()
    const pulse = getPulse()
    const base = getLatest()
    const activePulse = pulse && pulse.until > now ? pulse : undefined
    const source = activePulse ?? base
    // One entry per tracked session for the stacked-bubble view. The active
    // PULSE overlay (success / error flash) overrides its own session's entry
    // so the flash lands on the right bubble, not on the primary.
    const stateEntries = statesOf()
    let pulseMatched = false
    const sessions = stateEntries.map((entry) => {
      if (activePulse && activePulse.sessionId === entry.sessionId) {
        pulseMatched = true
        return {
          ...entry,
          state: activePulse.state,
          mood: activePulse.mood ?? entry.mood,
          phase: activePulse.phase ?? entry.phase,
          message: activePulse.message ?? entry.message,
          detail: activePulse.detail ?? entry.detail,
          approval: entry.approval === true,
          ask: entry.ask === true,
          completed: activePulse.state === PetState.SUCCESS,
          pulseUntil: activePulse.until,
        }
      }
      return entry
    })
    // Completed sessions are absent from reducer.states(). Add the transient
    // pulse card while it is live; persistent reminders are merged below.
    if (activePulse && activePulse.sessionId && !pulseMatched) {
      sessions.push({
        sessionId: activePulse.sessionId,
        state: activePulse.state,
        mood: activePulse.mood ?? '06',
        phase: activePulse.phase ?? 'pulse',
        message: activePulse.message ?? '',
        detail: activePulse.detail ?? 'DSH',
        project: activePulse.project,
        task: activePulse.task,
        progress: activePulse.progress,
        attention: activePulse.state === PetState.WAITING || activePulse.state === PetState.ERROR,
        approval: false,
        ask: false,
        completed: activePulse.state === PetState.SUCCESS,
        updatedAt: now,
        pulseUntil: activePulse.until,
      })
    }
    for (const completion of completionsOf()) {
      const liveIndex = sessions.findIndex((entry) => entry.sessionId === completion.sessionId)
      if (liveIndex >= 0) {
        const live = sessions[liveIndex]
        if (live.state === PetState.SUCCESS && live.pulseUntil > now) {
          sessions[liveIndex] = {
            ...live,
            targetSessionId: completion.sessionId,
            completionNotification: true,
          }
        }
        continue
      }
      sessions.push({
        ...completion,
        sessionId: `completion:${completion.sessionId}`,
        targetSessionId: completion.sessionId,
        state: PetState.SUCCESS,
        mood: completion.mood ?? '03',
        completed: true,
        completionNotification: true,
        attention: false,
        approval: false,
        ask: false,
      })
    }
    return {
      ok: true,
      enabled: config.enabled === true,
      scale: config.scale,
      opacity: config.opacity,
      locked: config.locked === true,
      bubble: config.showBubble !== false,
      // 客户端统一读 showBubble（与配置字段同名）；bubble 为旧字段别名，保留兼容
      showBubble: config.showBubble !== false,
      showBubbleStatus: config.showBubbleStatus !== false,
      showBubbleUsage: config.showBubbleUsage === true,
      usageMode: config.usageMode ?? 'ledger',
      platformToken: config.platformToken ?? '',
      paused: config.paused === true,
      hidden: config.hidden === true,
      desktopActive: desktopActiveOf(),
      desktopMode: config.desktopMode === true,
      petId: petIdOf() ?? DEFAULT_PET_ID,
      // 网页端上报的「用户正在看的会话」；空串=清除，回落为缺失（JSON 序列化时省略该字段）
      currentSessionId: currentOf() || undefined,
      posX: config.posX ?? null,
      posY: config.posY ?? null,
      pics: activePetOf()?.pics ?? 0,
      state: source?.state ?? PetState.IDLE,
      mood: activePulse?.mood ?? source?.mood ?? '06',
      phase: source?.phase ?? 'no-session',
      message: activePulse?.message ?? source?.message ?? '蕾米埃尔待命中',
      detail: activePulse?.detail ?? source?.detail ?? 'DSH',
      project: base?.project ?? undefined,
      task: base?.task ?? undefined,
      progress: base?.progress ?? undefined,
      pulseUntil: activePulse ? activePulse.until : 0,
      sessions,
      updatedAt: now,
      ts: now,
    }
  }
}

/**
 * Server-Sent Events hub for the pet state stream.
 *
 * A fresh subscriber immediately receives the current snapshot (so the
 * EventSource handshake doubles as a state read), then every `broadcast()`
 * pushes the latest snapshot. Heartbeat comment frames keep proxies from
 * timing the connection out; `close()` ends every client.
 *
 * Subscribers carry a client type: `add(res, { client: 'pet' })` marks the
 * desktop pet window, which keeps a permanent subscription but drops any
 * frame carrying a `kind` field. `notify()` therefore counts only web
 * clients as delivered — otherwise a running desktop window would make
 * every session-action look delivered and starve the pending-action replay.
 */
export function createStreamHub({ serve }) {
  const clients = new Map() // res -> { client: 'pet' | 'web' }
  const send = (res, payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      clients.delete(res)
    }
  }
  const heartbeat = setInterval(() => {
    for (const res of [...clients.keys()]) {
      try {
        res.write(': ping\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, 25000)
  heartbeat.unref?.()
  return {
    add(res, { client } = {}) {
      clients.set(res, { client: client === 'pet' ? 'pet' : 'web' })
      try {
        res.write('retry: 3000\n\n')
        send(res, serve())
      } catch {
        clients.delete(res)
      }
      res.on?.('close', () => clients.delete(res))
      res.on?.('error', () => clients.delete(res))
    },
    broadcast() {
      const payload = serve()
      for (const res of [...clients.keys()]) send(res, payload)
    },
    /**
     * Push an arbitrary message (e.g. download progress / session-action) to
     * every client. Returns the number of WEB clients reached — pet-window
     * subscribers still receive the frame (their page ignores kind frames)
     * but never count as delivered.
     */
    notify(payload) {
      let delivered = 0
      for (const [res, meta] of [...clients]) {
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          if (meta.client !== 'pet') delivered++
        } catch {
          clients.delete(res)
        }
      }
      return delivered
    },
    get size() {
      return clients.size
    },
    close() {
      clearInterval(heartbeat)
      for (const res of [...clients.keys()]) {
        try {
          res.end()
        } catch {
          /* already closed */
        }
      }
      clients.clear()
    },
  }
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

function mount(ctx, config = {}, eventCtx = ctx) {
  const logger = ctx.logger ?? console
  const base = publicConfig(config)
  const settings = ctx.settings?.register?.(PLUGIN_KEY, Config, {
    base,
    applies: 'live',
  }) ?? localSettingsScope(base)

  const resolveCredential = (name) => {
    const cred = eventCtx.credentials ?? ctx.credentials
    if (!cred || typeof cred.resolve !== 'function') return Promise.resolve(null)
    try {
      return cred.resolve(name)
    } catch (err) {
      return Promise.reject(err)
    }
  }
  const balanceService = createBalanceService({
    resolveCredential,
    getPlatformToken: () => String(settings.get().platformToken || ''),
    log: (code, error) => logger.error?.(`dsh-pet-remielle: ${code} ${error}`),
  })
  let usageModeNow = normalizeUsageMode(settings.get().usageMode)

  const petsRoot = fileURLToPath(new URL('../assets/pets/', import.meta.url))

  const reducer = new PetReducer({ includeSubagents: base.includeSubagents === true })
  let latest = createMessage(PetMessageKind.STATE, {
    state: PetState.IDLE,
    mood: '06',
    phase: 'plugin-start',
    stage: '待机中',
    message: '蕾米埃尔待命中',
    detail: 'DSH · 等待下一次任务',
  })
  let pulse = null
  // 网页端上报的当前会话 id（空串=清除）：只存内存，随下次快照/SSE 自然带出，
  // 上报本身 fire-and-forget，不触发 broadcast。附带 TTL：页面崩溃/被杀时
  // pagehide 清空上报不会执行，陈旧的 currentSessionId 会让桌面端持续误置顶、
  // 并对用户没看过的完成卡误自动 ack——超过时效后回落为「无当前会话」，
  // 用户下次任意操作即重新上报恢复。TTL 取 10 分钟，远大于正常浏览间隔。
  const CURRENT_SESSION_TTL_MS = 10 * 60 * 1000
  let reportedCurrentSessionId = ''
  let reportedCurrentSessionAt = 0
  // Completed turns stay visible until the user opens their conversation.
  const completionQueue = new Map()

  const onMessage = (message) => {
    if (message.kind === PetMessageKind.PULSE) {
      pulse = { ...message, until: Date.now() + (message.ttlMs ?? 3000) }
      if (message.state === PetState.SUCCESS && message.sessionId) {
        completionQueue.set(message.sessionId, {
          sessionId: message.sessionId,
          // 与 reducer 的 SUCCESS 文案同池（status-copy.js success）；种子取
          // sessionId 保持确定性（Date.now() 每次随机）。允许与 reducer/client
          // 端变体不同，池一致性由防漂移测试保证。
          message: message.message ?? statusCopy('success', message.sessionId ?? ''),
          detail: message.detail ?? '任务已完成',
          project: message.project,
          task: message.task,
          progress: message.progress,
          phase: 'turn-end',
          updatedAt: Date.now(),
          completedAt: Date.now(),
        })
      }
      // The durable state beneath the overlay: after the pulse expires the
      // pet falls back to what the reducer remembered at pulse time.
      latest = {
        protocolVersion: message.protocolVersion,
        kind: PetMessageKind.STATE,
        timestamp: Date.now(),
        sessionId: message.sessionId,
        state: message.resumeState ?? PetState.IDLE,
        mood: message.resumeMood ?? '06',
        phase: message.phase ?? 'pulse-end',
        message: message.resumeMessage ?? '蕾米埃尔待命中',
        detail: message.resumeDetail ?? 'DSH',
        task: latest.task,
        progress: latest.progress,
        project: latest.project,
      }
      return
    }
    if (message.kind === PetMessageKind.TASK) {
      // Attach task/progress to the durable state snapshot.
      latest = { ...latest, task: message.task, progress: message.progress, project: message.project }
      return
    }
    if (message.kind === PetMessageKind.STATE) {
      latest = message
      if (
        message.sessionId
        && message.state !== PetState.IDLE
        && message.state !== PetState.DISCONNECTED
      ) {
        completionQueue.delete(message.sessionId)
      }
    }
  }

  const settingsNow = () => settings.get()

  // Registry: merged view of discovered pet dirs + persisted config. Refreshed
  // on boot, on every config change, and on each registry request; the state
  // snapshot reads the last resolved active pet synchronously.
  let registry = { activePetId: DEFAULT_PET_ID, pets: [] }
  let refreshing = null
  const refreshRegistry = () => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const dirs = await scanPetDirs(petsRoot)
        const config = settings.get()
        registry = buildRegistry(dirs, config.pets ?? [], config.activePetId)
      } catch (error) {
        logger.error?.(`dsh-pet-remielle: registry refresh failed: ${String(error)}`)
      } finally {
        refreshing = null
      }
      return registry
    })()
    return refreshing
  }

  const serveState = createStateSnapshot({
    getLatest: () => latest,
    getPulse: () => pulse,
    getConfig: settingsNow,
    getPetId: () => registry.activePetId,
    getDesktopActive: () => desktopActive,
    getActivePet: () => registry.pets.find((pet) => pet.id === registry.activePetId),
    getStates: () => reducer.states(),
    getCompletions: () => [...completionQueue.values()],
    getCurrent: () => (Date.now() - reportedCurrentSessionAt < CURRENT_SESSION_TTL_MS ? reportedCurrentSessionId : ''),
  })

  const hub = createStreamHub({ serve: serveState })
  // 无网页在线时的点击卡兜底：只保留最新一条，下一个 SSE 订阅者握手时重放
  const pendingActions = createPendingActionStore()

  let desktopActive = false

  // Observe every DSH session. Loader entries may live inside a scoped
  // composition, so use the unscoped root bus and dispose explicitly.
  // 完成提醒的清理不依赖 reducer 的“选中渲染”：会话重新开工或被销毁时，
  // 直接在这里清队列——否则存在更高优先级锚点遮蔽时，旧完成卡会在中止轮次后复活；
  // one-shot 子 Agent 完成即销毁的场景下绿点也会永久残留。
  const completionSessionIdOf = (session) => {
    const id = String(session?.header?.id ?? session?.id ?? '')
    return id || null
  }
  const dropCompletion = (session) => {
    const id = completionSessionIdOf(session)
    if (id && completionQueue.delete(id)) hub.broadcast()
  }
  const offEvent = eventCtx.on('session/event', (session, event) => {
    const eventType = String(event?.type ?? '')
    if (eventType === 'turn/start' || eventType === 'tool/call') dropCompletion(session)
    for (const message of reducer.handle(session, event)) {
      onMessage(message)
      hub.broadcast()
    }
  }, { global: true })
  const offDisposed = eventCtx.on('session/disposed', (session) => {
    dropCompletion(session)
    for (const message of reducer.disposeSession(session)) {
      onMessage(message)
      hub.broadcast()
    }
  }, { global: true })

  const unwatch = settings.watch((next) => {
    for (const message of reducer.setIncludeSubagents(next.includeSubagents === true)) {
      onMessage(message)
      hub.broadcast()
    }
    // 用量模式切换时使余额缓存失效，下次请求立即按新模式计算
    const mode = normalizeUsageMode(next.usageMode)
    if (mode !== usageModeNow) {
      usageModeNow = mode
      balanceService.invalidate()
    }
    // enabled/scale/opacity/locked are read live by the client on every poll.
    refreshRegistry().then(() => hub.broadcast())
  })

  void refreshRegistry()

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      const port = httpCtx.webServer.port

      // ---- desktop pet window (transparent always-on-top Electron) ----
      let desktop = undefined
      const stopDesktop = (reason) => {
        desktop?.stop(reason)
        desktop = undefined
        if (desktopActive) {
          desktopActive = false
          hub.broadcast()
        }
      }
      const desktopUrl = `http://127.0.0.1:${port}${PET_VIEW_ENDPOINT}`
      const onDesktopExit = () => {
        desktop = undefined
        if (desktopActive) { desktopActive = false; hub.broadcast() }
      }
      let confirmSent = false // prevent duplicate confirm dialogs
      const startDesktop = (allowFetch = false) => {
        if (desktop) return
        // Boot-time call: respect the setting (desktopMode may be false).
        // User-action calls (watch / /desktop/start): the caller already
        // verified desktopMode flipped to true, so skip this guard —
        // settings.get() may still reflect the OLD value at this point.
        if (!allowFetch && settings.get().desktopMode === false) return
        /** Create a DesktopWindow, attach it, and broadcast state. */
        const spawnWindow = () => {
          const w = new DesktopWindow({ url: desktopUrl, logger, onExit: onDesktopExit })
          if (!w.backend) return false
          desktop = w
          w.start()
          if (!desktopActive) { desktopActive = true; hub.broadcast() }
          return true
        }
        if (spawnWindow()) return
        // No Electron runtime yet.  Only fetch on demand when the user
        // *actively* turns desktop mode on (settings toggle or in-page
        // "open desktop window"); boot-time call stays on the in-page pet.
        if (!allowFetch) {
          logger.info?.('dsh-pet-remielle: desktop pet window unavailable (no backend), browser pet stays')
          return
        }
        if (confirmSent) return // already waiting for user confirmation
        confirmSent = true
        logger.info?.('dsh-pet-remielle: no Electron backend — requesting user confirmation to fetch')
        hub.notify({ protocolVersion: 1, kind: 'download', phase: 'confirm' })
      }
      // Only react when desktopMode itself flips: the watch fires on every
      // config change (scale/opacity/locked/bubble from wheel zoom, sliders
      // or the in-page menu), and starting the desktop window on those would
      // yank the pet out of the page against the user's choice.
      let desktopModeNow = settings.get().desktopMode === false ? false : true
      const unwatchDesktop = settings.watch((next) => {
        const mode = next.desktopMode === false ? false : true
        if (mode === desktopModeNow) return
        desktopModeNow = mode
        if (mode === false) stopDesktop('settings-change')
        else startDesktop(true)
      })
      startDesktop()

      /** Actually perform the Electron download with SSE progress pushes. */
      let downloading = false
      const runDownload = () => {
        if (downloading) return
        downloading = true
        hub.notify({ protocolVersion: 1, kind: 'download', phase: 'start', percent: 0 })
        ensureElectronRuntime({
          onProgress: (m) => {
            logger.info?.(`dsh-pet-remielle: ${m}`)
            const pct = /(\d+)%/.exec(m)
            hub.notify({ protocolVersion: 1, kind: 'download', phase: 'progress', percent: pct ? Number(pct[1]) : -1, text: m })
          },
        })
          .then((exe) => {
            hub.notify({ protocolVersion: 1, kind: 'download', phase: 'done', percent: 100 })
            logger.info?.(`dsh-pet-remielle: Electron ready at ${exe}, starting desktop window`)
            downloading = false
            confirmSent = false
            if (desktop) return // already running
            // Open the window directly using the known path instead of
            // relying on resolveBackend() which re-scans and may not
            // find the freshly installed runtime in time.
            const petWindowCjs = new URL('../src/pet-window.cjs', import.meta.url)
            const backend = { kind: 'electron', command: exe, args: [petWindowCjs.href.startsWith('file://') ? fileURLToPath(petWindowCjs) : String(petWindowCjs)] }
            const w = new DesktopWindow({ url: desktopUrl, logger, onExit: onDesktopExit, backend })
            desktop = w
            w.start()
            if (!desktopActive) { desktopActive = true; hub.broadcast() }
          })
          .catch((error) => {
            hub.notify({ protocolVersion: 1, kind: 'download', phase: 'error', text: error.message })
            downloading = false
            confirmSent = false
            logger.info?.(`dsh-pet-remielle: desktop window unavailable — ${error.message} (browser pet stays)`)
          })
      }

      // ---- endpoints ----
      let petViewHtml = null
      const readPetView = async () => {
        if (petViewHtml) return petViewHtml
        petViewHtml = await readFile(new URL('../src/pet-view.html', import.meta.url), 'utf8')
        return petViewHtml
      }
      let balanceWidgetJs = null
      const readBalanceWidget = async () => {
        if (balanceWidgetJs) return balanceWidgetJs
        balanceWidgetJs = await readFile(new URL('../src/balance-widget.js', import.meta.url), 'utf8')
        return balanceWidgetJs
      }
      let sessionOrderJs = null
      const readSessionOrder = async () => {
        if (sessionOrderJs) return sessionOrderJs
        sessionOrderJs = await readFile(new URL('../src/session-order.js', import.meta.url), 'utf8')
        return sessionOrderJs
      }

      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: CONFIG_ENDPOINT, handler: createConfigHandler(settings) }),
        'dsh-pet-remielle: local settings endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: STATE_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          jsonResponse(res, 200, serveState())
        } }),
        'dsh-pet-remielle: local state endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: COMPLETION_ACK_ENDPOINT,
          handler: createCompletionAckHandler({
            acknowledge: (sessionId, opts) => {
              pulse = applyCompletionAck(completionQueue, pulse, sessionId, opts)
            },
            broadcast: () => hub.broadcast(),
          }),
        }),
        'dsh-pet-remielle: completion notification acknowledgement',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: SESSION_OPEN_ENDPOINT,
          handler: createSessionOpenHandler({
            notify: (payload) => hub.notify(payload),
            onUndelivered: (action) => pendingActions.stash(action),
          }),
        }),
        'dsh-pet-remielle: desktop session open/approve bridge',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: SESSION_CURRENT_ENDPOINT,
          handler: createSessionCurrentHandler({
            accept: (sessionId) => {
              reportedCurrentSessionId = sessionId
              // 空串（清除上报）同样刷新时间戳：清除态本身也是一种有效状态
              reportedCurrentSessionAt = Date.now()
            },
          }),
        }),
        'dsh-pet-remielle: web client current-session uplink',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: BALANCE_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          try {
            const payload = await balanceService.getBalance(settings.get().usageMode)
            jsonResponse(res, 200, payload)
          } catch (err) {
            jsonResponse(res, 200, { ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
          }
        } }),
        'dsh-pet-remielle: balance endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: STREAM_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          sseHeaders(res)
          // 订阅者类型入 hub：?client=pet（桌宠窗口）不参与 delivered 计数，
          // 否则它常驻订阅会让 session-action 永远“已送达”，暂存兜底成死代码。
          const client = streamClientOf(req.url)
          hub.add(res, { client })
          // 无网页在线时点卡的动作在此重放：新网页订阅者握手即补收最新一条
          // session-action。桌宠窗口会丢弃带 kind 的帧——跳过重放，防止
          // 它断线重连时把暂存动作抢收吞掉。
          if (client !== 'pet') {
            const replay = pendingActions.take()
            if (replay) {
              try {
                res.write(`data: ${JSON.stringify(replay)}\n\n`)
              } catch {
                // 客户端已断开：回滚暂存，动作留给下一个网页订阅者，
                // 避免先 take 后 write 失败导致动作静默丢失。
                pendingActions.stash(replay)
              }
            }
          }
        } }),
        'dsh-pet-remielle: local state stream endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: PET_VIEW_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const html = await readPetView()
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        } }),
        'dsh-pet-remielle: pet window view',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/balance-widget.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readBalanceWidget()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: balance bubble client script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/session-order.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readSessionOrder()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: shared bubble order script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: DESKTOP_ENDPOINT,
          handler: async (req, res) => {
            if (!localOnly(req, res)) return
            if (req.method !== 'POST') {
              jsonResponse(res, 405, { ok: false, error: 'method not allowed (POST only)' })
              return
            }
            let action = 'unknown'
            try {
              action = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'unknown'
            } catch {
              /* keep unknown */
            }
            if (action === 'start') startDesktop(true)
            else if (action === 'stop') stopDesktop('in-page menu')
            else if (action === 'confirm-download') runDownload()
            else if (action === 'cancel-download') { confirmSent = false; jsonResponse(res, 200, { ok: true }) }
            else {
              jsonResponse(res, 400, { ok: false, error: 'expected /desktop/start, /desktop/stop, /desktop/confirm-download, or /desktop/cancel-download' })
              return
            }
            jsonResponse(res, 200, { ok: true, desktopActive })
          },
        }),
        'dsh-pet-remielle: desktop window start/stop/confirm-download',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: PETS_ENDPOINT,
          handler: createPetsHandler({ settings, refreshRegistry }),
        }),
        'dsh-pet-remielle: pets registry endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: ASSETS_PREFIX,
          handler: createAssetsHandler(petsRoot),
        }),
        'dsh-pet-remielle: pet sticker assets',
      )
      // ---- self-update routes (version check + one-click update) ----
      // 一键更新会替换插件目录内的文件：先停掉桌宠窗并等进程退出——
      // electron.exe 从 vendor/ 目录内运行时会锁住文件，导致 pnpm/git EPERM
      setSelfUpdateHooks({
        stopDesktopWindow: async (reason = 'self-update') => {
          const w = desktop
          await w?.stop(reason)
          if (w && desktopActive) { desktopActive = false; hub.broadcast() }
        },
        // 更新成功后收尾：包内下载的 Electron 运行时已被 pnpm 替换掉，
        // 桌面模式继续开着会让重启后“双端皆无宠物”。自动切回网页宠物；
        // 返回的说明文字会展示在更新卡片里。
        onUpdateSuccess: () => {
          if (settings.get().desktopMode !== false) {
            void settings.update({ desktopMode: false })
            return '检测到桌面悬浮模式：其 Electron 运行时随更新被移除，已自动切回网页宠物；重启后可重新开启（将重新下载运行时）。'
          }
          return null
        },
      })
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: CHECK_ENDPOINT, handler: checkHandler }),
        'dsh-pet-remielle: version check endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: UPDATE_ENDPOINT, handler: updateHandler }),
        'dsh-pet-remielle: one-click update endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: INFO_ENDPOINT, handler: infoHandler }),
        'dsh-pet-remielle: install info endpoint',
      )
      httpCtx.effect(() => () => {
        unwatchDesktop()
        stopDesktop('dsh-host-stop')
        // 宿主退出时终止进行中的 pnpm/git：孤儿进程会把 node_modules 改成
        // 半成品，下一次启动插件加载直接崩溃
        killActiveUpdate()
      })
    })
  }

  ctx.effect(() => () => {
    offEvent?.()
    offDisposed?.()
    unwatch()
    hub.close()
  })
}

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => mount(settingsCtx, config, ctx))
    return
  }
  mount(ctx, config)
}

export {
  PetMessageKind,
  PetReducer,
  PetState,
}
