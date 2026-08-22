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
  const document = {
    body,
    head,
    documentElement: element('html'),
    createElement: (tag) => element(tag),
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
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
  return { card, click, elements, fetches, opened, select, send, styleWrites, flushTitleTimers }
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

test('desktop session-action without approve does not open the conversation', () => {
  const harness = createHarness()
  harness.send({ ...base, desktopActive: true, sessions: [] })
  harness.send({ kind: 'session-action', sessionId: 'desk-1', completed: true })
  assert.deepEqual(harness.opened, [])
})

test('desktop session-action approve opens the conversation for the native allow-once button', () => {
  const harness = createHarness()
  harness.send({ ...base, desktopActive: true, sessions: [] })
  harness.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  assert.deepEqual(harness.opened, ['desk-2'])
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
    ws2: { id: 'ws2', title: '插件图标遮挡配色问题', completed: true, cwd: 'C:\\xx\\.dsh', updatedAt: 5 },
    ws1: { id: 'ws1', title: '还在运行', running: true, completed: false, updatedAt: 4 },
  })
  harness.send({ ...base, sessions: [] })
  const card = harness.card('插件图标遮挡配色问题')
  assert.ok(card, 'missing sidebar completed completion card')
  card.listeners.get('click')[0]({ preventDefault() {}, stopPropagation() {} })
  assert.ok(harness.opened.includes('ws2'), 'clicking should open the completed session')
})

