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
  function orderSessions(sessions, currentSessionId) {
    return sessions.slice().sort(function (a, b) {
      var aTier = tierOf(a)
      var bTier = tierOf(b)
      if (aTier !== bTier) return bTier - aTier
      var aCur = a.sessionId === currentSessionId ? 1 : 0
      var bCur = b.sessionId === currentSessionId ? 1 : 0
      if (aCur !== bCur) return bCur - aCur
      var priority = stateRank(b.state) - stateRank(a.state)
      return priority || (b.updatedAt || 0) - (a.updatedAt || 0)
    })
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
