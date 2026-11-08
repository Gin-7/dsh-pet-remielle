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
import { createHolidayStore } from './holidays.js'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
const BALANCE_TTL_MS = 25000

export function normalizeUsageMode(m) {
  return m === 'token' ? 'token' : 'ledger'
}

/**
 * `usage/by_api_key/cost` returns the platform's own cost per hour bucket
 * (`data.biz_data.data[].series[].buckets[].cost`, CNY string). Summing them
 * gives the exact today usage — no local pricing table needed.
 */
export function computeTodayCost(data) {
  const biz = data && data.data && data.data.biz_data
  const groups = biz && Array.isArray(biz.data) ? biz.data : null
  if (!groups) return null
  let total = 0
  let found = false
  for (const g of groups) {
    const series = Array.isArray(g && g.series) ? g.series : []
    for (const s of series) {
      const buckets = Array.isArray(s && s.buckets) ? s.buckets : []
      for (const b of buckets) {
        const c = Number(b && b.cost)
        if (!isFinite(c)) continue
        found = true
        total += c
      }
    }
  }
  return found ? total : null
}

/**
 * @param {object} options
 * @param {(name: string) => Promise<{value: string}|null>} options.resolveCredential
 * @param {string} [options.dshHome]
 * @param {(m: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] 网络出口，测试注入用（默认全局 fetch）
 * @param {() => number} [options.now] 时钟，测试注入用（默认 Date.now）
 */
export function createBalanceService({ resolveCredential, getPlatformToken, getAccountBalance, getAccountPlatformToken, dshHome, log, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const DSH_HOME = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const logger = log || (() => {})
  // 峰谷时段判定（issue #25）：周末/法定节假日全天空闲，其余按 9–12、14–18
  // 判高峰。节假日日历以内置表兜底、后台静默刷新远程数据。
  const holidays = createHolidayStore({ dshHome: DSH_HOME, log: logger, fetchImpl, now })

  const USAGE_FILE_CANDIDATES = [
    path.join(DSH_HOME, '.dshp-usage.json'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshp-usage.json'),
  ]

  let balanceCache = null
  let balanceInFlight = null
  let lastUsageError = null

  async function fetchBalance() {
    // 登录账号优先：与设置页「账号与余额」同源（充值 + 赠金），且和用量令牌同账号。
    // 未登录 / 服务未挂载 / 查询失败时再回落 API key 的 /user/balance。
    if (typeof getAccountBalance === 'function') {
      try {
        const account = await getAccountBalance()
        if (account && Number.isFinite(account.totalBalance)) {
          return {
            ok: true,
            totalBalance: account.totalBalance,
            currency: account.currency || 'CNY',
            balanceSource: 'account',
            updatedAt: new Date(now()).toISOString(),
          }
        }
      } catch (err) {
        logger('account-balance', String((err && err.message) || err).slice(0, 160))
      }
    }
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
        res = await fetchImpl(BALANCE_URL, {
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
        balanceSource: 'apikey',
        updatedAt: new Date(now()).toISOString(),
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

  /** 按优先级收集可用的平台令牌：登录账号会话 > 凭据中心手填 > 旧配置字段。 */
  async function usageTokens() {
    const list = []
    if (typeof getAccountPlatformToken === 'function') {
      try {
        const token = String((await getAccountPlatformToken()) || '').replace(/^Bearer\s+/i, '')
        if (token) list.push(token)
      } catch (err) {
        logger('account-session', String((err && err.message) || err).slice(0, 160))
      }
    }
    try {
      const cred = await resolveCredential('DEEPSEEK_PLATFORM_TOKEN')
      const token = cred && cred.value ? String(cred.value).replace(/^Bearer\s+/i, '') : ''
      if (token) list.push(token)
    } catch (err) {
      /* 凭据中心不可用时继续尝试旧配置 */
    }
    // 旧配置字段作为最后一级兜底（迁移后它应为空）；与凭据同值时会被末尾去重。
    if (typeof getPlatformToken === 'function') {
      try {
        const token = String(getPlatformToken() || '').replace(/^Bearer\s+/i, '')
        if (token) list.push(token)
      } catch (err) { /* ignore */ }
    }
    return [...new Set(list)]
  }

  /** 用一枚令牌查询当天费用；鉴权失败单独标记，便于换下一枚令牌。 */
  async function fetchUsageWithToken(token) {
    const current = new Date(now())
    const tz = -current.getTimezoneOffset() * 60
    const start = Math.floor(new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime() / 1000)
    const end = start + 86400
    const url = `${USAGE_URL}?start=${start}&end=${end}&tz=${tz}`
    const res = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { error: 'http ' + res.status, authFailed: res.status === 401 || res.status === 403 }
    }
    const data = await res.json()
    const amount = computeTodayCost(data)
    // isFinite(null) 为 true：平台把鉴权失败也包在 HTTP 200 里（code 40003），
    // 必须显式排除 null，否则无效令牌会被当成「今日用量 0」而掩盖失败。
    if (amount !== null && isFinite(amount)) return { amount }
    // 有 biz_data 但没有 cost 桶 = 今天确实没产生用量
    if (data && data.data && data.data.biz_data) return { amount: 0 }
    const platformMsg = data && (data.msg || data.message)
    const platformCode = data && typeof data.code !== 'undefined' ? ' ' + data.code : ''
    const authFailed = !!(data && (data.code === 40003 || data.code === 401 || data.code === 403))
    return {
      error: 'platform' + platformCode + ': ' + String(platformMsg || 'no usage').slice(0, 120),
      authFailed,
    }
  }

  async function fetchUsage() {
    const tokens = await usageTokens()
    if (!tokens.length) return { error: 'no platform token' }
    let last = null
    for (const token of tokens) {
      try {
        const usage = await fetchUsageWithToken(token)
        if (usage.amount !== undefined) return usage
        last = usage
        // 网络/结构类失败换令牌也没用；只有鉴权失败才继续试下一枚
        if (!usage.authFailed) break
      } catch (err) {
        // 网络/超时与令牌无关，换下一枚只会把同一个超时再等一遍，直接结束。
        last = { error: String((err && err.message) || err) }
        break
      }
    }
    return last || { error: 'no usage' }
  }

  function todayKey() {
    const d = new Date(now())
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
    full.isPeak = holidays.isPeak(Math.floor(now() / 1000))
    // 日历刷新属后台行为，不阻塞余额展示；失败静默（内置表兜底仍在）。
    void holidays.refresh()
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
      lastUsageError = null
      return full
    }
    // 无令牌或令牌失败：回落记账模式
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    // 把失败原因随响应带出（无效令牌时用户切到 token 模式会静默回落，需要可解释）
    if (u && u.error) {
      full.usageError = u.error
      if (u.error !== lastUsageError) logger('token-usage', u.error)
      lastUsageError = u.error
    }
    return full
  }

  async function getBalance(usageMode) {
    const at = now()
    if (balanceCache && at - balanceCache.at < BALANCE_TTL_MS) {
      return balanceCache.payload
    }
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = getBalancePayload(usageMode)
      .then((payload) => {
        if (payload.ok) {
          balanceCache = { at: now(), payload }
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
