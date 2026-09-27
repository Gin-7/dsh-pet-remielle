import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cardHeightOf } from './helpers/card-height.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const CLIENT_CORE = new URL('../src/client.core.js', import.meta.url)
const STATUS_COPY = new URL('../src/status-copy.js', import.meta.url)

function createHarness(initialCurrent = 'other', autoSelect = true, snapshotItems = [], modernNavigation = false) {
  const elements = []
  const fetches = []
  const opened = []
  const timers = []
  let nextTimer = 0
  const styleWrites = []
  let current = initialCurrent
  let sessionListener
  let stream
  let visibilityState = 'visible'
  let focused = true
  let activePanelId = null
  const documentListeners = new Map()

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
  // 第二个审批面板：挂在**另一个**会话根（otherConversationFrame）下。
  //
  // 它必须带一个可点按钮。此前这里 querySelectorAll 恒返回 []，理由写的是
  // 「多面板时一个都不点，所以不需要按钮」——那个理由只对 document 级闸门成立，
  // 对会话作用域分支是致命的：根里没有可点按钮时，approvalPanels() 哪怕把别的
  // 会话根也收了进来，结果与只收当前根**完全一样**，于是
  // `if (sessionId && rootSession !== sessionId) continue` 这句删掉也测不出来
  // （变异验证：改成 if (false) continue，287 用例全绿）。按钮文案与正确那个
  // 区分开，点错根就会记成别的，断言随之报红。
  const otherAllowBtn = {
    textContent: '允许一次（other 会话）',
    innerText: '允许一次（other 会话）',
    getAttribute() { return '' },
    click() { allowClicks.push('allow-other') },
  }
  const otherApprovalPanel = {
    querySelectorAll(sel) {
      if (String(sel).includes('button')) return [otherAllowBtn]
      return []
    },
  }
  const documentListeners = new Map()
  const conversationFrame = {
    getAttribute(name) { return name === 'data-conversation-session' ? current : '' },
    querySelectorAll(sel) {
      if (sel === '[data-approval-key]') return [approvalPanel]
      return []
    },
  }
  const otherConversationFrame = {
    getAttribute(name) { return name === 'data-conversation-session' ? 'other-session' : '' },
    querySelectorAll(sel) {
      if (sel === '[data-approval-key]') return [otherApprovalPanel]
      return []
    },
  }
  // 默认模拟「页面带 [data-conversation-session] 作用域」的新宿主，approvalPanels
  // 走 scoped 分支。测试可用 setApprovalDom 切成「无作用域 + document 级面板」，
  // 以覆盖那条从未被走到的 panels.length === 1 闸门。
  let scopedRoots = [otherConversationFrame, conversationFrame]
  let loosePanels = [otherApprovalPanel, approvalPanel]
  const document = {
    body,
    head,
    documentElement: element('html'),
    get visibilityState() { return visibilityState },
    hasFocus: () => focused,
    createElement: (tag) => element(tag),
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) ?? []
      listeners.push(listener)
      documentListeners.set(name, listeners)
    },
    removeEventListener(name, listener) {
      documentListeners.set(name, (documentListeners.get(name) ?? []).filter((entry) => entry !== listener))
    },
    querySelector(sel) {
      return sel === '[data-conversation-session]' ? conversationFrame : sel === '[data-approval-key]' ? approvalPanel : null
    },
    querySelectorAll(sel) {
      if (sel === '[data-conversation-session]') return scopedRoots
      return sel === '[data-approval-key]' ? loosePanels : []
    },
  }
  class EventSourceStub {
    constructor() { stream = this }
    close() {}
  }
  const windowListeners = new Map()
  const beacons = []
  class BlobStub {
    constructor(parts) { this.parts = parts }
  }
  const navigatorStub = {
    // sendBeacon 记录请求体；测试可通过置空 sendBeacon 验证 keepalive fetch 兜底
    sendBeacon: (url, blob) => { beacons.push({ url, body: String(blob?.parts?.[0] ?? '') }); return true },
  }
  const window = {
    __ModuleLoader__: { load(entry) { window.factory = entry.factory } },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: { setItem() {} },
    addEventListener(name, listener) {
      const listeners = windowListeners.get(name) ?? []
      listeners.push(listener)
      windowListeners.set(name, listeners)
    },
    removeEventListener() {},
    setInterval() { return 1 },
    clearInterval() {},
    setTimeout(listener) {
      const id = ++nextTimer
      timers.push({ id, listener, cancelled: false })
      return id
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id)
      if (timer) timer.cancelled = true
    },
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
  new Function('window', 'document', 'EventSource', 'fetch', 'navigator', 'Blob', code)(window, document, EventSourceStub, fetch, navigatorStub, BlobStub)
  const moduleExports = window.factory((id) => {
    if (id === 'react') return { createElement: () => ({}), Fragment: Symbol('Fragment') }
    throw new Error(`unexpected require: ${id}`)
  })
  const slots = {
    inject(name, callback) { callback(); return () => {} },
    register() { return () => {} },
  }
  const openSession = (sessionId) => {
    opened.push(sessionId)
    if (autoSelect) {
      current = sessionId
      sessionListener?.()
    }
  }
  const sessions = {
    list: {
      getSnapshot: () => modernNavigation
        ? { byId: { ...snapshotItems, ...(current ? { [current]: { id: current, retainedBy: { mainView: 1 } } } : {}) } }
        : { current, byId: snapshotItems },
      subscribe(listener) { sessionListener = listener; return () => {} },
    },
    ...(modernNavigation ? {} : { open: openSession }),
  }
  const uiWorkspace = { openSession }
  const panelListeners = new Set()
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener) },
    },
  }
  moduleExports.apply({
    slots,
    sessions,
    get(name) {
      if (modernNavigation && name === 'uiWorkspace') return uiWorkspace
      if (name === 'layout') return layout
      return undefined
    },
    effect: (callback) => callback(),
  })

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
    for (const timer of queued) {
      if (!timer.cancelled) timer.listener()
    }
  }
  function dispatchWindowEvent(name) {
    for (const listener of windowListeners.get(name) ?? []) listener({})
  }
  function dispatchDocumentEvent(name) {
    for (const listener of documentListeners.get(name) ?? []) listener({})
  }
  function setVisibility(next) {
    visibilityState = next
    dispatchDocumentEvent('visibilitychange')
  }
  function setPanelActive(next) {
    activePanelId = next ? 'plugins' : null
    for (const listener of panelListeners) listener()
  }
  function setFocus(next) {
    focused = next
    dispatchWindowEvent(next ? 'focus' : 'blur')
  }
  return { allowClicks, beacons, card, click, dispatchDocumentEvent, dispatchWindowEvent, elements, fetches, navigator: navigatorStub, opened, panel: approvalPanel, otherPanel: otherApprovalPanel, select, send, setApprovalDom: (next) => { if (Array.isArray(next.scopedRoots)) scopedRoots = next.scopedRoots; if (Array.isArray(next.loosePanels)) loosePanels = next.loosePanels }, setFocus, setPanelActive, setVisibility, styleWrites, flushTitleTimers }
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

// 缩放与镜像最终写到 DOM 上的效果。
// 缩放口径的算术（同步/固定两模式）由 test/pet-tip.test.js 直接测 bubbleZoomOf
// 纯函数覆盖；此处只验 mountPet 确实把结果落到元素 style 上。镜像那段是本用例独有：
// 镜像只允许作用于贴纸，气泡容器不能跟着翻。
test('pet visuals: pet size, mirror and bubble zoom reach the DOM', () => {
  const sized = createHarness()
  sized.send({ ...base, scale: 0.75 })
  const bubble = sized.elements.find((node) => String(node.className).includes('rm2-pet-bubble') && !String(node.className).includes('rm2-pet-bubbles'))
  assert.equal(bubble.style.zoom, '0.75')
  assert.equal(sized.elements.find((node) => node.className === 'rm2-pet-bubbles').style.zoom, '0.75')

  // 镜像只作用于贴纸，不能把气泡容器一起翻过来
  const mirrored = createHarness()
  mirrored.send({ ...base, mirror: true })
  assert.equal(mirrored.elements.find((node) => node.tag === 'img').style.transform, 'scaleX(-1)')
  assert.equal(mirrored.elements.find((node) => node.className === 'rm2-pet-bubbles').style.transform, undefined)
  mirrored.send({ ...base, mirror: false })
  assert.equal(mirrored.elements.find((node) => node.tag === 'img').style.transform, '')
})

test('multi-session deck renders an inert backboard with a dynamic click target', () => {
  const harness = createHarness('first')
  const sessions = [
    { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: '正在继续处理任务呢', detail: '.dsh · 调用工具', updatedAt: 3 },
    { sessionId: 'second', state: 'THINKING', phase: 'think', message: '让我想想最优解是什么', detail: '.dsh · 分析阶段', updatedAt: 2 },
    { sessionId: 'third', state: 'THINKING', phase: 'think', message: '正在检查剩余问题', detail: '.dsh · 检查阶段', updatedAt: 1 },
  ]
  const hasCard = (t) => harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t)
  harness.send({ ...base, sessions })
  // 首层刷新不影响背板：+N 保持，第二层一律不渲染第 2 名的文字/图标。
  harness.send({ ...base, sessions: [{ ...sessions[0], message: '正在读取文件' }, sessions[1], sessions[2]] })

  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard, 'backboard card should exist')
  const writes = harness.styleWrites.filter(({ element, key }) => element === backboard && key === 'marginTop')
  assert.ok(writes.length >= 1)
  const lift = Math.abs(Number.parseInt(writes.at(-1).value, 10))
  // 卡高真值在 CSS 里（stub 的 offsetHeight 只是近似值），所以从源文件解析：
  // 卡高变了而上移量没跟着变，背板就会露太多或被完全盖住——这是布局不变量，
  // 不是纯派生的样式断言。解析函数已抽到 test/helpers/card-height.mjs，两端共用。
  const cardHeight = cardHeightOf(readFileSync(CLIENT_CORE, 'utf8'))
  assert.equal(lift, 80, '第二层应按共享常量 STACK_LIFT_PX 上移（常量唯一性由 desktop-window 测）')
  assert.equal(cardHeight, 91)
  assert.ok(
    Math.abs((cardHeight - lift) * 0.75 - 8) <= 0.5,
    `75% 档位露出应约 8px，实际 ${(cardHeight - lift) * 0.75}px`,
  )
  assert.equal(backboard.children.find((node) => node.className === 'rm2-pet-bubble-stack-count').textContent, '+2')
  assert.equal(hasCard('让我想想最优解是什么'), false)
  assert.equal(hasCard('正在检查剩余问题'), false)
  assert.equal(backboard.dataset.rm2Tip, '点击跳到这里看一下~')
  harness.send({
    ...base,
    sessions: [
      sessions[0],
      { ...sessions[1], project: 'dsh-pet-remielle', title: '审查提示框颜色与溢出问题' },
      sessions[2],
    ],
  })
  harness.flushTitleTimers()
  assert.equal(backboard.dataset.rm2Tip, '点击去看 dsh-pet-remielle · 审查提示框颜色与溢出问题 哦~')
  // 点击背板：按当帧排序动态解析第 2 名（second）并跳转。
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second'])
  // 同级轮转（third 刷出更大 updatedAt）后，同一张背板的跳转目标跟着排序走。
  // 先把当前会话复位回 first：上一次跳转已让 second 成为当前会话并占据首层。
  harness.select('first')
  harness.send({ ...base, sessions: [sessions[0], sessions[1], { ...sessions[2], updatedAt: 5 }] })
  harness.flushTitleTimers()
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second', 'third'])
})

test('modern workspace navigation promotes the clicked lower bubble', () => {
  const harness = createHarness('first', true, {}, true)
  const sessions = [
    { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: '首个对话', detail: '.dsh · 处理中', updatedAt: 3 },
    { sessionId: 'second', state: 'WORKING', phase: 'tool-call', message: '第二个对话', detail: '.dsh · 处理中', updatedAt: 2 },
  ]
  harness.send({ ...base, sessions })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard)
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second'])
  assert.match(harness.card('第二个对话').className, /\btop\b/)
})

// 背板提示：点击目标与文案必须成对更新，且优先用宿主会话列表补全标题。
test('backboard tip stays paired with its click target', () => {
  const harness = createHarness('first')
  const mk = (id, updatedAt, title) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, title, updatedAt })
  harness.send({ ...base, sessions: [mk('first', 30, '首个对话'), mk('second', 20, '第二个对话')] })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard)
  assert.equal(backboard.dataset.rm2Tip, '点击去看 第二个对话 哦~')

  harness.send({ ...base, sessions: [mk('first', 10, '首个对话'), mk('third', 40, '第三个对话')] })
  // 新排序先进入防抖，背板提示与点击目标仍保持上一对。
  assert.equal(backboard.dataset.rm2Tip, '点击去看 第二个对话 哦~')
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second'])

  harness.flushTitleTimers()
  assert.equal(backboard.dataset.rm2Tip, '点击去看 第三个对话 哦~')
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second', 'third'])
})

test('backboard tip fills conversation title from sessions.list when snapshot omits it', () => {
  const harness = createHarness('first', true, {
    second: { id: 'second', title: '审查提示框颜色与溢出问题', cwd: 'C:\\work\\dsh-pet-remielle' },
  })
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: '正在继续处理任务呢', detail: '.dsh · 调用工具', updatedAt: 3, project: 'other' },
      { sessionId: 'second', state: 'THINKING', phase: 'think', message: '让我想想最优解是什么', detail: '.dsh · 分析阶段', updatedAt: 2, project: 'dsh-pet-remielle' },
    ],
  })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard, 'backboard card should exist')
  assert.equal(backboard.dataset.rm2Tip, '点击去看 dsh-pet-remielle · 审查提示框颜色与溢出问题 哦~')
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

test('approval bubble tooltip shows the second-line request detail', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'approval',
      state: 'WAITING',
      phase: 'approval',
      message: '需要你确认一下哦',
      detail: '  • 读取工作区文件并执行安装',
      approval: true,
      attention: true,
    }],
  })
  // 悬停提示改自绘浮层：文本在 dataset.rm2Tip（与第二行同一套行首项目符号
  // 规范化），原生 title 置空避免双重提示
  const approvalCard = harness.card('需要你确认一下哦')
  assert.equal(approvalCard.dataset.rm2Tip, '· 读取工作区文件并执行安装')
  assert.equal(approvalCard.title, '')
})

test('web pet tip follows dark theme and stays inside the viewport', () => {
  // 接线护栏：网页端用的是共享的 pet-tip 模块，深色样式挂在宿主主题属性下。
  // 布局算法本身由 test/pet-tip.test.js 的 layoutPetTip 覆盖，这里只看两端接上了。
  const core = readFileSync(CLIENT_CORE, 'utf8')
  assert.match(core, /body\[data-ds-dark-theme\] \.rm2-pet-tip/)
  assert.match(core, /__tip\.layoutPetTip\(petTip, anchor/)
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{
      sessionId: 's1',
      state: 'WORKING',
      phase: 'output',
      message: '正在输出回答哦',
      detail: 'dsh-pet-remielle · 输出阶段',
    }],
  })
  const card = harness.card('正在输出回答哦')
  card.getBoundingClientRect = () => ({ left: 1100, top: 8, width: 180, height: 68, right: 1280, bottom: 76 })
  const enter = card.listeners.get('mouseenter')?.[0]
  assert.ok(enter, 'missing mouseenter listener')
  enter()
  const tip = harness.elements.find((node) => node.className === 'rm2-pet-tip')
  assert.ok(tip, 'missing .rm2-pet-tip')
  assert.equal(tip.textContent, '点击跳到这里看一下~')
  // 视口钳位本身由 test/pet-tip.test.js 直接对 layoutPetTip 断言（显式注入
  // offsetWidth/offsetHeight，覆盖 24px 光晕、maxWidth 420 与四种换行场景）。
  // 这里用 stub 的 offsetWidth(=字数×12) / offsetHeight(=68) 再算一遍，得到的是
  // stub 自己的数字而非真实布局——同样量级的检查已在那边做过且更强，故不重复。
  // 此处只留一条与 DOM 接线直接相关的：提示浮层拿到的是自绘节点且短口吻不拆字。
  assert.equal(tip.style.whiteSpace, 'nowrap')
})

test('pet dock grabbing cursor survives snapshot refresh until pointerup', () => {
  const harness = createHarness()
  harness.send({ ...base, sessions: [] })
  const dock = harness.elements.find((node) => String(node.style.cssText || '').includes('cursor:grab'))
  assert.ok(dock, 'missing pet dock')
  const down = dock.listeners.get('pointerdown')?.[0]
  assert.ok(down, 'missing dock pointerdown')
  down({ button: 0, clientX: 20, clientY: 20, preventDefault() {} })
  assert.equal(dock.style.cursor, 'grabbing')
  harness.send({ ...base, mood: '01', sessions: [] })
  assert.equal(dock.style.cursor, 'grabbing', 'snapshot must not reset grabbing while held')
  harness.dispatchWindowEvent('pointerup')
  assert.equal(dock.style.cursor, 'grab')
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
  harness.click(questionAction)
  assert.deepEqual(harness.opened, ['question'])
  // ERROR 卡（stateRank 低于 WAITING）排第二，落入假背板：无真卡无图标，
  // 点击背板动态跳到它。
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === '需要处理'), false)
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['question', 'error'])
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


  background.send({ ...base, sessions: [error] })
  const errorCard = background.card('任务好像遇到问题了哦')
  assert.ok(errorCard.className.includes('attention'))
  background.select('err')
  // 节点可能仍留在 harness.elements 里，但已从牌叠父节点卸下。
  assert.equal(errorCard.parentNode.children.includes(errorCard), false)

  const waiting = createHarness('ask')
  waiting.send({
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
  assert.ok(waiting.card('需要你确认一下哦').className.includes('attention'), '提问卡必须留在首位')
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

test('deck order puts approval above ask above completion', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'done', state: 'SUCCESS', message: '任务已完成', detail: '结果', completed: true, completionNotification: true, updatedAt: 3 },
      { sessionId: 'ask-1', state: 'WAITING', phase: 'ask', message: '等待回答', detail: '问题', ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'plan-1', state: 'WAITING', phase: 'plan-review', message: '计划待审', detail: '计划待审 · 计划', planReview: true, attention: true, updatedAt: 1 },
      { sessionId: 'appr-1', state: 'WAITING', phase: 'approval', message: '等待确认', detail: '审批', approval: true, attention: true, updatedAt: 1 },
    ],
  })
  const titles = harness.elements
    .filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent)
    .map((node) => node.textContent)
  // 牌叠只渲染首层真卡：approval 居首，plan/ask/completion 都收进假背板的 +N。
  assert.deepEqual(titles, ['等待确认'])
})

test('plan review outranks ask and completion when no tool approval is pending', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'done', state: 'SUCCESS', message: '任务已完成', detail: '结果', completed: true, completionNotification: true, updatedAt: 3 },
      { sessionId: 'ask-1', state: 'WAITING', phase: 'ask', message: '等待回答', detail: '问题', ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'plan-1', state: 'WAITING', phase: 'plan-review', message: '计划待审', detail: '计划待审 · 计划', planReview: true, attention: true, updatedAt: 1 },
    ],
  })
  const titles = harness.elements
    .filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent)
    .map((node) => node.textContent)
  assert.deepEqual(titles, ['计划待审'])
})

test('same-tier streaming sessions keep the top card stable (no width flapping)', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  // 视觉顺序由 style.order 决定（DOM 顺序不变），因此断言卡片节点的 order 值。
  const lastOrder = (node) => {
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  const titleCount = (t) => harness.elements.filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t).length
  harness.send({ ...base, sessions: [mk('w1', 10), mk('w2', 5)] })
  const topNode = harness.card('w1 的消息')
  assert.equal(lastOrder(topNode), 0, 'w1 starts on top')
  // w2 的 chunk 刷出更大的 updatedAt，但两者完全同级：顶层保持 w1，宽度不再抖动。
  harness.send({ ...base, sessions: [mk('w1', 10), mk('w2', 20)] })
  harness.send({ ...base, sessions: [mk('w1', 40), mk('w2', 30)] })
  // 滞回失效的话 w1 会掉到第二层并被销毁重建（title 节点出现两份）。
  assert.equal(titleCount('w1 的消息'), 1, 'top card is never unmounted by same-tier rotation')
  assert.equal(lastOrder(topNode), 0, 'hysteresis keeps w1 on top')
  // 层级变化（approval）不受滞回影响，照常上位；w1 让出顶层。
  harness.send({
    ...base,
    sessions: [mk('w1', 50), { sessionId: 'w2', state: 'WAITING', phase: 'approval', message: '等待确认', approval: true, attention: true, updatedAt: 60 }],
  })
  assert.equal(lastOrder(harness.card('等待确认')), 0, 'tier change overrides hysteresis')
})

test('deck keeps one real top card plus the backboard across three streaming sessions', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  const lastOrder = (node) => {
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  const titleCount = (t) => harness.elements.filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t).length
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50), mk('w3', 10)] })
  assert.equal(lastOrder(harness.card('w1 的消息')), 0, 'w1 leads initially')
  // 三个 WORKING 会话在场，前两名轮流刷新 updatedAt：滞回让 w1 始终守在顶层。
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 150), mk('w3', 10)] })
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 150), mk('w3', 10)] })
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 300), mk('w3', 10)] })
  assert.equal(lastOrder(harness.card('w1 的消息')), 0, 'top-2 hysteresis keeps w1 on top')
  assert.equal(titleCount('w1 的消息'), 1, 'rotation never unmounts and rebuilds the top card')
  // 第三名刷出更大的 updatedAt：新会话照常接管顶层（滞回只锁互为倒序的相邻对）。
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 300), mk('w3', 400)] })
  assert.equal(lastOrder(harness.card('w3 的消息')), 0, 'a third same-tier session may take over the top')
  // 随后新的前两名轮流刷新，顶层同样保持稳定（w1 已收进背板的 +N）。
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 500), mk('w3', 400)] })
  assert.equal(lastOrder(harness.card('w3 的消息')), 0, 'new top stays stable too')
})

test('approval tier change still surfaces above a stabilized deck', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} 的消息`, detail: '', updatedAt })
  const lastOrder = (node) => {
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50)] })
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 150)] })
  assert.equal(lastOrder(harness.card('w1 的消息')), 0, 'deck is stabilized by top-2 hysteresis')
  // 层级变化（WAITING+approval）不受滞回影响，照常上位到第一名。
  harness.send({
    ...base,
    sessions: [
      mk('w1', 100),
      { sessionId: 'appr-1', state: 'WAITING', phase: 'approval', message: '等待确认', approval: true, attention: true, updatedAt: 60 },
    ],
  })
  assert.equal(lastOrder(harness.card('等待确认')), 0, 'tier change overrides top-2 hysteresis')
})

test('single-session deck renders no backboard', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{ sessionId: 'only', state: 'WORKING', phase: 'tool-call', message: '独自工作中', detail: '', updatedAt: 1 }],
  })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.equal(backboard, undefined, 'no backboard for a single session')
  harness.click(harness.card('独自工作中'))
  assert.deepEqual(harness.opened, ['only'])
})

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

