/**
 * dsh-pet-remielle balance/usage service.
 *
 * Ported from DeepSeek-Balance-Whale-Widget (lib/index.js), adapted to the pet
 * plugin's host context:
 *   - balance from `api.deepseek.com/user/balance` (DEEPSEEK_API_KEY)
 *   - today usage in two modes:
 *       ledger (default): balance-delta ledger persisted to `$DSH_HOME/.dshp-usage.json`
 *       token:            platform usage API (DEEPSEEK_PLATFORM_TOKEN) with
 *                         peak/off-peak pricing
 *   - 25s in-memory cache + in-flight dedup + transient-failure stale fallback.
 *
 * The ledger file name is `.dshp-usage.json` (not the whale's `.dshw-usage.json`)
 * so the two plugins never fight over the same ledger.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
const BALANCE_TTL_MS = 25000

// DeepSeek CNY prices per million tokens: [空闲时段价, 高峰时段价].
// 高峰时段：每日 9:00–12:00 和 14:00–18:00（北京时间）。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRICING = {
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': BASE_PRICE,
  _default: BASE_PRICE,
}

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

/** bucket time is an epoch second; derive the Beijing local hour. */
export function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const hour = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000).getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

export function normalizeUsageMode(m) {
  return m === 'token' ? 'token' : 'ledger'
}

/**
 * @param {object} options
 * @param {(name: string) => Promise<{value: string}|null>} options.resolveCredential
 * @param {string} [options.dshHome]
 * @param {(m: string) => void} [options.log]
 */
export function createBalanceService({ resolveCredential, getPlatformToken, dshHome, log }) {
  const DSH_HOME = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const logger = log || (() => {})

  const USAGE_FILE_CANDIDATES = [
    path.join(DSH_HOME, '.dshp-usage.json'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshp-usage.json'),
  ]

  let balanceCache = null
  let balanceInFlight = null

  async function fetchBalance() {
    let cred
    try {
      cred = await resolveCredential('DEEPSEEK_API_KEY')
    } catch (err) {
      return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) }
    }
    if (!cred) {
      return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
    }
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + cred.value },
          signal: AbortSignal.timeout(20000),
        })
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      let data
      try {
        data = await res.json()
      } catch (err) {
        lastErr = err
        break
      }
      const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
      if (!info || info.total_balance === undefined) {
        return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
      }
      return {
        ok: true,
        totalBalance: Number(info.total_balance),
        currency: String(info.currency || 'CNY'),
        updatedAt: new Date().toISOString(),
      }
    }
    const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
    return {
      ok: false,
      code: 'HTTP',
      transient: transient,
      error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
    }
  }

  async function fetchUsage() {
    // 优先使用插件配置里的令牌，未配置时回落到 DSH 凭据服务
    let token = ''
    try {
      if (typeof getPlatformToken === 'function') token = String(getPlatformToken() || '').replace(/^Bearer\s+/i, '')
    } catch (err) { /* ignore */ }
    if (!token) {
      let cred
      try {
        cred = await resolveCredential('DEEPSEEK_PLATFORM_TOKEN')
      } catch (err) {
        return { error: 'platform cred resolve failed' }
      }
      if (!cred) return { error: 'no platform token' }
      token = String(cred.value).replace(/^Bearer\s+/i, '')
    }
    if (!token) return { error: 'no platform token' }
    try {
      const now = new Date()
      const tz = -now.getTimezoneOffset() * 60
      const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
      const end = start + 86400
      const url = `${USAGE_URL}?start=${start}&end=${end}&tz=${tz}`
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return { error: 'http ' + res.status }
      const data = await res.json()
      const u = computeTodayUsage(data)
      if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens }
      return { error: 'no usage' }
    } catch (err) {
      return { error: String((err && err.message) || err) }
    }
  }

  function computeTodayUsage(data) {
    let d = data
    if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
    else if (d && d.data && Array.isArray(d.data.series)) d = d.data
    const series = Array.isArray(d.series) ? d.series : null
    if (!series || series.length === 0) return null
    let cost = 0
    let tokens = 0
    let found = false
    for (const s of series) {
      if (!s || typeof s !== 'object') continue
      const p = priceFor(s.model)
      const buckets = Array.isArray(s.buckets) ? s.buckets : []
      for (const b of buckets) {
        const u = b && b.usage
        if (!u || typeof u !== 'object') continue
        const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
        const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
        const out = Number(u.RESPONSE_TOKEN) || 0
        if (hit + miss + out === 0) continue
        found = true
        tokens += hit + miss + out
        const pi = isPeakTime(b.time) ? 1 : 0
        cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
      }
    }
    return found ? { amount: cost, tokens: tokens } : null
  }

  function todayKey() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function readUsageLedger() {
    for (const p of USAGE_FILE_CANDIDATES) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
      } catch (err) { /* try next */ }
    }
    return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
  }

  function writeUsageLedger(led) {
    const body = JSON.stringify(led)
    for (const p of USAGE_FILE_CANDIDATES) {
      try {
        fs.writeFileSync(p, body, 'utf8')
        return true
      } catch (err) { /* try next */ }
    }
    return false
  }

  /** 记账模式：每次观测到余额后，用余额正差值累计当天用量（跨天自动归零并归档）。 */
  function recordLedgerUsage(currentBalance) {
    const t = todayKey()
    const led = readUsageLedger()
    if (led.date !== t) {
      if (led.date && typeof led.todayUsage === 'number') {
        led.history = led.history || {}
        led.history[led.date] = led.todayUsage
      }
      led.date = t
      led.lastBalance = currentBalance
      led.todayUsage = 0
    } else {
      const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
      if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
        led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
      }
      led.lastBalance = currentBalance
    }
    const keys = Object.keys(led.history || {}).sort()
    while (keys.length > 30) {
      delete led.history[keys.shift()]
    }
    writeUsageLedger(led)
    return led
  }

  async function getBalancePayload(usageMode) {
    const payload = await fetchBalance()
    if (!payload.ok) return payload
    // 无论哪种模式，都先把余额观测记入账本（自动累积记账数据）
    const led = recordLedgerUsage(Number(payload.totalBalance))
    const mode = normalizeUsageMode(usageMode)
    const full = { ...payload }
    full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
    if (mode === 'ledger') {
      full.todayUsage = led.todayUsage
      full.usageMode = 'ledger'
      return full
    }
    // token：尝试平台令牌实时计算
    const u = await fetchUsage()
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      return full
    }
    // 无令牌或令牌失败：回落记账模式
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    return full
  }

  async function getBalance(usageMode) {
    const now = Date.now()
    if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
      return balanceCache.payload
    }
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = getBalancePayload(usageMode)
      .then((payload) => {
        if (payload.ok) {
          balanceCache = { at: Date.now(), payload }
          return payload
        }
        if (payload.transient && balanceCache) {
          // transient network/API blip: keep serving the last known balance
          return { ...balanceCache.payload, stale: true, error: payload.error }
        }
        if (!payload.transient) logger('[pet-balance]', payload.code, payload.error)
        return payload
      })
      .catch((err) => ({
        ok: false,
        code: 'ERROR',
        error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
      }))
      .finally(() => {
        balanceInFlight = null
      })
    return balanceInFlight
  }

  /** Force the next request to recompute (e.g. when usageMode changes). */
  function invalidate() {
    balanceCache = null
  }

  return { getBalance, invalidate, normalizeUsageMode }
}
