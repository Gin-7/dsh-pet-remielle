/**
 * 节假日日历与峰谷时段判定（issue #25）。
 *
 * 官方规则（2026-09-19 口径）：工作日高峰 9:00–12:00、14:00–18:00（北京时间）；
 * 周六周日全天空闲（2026-08-23 起）；法定节假日全天空闲；调休上班的周末也全天
 * 空闲。因此判定 = 周末 ∪ 法定节假日 → 空闲，否则按小时。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_HOLIDAYS,
  FIXED_FALLBACK,
  beijingDate,
  monthDayKey,
  isWeekend,
  isPeakMoment,
  parseHolidayPayload,
  createHolidayStore,
} from '../src/holidays.js'

/** 北京时间某天某点的 epoch 秒。 */
function bj(y, m, d, h = 0, min = 0) {
  return Math.floor(Date.UTC(y, m - 1, d, h - 8, min) / 1000)
}

const NO_HOLIDAYS = new Set()

test('workday peak hours are 9-12 and 14-18 Beijing time', () => {
  // 2026-09-21 是周一，且不在内置节假日表里。
  const cases = [
    [8, 59, false], [9, 0, true], [11, 59, true], [12, 0, false],
    [13, 59, false], [14, 0, true], [17, 59, true], [18, 0, false], [23, 0, false],
  ]
  for (const [h, m, expected] of cases) {
    assert.equal(isPeakMoment(bj(2026, 9, 21, h, m), NO_HOLIDAYS), expected, `${h}:${m} 应${expected ? '为' : '非'}高峰`)
  }
})

test('weekends are off-peak all day (including adjusted workday weekends)', () => {
  // 2026-09-19 周六；2026-09-20 周日且是「中秋前补班」——官方明确补班周末仍按空闲。
  for (const day of [19, 20]) {
    for (const h of [9, 10, 15, 17]) {
      assert.equal(isPeakMoment(bj(2026, 9, day, h), new Set(BUILTIN_HOLIDAYS[2026])), false, `9/${day} ${h}:00 应空闲`)
    }
  }
})

test('legal holidays are off-peak on weekdays too', () => {
  const holidays = new Set(BUILTIN_HOLIDAYS[2026])
  // 2026-10-01 是周四，国庆假期 → 空闲。
  assert.equal(isPeakMoment(bj(2026, 10, 1, 10), holidays), false)
  assert.equal(isPeakMoment(bj(2026, 10, 1, 15), holidays), false)
  // 中秋 2026-09-25 周五 → 空闲；节后 09-28 周一 → 高峰。
  assert.equal(isPeakMoment(bj(2026, 9, 25, 10), holidays), false)
  assert.equal(isPeakMoment(bj(2026, 9, 28, 10), holidays), true)
  // 平安夜（工作日、非节假日）仍按小时判高峰。
  assert.equal(isPeakMoment(bj(2026, 12, 24, 10), holidays), true)
})

test('the builtin fallback table is not silently corrupted', () => {
  // 这不是「数据 == 数据」的同义反复：源码里那张表是**手抄**的国务院放假安排，
  // 抄错一个日期不会让任何东西报错，只会让那一天的峰谷计费判定悄悄判错。
  // 节假日数据要等每年 11 月官方发布才能补下一年，因此这里只钉各年最不可省的
  // 几天（元旦 / 劳动节 / 国庆），不穷举——穷举会让这张表每次更新都要改测试。
  for (const year of [2025, 2026]) {
    const set = new Set(BUILTIN_HOLIDAYS[year])
    for (const md of ['01-01', '05-01', '10-01', '10-02']) {
      assert.ok(set.has(md), `${year} 应包含 ${md}`)
    }
  }
  const y2026 = new Set(BUILTIN_HOLIDAYS[2026])
  for (const md of ['02-17', '04-05', '06-20', '09-26', '10-07']) assert.ok(y2026.has(md), `2026 应包含 ${md}`)
  const y2025 = new Set(BUILTIN_HOLIDAYS[2025])
  for (const md of ['01-28', '05-31', '10-08']) assert.ok(y2025.has(md), `2025 应包含 ${md}`)
})

test('beijing wall-clock helpers are UTC+8 based', () => {
  const d = beijingDate(bj(2026, 9, 21, 0, 30))
  assert.equal(monthDayKey(d), '09-21')
  assert.equal(d.getUTCHours(), 0)
  assert.equal(isWeekend(bj(2026, 9, 19, 12)), true)
  assert.equal(isWeekend(bj(2026, 9, 21, 12)), false)
  // 北京时间周一 00:30 在 UTC 仍是周日 16:30，判定必须以北京时间为准。
  assert.equal(isWeekend(bj(2026, 9, 21, 0, 30)), false)
})

test('parseHolidayPayload keeps days off and ignores adjusted workdays', () => {
  const payload = {
    code: 0,
    holiday: {
      '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
      '01-04': { holiday: false, name: '元旦后补班', date: '2026-01-04' },
      '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
      '10-10': { holiday: false, name: '国庆节后补班', date: '2026-10-10' },
    },
  }
  assert.deepEqual(parseHolidayPayload(payload), ['01-01', '10-01'])
  assert.deepEqual(parseHolidayPayload(null), [])
  assert.deepEqual(parseHolidayPayload({ holiday: {} }), [])
  // 缺 date 字段时回落到键名
  assert.deepEqual(parseHolidayPayload({ holiday: { '05-01': { holiday: true } } }), ['05-01'])
})

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'pet-holidays-test-'))
}

test('store falls back to the builtin table for known years', () => {
  const home = tempHome()
  try {
    const store = createHolidayStore({ dshHome: home, now: () => bj(2026, 9, 21, 10) * 1000 })
    assert.deepEqual(store.datesFor(2026), BUILTIN_HOLIDAYS[2026])
    // 2026-10-01 周四 10:00 → 空闲
    assert.equal(store.isPeak(bj(2026, 10, 1, 10)), false)
    // 2026-09-21 周一 10:00 → 高峰
    assert.equal(store.isPeak(bj(2026, 9, 21, 10)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('store uses the fixed-date fallback for years without data', () => {
  const home = tempHome()
  try {
    const store = createHolidayStore({ dshHome: home, now: () => bj(2099, 6, 1, 10) * 1000 })
    assert.deepEqual(store.datesFor(2099), FIXED_FALLBACK)
    // 2099-10-01 是周四：兜底表覆盖 → 空闲；春节等农历假期无法推算 → 按小时。
    assert.equal(store.isPeak(bj(2099, 10, 1, 10)), false)
    assert.equal(store.isPeak(bj(2099, 6, 1, 10)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('store refreshes from remote, caches to disk and respects TTL', async () => {
  const home = tempHome()
  try {
    // 缓存目录尚不存在也必须能写出去（首次使用 / 自定义 DSH_HOME 的真实情况）
    const cacheHome = join(home, 'not-yet-created')
    const fixedNow = bj(2099, 3, 10, 10) * 1000
    let calls = 0
    const fetchImpl = async (url) => {
      calls += 1
      assert.match(String(url), /\/holiday\/year\/2099$/)
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, holiday: { '03-08': { holiday: true, date: '2099-03-08' }, '03-09': { holiday: false, date: '2099-03-09' } } }),
      }
    }
    const store = createHolidayStore({ dshHome: cacheHome, fetchImpl, now: () => fixedNow })
    await store.refresh()
    assert.equal(calls, 1)
    assert.deepEqual(store.datesFor(2099), ['03-08'])
    const cacheFile = join(cacheHome, '.dshp-holidays-2099.json')
    assert.ok(existsSync(cacheFile), 'cache file should be written')
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')).dates, ['03-08'])
    // TTL 内不重复请求
    await store.refresh()
    assert.equal(calls, 1)
    // 新实例从磁盘缓存恢复
    const store2 = createHolidayStore({ dshHome: cacheHome, fetchImpl: async () => { throw new Error('must not fetch') }, now: () => fixedNow })
    assert.deepEqual(store2.datesFor(2099), ['03-08'])
    // 过期后强制刷新会重新请求
    await store.refresh(true)
    assert.equal(calls, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('store stays usable when the remote refresh fails', async () => {
  const home = tempHome()
  try {
    const logs = []
    let calls = 0
    let clock = bj(2026, 9, 21, 10) * 1000
    const store = createHolidayStore({
      dshHome: home,
      fetchImpl: async () => { calls += 1; throw new Error('offline') },
      now: () => clock,
      log: (tag, msg) => logs.push(`${tag} ${msg}`),
    })
    await store.refresh()
    assert.equal(calls, 1)
    assert.ok(logs.length >= 1, 'failure should be logged')
    // 失败退避：余额 25 秒一刷，10 分钟内不应反复重试并刷日志
    clock += 25000
    await store.refresh()
    assert.equal(calls, 1, 'failed refresh should back off')
    clock += 10 * 60 * 1000
    await store.refresh()
    assert.equal(calls, 2, 'backoff should expire')
    assert.deepEqual(store.datesFor(2026), BUILTIN_HOLIDAYS[2026])
    // 空结果（年份尚未发布）也应静默落盘并继续用兜底表判定
    const empty = createHolidayStore({ dshHome: home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) }), now: () => bj(2099, 3, 10, 10) * 1000 })
    await empty.refresh()
    assert.deepEqual(empty.datesFor(2099), FIXED_FALLBACK)
    writeFileSync(join(home, '.dshp-holidays-2099.json'), JSON.stringify({ year: 2099, fetchedAt: 0, dates: [] }), 'utf8')
    assert.deepEqual(createHolidayStore({ dshHome: home, now: () => 0 }).datesFor(2099), FIXED_FALLBACK)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
