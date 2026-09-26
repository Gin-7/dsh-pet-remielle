/**
 * Shared page-switch-dot hover copy, leave routing, tip layout clamp, and
 * bubble zoom resolution.
 * Web: inlined by scripts/build-client.mjs ahead of client.core.js.
 * Desktop: served at /plugins/dsh-pet-remielle/pet-tip.js.
 *
 * 文件用 .cjs：包是 "type":"module"，与 session-order.cjs 同一套加载约定。
 */
;(function (global) {
  'use strict'

  function dotTipText(page) {
    return page === 0 ? '点击看余额呀~' : '点击回状态呀~'
  }

  function backboardTipText(project, title) {
    var parts = []
    var p = String(project || '').trim()
    var t = String(title || '').trim()
    if (p) parts.push(p)
    if (t && t !== p) parts.push(t)
    if (!parts.length) return '点击跳到这里看一下~'
    return '点击去看 ' + parts.join(' · ') + ' 哦~'
  }

  // 让背板的点击目标和提示文字成对更新，并在候选目标稳定后再提交。
  function createBackboardStabilizer(commit, delay, schedule, cancel) {
    var currentTarget = ''
    var currentTip = ''
    var pendingTarget = ''
    var pendingTip = ''
    var timer = 0
    var commitFn = typeof commit === 'function' ? commit : function () {}
    var scheduleFn = typeof schedule === 'function' ? schedule : function (fn, ms) { return setTimeout(fn, ms) }
    var cancelFn = typeof cancel === 'function' ? cancel : function (id) { clearTimeout(id) }

    function clearTimer() {
      if (!timer) return
      cancelFn(timer)
      timer = 0
    }

    function commitNow(target, tip) {
      clearTimer()
      currentTarget = target
      currentTip = tip
      pendingTarget = ''
      pendingTip = ''
      commitFn(target, tip)
    }

    function update(target, tip) {
      target = String(target || '')
      tip = String(tip || '')
      if (!target) {
        commitNow('', '')
        return
      }
      if (target === currentTarget && tip === currentTip) {
        pendingTarget = ''
        pendingTip = ''
        clearTimer()
        return
      }
      if (!currentTarget) {
        commitNow(target, tip)
        return
      }
      pendingTarget = target
      pendingTip = tip
      clearTimer()
      timer = scheduleFn(function () {
        timer = 0
        commitNow(pendingTarget, pendingTip)
      }, delay)
    }

    return {
      update: update,
      target: function () { return currentTarget },
      tip: function () { return currentTip },
    }
  }

  function openIdleDshPage(bridge) {
    if (!bridge || typeof bridge.openDshPage !== 'function') return false
    bridge.openDshPage()
    return true
  }

  // ---- 气泡缩放口径（网页端与桌面端共用，防两端口径漂移）----
  // 同步模式（bubbleScaleSync !== false）：气泡 zoom = 桌宠 scale × 相对比例；
  // 固定模式（bubbleScaleSync === false）：气泡 zoom = 固定大小系数。
  // 字段缺失时回落旧口径（zoom = scale），与 0.3.6 及之前行为一致。
  var BUBBLE_ZOOM_MIN = 0.3
  var BUBBLE_ZOOM_MAX = 3

  function clampZoom(value) {
    if (!isFinite(value) || value <= 0) return 1
    // 4 位小数内取整：scale/ratio 步进 0.05，乘积最多 4 位小数，
    // 同时消掉 1.5×0.8=1.2000000000000002 这类浮点噪声。
    var clamped = Math.min(BUBBLE_ZOOM_MAX, Math.max(BUBBLE_ZOOM_MIN, value))
    return Math.round(clamped * 1e4) / 1e4
  }

  function bubbleZoomOf(snapshot) {
    if (!snapshot) return 1
    var scale = Number(snapshot.scale)
    if (!isFinite(scale) || scale <= 0) scale = 1
    if (snapshot.bubbleScaleSync === false) {
      var fixed = Number(snapshot.bubbleFixedSize)
      return clampZoom(isFinite(fixed) && fixed > 0 ? fixed : 1)
    }
    var ratio = Number(snapshot.bubbleScaleRatio)
    return clampZoom(scale * (isFinite(ratio) && ratio > 0 ? ratio : 1))
  }

  function applyDotTip(dot, page, anchor, show) {
    if (!dot || !dot.dataset) return
    dot.dataset.rm2Tip = dotTipText(page)
    dot.title = ''
    if (anchor === dot && typeof show === 'function') show(dot)
  }

  function onDotLeave(e, dot, dots, show, hide) {
    var related = e && e.relatedTarget
    if (related === dot || related === dots) return
    var host = dots && dots.parentNode
    if (related && host && host.dataset && host.dataset.rm2Tip && typeof host.contains === 'function' && host.contains(related)) {
      if (typeof show === 'function') show(host)
      return
    }
    if (typeof hide === 'function') hide()
  }

  // 先按单行量自然宽，超出可见 maxW 再换行；文案自带换行（审批全文）直接 wrap。
  function fitTipWrap(petTip, maxW) {
    if (!petTip || !petTip.style) return
    var text = String(petTip.textContent || '')
    if (text.indexOf('\n') !== -1) {
      petTip.style.whiteSpace = 'pre-wrap'
      petTip.style.wordBreak = 'break-all'
      return
    }
    petTip.style.whiteSpace = 'nowrap'
    petTip.style.wordBreak = 'normal'
    petTip.style.maxWidth = 'none'
    if (petTip.offsetWidth > maxW) {
      petTip.style.whiteSpace = 'pre-wrap'
      petTip.style.wordBreak = 'break-all'
    }
  }

  // 网页/桌面同一套钳位：用可见宽度自然展开，再把盒子钳进光晕内（可向空侧偏置）。
  // 桌面 showPetTip 在首帧后再按 getWorkArea 收紧 L/T/R/B，算法仍走这里。
  function layoutPetTip(petTip, anchor, L, T, R, B) {
    if (!petTip || !anchor) return
    var pad = 24
    var gap = 6
    var win = typeof window !== 'undefined' ? window : null
    var W = (win && win.innerWidth) || 1280
    var H = (win && win.innerHeight) || 800
    var visL = Math.max(0, L)
    var visT = Math.max(0, T)
    var visR = Math.min(W, R)
    var visB = Math.min(H, B)
    if (visR - visL < 80) { visL = 0; visR = W }
    if (visB - visT < 40) { visT = 0; visB = H }
    var r = anchor.getBoundingClientRect()
    var cx = r.left + r.width / 2
    var visW = visR - visL - pad * 2
    var maxW = Math.min(420, Math.max(80, visW))
    fitTipWrap(petTip, maxW)
    petTip.style.maxWidth = maxW + 'px'
    var tw = petTip.offsetWidth
    var th = petTip.offsetHeight
    var minL = visL + pad
    var maxL = visR - tw - pad
    var left = cx - tw / 2
    if (maxL < minL) left = visL + Math.max(0, (visR - visL - tw) / 2)
    else left = Math.min(Math.max(minL, left), maxL)
    var minT = visT + pad
    var maxT = visB - th - pad
    var above = r.top - th - gap
    var below = r.bottom + gap
    var top
    if (above >= minT) top = above
    else if (below + th <= visB - pad) top = below
    else if (maxT >= minT) top = Math.min(Math.max(minT, above), maxT)
    else top = visT + Math.max(0, (visB - visT - th) / 2)
    petTip.style.left = left + 'px'
    petTip.style.top = top + 'px'
  }

  global.__rm2PetTip = {
    dotTipText: dotTipText,
    backboardTipText: backboardTipText,
    createBackboardStabilizer: createBackboardStabilizer,
    openIdleDshPage: openIdleDshPage,
    bubbleZoomOf: bubbleZoomOf,
    applyDotTip: applyDotTip,
    onDotLeave: onDotLeave,
    layoutPetTip: layoutPetTip,
  }
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2PetTip
  }
})(typeof window !== 'undefined' ? window : globalThis)
