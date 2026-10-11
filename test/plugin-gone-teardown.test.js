/**
 * 插件停用自毁（issue #34）结构护栏。
 *
 * 背景：DSH 0.2 的 live patch 卸载不调用客户端的 ctx.effect 清理钩子——
 * 页面里已执行的客户端实例成为僵尸（桌宠 DOM/轮询/SSE/主题心跳全部残留），
 * 宿主重新启用后再挂载一份新实例，页面上出现两只桌宠。修复 = 客户端不再
 * 依赖宿主调用：/state 连续 404（路由已注销 = 插件已停用）触发自毁。
 * 同时 resolveActive 无可显示宠物时返回 null，快照 petId 缺省，
 * 两端（网页 client.core.js / 桌面 pet-view.html）整体隐藏。
 *
 * 本文件用静态断言钉住接线，防止清理钩子被误删/改名后无人触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const coreSrc = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
const petViewSrc = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
const indexSrc = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

test('client detects persistent /state 404 and triggers plugin-gone teardown', () => {
  assert.match(coreSrc, /runPluginGoneTeardown\('state-404'\)/, 'poll 必须在 404 连击达到阈值时触发自毁')
  assert.match(coreSrc, /lastStateHttpStatus === 404/, '404 判定必须基于真实 HTTP 状态码（网络错误不算）')
  assert.match(coreSrc, /stateGoneStreak = 0/, '非 404 失败必须重置连击计数（宿主网关重启要能等回来）')
})

test('ctx.effect teardown is also registered via onPluginGone (dual path)', () => {
  assert.match(coreSrc, /ctx\.effect\(function \(\) \{ return teardownPetClient \}\)/, '宿主正常 dispose 路径保留')
  assert.match(coreSrc, /onPluginGone\(teardownPetClient\)/, '自毁路径必须复用同一份清理序列')
  assert.match(coreSrc, /var tornDown = false/, 'teardown 必须幂等（两条路可能先后触发）')
})

test('plugin-gone teardown also covers update UI and settings slots', () => {
  assert.match(coreSrc, /onPluginGone\(function \(\) \{\s*stopUpdateWatchdog\(\)/, '更新轮询看门狗必须随自毁停止')
  assert.match(coreSrc, /onPluginGone\(function \(\) \{\s*while \(slotDisposers\.length\)/, 'settings slot 注销必须挂进自毁')
})

test('both clients hide the pet when the snapshot has no showable petId', () => {
  assert.match(coreSrc, /wantHidden = snapshot\.enabled === false \|\| snapshot\.hidden === true \|\| snapshot\.petId == null/,
    '网页端 petId 缺省必须整体隐藏')
  assert.match(petViewSrc, /snapshot\.petId == null/, '桌面窗 petId 缺省必须隐藏宠物与气泡')
})

test('bootId mismatch triggers immediate teardown (fast disable→enable)', () => {
  assert.match(coreSrc, /snapshot\.bootId !== seenBootId\)\s*\{\s*runPluginGoneTeardown\('boot-changed'\)/,
    'bootId 代际不一致必须立即自毁——404 连击会被秒关秒开的操作绕过')
  assert.match(coreSrc, /var seenBootId = null/, 'seenBootId 必须初始化（首个快照作为本代基准）')
  assert.match(coreSrc, /seenBootId = snapshot\.bootId/, '首个快照必须记录本代 bootId')
})

test('client.core.js must define exactly one poll() (duplicates silently override)', () => {
  const matches = coreSrc.match(/function poll\(\)/g) || []
  assert.equal(matches.length, 1,
    '同作用域的函数声明后者覆盖前者——出现第二个 poll() 会让 404 检测/徽章等全部变成死代码（issue #34 排障实修教训）')
})

test('plugin disable hides/stops the web pet immediately (no seconds-long zombie)', () => {
  assert.match(coreSrc, /snapshot\.kind === 'plugin-gone'\)\s*\{\s*runPluginGoneTeardown\('sse-plugin-gone'\)/,
    'SSE 告别帧必须立即触发自毁（关插件毫秒级消失的主路径）')
  assert.match(indexSrc, /hub\.notify\(\{ kind: 'plugin-gone' \}\)[\s\S]*?hub\.close\(\)/,
    '服务端必须在关闭 SSE 流之前先广播告别帧')
  assert.match(coreSrc, /if \(!hidden\) setHidden\(true\)/, '首次 404 必须立即藏匿桌宠（告别帧丢失的兜底）')
})
