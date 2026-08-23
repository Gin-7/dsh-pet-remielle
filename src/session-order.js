/**
 * Shared bubble-deck ordering used by both the desktop floating window
 * (src/pet-view.html, served by the host at /plugins/dsh-pet-remielle/session-order.js)
 * and the web client (src/client.core.js, inlined by scripts/build-client.mjs).
 *
 * Priority: approval > ask (ask_user_question) > completion > attention
 * > current session > state rank > updatedAt.
 */
;(function (global) {
  'use strict'

  function stateRank(state) {
    switch (state) {
      case 'WAITING': return 60
      case 'ERROR': return 50
      case 'SUCCESS': return 70
      case 'WORKING': return 30
      case 'THINKING': return 20
      case 'DISCONNECTED': return -1
      default: return 0
    }
  }
  function attentionOf(entry) {
    return entry.attention === true || entry.state === 'WAITING' || entry.state === 'ERROR'
  }
  function completionOf(entry) {
    return entry.completionNotification === true
  }
  function targetSessionOf(entry) {
    return entry.targetSessionId || entry.sessionId
  }
  function approvalOf(entry) {
    return entry.approval === true
  }
  function askOf(entry) {
    return entry.ask === true
  }
  function tierOf(entry) {
    if (approvalOf(entry)) return 5
    if (askOf(entry)) return 4
    if (completionOf(entry)) return 3
    if (attentionOf(entry)) return 2
    return 0
  }
  // 前 2 名滞回：两个会话完全同级（tier/current/stateRank 都相同）时，
  // 不因 updatedAt（每个流式 chunk 都会刷新）互换前两名的顺序——
  // 堆叠卡宽度由最上层决定，否则方框宽度会在两会话间高频抖动。
  // 记住上一次的前两名 id 序列；本次纯排序若恰好互为倒序则交换回来。
  // 审批/回答/完成/attention 等层级变化不受影响，照常上位。
  // ≥3 个同级会话的轮转由下方的第二层冻结（stabilizeDeckSecond）兜底。
  var lastTopIds = []
  function orderSessions(sessions, currentSessionId) {
    var ranked = sessions.slice().sort(function (a, b) {
      var aTier = tierOf(a)
      var bTier = tierOf(b)
      if (aTier !== bTier) return bTier - aTier
      var aCur = a.sessionId === currentSessionId ? 1 : 0
      var bCur = b.sessionId === currentSessionId ? 1 : 0
      if (aCur !== bCur) return bCur - aCur
      var priority = stateRank(b.state) - stateRank(a.state)
      return priority || (b.updatedAt || 0) - (a.updatedAt || 0)
    })
    if (lastTopIds.length === 2 && ranked.length >= 2) {
      var first = ranked[0]
      var second = ranked[1]
      if (String(targetSessionOf(second) || '') === lastTopIds[0]
        && String(targetSessionOf(first) || '') === lastTopIds[1]
        && sameRankKey(first, second, currentSessionId)) {
        ranked[0] = second
        ranked[1] = first
      }
    }
    // 第二层冻结后再记录展示用的前两名，保证滞回记住的顺序与实际渲染一致。
    stabilizeDeckSecond(ranked, currentSessionId)
    lastTopIds = [
      ranked.length > 0 ? String(targetSessionOf(ranked[0]) || '') : '',
      ranked.length > 1 ? String(targetSessionOf(ranked[1]) || '') : '',
    ]
    return ranked
  }
  function sameRankKey(a, b, currentSessionId) {
    return tierOf(a) === tierOf(b)
      && (a.sessionId === currentSessionId ? 1 : 0) === (b.sessionId === currentSessionId ? 1 : 0)
      && stateRank(a.state) === stateRank(b.state)
  }

  // 牌叠第二层冻结：首层未变时锁定第二层的「人选」，吸收同级会话间因
  // updatedAt 轮转造成的背景卡闪换。只锁选人不锁内容——冻结会话的
  // message/state 照常逐帧更新，信息不失效。仅三种情况重选：
  //   1) 首层变化（换人则整叠重排）；
  //   2) 冻结的会话已不在活跃列表（IDLE/DISCONNECTED/移除）；
  //   3) 层级更高的会话要上位到第 2（完成/attention/ask 等提醒卡必须
  //      及时露脸，不能被冻结压制）——同级轮转才冻结。
  var lastDeckTopId = ''
  var lastDeckSecondId = ''
  function deckRankKey(entry, currentSessionId) {
    return [tierOf(entry), entry.sessionId === currentSessionId ? 1 : 0, stateRank(entry.state)]
  }
  function rankKeyGreater(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i]
    }
    return false
  }
  function stabilizeDeckSecond(ordered, currentSessionId) {
    var topId = ordered.length > 0 ? String(targetSessionOf(ordered[0]) || '') : ''
    var freshSecondId = ordered.length > 1 ? String(targetSessionOf(ordered[1]) || '') : ''
    if (topId !== lastDeckTopId || !lastDeckSecondId || freshSecondId === lastDeckSecondId) {
      lastDeckTopId = topId
      lastDeckSecondId = freshSecondId
      return
    }
    var frozenIdx = -1
    for (var i = 1; i < ordered.length; i++) {
      if (String(targetSessionOf(ordered[i]) || '') === lastDeckSecondId) {
        frozenIdx = i
        break
      }
    }
    // 冻结会话已离场，或有层级更高的会话顶到第 2：放弃冻结，照常重选。
    if (frozenIdx < 1
      || rankKeyGreater(deckRankKey(ordered[1], currentSessionId), deckRankKey(ordered[frozenIdx], currentSessionId))) {
      lastDeckTopId = topId
      lastDeckSecondId = freshSecondId
      return
    }
    // 首层未变且无上位者：把冻结的会话提回第二层（若被挤到更后面）。
    if (frozenIdx > 1) {
      var displaced = ordered[1]
      ordered[1] = ordered[frozenIdx]
      ordered[frozenIdx] = displaced
    }
  }

  global.__rm2SessionOrder = {
    stateRank: stateRank,
    attentionOf: attentionOf,
    completionOf: completionOf,
    targetSessionOf: targetSessionOf,
    approvalOf: approvalOf,
    askOf: askOf,
    orderSessions: orderSessions,
  }
})(typeof window !== 'undefined' ? window : globalThis)
