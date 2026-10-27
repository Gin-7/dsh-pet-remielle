/**
 * 页面内桌宠的位置接线（跑真产物 lib/client.js）：锚点还原、旧存档迁移、视口变化。
 * 纯算术在 test/pet-pos.test.js，这里只管「快照 → 落点 → 回写」这条链路。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { base, createHarness } from './helpers/client-harness.mjs'

const CONFIG_ENDPOINT = '/plugins/dsh-pet-remielle/config'

function lastWrite(harness, key) {
  const writes = harness.styleWrites.filter((entry) => entry.key === key && entry.element)
  assert.ok(writes.length, `没有写入过 style.${key}`)
  return writes.at(-1)
}

function pxOf(write) {
  return Number(String(write.value).replace('px', ''))
}

function lastPatch(harness) {
  const patches = harness.fetches.filter(({ url, options }) => String(url).endsWith(CONFIG_ENDPOINT) && options.method === 'PATCH')
  assert.ok(patches.length, '应该回写一次位置存档')
  return JSON.parse(patches.at(-1).options.body)
}

test('anchor position keeps the exact edge margins when the viewport shrinks and grows', () => {
  const harness = createHarness()
  // 右下角：右边距 30px、下边距 40px
  harness.send({ ...base, posAnchorX: 'right', posGapX: 30, posAnchorY: 'bottom', posGapY: 40 })
  const root = lastWrite(harness, 'left').element
  const w = root.offsetWidth
  const h = root.offsetHeight
  assert.equal(pxOf(lastWrite(harness, 'left')), 1280 - w - 30)
  assert.equal(pxOf(lastWrite(harness, 'top')), 800 - h - 40)

  // 换到小屏/竖屏最大化：边距不变（这正是「同一个位置」的意思）
  harness.window.innerWidth = 900
  harness.window.innerHeight = 520
  harness.dispatchWindowEvent('resize')
  assert.equal(pxOf(lastWrite(harness, 'left')), 900 - w - 30)
  assert.equal(pxOf(lastWrite(harness, 'top')), 520 - h - 40)

  // 再放大回去：还是同一组边距，而不是按比例缩放过的位置
  harness.window.innerWidth = 1600
  harness.window.innerHeight = 1000
  harness.dispatchWindowEvent('resize')
  assert.equal(pxOf(lastWrite(harness, 'left')), 1600 - w - 30)
  assert.equal(pxOf(lastWrite(harness, 'top')), 1000 - h - 40)
})

test('the pet stays complete inside a viewport smaller than its stored gap', () => {
  const harness = createHarness()
  harness.send({ ...base, posAnchorX: 'right', posGapX: 900, posAnchorY: 'bottom', posGapY: 700 })
  const root = lastWrite(harness, 'left').element
  const w = root.offsetWidth
  const h = root.offsetHeight
  assert.equal(pxOf(lastWrite(harness, 'left')), 1280 - w - 900)
  assert.equal(pxOf(lastWrite(harness, 'top')), 800 - h - 700)

  // 窗口缩到放不下这组边距：钳到左上角而不是变成负坐标
  harness.window.innerWidth = 400
  harness.window.innerHeight = 300
  harness.dispatchWindowEvent('resize')
  assert.equal(pxOf(lastWrite(harness, 'left')), 0)
  assert.equal(pxOf(lastWrite(harness, 'top')), 0)
})

test('legacy ratio archive migrates to an anchor and is clamped back on screen', () => {
  const harness = createHarness()
  // 上一版存的相对比例（越界比例）：换算成锚点后应贴到右下角
  harness.send({ ...base, posRelX: 3, posRelY: 4 })
  const root = lastWrite(harness, 'left').element
  assert.equal(pxOf(lastWrite(harness, 'left')), 1280 - root.offsetWidth)
  assert.equal(pxOf(lastWrite(harness, 'top')), 800 - root.offsetHeight)
  // 回写锚点，并在同一次 PATCH 里清掉旧的比例字段（否则下次启动又会走迁移）
  const patch = lastPatch(harness)
  assert.deepEqual({ sideX: patch.posAnchorX, gapX: patch.posGapX, sideY: patch.posAnchorY, gapY: patch.posGapY }, {
    sideX: 'right', gapX: 0, sideY: 'bottom', gapY: 0,
  })
  assert.equal(patch.posRelX, null, '迁移后应清空旧的比例字段')
  assert.equal(patch.posRelY, null)
})

test('legacy absolute pixels migrate to an anchor and come back into the viewport', () => {
  const harness = createHarness()
  // 最初版本只有绝对像素，且这组坐标对当前窗口早已越界
  harness.send({ ...base, posX: 4000, posY: 3000 })
  const root = lastWrite(harness, 'left').element
  assert.equal(pxOf(lastWrite(harness, 'left')), 1280 - root.offsetWidth)
  assert.equal(pxOf(lastWrite(harness, 'top')), 800 - root.offsetHeight)
  const patch = lastPatch(harness)
  assert.equal(patch.posAnchorX, 'right')
  assert.equal(patch.posAnchorY, 'bottom')
})

test('an anchor archive wins over a stale legacy ratio and retires the old fields', () => {
  const harness = createHarness()
  // 锚点已经存在（新版客户端拖过），但上一版留下的比例字段还在：以锚点为准，
  // 并顺手把过时的比例清掉，避免它日后被当成迁移依据。
  harness.send({
    ...base,
    posAnchorX: 'left', posGapX: 40, posAnchorY: 'bottom', posGapY: 25,
    posRelX: 0.9, posRelY: 0.1,
  })
  const root = lastWrite(harness, 'left').element
  assert.equal(pxOf(lastWrite(harness, 'left')), 40)
  assert.equal(pxOf(lastWrite(harness, 'top')), 800 - root.offsetHeight - 25)
  const patch = lastPatch(harness)
  assert.equal(patch.posRelX, null)
  assert.equal(patch.posRelY, null)
})

// 拖动存档、重置、拆监听、世代兜底用源码级护栏钉住（行为不易在假 DOM 里模拟）。
test('the client wires the shared math to drag-save, reset, hide/show and teardown', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const build = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  // 共享纯函数模块必须拼在 client.core.js 之前，否则早失败守卫会直接抛错
  assert.match(build, /__rm2PetPos/, 'build-client 必须把 pet-pos.cjs 拼进产物并纳入顺序护栏')
  assert.match(core, /__pos\.pxFromAnchor\(/)
  assert.match(core, /__pos\.anchorFromPx\(/)
  assert.match(core, /__pos\.normalizeAnchor\(/)
  // 拖动结束：把实测落点折算成锚点并存档（最近的边 + 像素距离）
  assert.match(core, /saveAnchorAt\(\{ x: r\.left, y: r\.top \}\)/)
  // 视口变化与隐藏后重新可见都要按锚点补落点（display:none 时测不到尺寸）
  assert.match(core, /window\.addEventListener\('resize', onViewportResize\)/)
  assert.match(core, /window\.removeEventListener\('resize', onViewportResize\)/)
  assert.match(core, /if \(posAnchor\) placeByAnchor\(\)/)
  // 重置位置：锚点 + 两套旧存档 + 桌面窗坐标一次全清（两端一致）
  const ALL_POSITIONS = /\{\s*posX: null,\s*posY: null,\s*posRelX: null,\s*posRelY: null,\s*posAnchorX: null,\s*posGapX: null,\s*posAnchorY: null,\s*posGapY: null,\s*desktopX: null,\s*desktopY: null,?\s*\}/
  assert.match(core, ALL_POSITIONS, '网页端「重置位置」应清空全部位置存档')
  assert.match(main, ALL_POSITIONS, '桌面端「重置位置」应清空全部位置存档')
  // 热重载残留实例兜底：一个页面只允许一只宠物，旧实例下一次轮询时自拆
  assert.match(core, /sweepStaleInstances\(\)/, '挂载时应清掉上一代实例留下的节点')
  assert.match(core, /window\.__rm2PetGeneration !== generation/, '旧实例发现世代过期后应自拆')
})
