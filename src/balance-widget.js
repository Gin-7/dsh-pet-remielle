/**
 * dsh-pet-remielle balance controller (client side).
 *
 * This controller owns NO DOM. It only fetches the balance, keeps the
 * rolling-number animation and the 5-second auto-collapse timer, then emits
 * "display frames" that the pet's OWN status bubble renders.
 *
 * Emitted frames (via subscribe):
 *   { kind: 'status' }                         -> show the pet's session status
 *   { kind: 'balance', label, amount, detail, period, color } -> balance + time period
 *
 * Interactions:
 *   - 60s auto-refresh (silent; the balance number rolls if it changes while
 *     the balance view is open)
 *   - pet click -> manual refresh + switch the bubble to balance/time-period,
 *     5 seconds later it returns to the session status automatically
 */

;(function () {
  'use strict'
  if (window.__petBalance) return

  var BALANCE_URL = '/plugins/dsh-pet-remielle/balance'
  var REFRESH_MS = 60000
  var ANIM_MS = 700
  var BUBBLE_MS = 5000
  var FETCH_TIMEOUT_MS = 25000

  var usageMode = 'ledger'
  var state = { balance: null, currency: 'CNY', todayUsage: null, isPeak: false, status: 'loading', message: '' }
  var shown = null
  var busy = false
  var animId = null
  var mode = 'status' // 'status' | 'balance' | 'random'
  var bubbleTimer = null
  var listeners = []

  // ---- helpers ----
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
  function fmt(balance, currency) {
    var num = Number(balance)
    var fixed = isFinite(num) ? num.toFixed(2) : '--'
    currency = currency || 'CNY'
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
  }

  function emit(frame) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](frame) } catch (e) { /* ignore */ }
    }
  }

  function periodText() {
    return state.isPeak ? '高峰时段' : '空闲时段'
  }
  function periodColor() {
    return state.isPeak ? '#e0433f' : '#2fa24c'
  }

  function emitBalance(amount) {
    var used = state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--'
    var detail = '今日已用 ' + used
    var period = periodText()
    var color = periodColor()
    // 失败时可观测：把时段替换为"获取失败"，不要把错误信息再拼进 detail（客户端会再拼一次 · period，会重复）
    if (state.status === 'error' && state.message) {
      period = '获取失败'
      color = '#c0392b'
    }
    emit({
      kind: 'balance',
      label: 'DeepSeek 余额',
      amount: amount !== undefined ? fmt(amount, state.currency) : fmt(shown, state.currency),
      detail: detail,
      period: period,
      color: color,
    })
  }

  // ---- rolling number animation: emits one frame per animation step ----
  function animateAmount(from, to, currency) {
    if (animId) cancelAnimationFrame(animId)
    if (from === null || !isFinite(from)) from = to
    if (from === to) {
      shown = to
      emitBalance(to)
      return
    }
    var startTime = null
    function step(ts) {
      if (startTime === null) startTime = ts
      var t = Math.min(1, (ts - startTime) / ANIM_MS)
      var eased = 1 - Math.pow(1 - t, 3)
      var val = from + (to - from) * eased
      emitBalance(val)
      if (t < 1) {
        animId = requestAnimationFrame(step)
      } else {
        animId = null
        shown = to
        emitBalance(to)
      }
    }
    animId = requestAnimationFrame(step)
  }

  // ---- mode/timer ----
  function enterBalance() {
    mode = 'balance'
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    emitBalance(shown)
    bubbleTimer = setTimeout(function () {
      bubbleTimer = null
      if (mode === 'balance') {
        mode = 'status'
        emit({ kind: 'status' })
      }
    }, BUBBLE_MS)
  }

  // ---- refresh ----
  function refresh(manual) {
    if (busy) return
    busy = true
    if (manual || state.balance === null) state.status = 'loading'
    var ctrl = null
    var timer = null
    try {
      ctrl = new AbortController()
      timer = setTimeout(function () { try { ctrl.abort() } catch (e) {} }, FETCH_TIMEOUT_MS)
    } catch (e) {}
    fetch(BALANCE_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (data && data.ok) {
          var nb = Number(data.totalBalance)
          var nc = String(data.currency || 'CNY')
          var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
          state.balance = nb
          state.currency = nc
          state.message = ''
          state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
          state.isPeak = !!data.isPeak
          state.status = 'ok'
          if (changed && (manual || mode !== 'status')) {
            animateAmount(shown, nb, nc)
          } else if (changed) {
            shown = nb
          } else if (shown === null || !isFinite(shown)) {
            shown = nb
          }
          if (mode === 'balance') emitBalance(shown)
        } else {
          state.status = 'error'
          state.message = (data && data.error) ? String(data.error) : '获取失败'
          if (mode === 'balance') emitBalance(shown)
        }
      })
      .catch(function () {
        state.status = 'error'
        state.message = '获取失败'
        if (mode === 'balance') emitBalance(shown)
      })
      .finally(function () {
        busy = false
        if (timer) clearTimeout(timer)
      })
  }

  // ---- public API ----
  window.__petBalance = {
    init: function (modeArg) {
      usageMode = modeArg === 'token' ? 'token' : 'ledger'
      refresh(false)
    },
    setUsageMode: function (m) {
      var next = m === 'token' ? 'token' : 'ledger'
      if (next === usageMode) return
      usageMode = next
      refresh(false)
    },
    /** Pet single-click: manual refresh + switch the bubble to balance/time period. */
    click: function () {
      enterBalance()
      refresh(true)
    },
    /** Switch to balance mode (no 5s auto-collapse) for page-based navigation. */
    showBalance: function () {
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
      mode = 'balance'
      emitBalance(shown)
      refresh(false)
    },
    /** Switch back to status mode. */
    showStatus: function () {
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
      mode = 'status'
      emit({ kind: 'status' })
    },
    subscribe: function (cb) {
      listeners.push(cb)
      return function () {
        var i = listeners.indexOf(cb)
        if (i !== -1) listeners.splice(i, 1)
      }
    },
    fmt: fmt,
  }

  setInterval(function () { refresh(false) }, REFRESH_MS)
})()
