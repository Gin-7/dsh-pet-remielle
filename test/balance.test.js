/**
 * 余额 / 今日用量服务（src/balance.js）。
 *
 * 这块此前零测试覆盖，而它是唯一会写用户磁盘文件（记账本）的地方：
 * 余额下降要累计成"今日已用"、跨天要归零并把前一日归档、归档历史上限 30 天——
 * 写坏了表现为"用量一直不对"，且不会报错。
 *
 * 网络出口由 fetchImpl 注入，holidays 的后台刷新也走同一个注入并在 404 时静默，
 * 因此本文件全程不联网。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { computeTodayCost, createBalanceService, normalizeUsageMode } from '../src/balance.js'

const homes = []

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-balance-test-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true })
})

const LEDGER = '.dshp-usage.json'
// 与 src/balance.js 的 BALANCE_TTL_MS 一致；改那边记得同步这里
const BALANCE_TTL_MS = 25000
function readLedger(home) {
  return JSON.parse(readFileSync(join(home, LEDGER), 'utf8'))
}
function writeLedger(home, body) {
  writeFileSync(join(home, LEDGER), JSON.stringify(body), 'utf8')
}
function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function yesterdayKey() {
  const d = new Date(Date.now() - 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 余额接口的成功响应。 */
function okBody(balance) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ balance_infos: [{ total_balance: String(balance), currency: 'CNY' }] }),
  }
}

/**
 * fetch 桩。假日日历的后台刷新也走这里，返回 404 让它静默失败，
 * 这样 calls 里只剩余额请求，便于断言缓存与去重。
 */
function fakeFetch(balance) {
  const calls = []
  const impl = async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('/user/balance')) {
      return typeof balance === 'function' ? balance(calls.length) : okBody(balance)
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  impl.calls = calls
  impl.balanceCalls = () => calls.filter((u) => u.includes('/user/balance')).length
  return impl
}

function service(fetchImpl, extra = {}) {
  return createBalanceService({
    resolveCredential: async (name) => (name === 'DEEPSEEK_API_KEY' ? { value: 'sk-test' } : null),
    dshHome: tempHome(),
    fetchImpl,
    log: () => {},
    ...extra,
  })
}

test('normalizeUsageMode falls back to ledger for anything but the exact token', () => {
  assert.equal(normalizeUsageMode('token'), 'token')
  assert.equal(normalizeUsageMode('ledger'), 'ledger')
  assert.equal(normalizeUsageMode('TOKEN'), 'ledger')
  assert.equal(normalizeUsageMode(''), 'ledger')
  assert.equal(normalizeUsageMode(undefined), 'ledger')
})

test('computeTodayCost sums the platform cost buckets and rejects unusable shapes', () => {
  const payload = {
    data: {
      biz_data: {
        data: [
          { series: [{ buckets: [{ cost: '1.5' }, { cost: '2.25' }] }] },
          { series: [{ buckets: [{ cost: '0.25' }] }, { buckets: [] }] },
        ],
      },
    },
  }
  assert.equal(computeTodayCost(payload), 4)
  // 非数字 cost 跳过但不把 found 置真——全是非数字时必须回 null（= 取不到），不能回 0
  assert.equal(computeTodayCost({ data: { biz_data: { data: [{ series: [{ buckets: [{ cost: 'x' }] }] }] } } }), null)
  assert.equal(computeTodayCost({ data: { biz_data: { data: [] } } }), null)
  assert.equal(computeTodayCost({}), null)
  assert.equal(computeTodayCost(null), null)
})

test('missing credential is reported without touching the network', async () => {
  const fetchImpl = fakeFetch(100)
  const svc = createBalanceService({
    resolveCredential: async () => null,
    dshHome: tempHome(),
    fetchImpl,
    log: () => {},
  })
  const result = await svc.getBalance('ledger')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_KEY')
  assert.equal(fetchImpl.balanceCalls(), 0, '没有凭据就不该发请求')
})

test('a 4xx fails fast while a 5xx is retried once', async () => {
  const client = fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) }))
  const r1 = await service(client).getBalance('ledger')
  assert.equal(r1.ok, false)
  assert.equal(client.balanceCalls(), 1, '4xx 不该重试')

  const server = fakeFetch(() => ({ ok: false, status: 503, json: async () => ({}) }))
  const r2 = await service(server).getBalance('ledger')
  assert.equal(r2.ok, false)
  assert.equal(server.balanceCalls(), 2, '5xx 应重试一次')
  assert.equal(r2.transient, true, '服务端故障是暂态，可回落旧缓存')
})

test('an unexpected balance payload shape is flagged, not silently zeroed', async () => {
  const client = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ balance_infos: [] }) }))
  const result = await service(client).getBalance('ledger')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SHAPE', '结构异常要能区分于网络失败')
  assert.match(result.error, /结构异常/)
})

test('ledger mode accumulates the balance drop and ignores top-ups', async () => {
  const home = tempHome()
  let balance = 100
  const svc = service(fakeFetch(() => okBody(balance)), { dshHome: home })

  assert.equal((await svc.getBalance('ledger')).todayUsage, 0, '首次观测只记基线，不算用量')

  balance = 90
  svc.invalidate()
  assert.equal((await svc.getBalance('ledger')).todayUsage, 10, '余额降 10 应累计成今日已用 10')

  balance = 95
  svc.invalidate()
  assert.equal((await svc.getBalance('ledger')).todayUsage, 10, '充值不是消耗，用量不得下降')

  balance = 80
  svc.invalidate()
  assert.equal((await svc.getBalance('ledger')).todayUsage, 25)
  assert.equal(readLedger(home).date, todayKey())
})

test('a new day resets the counter and archives yesterday', async () => {
  const home = tempHome()
  // 预置一条「昨天」的记录：跨天分支靠 ledger.date 与今天不同来触发
  writeLedger(home, { date: yesterdayKey(), lastBalance: 50, todayUsage: 33, history: {} })
  const svc = service(fakeFetch(40), { dshHome: home })

  const result = await svc.getBalance('ledger')
  assert.equal(result.todayUsage, 0, '跨天后今日用量应归零')
  const ledger = readLedger(home)
  assert.equal(ledger.date, todayKey())
  assert.equal(ledger.lastBalance, 40, '今天的第一笔余额作为新基线')
  assert.equal(ledger.history[yesterdayKey()], 33, '昨天的用量要归档进 history')
})

test('the archive keeps only the most recent 30 days', async () => {
  const home = tempHome()
  const history = {}
  for (let i = 0; i < 35; i++) history[`2000-01-${String(i + 1).padStart(2, '0')}`] = i + 1
  writeLedger(home, { date: yesterdayKey(), lastBalance: 10, todayUsage: 5, history })
  await service(fakeFetch(10), { dshHome: home }).getBalance('ledger')
  const kept = Object.keys(readLedger(home).history)
  assert.ok(kept.length <= 31, `归档应被裁到 30 天左右，实际 ${kept.length}`)
  assert.equal(kept.includes('2000-01-01'), false, '最旧的一天应被淘汰')
})

test('getBalance caches for the TTL and de-duplicates concurrent calls', async () => {
  const client = fakeFetch(77)
  const svc = service(client)

  await svc.getBalance('ledger')
  await svc.getBalance('ledger')
  assert.equal(client.balanceCalls(), 1, 'TTL 内的第二次调用应命中缓存')

  const [a, b] = await Promise.all([svc.getBalance('ledger'), svc.getBalance('ledger')])
  assert.equal(client.balanceCalls(), 1, '并发调用应合并成一次请求')
  assert.deepEqual(a, b, '并发拿到的是同一个结果')
})

test('invalidate forces the next read to recompute', async () => {
  const client = fakeFetch(50)
  const svc = service(client)
  await svc.getBalance('ledger')
  svc.invalidate()
  await svc.getBalance('ledger')
  assert.equal(client.balanceCalls(), 2)
})

test('a transient failure keeps serving the last known balance, flagged stale', async () => {
  let healthy = true
  const client = fakeFetch(() => (healthy ? okBody(64) : { ok: false, status: 500, json: async () => ({}) }))
  // 可推进的时钟：stale 回落只在 TTL 自然过期后才可达（invalidate 会把缓存整个丢掉）
  let clock = 1_000_000
  const svc = service(client, { now: () => clock })

  const first = await svc.getBalance('ledger')
  assert.equal(first.totalBalance, 64)
  assert.equal(first.stale, undefined)

  // 仍在 TTL 内：直接吃缓存，连请求都不发
  clock += BALANCE_TTL_MS - 1
  assert.equal((await svc.getBalance('ledger')).totalBalance, 64)
  assert.equal(client.balanceCalls(), 1)

  // TTL 过期后服务端故障：不得把已知余额清空，但必须标记为陈旧
  healthy = false
  clock += 2
  const second = await svc.getBalance('ledger')
  assert.equal(second.totalBalance, 64, '暂态故障不得把已知余额清空')
  assert.equal(second.stale, true, '但必须标记为陈旧，让调用方能提示用户')
  assert.ok(second.error, '应带上失败原因')
  assert.equal(client.balanceCalls(), 3, '5xx 会重试一次，两次都算这次请求')
})

test('invalidate drops the stale fallback along with the cache', async () => {
  // 记录当前行为：invalidate 的用途是 usageMode 变化时强制重算，它把缓存整个丢掉，
  // 于是紧随其后的暂态故障没有可回落的旧余额。切模式时这正是想要的，但读代码的人
  // 容易以为它保留旧值兜底，故钉住现状。
  let healthy = true
  const client = fakeFetch(() => (healthy ? okBody(64) : { ok: false, status: 500, json: async () => ({}) }))
  const svc = service(client)
  await svc.getBalance('ledger')

  healthy = false
  svc.invalidate()
  const result = await svc.getBalance('ledger')
  assert.equal(result.ok, false, 'invalidate 后失败就是失败，不回落')
  assert.equal(result.stale, undefined)
})

test('token mode strips a Bearer prefix and falls back to ledger when the platform call fails', async () => {
  const home = tempHome()
  const urls = []
  const fetchImpl = async (url) => {
    const href = String(url)
    urls.push(href)
    if (href.includes('/user/balance')) return okBody(20)
    return { ok: false, status: 403, json: async () => ({}) }
  }
  const svc = service(fetchImpl, { dshHome: home, getPlatformToken: () => 'Bearer secret-token' })

  const result = await svc.getBalance('token')
  // 平台接口 403 → 回落到记账模式，而不是把余额页显示成「取不到用量」
  assert.equal(result.usageMode, 'ledger')
  assert.equal(result.todayUsage, 0, '回落时应给出记账模式的当日用量')
  assert.ok(urls.some((u) => u.includes('/api/v0/usage/by_api_key/cost')), '应真的尝试过平台接口')

  const usageUrl = urls.find((u) => u.includes('by_api_key/cost'))
  assert.ok(usageUrl.includes('start=') && usageUrl.includes('end=') && usageUrl.includes('tz='), '平台接口需要当天起止时间与时区')
})

test('a platform cost payload is adopted as today usage in token mode', async () => {
  const fetchImpl = async (url) => (String(url).includes('/user/balance')
    ? okBody(20)
    : {
        ok: true,
        status: 200,
        json: async () => ({ data: { biz_data: { data: [{ series: [{ buckets: [{ cost: '1.25' }, { cost: '2' }] }] }] } } }),
      })
  const result = await service(fetchImpl, { getPlatformToken: () => 'tok' }).getBalance('token')
  assert.equal(result.usageMode, 'token')
  assert.equal(result.todayUsage, 3.25)
})
