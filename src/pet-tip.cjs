/**
 * Shared page-switch-dot hover copy, leave routing, and tip layout clamp.
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

  // 网页/桌面同一套钳位：贴边收窄换行、相对卡片居中，并留出 24px 光晕。
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
    var spaceL = cx - (visL + pad)
    var spaceR = visR - pad - cx
    var visW = visR - visL - pad * 2
    var maxW = (spaceL > 0 && spaceR > 0)
      ? Math.min(420, visW, Math.max(80, 2 * Math.min(spaceL, spaceR)))
      : Math.min(420, Math.max(80, visW))
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
    applyDotTip: applyDotTip,
    onDotLeave: onDotLeave,
    layoutPetTip: layoutPetTip,
  }
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2PetTip
  }
})(typeof window !== 'undefined' ? window : globalThis)
