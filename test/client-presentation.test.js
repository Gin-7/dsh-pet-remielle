import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cardHeightOf } from './helpers/card-height.mjs'
import { CLIENT_CORE, base, createHarness } from './helpers/client-harness.mjs'
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
