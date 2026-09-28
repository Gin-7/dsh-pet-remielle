import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base, createHarness } from './helpers/client-harness.mjs'
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
