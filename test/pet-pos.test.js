/**
 * 页面内桌宠的位置计算（src/pet-pos.cjs）：锚点 <-> 像素，以及旧版比例的迁移口径。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const pos = require('../src/pet-pos.cjs')

const VIEW = { w: 1280, h: 800 }
const PET = { w: 180, h: 180 }
const SPAN_X = VIEW.w - PET.w // 1100
const SPAN_Y = VIEW.h - PET.h // 620

test('anchorFromPx picks the nearest edge on each axis and keeps that pixel gap', () => {
  // 左下角附近：横向离左边 118 更近，纵向离下边 33 更近
  assert.deepEqual(pos.anchorFromPx({ x: 118, y: SPAN_Y - 33 }, VIEW, PET), {
    sideX: 'left', gapX: 118, sideY: 'bottom', gapY: 33,
  })
  // 右下角：两个方向都贴右边/下边
  assert.deepEqual(pos.anchorFromPx({ x: SPAN_X - 36, y: SPAN_Y - 24 }, VIEW, PET), {
    sideX: 'right', gapX: 36, sideY: 'bottom', gapY: 24,
  })
  // 左上角
  assert.deepEqual(pos.anchorFromPx({ x: 12, y: 8 }, VIEW, PET), {
    sideX: 'left', gapX: 12, sideY: 'top', gapY: 8,
  })
})

test('pxFromAnchor keeps the exact same margins on a portrait or smaller screen', () => {
  const anchor = pos.anchorFromPx({ x: 118, y: SPAN_Y - 33 }, VIEW, PET)
  for (const screen of [{ w: 1152, h: 2000 }, { w: 1573, h: 1049 }, { w: 2560, h: 1396 }]) {
    const px = pos.pxFromAnchor(anchor, screen, PET)
    // 关键断言：边距原样保留（不是按比例缩放），宠物仍然完整可见
    assert.equal(px.x, 118, `左边距应保持 118px：${JSON.stringify({ screen, px })}`)
    assert.equal(px.y, screen.h - PET.h - 33, `下边距应保持 33px：${JSON.stringify({ screen, px })}`)
    assert.ok(px.x >= 0 && px.x + PET.w <= screen.w)
    assert.ok(px.y >= 0 && px.y + PET.h <= screen.h)
  }
})

// 真实报障场景：主屏 2560×1396 上贴左下角（左 118 / 下 33），换到竖屏与小屏后边距必须不变
test('the reported 118/33 corner survives the exact monitor set from the bug report', () => {
  const pet = { w: 144, h: 144 } // 角色大小 0.8 时的实际尺寸
  const main = { w: 2560, h: 1396 } // 主屏最大化后的视口
  const anchor = pos.anchorFromPx({ x: 118, y: 1396 - 144 - 33 }, main, pet)
  assert.deepEqual(anchor, { sideX: 'left', gapX: 118, sideY: 'bottom', gapY: 33 })

  const portrait = pos.pxFromAnchor(anchor, { w: 1152, h: 2000 }, pet)
  assert.deepEqual(portrait, { x: 118, y: 2000 - 144 - 33 })
  const smaller = pos.pxFromAnchor(anchor, { w: 1573, h: 1049 }, pet)
  assert.deepEqual(smaller, { x: 118, y: 1049 - 144 - 33 })

  // 老比例口径会落到 49px（差 69px），这正是「偏差」的来源——回归护栏
  const oldRatio = pos.ratioFromPx(118, 1396 - 144 - 33, main, pet)
  const oldPortraitX = pos.pxFromRatio(oldRatio.rx, oldRatio.ry, { w: 1152, h: 2000 }, pet).x
  assert.notEqual(oldPortraitX, portrait.x, '比例口径的横向落点与锚点口径不同（回归护栏）')
})

test('a viewport smaller than pet + gap clamps the pet back inside', () => {
  // 900×600 的可用空间是 720×420：右边距 1000 放不下 → 钳到最右侧（x=0 表示贴左）
  assert.deepEqual(pos.pxFromAnchor({ sideX: 'right', gapX: 1000, sideY: 'bottom', gapY: 300 }, { w: 900, h: 600 }, PET), { x: 0, y: 120 })
  // 正好放得下的边距原样保留
  assert.deepEqual(pos.pxFromAnchor({ sideX: 'right', gapX: 400, sideY: 'bottom', gapY: 300 }, { w: 900, h: 600 }, PET), { x: 320, y: 120 })
  // 宠物比视口还大：贴左上角
  assert.deepEqual(pos.pxFromAnchor({ sideX: 'right', gapX: 400, sideY: 'bottom', gapY: 300 }, { w: 100, h: 80 }, PET), { x: 0, y: 0 })
})

test('anchorFromPx and pxFromAnchor round-trip on the same viewport', () => {
  for (const point of [{ x: 0, y: 0 }, { x: 118, y: 462 }, { x: SPAN_X, y: SPAN_Y }, { x: 432, y: 17 }]) {
    assert.deepEqual(pos.pxFromAnchor(pos.anchorFromPx(point, VIEW, PET), VIEW, PET), point)
  }
  // 越界像素在折算时就被钳回可见范围
  assert.deepEqual(pos.pxFromAnchor(pos.anchorFromPx({ x: 4000, y: 3000 }, VIEW, PET), VIEW, PET), {
    x: SPAN_X, y: SPAN_Y,
  })
})

test('normalizeAnchor rejects incomplete stored values and keeps valid ones', () => {
  assert.equal(pos.normalizeAnchor(null), null)
  assert.equal(pos.normalizeAnchor({ sideX: 'left' }), null)
  assert.equal(pos.normalizeAnchor({ sideX: 'middle', gapX: 1, sideY: 'top', gapY: 2 }), null)
  assert.equal(pos.normalizeAnchor({ sideX: 'left', gapX: 'oops', sideY: 'top', gapY: 2 }), null)
  assert.deepEqual(
    pos.normalizeAnchor({ sideX: 'right', gapX: -30, sideY: 'bottom', gapY: '40' }),
    { sideX: 'right', gapX: 0, sideY: 'bottom', gapY: 40 },
  )
})

// ---- 旧存档迁移口径（相对比例） ----

test('legacy ratio restores on the free space and clamps out-of-range values', () => {
  assert.deepEqual(pos.pxFromRatio(0, 0, VIEW, PET), { x: 0, y: 0 })
  assert.deepEqual(pos.pxFromRatio(1, 1, VIEW, PET), { x: SPAN_X, y: SPAN_Y })
  assert.deepEqual(pos.pxFromRatio(0.5, 0.5, VIEW, PET), { x: SPAN_X / 2, y: SPAN_Y / 2 })
  assert.deepEqual(pos.pxFromRatio(-3, 7, VIEW, PET), { x: 0, y: SPAN_Y })
})

test('legacy ratio round-trips on the same viewport and clamps off-screen pixels', () => {
  const saved = pos.ratioFromPx(300, 200, VIEW, PET)
  assert.deepEqual(pos.pxFromRatio(saved.rx, saved.ry, VIEW, PET), { x: 300, y: 200 })
  // 越界旧坐标贴到右下角，迁移不会把宠物留在视口外
  assert.deepEqual(pos.ratioFromPx(2000, 1200, VIEW, PET), { rx: 1, ry: 1 })
})

test('non-finite or missing inputs never leak NaN into a position', () => {
  assert.equal(pos.clamp01(undefined), 0)
  assert.equal(pos.clamp01(Number.NaN), 0)
  assert.equal(pos.clamp01(2), 1)
  assert.deepEqual(pos.pxFromRatio(undefined, Number.POSITIVE_INFINITY, VIEW, PET), { x: 0, y: 0 })
  assert.deepEqual(pos.ratioFromPx(null, undefined, VIEW, PET), { rx: 0, ry: 0 })
  assert.deepEqual(pos.pxFromAnchor(null, VIEW, PET), { x: 0, y: 0 })
  assert.deepEqual(pos.anchorFromPx(null, VIEW, PET), { sideX: 'left', gapX: 0, sideY: 'top', gapY: 0 })
})
