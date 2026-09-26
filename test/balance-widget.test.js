/**
 * 余额控件控制器（src/balance-widget.js）的客户端行为。
 *
 * 该文件头部自己写明「This controller owns NO DOM」——它只拉数据、维护滚动数字
 * 动画，然后向外发「显示帧」，由桌宠自己的气泡去渲染。因此本文件不需要任何
 * DOM 桩：一个假 window + 假 fetch 就能驱动，这也是它此前该有测试却一直没有的原因。
 *
 * 安全相关的一条在 fmt()：取不到余额时必须显示 '--'，绝不能显示成 ¥0.00 ——
 * 后者会被用户读成「余额已经花光」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const SRC = readFileSync(new URL('../src/balance-widget.js', import.meta.url), 'utf8')

const ANIM_MS = 700

/**
 * 载入一份全新的 widget 实例。
 * 源码是 IIFE 且见到 window.__petBalance 就直接 return，所以每次都要给干净的 window。
 */
function load({ fetchImpl, frameStep = ANIM_MS } = {}) {
  const timers = { intervals: new Set(), timeouts: new Set() }
  const requests = []
  let frameTs = 0

  const win = {
    setInterval(fn) { timers.intervals.add(fn); return timers.intervals.size },
    clearInterval(id) { timers.intervals.delete([...timers.intervals][id - 1]) },
    setTimeout(fn) { timers.timeouts.add(fn); return timers.timeouts.size },
    clearTimeout(id) { timers.timeouts.delete([...timers.timeouts][id - 1]) },
    requestAnimationFrame(cb) { frameTs += frameStep; cb(frameTs); return frameTs },
    cancelAnimationFrame() {},
  }
  win.window = win
  const doc = { createElement: () => ({ style: {}, classList: { add() {} } }) }
  const fetchStub = async (url, options) => {
    requests.push({ url: String(url), options })
    return fetchImpl ? fetchImpl(String(url), options) : { json: async () => ({ ok: false, error: '未配置' }) }
  }
  class AbortControllerStub {
    constructor() { this.signal = {} }
    abort() {}
  }

  new Function('window', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', SRC)
    .call(win, win, doc, fetchStub, AbortControllerStub, win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval, win.requestAnimationFrame, win.cancelAnimationFrame)

  const api = win.__petBalance
  const frames = []
  const unsubscribe = api.subscribe((frame) => frames.push(frame))
  // 把 microtask 链（fetch → json → then/catch/finally）排空
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return { api, frames, requests, flush, unsubscribe, timers }
}

function balanceBody(totalBalance, extra = {}) {
  return { ok: true, totalBalance, currency: 'CNY', todayUsage: 1.5, isPeak: false, ...extra }
}

test('fmt never renders an unknown balance as zero', () => {
  const { api } = load()
  // 金额敏感：null / undefined / NaN / Infinity 一律显示 '--'，不能显示 ¥0.00
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, 'abc']) {
    assert.equal(api.fmt(bad, 'CNY'), '--', `${String(bad)} 应显示为 --`)
  }
  assert.equal(api.fmt(0, 'CNY'), '¥ 0.00', '真的是 0 余额才显示 ¥0.00')
  assert.equal(api.fmt(12.3, 'CNY'), '¥ 12.30')
  assert.equal(api.fmt(12.345, 'CNY'), '¥ 12.35')
  assert.equal(api.fmt(12.5, 'USD'), '12.50 USD', '非 CNY 不加货币符号前缀')
  assert.equal(api.fmt(12.5), '¥ 12.50', '币种缺省按 CNY')
  // 已知边界：空串会走 Number('') === 0 而显示 ¥0.00。真实调用路径传不到空串
  // （state.todayUsage / shown 初值都是 null，动画中间值都是数字），故不在此断言。
})

test('showStatus and showBalance emit different frame kinds', async () => {
  const { api, frames, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()

  api.showStatus()
  assert.deepEqual(frames.at(-1), { kind: 'status' })

  api.showBalance()
  assert.equal(frames.at(-1).kind, 'balance')
  assert.equal(frames.at(-1).label, 'DeepSeek 余额')
  assert.equal(frames.at(-1).amount, '¥ 30.00')
  assert.equal(frames.at(-1).detail, '今日已用 ¥ 1.50', '明细用今日已用，不与 period 重复拼接')
  assert.equal(frames.at(-1).period, '空闲时段')
})

test('the period label and colour follow the peak flag', async () => {
  const peak = load({ fetchImpl: async () => ({ json: async () => balanceBody(30, { isPeak: true }) }) })
  peak.api.init('ledger')
  await peak.flush()
  peak.api.showBalance()
  assert.equal(peak.frames.at(-1).period, '高峰时段')
  assert.equal(peak.frames.at(-1).color, '#e0433f')

  const off = load({ fetchImpl: async () => ({ json: async () => balanceBody(30, { isPeak: false }) }) })
  off.api.init('ledger')
  await off.flush()
  off.api.showBalance()
  assert.equal(off.frames.at(-1).period, '空闲时段')
  assert.equal(off.frames.at(-1).color, '#2fa24c')
})

test('a failure replaces the period with an explicit notice instead of leaking a raw error', async () => {
  const { api, frames, flush } = load({ fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'HTTP 500' }) }) })
  api.init('ledger')
  await flush()
  api.showBalance()
  const frame = frames.at(-1)
  assert.equal(frame.period, '获取失败', '失败要看得见，不能显示成「空闲时段」')
  assert.equal(frame.color, '#c0392b')
  assert.equal(frame.amount, '--', '取不到余额时金额也是 --，不是 ¥0.00')
  assert.ok(!frame.detail.includes('HTTP 500'), '错误文案不再拼进 detail（客户端会再拼一次 period，会重复）')
})

test('a rejected fetch degrades to the same failure frame', async () => {
  const { api, frames, flush } = load({ fetchImpl: async () => { throw new Error('network down') } })
  api.init('ledger')
  await flush()
  api.showBalance()
  assert.equal(frames.at(-1).period, '获取失败')
  assert.equal(frames.at(-1).amount, '--')
})

test('the balance request always opts out of caching and carries a timeout signal', async () => {
  const { api, requests, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/plugins/dsh-pet-remielle/balance')
  assert.equal(requests[0].options.cache, 'no-store', '余额必须绕过缓存，否则用户看到的是过期金额')
  assert.ok(requests[0].options.signal, '必须带超时信号，否则请求可以无限挂住')
})

test('concurrent refreshes collapse into a single request', async () => {
  let inflight = 0
  let peak = 0
  const { api, requests, flush } = load({
    fetchImpl: async () => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return { json: async () => balanceBody(30) }
    },
  })
  api.showBalance()
  api.showBalance()
  api.showBalance()
  await flush()
  assert.equal(peak, 1, 'busy 标记应保证同一时刻只有一个请求在飞')
  assert.equal(requests.length, 1)
})

test('setUsageMode only refetches when the mode actually changes', async () => {
  const { api, requests, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()
  assert.equal(requests.length, 1)

  api.setUsageMode('ledger')
  await flush()
  assert.equal(requests.length, 1, '同模式重复设置不该再拉一次')

  api.setUsageMode('token')
  await flush()
  assert.equal(requests.length, 2, '切模式要立刻重算')

  api.setUsageMode('BOGUS')
  await flush()
  assert.equal(requests.length, 3, '非法值按 ledger 处理，与上次不同故重算')
  api.setUsageMode('ledger')
  await flush()
  assert.equal(requests.length, 3, '回到已生效的 ledger 不再重算')
})

test('setEnabled stops and restarts polling', async () => {
  const { api, timers, requests, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  assert.equal(timers.intervals.size, 1, '载入即开始 60s 轮询')

  api.setEnabled(false)
  assert.equal(timers.intervals.size, 0, '关掉用量子开关必须停轮询')
  api.setEnabled(false)
  assert.equal(requests.length, 0, '重复关闭不该触发请求')

  const before = requests.length
  api.setEnabled(true)
  await flush()
  assert.equal(timers.intervals.size, 1, '重新开启要恢复轮询')
  assert.equal(requests.length, before + 1, '重新开启时立即拉一次')
})

test('unsubscribe stops delivery to that listener', async () => {
  const { api, frames, unsubscribe, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()
  api.showBalance()
  const seen = frames.length
  assert.ok(seen > 0)

  unsubscribe()
  api.showStatus()
  assert.equal(frames.length, seen, '退订后不再收到帧')
})
