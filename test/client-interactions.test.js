import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const CLIENT = new URL('../lib/client.js', import.meta.url)

function createHarness(initialCurrent = 'other', autoSelect = true, snapshotItems = []) {
  const elements = []
  const fetches = []
  const opened = []
  const timers = []
  const styleWrites = []
  let current = initialCurrent
  let sessionListener
  let stream

  function element(tag = 'div') {
    let node
    const state = {
      tag,
      children: [],
      listeners: new Map(),
      style: new Proxy({}, {
        set(target, key, value) {
          styleWrites.push({ element: node, key, value })
          target[key] = value
          return true
        },
      }),
      dataset: {},
      className: '',
      textContent: '',
      parentNode: null,
    }
    node = new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key]
        if (key === 'appendChild') return (child) => {
          child.parentNode = node
          target.children.push(child)
          return child
        }
        if (key === 'remove') return () => {
          if (!target.parentNode) return
          target.parentNode.children = target.parentNode.children.filter((child) => child !== node)
        }
        if (key === 'addEventListener') return (name, listener) => {
          const listeners = target.listeners.get(name) ?? []
          listeners.push(listener)
          target.listeners.set(name, listeners)
        }
        if (key === 'setAttribute') return () => {}
        if (key === 'contains') return () => true
        if (key === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 180, height: 180 })
        if (key === 'scrollWidth' || key === 'offsetWidth') {
          const own = String(target.textContent || '').length * 12
          const children = target.children.reduce((total, child) => total + Number(child.scrollWidth || 0), 0)
          return Math.max(own, children, 16)
        }
        if (key === 'offsetHeight' || key === 'clientHeight') return 68
        if (key === 'classList') return {
          add(name) { if (!target.className.includes(name)) target.className += ` ${name}` },
          remove(name) { target.className = target.className.split(/\s+/).filter((value) => value && value !== name).join(' ') },
          toggle(name, force) {
            if (force) this.add(name)
            else this.remove(name)
          },
        }
        return () => node
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    })
    elements.push(node)
    return node
  }

  const body = element('body')
  const head = element('head')
  const allowClicks = []
  const allowBtn = {
    textContent: ' 允许一次 ',
    innerText: ' 允许一次 ',
    getAttribute() { return '' },
    click() { allowClicks.push('allow') },
  }
  const rejectBtn = {
    textContent: '拒绝',
    innerText: '拒绝',
    getAttribute() { return '' },
    click() { allowClicks.push('reject') },
  }
  const approvalPanel = {
    querySelectorAll(sel) {
      if (String(sel).includes('button')) return [rejectBtn, allowBtn]
      return []
    },
  }
  const document = {
    body,
    head,
    documentElement: element('html'),
    createElement: (tag) => element(tag),
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return sel === '[data-approval-key]' ? approvalPanel : null },
    querySelectorAll(sel) { return sel === '[data-approval-key]' ? [approvalPanel] : [] },
  }
  class EventSourceStub {
    constructor() { stream = this }
    close() {}
  }
  const window = {
    __ModuleLoader__: { load(entry) { window.factory = entry.factory } },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: { setItem() {} },
    addEventListener() {},
    removeEventListener() {},
    setInterval() { return 1 },
    clearInterval() {},
    setTimeout(listener) { timers.push(listener); return timers.length },
    clearTimeout() {},
    requestAnimationFrame() { return 1 },
    cancelAnimationFrame() {},
    dispatchEvent() {},
  }
  const fetch = async (url, options = {}) => {
    fetches.push({ url, options })
    if (String(url).endsWith('/state')) return { ok: true, json: async () => null }
    return { ok: true, json: async () => ({ ok: true }) }
  }

  const code = readFileSync(CLIENT, 'utf8')
  new Function('window', 'document', 'EventSource', 'fetch', code)(window, document, EventSourceStub, fetch)
  const moduleExports = window.factory((id) => {
    if (id === 'react') return { createElement: () => ({}), Fragment: Symbol('Fragment') }
    throw new Error(`unexpected require: ${id}`)
  })
  const slots = {
    inject(name, callback) { callback(); return () => {} },
    register() { return () => {} },
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ current, byId: snapshotItems }),
      subscribe(listener) { sessionListener = listener; return () => {} },
    },
    open(sessionId) {
      opened.push(sessionId)
      if (autoSelect) {
        current = sessionId
        sessionListener?.()
      }
    },
  }
  moduleExports.apply({ slots, sessions, effect: (callback) => callback() })

  function send(snapshot) {
    stream.onmessage({ data: JSON.stringify(snapshot) })
  }
  function card(title) {
    const titleNode = elements.find((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === title)
    assert.ok(titleNode, `missing card title ${title}`)
    return titleNode.parentNode.parentNode
  }
  function click(node) {
    const listener = node.listeners.get('click')?.[0]
    assert.ok(listener, 'missing click listener')
    listener({ preventDefault() {}, stopPropagation() {} })
  }
  function select(sessionId) {
    current = sessionId
    sessionListener?.()
  }
  function flushTitleTimers() {
    const queued = timers.splice(0)
    for (const listener of queued) listener()
  }
  return { allowClicks, card, click, elements, fetches, opened, select, send, styleWrites, flushTitleTimers }
}

const base = {
  ok: true,
  enabled: true,
  bubble: true,
  petId: 'remielle',
  mood: '06',
  opacity: 1,
  scale: 1,
  sessions: [],
}

test('generated CSS fixes active and idle heights without margin animation', () => {
  const harness = createHarness()
  const css = harness.elements.find((node) => node.tag === 'style' && node.textContent.includes('.rm2-pet-bubbles'))?.textContent
  assert.ok(css, 'missing injected pet CSS')
  assert.match(css, /height:68px;min-height:68px/)
  assert.match(css, /idle-placeholder\{height:46px;min-height:46px/)
  assert.doesNotMatch(css, /transition:[^;}]*margin/)
})

test('multi-session updates keep one eight-pixel summary backboard stable', () => {
  const harness = createHarness('first')
  const sessions = [
    { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: '正在继续处理任务呢', detail: '.dsh · 调用工具', updatedAt: 3 },
    { sessionId: 'second', state: 'THINKING', phase: 'think', message: '让我想想最优解是什么', detail: '.dsh · 分析阶段', updatedAt: 2 },
    { sessionId: 'third', state: 'THINKING', phase: 'think', message: '正在检查剩余问题', detail: '.dsh · 检查阶段', updatedAt: 1 },
  ]
  harness.send({ ...base, sessions })
  harness.send({ ...base, sessions: [{ ...sessions[0], message: '正在读取文件' }, sessions[1], sessions[2]] })

  const background = harness.card('让我想想最优解是什么')
  const writes = harness.styleWrites.filter(({ element, key }) => element === background && key === 'marginTop')
  assert.ok(writes.length >= 2)
  assert.deepEqual(new Set(writes.map(({ value }) => value)), new Set(['-60px']))
  assert.equal(background.offsetHeight - Math.abs(Number.parseInt(writes.at(-1).value, 10)), 8)
  assert.equal(background.children.find((node) => node.className === 'rm2-pet-bubble-stack-count').textContent, '+2')
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '正在检查剩余问题'), false)
  harness.click(background)
  assert.deepEqual(harness.opened, ['second'])
})

test('title clipping ignores long detail text for short approval titles', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'approval',
      state: 'WAITING',
      phase: 'approval',
      message: '等你看一眼呢',
      detail: '.dsh · 这是足够长并会决定公共卡片宽度的详情文字，用来验证短标题不会被误判为需要省略',
      approval: true,
      attention: true,
    }],
  })
  assert.equal(harness.card('等你看一眼呢').className.includes('title-clipped'), false)

  harness.send({
    ...base,
    sessions: [{
      sessionId: 'approval',
      state: 'WAITING',
      phase: 'approval',
      message: '这是一个确实长到超过卡片内部可用宽度并且必须截断显示的审批标题文本',
      detail: '.dsh · 审批阶段',
      approval: true,
      attention: true,
    }],
  })
  assert.equal(harness.card('这是一个确实长到超过卡片内部可用宽度并且必须截断显示的审批标题文本').className.includes('title-clipped'), true)
})

test('question and error action symbols open their own conversations', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'question', state: 'WAITING', phase: 'ask', message: '等待回答', detail: '问题', attention: true, updatedAt: 2 },
      { sessionId: 'error', state: 'ERROR', phase: 'tool-error', message: '需要处理', detail: '错误', attention: true, updatedAt: 1 },
    ],
  })
  const questionAction = harness.card('等待回答').children[0].children.find((node) => node.className === 'rm2-pet-bubble-action')
  const errorAction = harness.card('需要处理').children[0].children.find((node) => node.className === 'rm2-pet-bubble-action')
  harness.click(errorAction)
  harness.click(questionAction)
  assert.deepEqual(harness.opened, ['error', 'question'])
})

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

test('same-mood bubble title holds until the refresh interval elapses', () => {
  const harness = createHarness('s1')
  const thinking = (message) => ({
    sessionId: 's1',
    state: 'THINKING',
    mood: '04',
    phase: 'think',
    message,
    detail: '.dsh · 推理阶段',
    updatedAt: 2,
  })
  harness.send({ ...base, sessions: [thinking('让我想想最优解是什么')] })
  harness.send({ ...base, sessions: [thinking('思路整理中，稍等片刻~')] })
  harness.card('让我想想最优解是什么')
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '思路整理中，稍等片刻~'), false)
  harness.flushTitleTimers()
  harness.card('思路整理中，稍等片刻~')
})

test('mood change updates bubble title immediately', () => {
  const harness = createHarness('s1')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 's1',
      state: 'THINKING',
      mood: '04',
      phase: 'think',
      message: '让我想想最优解是什么',
      detail: '.dsh · 推理阶段',
      updatedAt: 2,
    }],
  })
  harness.send({
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
  harness.card('正在修改这部分内容呢')
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

test('desktop session-action without approve opens the conversation (bubble-card jump)', () => {
  const harness = createHarness()
  harness.send({ ...base, desktopActive: true, sessions: [] })
  harness.send({ kind: 'session-action', sessionId: 'desk-1', completed: true })
  assert.deepEqual(harness.opened, ['desk-1'])
})

test('desktop session-action approve opens the conversation for the native allow-once button', () => {
  const harness = createHarness()
  harness.send({ ...base, desktopActive: true, sessions: [] })
  harness.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  assert.deepEqual(harness.opened, ['desk-2'])
  harness.flushTitleTimers()
  assert.deepEqual(harness.allowClicks, ['allow'])
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
  // 悬浮指针：气泡区域不再继承 dock 的 grab 手型（可点击的会话卡/圆点仍为 pointer）
  const css = harness.elements.find((node) => node.tag === 'style' && node.textContent.includes('.rm2-pet-bubbles'))?.textContent
  assert.ok(css, 'missing injected pet CSS')
  assert.match(css, /\.rm2-pet-bubble\{[^}]*cursor:default/)
  assert.match(css, /\.rm2-pet-bubbles\{[^}]*cursor:default/)
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

test('deck order puts approval above ask above completion', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'done', state: 'SUCCESS', message: '任务已完成', detail: '结果', completed: true, completionNotification: true, updatedAt: 3 },
      { sessionId: 'ask-1', state: 'WAITING', phase: 'ask', message: '等待回答', detail: '问题', ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'appr-1', state: 'WAITING', phase: 'approval', message: '等待确认', detail: '审批', approval: true, attention: true, updatedAt: 1 },
    ],
  })
  const titles = harness.elements
    .filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent)
    .map((node) => node.textContent)
  // MAX_BUBBLES = 2：完成卡被挤出可视栈，但旧排序下它（updatedAt 最大）会占首位。
  assert.deepEqual(titles, ['等待确认', '等待回答'])
})

test('same-tier streaming sessions keep the top card stable (no width flapping)', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  // 视觉顺序由 style.order 决定（DOM 顺序不变），因此断言卡片节点的 order 值。
  const rankOf = (t) => {
    const node = harness.card(t)
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  harness.send({ ...base, sessions: [mk('w1', 10), mk('w2', 5)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'w1 starts on top')
  // w2 的 chunk 刷出更大的 updatedAt，但两者完全同级：顶层保持 w1，宽度不再抖动。
  harness.send({ ...base, sessions: [mk('w1', 10), mk('w2', 20)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'hysteresis keeps w1 on top')
  harness.send({ ...base, sessions: [mk('w1', 40), mk('w2', 30)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'hysteresis still keeps w1 on top')
  // 层级变化（approval）不受滞回影响，照常上位。
  harness.send({
    ...base,
    sessions: [mk('w1', 50), { sessionId: 'w2', state: 'WAITING', phase: 'approval', message: '等待确认', approval: true, attention: true, updatedAt: 60 }],
  })
  assert.ok(rankOf('等待确认') < rankOf('w1 的消息'), 'tier change overrides hysteresis')
})

test('top-2 hysteresis keeps the first two cards stable across three streaming sessions', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  // 视觉顺序由 style.order 决定（DOM 顺序不变），因此断言卡片节点的 order 值。
  const rankOf = (t) => {
    const node = harness.card(t)
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50), mk('w3', 10)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'w1 leads w2 initially')
  // 三个 WORKING 会话在场，前两名轮流刷新 updatedAt：前两名顺序保持稳定，宽度不抖动。
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 150), mk('w3', 10)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'top-2 hysteresis keeps w1 above w2')
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 150), mk('w3', 10)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'top-2 hysteresis survives w1 refresh')
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 300), mk('w3', 10)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'top-2 hysteresis keeps w1 above w2 again')
  // 第三名刷出更大的 updatedAt：新会话照常进入顶层（滞回只锁互为倒序的相邻对）。
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 300), mk('w3', 400)] })
  assert.ok(rankOf('w3 的消息') < rankOf('w2 的消息'), 'a third same-tier session may take over the top')
  // 随后新的前两名（w3/w2）轮流刷新，顺序同样保持稳定（w1 已被 MAX_BUBBLES 挤出可视栈）。
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 500), mk('w3', 400)] })
  assert.ok(rankOf('w3 的消息') < rankOf('w2 的消息'), 'new top pair stays stable too')
})

test('approval tier change still surfaces above a stabilized top-2 deck', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  const rankOf = (t) => {
    const node = harness.card(t)
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50)] })
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 150)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'deck is stabilized by top-2 hysteresis')
  // 层级变化（WAITING+approval）不受滞回影响，照常上位到第一名。
  harness.send({
    ...base,
    sessions: [
      mk('w1', 100),
      { sessionId: 'appr-1', state: 'WAITING', phase: 'approval', message: '等待确认', approval: true, attention: true, updatedAt: 60 },
    ],
  })
  assert.ok(rankOf('等待确认') < rankOf('w1 的消息'), 'tier change overrides top-2 hysteresis')
})

test('deck freezes the second-layer occupant against same-tier rotation', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  const rankOf = (t) => {
    const node = harness.card(t)
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  const hasCard = (t) => harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t)
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50), mk('w3', 10)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'w1 leads w2 initially')
  // w3 刷出介于 w1/w2 之间的 updatedAt：纯排序会把 w3 顶到第二，
  // 第二层冻结让 w2 守住背板位，w3 不闪进牌叠。
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50), mk('w3', 60)] })
  assert.ok(rankOf('w1 的消息') < rankOf('w2 的消息'), 'frozen second stays behind the top')
  assert.equal(hasCard('w3 的消息'), false, 'third session does not flash into the deck')
  // 例外 2：冻结会话离场后立即换人，不渲染幽灵卡。
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w3', 60)] })
  assert.ok(hasCard('w3 的消息'), 'departed frozen session is replaced immediately')
})

test('deck freeze yields to higher-tier sessions and top changes', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  const appr = () => ({ sessionId: 'appr', state: 'WAITING', phase: 'approval', message: '等待确认', approval: true, attention: true, updatedAt: 9 })
  const rankOf = (t) => {
    const node = harness.card(t)
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  // 建立牌叠：appr 顶层，w2 冻结在第二层。
  harness.send({ ...base, sessions: [appr(), mk('w2', 50), mk('w3', 10)] })
  assert.ok(rankOf('等待确认') < rankOf('w2 的消息'), 'approval leads, w2 holds the back slot')
  // 例外 3：attention 会话要上位到第 2，不被 w2 的冻结压制。
  harness.send({
    ...base,
    sessions: [
      appr(),
      mk('w2', 50),
      { sessionId: 'att-1', state: 'WAITING', phase: 'tool-error', message: '需要处理', attention: true, updatedAt: 1 },
      mk('w3', 10),
    ],
  })
  assert.ok(rankOf('等待确认') < rankOf('需要处理'), 'attention session takes the back slot')
  assert.equal(rankOf('需要处理'), 1, 'attention holds the back slot')
  // att-1 离场后：冻结对象消失触发重选，w2 守回背板位（同级轮转继续被吸收）。
  harness.send({ ...base, sessions: [appr(), mk('w2', 50), mk('w3', 10)] })
  assert.equal(rankOf('等待确认'), 0, 'approval keeps the top')
  assert.equal(rankOf('w2 的消息'), 1, 'w2 returns to the back slot after the higher tier departs')
})

test('current-session uplink fires on mount/select and clears on page unload', () => {
  const harness = createHarness()
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  // 挂载时即上报当前会话（fire-and-forget，宿主随下次快照带出）
  assert.ok(currentPosts().length >= 1, 'mount should report the current session')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'other')
  // 切换会话时重新上报
  harness.select('ws9')
  assert.ok(currentPosts().length >= 2, 'selecting a session should re-report')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'ws9')
  // 卸载清空：注册 pagehide/beforeunload 上报，sendBeacon 优先、fetch keepalive 兜底
  // （harness 的 window 不派发卸载事件，此处对 lib 产物做静态断言）
  const code = readFileSync(CLIENT, 'utf8')
  assert.match(code, /addEventListener\('pagehide',\s*clearReportedCurrentSession\)/)
  assert.match(code, /addEventListener\('beforeunload',\s*clearReportedCurrentSession\)/)
  assert.match(code, /navigator\.sendBeacon/)
  assert.match(code, /keepalive:\s*true/)
})

test('desktop bubble click (session-action without approve) opens its conversation only', () => {
  const harness = createHarness()
  harness.send({ kind: 'session-action', sessionId: 'desk-9', approve: false })
  assert.ok(harness.opened.includes('desk-9'), 'should open the session')
  assert.deepEqual(harness.allowClicks, [])
})

test('desktop completion-card click opens the conversation and acknowledges', async () => {
  const harness = createHarness()
  harness.send({ kind: 'session-action', sessionId: 'done-9', approve: false, completed: true })
  assert.ok(harness.opened.includes('done-9'), 'should open the completed session')
  assert.deepEqual(harness.allowClicks, [])
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'done-9' })))
})

