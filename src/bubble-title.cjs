/**
 * 气泡会话卡的共享呈现层：标题节流、文字宽度测量，以及审批 / 计划待审 /
 * 完成三种状态的文案、类名与牌叠布局。网页端与桌面端同一份实现——
 * 这层文案一改就必须两端同步，历史上的「计划待审」提示就因此漂移过一次。
 * Web: inlined by scripts/build-client.mjs ahead of client.core.js.
 * Desktop: served at /plugins/dsh-pet-remielle/bubble-title.js.
 *
 * 文件用 .cjs：包是 "type":"module"，与 pet-tip.cjs 同一套加载约定。
 */
;(function (global) {
  'use strict'

  // 气泡首行：同贴纸最多每 2s 换一次（0.3.1 锁定，避免 think/干活逐 chunk 翻文案）。
  var BUBBLE_TITLE_MS = 2000
  // 气泡框最小宽度：把标题在常见长度内的宽度变化"吸收"掉，避免方框频繁抖动。
  var BUBBLE_MIN_W = 277
  // 牌叠第二层（假背板）上移量：卡片高 91px（CSS 里写死）− 80px = 露出 11px；
  // 同步缩放模式下 stack 的 zoom = 角色大小，故 75% 档位露出约 8px。
  var STACK_LIFT_PX = 80
  var PLAN_MARKER = '计划待审'

  // 隐藏测量节点：复制真实渲染字体来精确测量文字宽度，避免 max-content 撑宽。
  // 模块级懒创建，mountPet 可多次挂载也不会重复往 body 追加节点。
  var __petMeasureEl = null
  function ensureMeasureEl() {
    if (!__petMeasureEl) {
      __petMeasureEl = document.createElement('span')
      __petMeasureEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;'
    }
    // 挂载与创建分开判断。旧实现是在 !__petMeasureEl 时无条件 append，body 缺失
    // 会响亮抛错；改成 `if (document.body)` 之后这次跳过变成永久的——元素已被
    // 缓存、下次不再重试挂载，measureTextW 的 offsetWidth 恒为 0，所有卡片宽度
    // 静默塌到 BUBBLE_MIN_W 且无任何报错。改成按 parentNode 补挂载：body 缺失
    // 时仍不抛错，但 body 一出现就会挂上。用 parentNode 而非 isConnected，
    // 是因为测试用的 DOM stub 没有 isConnected。
    if (document.body && __petMeasureEl.parentNode !== document.body) document.body.appendChild(__petMeasureEl)
    return __petMeasureEl
  }

  function measureTextW(srcEl, text) {
    var el = ensureMeasureEl()
    if (window.getComputedStyle && srcEl) {
      var cs = window.getComputedStyle(srcEl)
      el.style.fontFamily = cs.fontFamily
      el.style.fontSize = cs.fontSize
      el.style.fontWeight = cs.fontWeight
      el.style.letterSpacing = cs.letterSpacing
    }
    el.textContent = text || ''
    return el.offsetWidth || 0
  }

  // 两种方框（堆叠对话卡 / 余额气泡）共用同一宽度规则：取"最宽一行" + 内边距，
  // 下限 BUBBLE_MIN_W、上限 min(440, 视口-24)。返回含内边距的总宽。
  function bubbleRowWidth(textW) {
    var win = typeof window !== 'undefined' ? window : null
    var vw = Math.max(150, ((win && win.innerWidth) || 1280) - 24)
    return Math.min(440, vw, Math.max(BUBBLE_MIN_W, textW + 67))
  }

  function clearBubbleTitleTimer(el) {
    if (el && el.titleTimer) {
      window.clearTimeout(el.titleTimer)
      el.titleTimer = 0
    }
  }

  function commitBubbleTitle(el, text, mood) {
    clearBubbleTitleTimer(el)
    el.titleMood = mood
    el.titleChangedAt = Date.now()
    el.pendingTitle = ''
    el.pendingMood = ''
    if (text !== el.lastText) {
      el.lastText = text
      el.title.textContent = text
    }
  }

  // 贴纸变了，或 WAITING / ERROR / SUCCESS / attention / 完成卡 / 占位卡，
  // 立即更新；否则等 BUBBLE_TITLE_MS 到期再刷出等待中的 pending。
  function applyBubbleTitle(el, entry) {
    var text = entry.message || ''
    var mood = entry.mood || ''
    var state = entry.state || ''
    var immediate = !text
      || state === 'WAITING' || state === 'ERROR' || state === 'SUCCESS'
      || entry.attention === true
      || entry.completionNotification === true
      || entry.idlePlaceholder === true
    if (!el.titleChangedAt) {
      commitBubbleTitle(el, text, mood)
      return
    }
    var moodChanged = mood !== el.titleMood
    var elapsed = Date.now() - el.titleChangedAt
    if (immediate || moodChanged || elapsed >= BUBBLE_TITLE_MS) {
      commitBubbleTitle(el, text, mood)
      return
    }
    if (text === el.lastText) {
      el.pendingTitle = ''
      clearBubbleTitleTimer(el)
      return
    }
    el.pendingTitle = text
    el.pendingMood = mood
    if (!el.titleTimer) {
      el.titleTimer = window.setTimeout(function () {
        el.titleTimer = 0
        if (el.pendingTitle && el.pendingTitle !== el.lastText) {
          commitBubbleTitle(el, el.pendingTitle, el.pendingMood || el.titleMood)
        }
      }, Math.max(16, BUBBLE_TITLE_MS - elapsed))
    }
  }

  // 详情行归一化成单行文本：统一分隔点，display:flex 会让 text-overflow 失效，
  // 所以渲染时用 block。
  function detailShown(detail) {
    return String(detail || '').replace(/^\s*[·•]\s*/, '· ')
  }

  // 详情形如 `<项目> · 计划待审 · <摘要>`：提示里只取标记之后的摘要，
  // 避免项目名与「计划待审」在气泡提示里重复出现。
  function planSummaryOf(text) {
    var parts = String(text || '').split(/\s*·\s*/).filter(Boolean)
    var marker = parts.indexOf(PLAN_MARKER)
    return marker >= 0 ? parts.slice(marker + 1).join(' · ') : ''
  }

  function cardView(entry, derived) {
    derived = derived || {}
    return {
      detailShown: derived.detailShown || '',
      planSummary: derived.planSummary || '',
      approval: derived.approval === true,
      planReview: derived.planReview === true,
      completed: derived.completed === true,
      attention: derived.attention === true,
      idlePlaceholder: entry.idlePlaceholder === true,
      phase: entry.phase,
      summaryCount: entry.summaryCount,
    }
  }

  function classNameOf(view, index) {
    return 'rm2-pet-bubble'
      + (index === 0 ? ' top' : '')
      + (view.attention ? ' attention' : '')
      + (view.completed ? ' completed' : '')
      + (view.idlePlaceholder ? ' idle-placeholder' : '')
      + (view.summaryCount ? ' summary-backboard' : '')
  }

  // 审批卡悬停用第二行全文（工作区 · preview）：气泡宽度会 CSS 省略，自绘
  // 浮层才能读到请求内容；原生 title 不随 zoom 缩放已废弃；操作说明在勾号
  // aria-label 里。title 置空避免与自绘浮层双重提示。
  function tipTextOf(view) {
    if (view.idlePlaceholder) return ''
    if (view.approval) return view.detailShown || ''
    if (view.planReview) {
      return view.planSummary
        ? PLAN_MARKER + '：' + view.planSummary + '，点击打开同意执行/要求修改'
        : PLAN_MARKER + '，点击打开同意执行/要求修改'
    }
    if (view.completed) return '完成啦~ 点击查看结果哦'
    if (view.attention) return '轮到你啦，点击跳到这里处理呢'
    return '点击跳到这里看一下~'
  }

  // 假背板：固定高度空方框，仅展示 +N；点击由 activate 动态解析第二层。
  function applyBackboardChrome(el, entry, index) {
    el.detail.style.display = 'none'
    el.action.style.display = 'none'
    el.stackCount.textContent = entry.summaryCount ? '+' + entry.summaryCount : ''
    el.node.className = 'rm2-pet-bubble' + (entry.summaryCount ? ' summary-backboard' : '')
    el.node.setAttribute('aria-disabled', 'false')
    el.node.style.cursor = 'pointer'
    el.node.title = ''
    el.node.dataset.rm2Tip = entry.backboardTip || ''
    el.node.style.zIndex = String(100 - index)
    el.node.style.order = String(index)
    el.node.style.marginTop = '-' + STACK_LIFT_PX + 'px'
    el.node.style.width = '100%'
    el.node.style.opacity = String(Math.max(0.46, 0.82 - index * 0.1))
    el.node.style.display = 'block'
  }

  function applyCardChrome(el, entry, index, derived) {
    var view = cardView(entry, derived)
    el.stackCount.textContent = view.summaryCount ? '+' + view.summaryCount : ''
    el.node.className = classNameOf(view, index)
    el.node.setAttribute('aria-disabled', view.idlePlaceholder ? 'true' : 'false')
    // 光标策略：点击行为统一为整卡跳转后，工作卡同样可点，仅待机占位卡显示 default。
    el.node.style.cursor = view.idlePlaceholder ? 'default' : 'pointer'
    el.node.dataset.idlePlaceholder = view.idlePlaceholder ? 'true' : 'false'
    el.node.dataset.rm2Tip = tipTextOf(view)
    el.node.title = ''
    if (view.approval || view.planReview || (view.attention && !view.completed)) {
      var glyph = view.approval ? '✓' : (view.planReview || view.phase === 'ask') ? '?' : '!'
      if (el.action.textContent !== glyph) el.action.textContent = glyph
      el.action.setAttribute('aria-label', view.approval
        ? '允许一次，点击直接确认'
        : view.planReview ? '计划待审，点击打开审核' : '需要处理，点击跳转')
    } else if (el.action.firstChild !== el.brandImg) {
      el.action.textContent = ''
      el.action.appendChild(el.brandImg)
      el.action.setAttribute('aria-label', '蕾米埃尔桌宠')
    }
    // Deck layout: the front card is readable and background cards expose
    // only a shallow lower edge. Visual order is driven by the flex `order`
    // property (not DOM order), so cards keep their correct stacking even
    // when a session moves between the front and the backboard slot.
    el.node.style.zIndex = String(100 - index)
    el.node.style.order = String(index)
    el.node.style.marginTop = index === 0 ? '0px' : '-' + STACK_LIFT_PX + 'px'
    // All cards share one width: the widest visible card determines the deck,
    // so a short front card never floats above a much wider lower card.
    el.node.style.width = '100%'
    el.node.style.opacity = index === 0 ? '1' : String(Math.max(0.46, 0.82 - index * 0.1))
    el.node.style.display = 'block'
  }

  global.__rm2BubbleTitle = {
    BUBBLE_TITLE_MS: BUBBLE_TITLE_MS,
    BUBBLE_MIN_W: BUBBLE_MIN_W,
    STACK_LIFT_PX: STACK_LIFT_PX,
    ensureMeasureEl: ensureMeasureEl,
    measureTextW: measureTextW,
    bubbleRowWidth: bubbleRowWidth,
    clearBubbleTitleTimer: clearBubbleTitleTimer,
    commitBubbleTitle: commitBubbleTitle,
    applyBubbleTitle: applyBubbleTitle,
    detailShown: detailShown,
    planSummaryOf: planSummaryOf,
    classNameOf: classNameOf,
    tipTextOf: tipTextOf,
    applyBackboardChrome: applyBackboardChrome,
    applyCardChrome: applyCardChrome,
  }
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2BubbleTitle
  }
})(typeof window !== 'undefined' ? window : globalThis)
