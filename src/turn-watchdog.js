/**
 * Turn-hang watchdog (host half) — 兜底「强行终止会话后永久卡在分析阶段」。
 *
 * 用户在 GUI 强杀会话时，DSH agent-loop 补写的 turn/end 既可能没有落盘、
 * 也不向 live 事件总线广播（仅冷读日志时 repair 补 turn/end{kind:'interrupted'}），
 * 插件侧只见事件流戛然而止，reducer 永远停在 THINKING（如 step/start 的
 * 「分析阶段」）。本模块只做纯判定并保持可单测：记录每个会话最近一次事件的
 * 时刻，配合 reducer.states() 扫描仍在 THINKING/WORKING 且超过阈值无任何
 * 事件的会话；WAITING/ERROR/IDLE 不判悬挂——审批与等待用户回答可以合法
 * 等待很久。命中后的收尾（合成 turn/end{kind:'aborted'}）由 index.js 接线，
 * 复用 reducer 现有的 aborted 分支回 IDLE「已停止」，不新增公开方法。
 */

/** 正常流式期间 chunk 事件频繁，3 分钟无任何事件即视为 turn 悬挂。 */
export const TURN_STALL_THRESHOLD_MS = 180_000

/** 看门狗扫描周期（index.js 里 setInterval 的间隔）。 */
export const TURN_WATCHDOG_INTERVAL_MS = 30_000

function isStallProne(state) {
  return state === 'THINKING' || state === 'WORKING'
}

/**
 * 创建看门狗。`now` 可注入以便单测；`tick` 只读不写，
 * 命中列表由调用方收尾（合成 turn/end）后逐个调用 `end` 移除条目。
 */
export function createTurnWatchdog({ thresholdMs = TURN_STALL_THRESHOLD_MS, now = Date.now } = {}) {
  const lastSeenMs = new Map()
  return {
    /** 任一 session/event 到达时刷新该会话的活跃时间戳。 */
    feed(sessionId) {
      if (!sessionId) return
      lastSeenMs.set(String(sessionId), now())
    },
    /** turn/end 或 session/disposed 后回合已收尾，条目随之移除。 */
    end(sessionId) {
      if (!sessionId) return
      lastSeenMs.delete(String(sessionId))
    },
    /**
     * 扫描 reducer.states() 快照，返回超阈值且仍处 THINKING/WORKING 的
     * 会话 id 列表；未 feed 过或已 end 的会话天然不会命中。
     */
    tick(states, at = now()) {
      const stalled = []
      for (const entry of Array.isArray(states) ? states : []) {
        const sessionId = String(entry?.sessionId ?? '')
        const seen = lastSeenMs.get(sessionId)
        if (seen === undefined) continue
        if (!isStallProne(entry.state)) continue
        if (at - seen < thresholdMs) continue
        stalled.push(sessionId)
      }
      return stalled
    },
  }
}
