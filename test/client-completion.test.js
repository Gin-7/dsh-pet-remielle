import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base, createHarness } from './helpers/client-harness.mjs'
test('completion card waits for confirmed selection before acknowledgement', async () => {
  const harness = createHarness('other', false)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:done',
      targetSessionId: 'done',
      state: 'SUCCESS',
      message: '任务已完成',
      detail: '结果',
      completed: true,
      completionNotification: true,
    }],
  })
  harness.click(harness.card('任务已完成'))
  assert.deepEqual(harness.opened, ['done'])
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)
  harness.select('done')
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'done' })))
})

// 「当前会话 vs 后台会话」的卡片去留规则：正在看的 ERROR 直接撤掉，后台的
// ERROR / WAITING 保持 attention 直到那个会话被打开。
test('cards of the viewed session are dropped while background cards stay in attention', () => {
  const error = {
    sessionId: 'err',
    state: 'ERROR',
    message: '任务好像遇到问题了哦',
    detail: 'dsh-pet-remielle · 需要处理',
    attention: true,
    updatedAt: 1,
  }
  const viewed = createHarness('err')
  viewed.send({ ...base, message: '蕾米埃尔待机中~', sessions: [error] })
  assert.equal(
    viewed.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '任务好像遇到问题了哦'),
    false,
    '正在看的会话不该再顶一张 ERROR 卡',
  )

  const background = createHarness('other')
  background.send({ ...base, sessions: [error] })
  const errorCard = background.card('任务好像遇到问题了哦')
  assert.ok(errorCard.className.includes('attention'))
  background.select('err')
  // 节点可能仍留在 harness.elements 里，但已从牌叠父节点卸下。
  assert.equal(errorCard.parentNode.children.includes(errorCard), false)
})

test('a visible but unfocused window waits to acknowledge until focus returns', async () => {
  const harness = createHarness('watched')
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
  harness.setFocus(false)
  harness.send(completed)
  await Promise.resolve()
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)

  harness.setFocus(true)
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
})

test('an older host without layout still auto-acknowledges a foreground completion', async () => {
  const harness = createHarness('watched', true, [], false, false)
  harness.send({
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
  })
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'watched' })))
})


test('background waiting card stays in attention', () => {
  const harness = createHarness('ask')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'ask',
      state: 'WAITING',
      phase: 'ask',
      message: '需要你确认一下哦',
      detail: '等待回答',
      ask: true,
      attention: true,
      updatedAt: 1,
    }],
  })
  assert.ok(harness.card('需要你确认一下哦').className.includes('attention'), '提问卡必须留在首位')
})

test('plan review card renders with its own tooltip and opens without auto-approving', () => {
  const harness = createHarness('plan')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'plan',
      state: 'WAITING',
      phase: 'plan-review',
      message: '计划待审',
      detail: 'dsh-pet-remielle · 计划待审 · 推理面板改材质',
      planReview: true,
      attention: true,
      updatedAt: 1,
    }],
  })
  const card = harness.card('计划待审')
  // 计划待审没有专属类名：approval / plan-review 两个 token 两端都没有 CSS 规则
  // 消费，已从 classNameOf 移除。它靠 attention 样式 + 自己的提示文案 + 「不自动
  // 点允许一次」与审批卡区分。
  assert.equal(card.className.includes('attention'), true)
  assert.equal(card.className.includes('approval'), false)
  assert.equal(card.className.includes('plan-review'), false, 'plan-review 类名无样式消费，不得回归')
  assert.match(card.dataset.rm2Tip, /计划待审：推理面板改材质，点击打开同意执行\/要求修改/)
  harness.click(card)
  assert.deepEqual(harness.opened, ['plan'])
  assert.equal(harness.allowClicks.length, 0)
})

test('current conversation completion is acknowledged without a green reminder', async () => {
  const harness = createHarness('done')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'done',
      targetSessionId: 'done',
      state: 'SUCCESS',
      message: '任务已完成',
      detail: '结果',
      completed: true,
      completionNotification: true,
      pulseUntil: Date.now() + 5000,
    }],
  })
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
  assert.equal(harness.card('任务已完成').className.includes(' completed'), false)
})

// 只有前台标签页在"看着"当前会话时才能自动确认完成提醒；桌面窗开着不算，
// 隐藏标签页也不算——否则完成卡会在用户根本没看的时候消失。
test('completion is auto-acknowledged only by a foreground tab viewing that session', async () => {
  for (const [label, desktopActive] of [['普通标签页', false], ['桌面窗在场', true]]) {
    const harness = createHarness('watched')
    harness.setVisibility('hidden')
    const completed = {
      ...base,
      desktopActive,
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
    harness.send(completed)
    await Promise.resolve()
    assert.equal(
      harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')),
      false,
      `${label}：隐藏标签页不得自动确认`,
    )
    // 提醒确实还挂在牌叠上；桌面窗在场时网页端不再重复渲染这张卡（由桌宠窗口显示），
    // 但同样不得自动确认。
    if (!desktopActive) harness.card('任务已完成')

    harness.setVisibility('visible')
    harness.send(completed)
    await Promise.resolve()
    assert.ok(
      harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'watched' })),
      `${label}：切回可见标签页后才自动确认`,
    )
  }
})

// 标题节流：同一贴纸的逐 chunk 文案要按住不动（否则每 chunk 翻一次），
// 换贴纸则立即更新。
test('bubble title holds while the mood is unchanged and updates when it changes', () => {
  const held = createHarness('s1')
  const thinking = (message) => ({
    sessionId: 's1',
    state: 'THINKING',
    mood: '04',
    phase: 'think',
    message,
    detail: '.dsh · 推理阶段',
    updatedAt: 2,
  })
  held.send({ ...base, sessions: [thinking('让我想想最优解是什么')] })
  held.send({ ...base, sessions: [thinking('思路整理中，稍等片刻~')] })
  held.card('让我想想最优解是什么')
  assert.equal(held.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '思路整理中，稍等片刻~'), false)
  held.flushTitleTimers()
  held.card('思路整理中，稍等片刻~')

  const swapped = createHarness('s1')
  swapped.send({ ...base, sessions: [thinking('让我想想最优解是什么')] })
  swapped.send({
    ...base,
    sessions: [{
      sessionId: 's1',
      state: 'WORKING',
      mood: '02',
      phase: 'tool-call',
      message: '正在修改这部分内容呢',
      detail: '.dsh · 实现阶段',
      updatedAt: 3,
    }],
  })
  swapped.card('正在修改这部分内容呢')
})

test('expired reminder for the current conversation disappears immediately', async () => {
  const harness = createHarness('done')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:done',
      targetSessionId: 'done',
      state: 'SUCCESS',
      message: '任务已完成',
      detail: '结果',
      completed: true,
      completionNotification: true,
    }],
  })
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '任务已完成'), false)
})

test('desktop approval clicks only the panel inside the current DSH conversation root', () => {
  const harness = createHarness('other', true, [], true)
  harness.send({ ...base, desktopActive: true, sessions: [] })
  harness.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  assert.deepEqual(harness.opened, ['desk-2'])
  harness.flushTitleTimers()
  assert.deepEqual(harness.allowClicks, ['allow'])
})

// approvalPanels 的 document 级兜底分支：页面没有 [data-conversation-session]
// 作用域（旧宿主）时，只有恰好一个审批面板才自动点「允许一次」——页面上同时有多个
// 审批面板就宁可不动，点错对话的审批比不点更糟。这条闸门此前在测试里从未被走到
// （harness 恒提供作用域，document 级分支是死代码）。
test('unscoped page refuses auto allow-once unless exactly one panel exists', () => {
  const single = createHarness('other', true, [], true)
  single.setApprovalDom({ scopedRoots: [], loosePanels: [single.panel] })
  single.send({ ...base, desktopActive: true, sessions: [] })
  single.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  single.flushTitleTimers()
  assert.deepEqual(single.allowClicks, ['allow'], '唯一面板时照常自动点')

  const many = createHarness('other', true, [], true)
  many.setApprovalDom({ scopedRoots: [], loosePanels: [many.panel, many.otherPanel] })
  many.send({ ...base, desktopActive: true, sessions: [] })
  many.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  many.flushTitleTimers()
  assert.deepEqual(many.allowClicks, [], '多个审批面板时不得自动点「允许一次」')
})

test('same session live work hides its own completion reminder', () => {
  const harness = createHarness('s1', true, {
    s1: { id: 's1', title: '将PR迁移到桌面悬浮模式', running: true, completed: true, updatedAt: 9 },
  })
  harness.send({
    ...base,
    sessions: [
      { sessionId: 's1', state: 'WORKING', message: '正在继续处理任务呢', detail: 'dsh-pet-remielle · 执行阶段', updatedAt: 9 },
      {
        sessionId: 'completion:s1',
        targetSessionId: 's1',
        state: 'SUCCESS',
        message: '这一轮顺利完成哦',
        detail: 'dsh-pet-remielle · 本轮已完成',
        completed: true,
        completionNotification: true,
        updatedAt: 8,
      },
    ],
  })
  harness.card('正在继续处理任务呢')
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '这一轮顺利完成哦'), false)
})

test('sidebar green-dot session (completed) is surfaced as a clickable completion card', () => {
  const harness = createHarness('current', true, {
    ws2: { id: 'ws2', displayTitle: '插件图标遮挡配色问题', completed: true, cwd: 'C:\\xx\\.dsh', updatedAt: 5 },
    ws1: { id: 'ws1', title: '还在运行', running: true, completed: false, updatedAt: 4 },
  })
  harness.send({ ...base, sessions: [] })
  // 补卡标题用 success 固定文案池（不泄漏会话首条用户消息原文 displayTitle）。
  const completionTitles = ['这次任务搞定啦~', '这一轮顺利完成哦', '任务完成咯，干得漂亮']
  const card = harness.elements.find((node) => node.className === 'rm2-pet-bubble-title' && completionTitles.includes(node.textContent))
  assert.ok(card, 'missing sidebar completed completion card')
  const bubbleCard = card.parentNode.parentNode
  bubbleCard.listeners.get('click')[0]({ preventDefault() {}, stopPropagation() {} })
  assert.ok(harness.opened.includes('ws2'), 'clicking should open the completed session')
})

test('subagent sessions never become synthesized completion cards, fork sessions still do', () => {
  const harness = createHarness('current', true, {
    // 子会话：DSH 列表行带 origin=subagent。宿主在 includeSubagents=false 时完全忽略它，
    // 网页端不得再兜底合成——否则关掉开关也会看到子 Agent 的完成提醒。
    child: { id: 'child', title: '探针任务', completed: true, cwd: 'C:\\xx\\dsh-pet-remielle', origin: 'subagent', parentId: 'parent', updatedAt: 6 },
    // fork 会话：只带 parentId、没有 origin。它不是子 Agent，且被中断/停止时宿主不会生成
    // 完成卡（只有正常结束才入队），网页兜底是那种情况下唯一的提醒来源，不能被一起跳过。
    forked: { id: 'forked', title: 'fork 出来的会话', completed: true, cwd: 'C:\\xx\\dsh-pet-remielle', parentId: 'parent', updatedAt: 5 },
    // 对照：普通会话的绿点仍必须合成卡（防止过滤写过头）。
    plain: { id: 'plain', title: '普通会话', completed: true, cwd: 'C:\\xx\\.dsh', updatedAt: 4 },
  })
  harness.send({ ...base, sessions: [] })
  // 牌叠只给顶层卡渲染标题、其余退化成 +N 背板，所以「合成了几张卡」要看背板计数：
  // child 被过滤 → 只剩 forked + plain 两张 → 背板 +1（漏过滤会变成 +2）。
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard, '两张合成卡应产生一张背板')
  const stackCount = backboard.children.find((node) => node.className === 'rm2-pet-bubble-stack-count')
  assert.equal(stackCount.textContent, '+1')
  // 顶层卡应是 updatedAt 最大的 forked（child 未被合成）；漏过滤时顶层会变成 child。
  const completionTitles = ['这次任务搞定啦~', '这一轮顺利完成哦', '任务完成咯，干得漂亮']
  const topTitle = harness.elements.find(
    (node) => node.className === 'rm2-pet-bubble-title' && completionTitles.includes(node.textContent),
  )
  assert.ok(topTitle, 'missing synthesized completion card')
  topTitle.parentNode.parentNode.listeners.get('click')[0]({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(harness.opened, ['forked'])
})

test('bubble area swallows pet interactions (click/dblclick/pointerdown/mousedown)', () => {
  const harness = createHarness()
  // 状态页牌叠（rm2-pet-bubbles）与余额页单气泡（rm2-pet-bubble top）都要拦截：
  // 否则事件冒泡到 dock 会触发随机表情 / 双击画画 / 按下拖拽。
  for (const className of ['rm2-pet-bubble top', 'rm2-pet-bubbles']) {
    const el = harness.elements.find((node) => node.className === className)
    assert.ok(el, `missing element ${className}`)
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      const listeners = el.listeners.get(type) ?? []
      assert.ok(listeners.length >= 1, `${className} is missing a ${type} blocker`)
      let stopped = false
      listeners[listeners.length - 1]({ stopPropagation() { stopped = true } })
      assert.ok(stopped, `${className} ${type} blocker does not stop propagation`)
    }
  }
})

test('bubble hover uses the default cursor and wheel flips pages instead of scaling', () => {
  const harness = createHarness()
  // 「气泡区不继承 dock 的 grab 手型」原先是断言 CSS 文本里的 cursor:default，已移除：
  // 指针形状是视觉表现，改成 `cursor: default`（多个空格）就会假红，而这不是行为
  // 契约——同类判断应当是手工验收。下面几条断言的都是可观察行为。
  const balanceBubble = harness.elements.find((node) => node.className === 'rm2-pet-bubble top')
  const pageDot = harness.elements.find((node) => node.className === 'rm2-bubble-dot')
  assert.equal(balanceBubble.title, '', 'balance bubble must not inherit dock title')
  assert.equal(pageDot.title, '', 'page-switch dot must not inherit dock title')
  assert.equal(pageDot.dataset.rm2Tip, '点击看余额呀~')
  harness.send({ ...base, sessions: [] })
  // 滚轮翻页：两个气泡容器都要接住 wheel（stopPropagation，不冒泡到 dock 缩放），
  // 且容器可命中（pointer-events:auto），卡片缝隙上的滚轮不再穿透。
  for (const className of ['rm2-pet-bubble top', 'rm2-pet-bubbles']) {
    const el = harness.elements.find((node) => node.className === className)
    assert.ok(el, `missing element ${className}`)
    assert.equal(el.style.pointerEvents, 'auto', `${className} should be hit-testable while shown`)
    const wheel = el.listeners.get('wheel')?.[0]
    assert.ok(wheel, `${className} is missing a wheel handler`)
    let stopped = false
    let prevented = false
    wheel({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    assert.ok(stopped && prevented, `${className} wheel handler must capture the event`)
  }
})

test('page-switch dot overlay tip follows the page and restores the card tip', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    showBubble: true,
    showBubbleStatus: true,
    showBubbleUsage: true,
    sessions: [{
      sessionId: 's1',
      state: 'WORKING',
      phase: 'output',
      message: '正在输出回答哦',
      detail: 'dsh-pet-remielle · 输出阶段',
    }],
  })
  const pageDot = harness.elements.find((node) => node.className === 'rm2-bubble-dot')
  const card = harness.card('正在输出回答哦')
  assert.equal(pageDot.title, '')
  assert.equal(pageDot.dataset.rm2Tip, '点击看余额呀~')
  const enter = pageDot.listeners.get('mouseenter')?.[0]
  const leave = pageDot.listeners.get('mouseleave')?.[0]
  assert.ok(enter && leave, 'missing switch-dot hover listeners')
  enter({ stopPropagation() {} })
  const tip = harness.elements.find((node) => node.className === 'rm2-pet-tip')
  assert.ok(tip, 'missing .rm2-pet-tip')
  assert.equal(tip.textContent, '点击看余额呀~')
  leave({ relatedTarget: card })
  assert.equal(tip.textContent, '点击跳到这里看一下~')
  leave({})
  assert.equal(tip.style.display, 'none')
  harness.click(pageDot)
  assert.equal(pageDot.dataset.rm2Tip, '点击回状态呀~')
  assert.equal(pageDot.title, '')
})
