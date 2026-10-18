/**
 * 页面内桌宠的位置记忆：像素落点 <-> 锚点（最近的边 + 边距）。
 * 网页端独占，由 scripts/build-client.mjs 拼在 client.core.js 之前。
 *
 * 不存像素：视口尺寸会变，换屏/改窗口后越界。
 * 不存比例：边距会按屏幕伸缩（118px 到竖屏上缩成 49px），看着就是「差了一截」。
 * 存锚点：贴左下角就一直是左下角、留同样宽的边距；放不下时以「能放下」为界钳住。
 */
;(function (global) {
  'use strict'

  /** 非有限值（null/NaN/Infinity/非数字串）一律回落。 */
  function finiteOr(value, fallback) {
    var n = typeof value === 'number' ? value : Number(value)
    return typeof n === 'number' && isFinite(n) ? n : fallback
  }

  function clamp(value, min, max) {
    var n = finiteOr(value, min)
    return n < min ? min : n > max ? max : n
  }

  function clamp01(value) {
    return clamp(value, 0, 1)
  }

  /** 可移动空间 = 视口 − 宠物尺寸（负值按 0，宠物比视口大时只能贴左上角）。 */
  function freeSpace(viewport, pet) {
    var vw = Math.max(0, finiteOr(viewport && viewport.w, 0))
    var vh = Math.max(0, finiteOr(viewport && viewport.h, 0))
    var pw = Math.max(0, finiteOr(pet && pet.w, 0))
    var ph = Math.max(0, finiteOr(pet && pet.h, 0))
    return { w: Math.max(0, vw - pw), h: Math.max(0, vh - ph) }
  }

  /** 像素落点 → 锚点：横竖各自取较近的边，平局归左/上以保持稳定。 */
  function anchorFromPx(px, viewport, pet) {
    var space = freeSpace(viewport, pet)
    var x = clamp(px && px.x, 0, space.w)
    var y = clamp(px && px.y, 0, space.h)
    var rightGap = space.w - x
    var bottomGap = space.h - y
    var sideX = x <= rightGap ? 'left' : 'right'
    var sideY = y <= bottomGap ? 'top' : 'bottom'
    return {
      sideX: sideX,
      gapX: Math.round(sideX === 'left' ? x : rightGap),
      sideY: sideY,
      gapY: Math.round(sideY === 'top' ? y : bottomGap),
    }
  }

  /** 锚点 → 像素落点：边距原样保留，放不下时钳到还能放下的位置。 */
  function pxFromAnchor(anchor, viewport, pet) {
    var space = freeSpace(viewport, pet)
    var a = anchor || {}
    var sideX = a.sideX === 'right' ? 'right' : 'left'
    var sideY = a.sideY === 'bottom' ? 'bottom' : 'top'
    var gapX = Math.max(0, finiteOr(a.gapX, 0))
    var gapY = Math.max(0, finiteOr(a.gapY, 0))
    var x = sideX === 'left' ? gapX : space.w - gapX
    var y = sideY === 'top' ? gapY : space.h - gapY
    return { x: Math.round(clamp(x, 0, space.w)), y: Math.round(clamp(y, 0, space.h)) }
  }

  /** 清洗配置里的锚点；缺项返回 null，调用方据此回落到旧存档。 */
  function normalizeAnchor(raw) {
    if (!raw) return null
    var sideX = raw.sideX
    var sideY = raw.sideY
    if (sideX !== 'left' && sideX !== 'right') return null
    if (sideY !== 'top' && sideY !== 'bottom') return null
    var gapX = finiteOr(raw.gapX, null)
    var gapY = finiteOr(raw.gapY, null)
    if (gapX === null || gapY === null) return null
    return { sideX: sideX, sideY: sideY, gapX: Math.max(0, gapX), gapY: Math.max(0, gapY) }
  }

  /** 以下两个比例函数只用于迁移旧版 posRelX/posRelY 存档。 */
  function pxFromRatio(rx, ry, viewport, pet) {
    var space = freeSpace(viewport, pet)
    return {
      x: Math.round(clamp01(rx) * space.w),
      y: Math.round(clamp01(ry) * space.h),
    }
  }

  function ratioFromPx(x, y, viewport, pet) {
    var space = freeSpace(viewport, pet)
    return {
      rx: space.w > 0 ? clamp01(finiteOr(x, 0) / space.w) : 0,
      ry: space.h > 0 ? clamp01(finiteOr(y, 0) / space.h) : 0,
    }
  }

  global.__rm2PetPos = {
    finiteOr: finiteOr,
    clamp: clamp,
    clamp01: clamp01,
    freeSpace: freeSpace,
    anchorFromPx: anchorFromPx,
    pxFromAnchor: pxFromAnchor,
    normalizeAnchor: normalizeAnchor,
    pxFromRatio: pxFromRatio,
    ratioFromPx: ratioFromPx,
  }
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2PetPos
  }
})(typeof window !== 'undefined' ? window : globalThis)
