/**
 * 峰谷时段判定用的「法定节假日」日历（issue #25）。
 *
 * DeepSeek 现行峰谷规则（以 2026-09-19 官方口径为准）：
 *   - 工作日：高峰 9:00–12:00、14:00–18:00（北京时间），其余为空闲时段；
 *   - 周六 / 周日：全天按空闲时段计费（2026-08-23 起）；
 *   - 中国法定节假日：全天按空闲时段计费；
 *   - 调休上班的周末：同样全天按空闲时段计费。
 *
 * 后两条让「调休补班表」变得多余——补班只会落在周末，而周末本就全天空闲，
 * 于是判定只需「周末 ∪ 法定节假日 → 空闲；否则按小时」。本模块因此只维护
 * 一份「放假日」集合。
 *
 * 数据优先级：远程缓存 > 内置静态表 > 兜底近似。
 * 远程（公共节假日 API）只在首次/过期时拉取，失败静默回落；请求里只有年份，
 * 不携带任何用户数据。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BEIJING_OFFSET_SEC = 8 * 3600
const DAY_MS = 86400000
/** 远程数据有效期；「尚未发布」的空结果用更短 TTL 以便尽快跟进。 */
const CACHE_TTL_MS = 30 * DAY_MS
const EMPTY_CACHE_TTL_MS = 3 * DAY_MS
const FETCH_TIMEOUT_MS = 8000
/** 刷新失败后的退避：余额是 25 秒一刷，离线时不该每轮都重试并刷日志。 */
const FAILURE_RETRY_MS = 10 * 60 * 1000
const SOURCE_URL = (year) => `https://timor.tech/api/holiday/year/${year}`

/**
 * 内置放假日（MM-DD，北京时间）。数据取自国务院办公厅年度节假日安排，
 * 已与公共节假日 API 逐日核对。每年 11 月通知发布后需随版本补下一年。
 */
export const BUILTIN_HOLIDAYS = {
  2025: [
    '01-01', // 元旦
    '01-28', '01-29', '01-30', '01-31', '02-01', '02-02', '02-03', '02-04', // 春节
    '04-04', '04-05', '04-06', // 清明
    '05-01', '05-02', '05-03', '05-04', '05-05', // 劳动节
    '05-31', '06-01', '06-02', // 端午
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', '10-08', // 国庆 + 中秋
  ],
  2026: [
    '01-01', '01-02', '01-03', // 元旦
    '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23', // 春节
    '04-04', '04-05', '04-06', // 清明
    '05-01', '05-02', '05-03', '05-04', '05-05', // 劳动节
    '06-19', '06-20', '06-21', // 端午
    '09-25', '09-26', '09-27', // 中秋
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', // 国庆
  ],
}

/**
 * 内置表与远程缓存都没有该年份时的兜底近似：只列日期基本固定的三大假期。
 * 春节/端午/中秋按农历，无数据时无法推算；宁可漏判少数几天，也不要在已知
 * 固定假期上整体误报「高峰时段」。远程数据一旦可用即以其为准。
 */
export const FIXED_FALLBACK = [
  '01-01', // 元旦
  '05-01', '05-02', '05-03', '05-04', '05-05', // 劳动节
  '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', // 国庆
]

/** 北京时间（UTC+8）的墙钟 Date；用 getUTC* 读取即为北京本地字段。 */
export function beijingDate(timeSec) {
  return new Date(Number(timeSec) * 1000 + BEIJING_OFFSET_SEC * 1000)
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 北京时间的「MM-DD」键。 */
export function monthDayKey(date) {
  return pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
}

export function isWeekend(timeSec) {
  const day = beijingDate(timeSec).getUTCDay()
  return day === 0 || day === 6
}

/**
 * 是否处于高峰时段。`holidayDates` 为「MM-DD」集合（可为空）。
 * 周末与法定节假日一律返回 false（全天空闲）。
 */
export function isPeakMoment(timeSec, holidayDates) {
  const sec = Number(timeSec)
  if (!isFinite(sec)) return false
  if (isWeekend(sec)) return false
  const date = beijingDate(sec)
  if (holidayDates && typeof holidayDates.has === 'function' && holidayDates.has(monthDayKey(date))) {
    return false
  }
  const hour = date.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * 解析年度节假日接口。只取 `holiday === true`（放假）的日期；
 * `holiday === false` 是调休补班（周末），对峰谷判定无影响，直接忽略。
 */
export function parseHolidayPayload(payload) {
  const map = payload && payload.holiday
  if (!map || typeof map !== 'object') return []
  const out = []
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || entry.holiday !== true) continue
    const md = typeof entry.date === 'string' && entry.date.length >= 10 ? entry.date.slice(5) : key
    if (/^\d{2}-\d{2}$/.test(md)) out.push(md)
  }
  return Array.from(new Set(out)).sort()
}

/**
 * 节假日日历：同步取数（供渲染路径随时调用）+ 后台刷新（异步、静默失败）。
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] 缓存目录（默认 $DSH_HOME 或 ~/.dsh）
 * @param {(m: string, e?: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] 便于测试注入
 * @param {() => number} [options.now] 便于测试注入
 */
export function createHolidayStore({ dshHome, log = () => {}, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const DIR = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const remote = new Map() // year -> { dates: string[], fetchedAt: number }
  const lastAttempt = new Map() // year -> ms，仅记录失败时间用于退避
  const diskChecked = new Set()
  let refreshing = null

  const cachePath = (year) => path.join(DIR, `.dshp-holidays-${year}.json`)

  function loadDisk(year) {
    if (remote.has(year) || diskChecked.has(year)) return
    diskChecked.add(year)
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath(year), 'utf8'))
      if (parsed && Array.isArray(parsed.dates) && typeof parsed.fetchedAt === 'number') {
        remote.set(year, {
          dates: parsed.dates.filter((d) => typeof d === 'string' && /^\d{2}-\d{2}$/.test(d)),
          fetchedAt: parsed.fetchedAt,
        })
      }
    } catch { /* 无缓存或损坏：走内置表 */ }
  }

  function datesFor(year) {
    loadDisk(year)
    const cached = remote.get(year)
    if (cached && cached.dates.length) return cached.dates
    if (BUILTIN_HOLIDAYS[year]) return BUILTIN_HOLIDAYS[year]
    return FIXED_FALLBACK
  }

  function holidaySet(timeSec) {
    return new Set(datesFor(beijingDate(timeSec).getUTCFullYear()))
  }

  /** 当前是否高峰时段（同步，随时可调）。 */
  function isPeak(timeSec) {
    const sec = Math.floor(Number(timeSec))
    if (!isFinite(sec)) return false
    return isPeakMoment(sec, holidaySet(sec))
  }

  function stale(year) {
    const attempted = lastAttempt.get(year)
    if (attempted !== undefined && now() - attempted < FAILURE_RETRY_MS) return false
    loadDisk(year)
    const cached = remote.get(year)
    if (!cached) return true
    const ttl = cached.dates.length ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS
    return now() - cached.fetchedAt > ttl
  }

  /**
   * 后台刷新（幂等、可并发调用）。失败只记日志——内置表与兜底近似仍在，
   * 判定不会因此中断。
   */
  function refresh(force = false) {
    const today = beijingDate(now() / 1000)
    const year = today.getUTCFullYear()
    const targets = [year]
    // 12 月与次年通知发布期重叠：顺手把下一年也取回，避免跨年那几天判错。
    if (today.getUTCMonth() === 11) targets.push(year + 1)
    const pending = targets.filter((y) => force || stale(y))
    if (!pending.length) return Promise.resolve()
    if (refreshing) return refreshing
    refreshing = (async () => {
      for (const y of pending) {
        try {
          const res = await fetchImpl(SOURCE_URL(y), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          if (!res || !res.ok) {
            lastAttempt.set(y, now())
            log('[pet-holidays]', 'http ' + ((res && res.status) || 'failed'))
            continue
          }
          const dates = parseHolidayPayload(await res.json())
          const at = now()
          remote.set(y, { dates, fetchedAt: at })
          try {
            fs.mkdirSync(DIR, { recursive: true })
            fs.writeFileSync(cachePath(y), JSON.stringify({ year: y, fetchedAt: at, dates }), 'utf8')
          } catch { /* 缓存写失败不影响本次判定 */ }
        } catch (err) {
          lastAttempt.set(y, now())
          log('[pet-holidays]', 'refresh failed: ' + String((err && err.message) || err).slice(0, 120))
        }
      }
    })().finally(() => { refreshing = null })
    return refreshing
  }

  return { datesFor, holidaySet, isPeak, refresh, cachePath }
}
