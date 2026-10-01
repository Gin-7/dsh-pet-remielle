import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CLIENT_CORE, STATUS_COPY, base, createHarness } from './helpers/client-harness.mjs'
// 卸载清空上报（pagehide/beforeunload + sendBeacon/keepalive）由下面那条
// 'unloading clears the reported current session…' 真派发 window 事件验证——
// 此前这里还留着 4 条对 lib 产物的静态断言（grep addEventListener('pagehide'…
// 与 keepalive），覆盖的是同一件事且更容易假阳。
test('current-session uplink fires on mount and on select', () => {
  const harness = createHarness()
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  // 挂载时即上报当前会话（fire-and-forget，宿主随下次快照带出）
  assert.ok(currentPosts().length >= 1, 'mount should report the current session')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'other')
  // 切换会话时重新上报
  harness.select('ws9')
  assert.ok(currentPosts().length >= 2, 'selecting a session should re-report')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'ws9')
})

test('hidden tab does not overwrite the reported current session until it becomes visible', () => {
  const harness = createHarness('other')
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  const initialCount = currentPosts().length

  harness.setVisibility('hidden')
  harness.select('background')
  assert.equal(currentPosts().length, initialCount, 'hidden tab must not report its selection')

  harness.setVisibility('visible')
  assert.equal(currentPosts().length, initialCount + 1, 'becoming visible re-reports the local selection')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'background')
})

test('a focus event while hidden does not restore the current-session report', () => {
  const harness = createHarness('other')
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  const initialCount = currentPosts().length

  harness.setVisibility('hidden')
  harness.setFocus(false)
  harness.select('background')
  harness.setFocus(true)

  assert.equal(currentPosts().length, initialCount, 'hidden focus must not report a session')
  harness.setVisibility('visible')
  assert.equal(currentPosts().length, initialCount + 1, 'the visible transition reports the local session')
})

test('missing layout service keeps current-session reporting usable on older hosts', () => {
  const harness = createHarness('other', true, [], false, false)
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  const initialCount = currentPosts().length

  harness.select('background')
  assert.equal(currentPosts().length, initialCount + 1, 'missing optional layout must not disable session reporting')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'background')
})

test('active global panel keeps the retained session completion unacknowledged', async () => {
  const harness = createHarness('watched', true, {
    watched: { id: 'watched', retainedBy: { mainView: 1 } },
  }, true)
  const completed = {
    ...base,
    sessions: [{
      sessionId: 'completion:watched',
      targetSessionId: 'watched',
      state: 'SUCCESS',
      message: '任务已完成',
      detail: '结果',
      completed: true,
      completionNotification: true,
    }],
  }

  harness.setPanelActive(true)
  harness.send(completed)
  await Promise.resolve()
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)
  harness.card('任务已完成')

  harness.setPanelActive(false)
  harness.send(completed)
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
})

// 「只有一张完成卡」不等于「用户正在看它」。宿主没给出当前会话时（页面刚加载、
// 多标签互相覆盖）猜错就是静默吞掉一条没看过的提醒，宁可留给手动点击。
//
// 这条用例钉的是「不猜」这个整体行为，**不区分** ackCurrentSessionCompletion 里
// `if (!target) return` 那句守卫：夹具换成 undefined（触发 createHarness 的默认值
// 'other'）结果同样是全绿，因为「没有当前会话」与「有但不匹配」都不发 ack。
// 那句守卫也无法用行为断言单独钉住——想造出差异只能让完成卡自己也没有
// target（entry 既无 targetSessionId 也无 sessionId，targetSessionOf 返回
// undefined），但那样 acknowledgeCompletion(undefined) 会被它自己开头的
// `if (!sessionId) return` 挡下，删掉守卫同样全绿（已实测）。换言之这两句
// 守卫在所有可达路径上行为等价，后者是前者的冗余保险，不需要测试保护。
test('a lone completion card stays unacknowledged while the viewed session is unknown', async () => {
  const harness = createHarness(null, false, [], true)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:elsewhere',
      targetSessionId: 'elsewhere',
      state: 'SUCCESS',
      message: '任务已完成',
      detail: '结果',
      completed: true,
      completionNotification: true,
    }],
  })
  await Promise.resolve()
  assert.equal(
    harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')),
    false,
    '不知道用户在看哪个会话时，不得替用户确认唯一那张完成卡',
  )
  // 提醒仍在：这条只约束自动确认，不影响牌照常显示
  harness.card('任务已完成')
})

// 桌面气泡点击必须走宿主导航：DSH 0.1.7 的 uiWorkspace.openSession 与旧路径
// ctx.sessions.open 都要打开会话，且不带任何「允许一次」副作用。
test('desktop bubble click opens its conversation on both navigation paths', () => {
  for (const modern of [false, true]) {
    const harness = createHarness('other', true, [], modern)
    harness.send({ ...base, desktopActive: true, sessions: [] })
    harness.send({ kind: 'session-action', sessionId: 'desk-9', approve: false })
    assert.ok(harness.opened.includes('desk-9'), `should open the session (uiWorkspace=${modern})`)
    assert.deepEqual(harness.allowClicks, [])
  }
})

test('desktop completion-card click opens the conversation and acknowledges', async () => {
  const harness = createHarness()
  harness.send({ kind: 'session-action', sessionId: 'done-9', approve: false, completed: true })
  assert.ok(harness.opened.includes('done-9'), 'should open the completed session')
  assert.deepEqual(harness.allowClicks, [])
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'done-9' })))
})

test('内联 SUCCESS_COPY_POOL 与 status-copy.js 的 success 池逐字一致（防漂移护栏）', () => {
  // 网页包不含 status-copy 模块，client.core.js 内联了 success 文案池；
  // 两处必须同步维护，这里静态断言内容一致，防止后续只改一处导致漂移。
  const core = readFileSync(CLIENT_CORE, 'utf8')
  const copySource = readFileSync(STATUS_COPY, 'utf8')
  // 从源码字面量中提取全部单引号字符串，得到字符串数组
  const parsePool = (literal) => {
    const items = [...literal.matchAll(/'([^']*)'/g)].map((match) => match[1])
    assert.ok(items.length >= 1, `文案池不应为空：${literal}`)
    return items
  }
  const inlineMatch = core.match(/\bSUCCESS_COPY_POOL\s*=\s*(\[[^\]]*\])/)
  assert.ok(inlineMatch, 'client.core.js 中应存在内联 SUCCESS_COPY_POOL 字面量')
  const statusMatch = copySource.match(/\bsuccess:\s*(\[[^\]]*\])/)
  assert.ok(statusMatch, 'status-copy.js 中应存在 success 池字面量')
  assert.deepEqual(parsePool(inlineMatch[1]), parsePool(statusMatch[1]))
})

// 拼接顺序（__rm2SessionOrder / __rm2PetTip / __rm2GifFrame / __rm2BubbleTitle /
// __rm2Markdown 必须排在 mountPet 之前）已迁到 scripts/build-client.mjs 做构建期
// 硬断言：顺序错就直接构建失败，产物根本写不出去，比事后测产物字符串更早也更可靠。
//
// 这里原本还有一条「拼接顺序」的单测，已删除而不再补替代表述——消费端的早失败
// 守卫（throw new Error('__rm2X is missing ...')）在加载真 bundle 时就会触发，
// 本文件 38 个用例能跑起来，本身就证明守卫没有被误触发。

test('unloading clears the reported current session via beacon or keepalive fetch（行为验证）', async () => {
  // sendBeacon 可用：pagehide 清空上报走 sendBeacon
  const harness = createHarness()
  harness.select('ws9')
  harness.dispatchWindowEvent('pagehide')
  assert.equal(harness.beacons.length, 1)
  assert.equal(JSON.parse(harness.beacons[0].body).sessionId, '')
  assert.ok(String(harness.beacons[0].url).endsWith('/plugins/dsh-pet-remielle/session/current'))

  // beforeunload 同样清空（重复清空无副作用）
  harness.select('ws8')
  harness.dispatchWindowEvent('beforeunload')
  assert.equal(harness.beacons.length, 2)
  assert.equal(JSON.parse(harness.beacons[1].body).sessionId, '')

  // sendBeacon 不可用：兜底为 keepalive fetch
  harness.navigator.sendBeacon = undefined
  harness.select('ws7')
  const before = harness.fetches.length
  harness.dispatchWindowEvent('pagehide')
  const fallback = harness.fetches.slice(before).find(({ url, options }) =>
    String(url).endsWith('/session/current') && options.keepalive === true)
  assert.ok(fallback, 'should fall back to keepalive fetch when sendBeacon is unavailable')
  assert.equal(JSON.parse(fallback.options.body).sessionId, '')
})

test('disposed client ignores later focus and visibility events', async () => {
  const harness = createHarness('old-session')
  harness.setFocus(false)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:old-session',
      targetSessionId: 'old-session',
      state: 'SUCCESS',
      message: '任务已完成',
      completed: true,
      completionNotification: true,
    }],
  })
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)

  harness.dispose()
  harness.select('new-session')
  harness.fetches.length = 0
  harness.setFocus(true)
  harness.setVisibility('visible')
  await Promise.resolve()

  const staleRequests = harness.fetches.filter(({ url, options }) => {
    if (!/session\/current|completion\/ack/.test(String(url))) return false
    return JSON.parse(options.body).sessionId === 'old-session'
  })
  assert.equal(staleRequests.length, 0, 'disposed client must not report or acknowledge its old session')
})
