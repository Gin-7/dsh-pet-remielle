/**
 * Pure, testable state machine that turns DSH session events into pet
 * messages (state / pulse / task). The shape is:
 *
 *  - every rendered message carries a `mood` (remielle sticker id), derived
 *    from state + phase (THINKING -> '04', tools -> '02', ...);
 *  - assistant output streaming is tracked as a THINKING phase 'streaming'
 *    so the "绘制中" sticker shows while text is being written;
 *  - SUCCESS / ERROR are transient PULSE overlays with a TTL (the browser
 *    client shows them until the deadline, then falls back to durable state).
 */

import {
  PetMessageKind,
  PetState,
  createMessage,
} from './protocol.js'
import {
  activityCopy,
  activityStage,
  statusCopy,
  taskCopy,
} from './status-copy.js'

const statePriority = Object.freeze({
  [PetState.WAITING]: 60,
  [PetState.ERROR]: 50,
  [PetState.WORKING]: 30,
  [PetState.THINKING]: 20,
  [PetState.IDLE]: 0,
  [PetState.DISCONNECTED]: -1,
})

function toolActivity(name) {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value)) return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value)) return 'editing'
  if (/test|check|lint|build|verify/.test(value)) return 'testing'
  if (/shell|bash|exec|command|terminal|powershell/.test(value)) return 'commanding'
  return 'using-tool'
}

function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown-session')
}

function isSubagent(session) {
  return session?.header?.origin === 'subagent'
    || Number(session?.header?.delegationDepth ?? 0) > 0
}

function cleanProjectName(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const pathParts = text.split(/[\\/]/u).filter(Boolean)
  const candidate = pathParts.length > 1 ? pathParts.at(-1) : text
  return candidate.replace(/\s+/gu, ' ').slice(0, 40) || undefined
}

function projectNameOf(session, event) {
  const candidates = [
    session?.header?.title,
    session?.header?.name,
    session?.title,
    session?.name,
    session?.header?.cwd,
    session?.cwd,
    session?.context?.cwd,
    event?.data?.projectName,
    event?.data?.cwd,
  ]
  return candidates.map(cleanProjectName).find(Boolean)
}

function progressOf(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const completed = todos.filter((todo) => ['completed', 'complete', 'done'].includes(todo?.status)).length
  const currentIndex = todos.findIndex((todo) => todo?.status === 'in_progress')
  return {
    completed,
    total: todos.length,
    current: currentIndex >= 0 ? currentIndex + 1 : undefined,
  }
}

function clipLine(text, max = 80) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw ?? '')) } catch { return null }
}

function approvalReason(reason) {
  const value = String(reason ?? '').replace(/\s+/gu, ' ').trim()
  if (!value) return ''
  const match = value.match(/^escalate sandbox to \S+:\s*(.+)$/iu)
  return match ? match[1].trim() : value
}

function approvalContent(toolName, reason, argsRaw) {
  const why = clipLine(approvalReason(reason))
  if (why) return why
  const args = parseToolArgs(argsRaw)
  if (args && typeof args.justification === 'string' && args.justification.trim()) return clipLine(args.justification)
  if (args && typeof args.command === 'string' && args.command.trim()) return clipLine(args.command)
  if (args && typeof args.description === 'string' && args.description.trim()) return clipLine(args.description)
  return clipLine(toolName) || '等待确认'
}

function detailFor(record, stage = record.payload.stage) {
  const approval = record.waits?.find((wait) => wait.kind === 'approval')
  if (approval) {
    const parts = []
    if (record.project) parts.push(record.project)
    parts.push(approval.payload.preview || approval.payload.toolName || '等待确认')
    return parts.join(' · ')
  }
  const parts = []
  if (record.project) parts.push(record.project)
  if (record.progress?.total) parts.push(`已完成 ${record.progress.completed}/${record.progress.total} 步`)
  if (record.task) parts.push(record.task)
  else if (stage) parts.push(stage)
  return parts.join(' · ') || stage || 'DSH 任务'
}

/** Remielle sticker for the current durable state + phase. */
export function moodFor(state, phase) {
  // 流式输出（正在写回复）→ 绘制中；其它思考 → 思考中
  if (state === PetState.THINKING && phase === 'streaming') return '01'
  if (state === PetState.THINKING) return '04'
  if (state === PetState.WAITING) return '05'
  if (state === PetState.IDLE) return '06'
  if (state === PetState.DISCONNECTED) return '06'
  // WORKING (tool busy) and ERROR both show as "摸鱼中".
  return '02'
}

export class PetReducer {
  constructor({ includeSubagents = false } = {}) {
    this.includeSubagents = includeSubagents
    this.sessions = new Map()
    this.clock = 0
    this.selectedSessionId = undefined
    this.outputSignature = undefined
  }

  setIncludeSubagents(value) {
    const includeSubagents = value === true
    if (includeSubagents === this.includeSubagents) return []
    this.includeSubagents = includeSubagents
    if (!includeSubagents) {
      for (const [sessionId, record] of this.sessions) {
        if (record.subagent) this.sessions.delete(sessionId)
      }
    }
    return this.#render()
  }

  handle(session, event) {
    if (!event || typeof event.type !== 'string') return []
    const subagent = isSubagent(session)
    if (!this.includeSubagents && subagent) return []

    const sessionId = sessionIdOf(session)
    const record = this.#record(sessionId)
    record.subagent = subagent
    record.lastSeq = Number(event.seq ?? record.lastSeq)
    record.project = projectNameOf(session, event) ?? record.project

    switch (event.type) {
      case 'turn/start':
        record.turnActive = true
        record.openTools.clear()
        record.askTools.clear()
        record.waits.length = 0
        record.savedState = undefined
        record.savedPayload = undefined
        record.task = undefined
        record.progress = undefined
        this.#update(record, PetState.THINKING, {
          phase: 'turn-start',
          stage: '准备阶段',
          message: statusCopy('preparing', event.seq),
        })
        return this.#render()

      case 'step/start':
        if (!record.turnActive || record.openTools.size > 0) return []
        this.#update(record, PetState.THINKING, {
          phase: 'step-start',
          stage: '分析阶段',
          message: statusCopy('thinking', event.seq),
        })
        return this.#render()

      case 'assistant/chunk': {
        if (!record.turnActive || record.openTools.size > 0) return []
        const chunkType = String(event.data?.chunk?.type ?? 'text-delta')
        if (chunkType === 'reasoning-delta') {
          // 思考块（推理中）→ 思考中 04
          this.#update(record, PetState.THINKING, {
            phase: 'think',
            stage: '推理阶段',
            message: statusCopy('thinking', event.seq),
          })
        } else if (chunkType === 'tool-call-delta') {
          // 工具调用流式帧 → 摸鱼中 02（随后的 tool/call 事件继续/确认）
          this.#update(record, PetState.WORKING, {
            phase: 'tool-call',
            stage: '调用工具',
            message: statusCopy('working', event.seq),
          })
        } else {
          // text-delta（默认）：真正输出 → 绘制中 01
          this.#update(record, PetState.THINKING, {
            phase: 'streaming',
            stage: '输出阶段',
            message: statusCopy('streaming', event.seq),
          })
        }
        return this.#render()
      }

      case 'assistant/message':
        if (!record.turnActive || record.openTools.size > 0) return []
        this.#update(record, PetState.THINKING, {
          phase: 'streaming',
          stage: '输出阶段',
          message: statusCopy('streaming', event.seq),
        })
        return this.#render()

      case 'tool/call': {
        const callId = String(event.data?.callId ?? `seq-${String(event.seq ?? 'unknown')}`)
        const name = String(event.data?.name ?? 'tool')
        record.openTools.set(callId, { name, args: event.data?.arguments })
        // Asking the human a question is a "waiting" state, not "摸鱼中".
        if (name === 'ask_user_question') {
          record.askTools.add(callId)
          this.#enterWait(record, {
            kind: 'ask',
            id: callId,
            payload: {
              phase: 'ask',
              stage: '等待回答',
              toolName: name,
              message: statusCopy('waiting', event.seq),
            },
          })
          return this.#render()
        }
        const activity = toolActivity(name)
        this.#update(record, PetState.WORKING, {
          phase: 'tool-call',
          activity,
          stage: activityStage(activity),
          toolName: name,
          message: activityCopy(activity, event.seq),
        })
        return this.#render()
      }

      case 'tool/result':
        return this.#toolResult(record, event)

      case 'todo/write':
        return this.#todo(record, event)

      case 'approval/asked': {
        // Waiting for the human to confirm/deny a tool approval.
        const toolName = String(event.data?.toolName ?? 'tool')
        const approvalId = String(event.data?.id ?? `seq-${String(event.seq ?? 'unknown')}`)
        const callId = event.data?.callId ? String(event.data.callId) : ''
        let argsRaw
        if (callId && record.openTools.has(callId)) argsRaw = record.openTools.get(callId).args
        else {
          for (const entry of record.openTools.values()) {
            if (entry.name === toolName) { argsRaw = entry.args; break }
          }
        }
        this.#enterWait(record, {
          kind: 'approval',
          id: approvalId,
          payload: {
            phase: 'approval',
            stage: '等待确认',
            toolName,
            preview: approvalContent(toolName, event.data?.reason, argsRaw),
            message: statusCopy('waiting', event.seq),
          },
        })
        return this.#render()
      }

      case 'approval/decided':
        // Approval resolved: restore whatever the pet was doing underneath.
        this.#exitWait(record, 'approval', String(event.data?.id ?? ''))
        return this.#render()

      case 'turn/end':
        return this.#turnEnd(record, event)

      default:
        return []
    }
  }

  disposeSession(session) {
    const sessionId = sessionIdOf(session)
    const existed = this.sessions.delete(sessionId)
    if (!existed) return []
    return this.#render()
  }

  /**
   * One renderable state per active or attention-needing session. IDLE and
   * DISCONNECTED records remain internally tracked for primary-state fallback,
   * but are omitted from the card deck so completed/stopped turns disappear.
   * A SUCCESS pulse is emitted for every completed turn; the Host persists
   * its reminder independently until the conversation is opened.
   */
  states() {
    const out = []
    for (const record of this.sessions.values()) {
      if ([PetState.IDLE, PetState.DISCONNECTED].includes(record.state)) continue
      out.push({
        sessionId: record.id,
        state: record.state,
        mood: moodFor(record.state, record.payload.phase),
        phase: record.payload.phase ?? '',
        message: record.payload.message ?? '',
        detail: detailFor(record),
        project: record.project,
        task: record.task,
        progress: record.progress,
        // Only an unresolved approval wait may render the actionable ✓.
        // Generic WAITING (ask_user_question) and ERROR must not inherit it.
        approval: record.waits.some((wait) => wait.kind === 'approval'),
        // 等待用户回答（ask_user_question）单独暴露，供气泡排序置于审批之下、完成之上。
        ask: record.waits.some((wait) => wait.kind === 'ask'),
        attention: record.state === PetState.WAITING || record.state === PetState.ERROR,
        updatedAt: record.updatedAt,
      })
    }
    out.sort((left, right) => {
      const attention = Number(right.attention) - Number(left.attention)
      if (attention !== 0) return attention
      const priority = (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0)
      return priority || right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId)
    })
    return out
  }

  #toolResult(record, event) {
    const callId = String(event.data?.message?.source?.callId
      ?? event.data?.message?.toolCallId
      ?? event.data?.message?.callId
      ?? event.data?.callId
      ?? '')
    const knownTool = callId ? record.openTools.has(callId) || record.askTools.has(callId) : false
    if (!record.turnActive && !knownTool) return []
    const wasAsk = callId ? record.askTools.has(callId) : false
    if (wasAsk) record.askTools.delete(callId)
    if (callId) record.openTools.delete(callId)
    // An answered question ends the waiting state; restore what the pet was
    // doing underneath (e.g. THINKING while streaming the next answer).
    if (wasAsk) {
      this.#exitWait(record, 'ask', callId)
      return this.#render()
    }
    const next = record.openTools.size > 0 ? PetState.WORKING : PetState.THINKING
    const nextPayload = {
      phase: 'tool-result',
      activity: next === PetState.WORKING
        ? toolActivity(record.openTools.values().next().value?.name)
        : undefined,
      stage: next === PetState.WORKING
        ? activityStage(toolActivity(record.openTools.values().next().value?.name))
        : '整理阶段',
      message: next === PetState.WORKING
        ? activityCopy(toolActivity(record.openTools.values().next().value?.name), event.seq)
        : statusCopy('result', event.seq),
    }
    this.#update(record, next, nextPayload)
    if (!event.data?.error) return this.#render()

    // 与成功路径对称：后台工具报错也发脉冲提示，不再被全局的
    // WAITING/ERROR 锚点整体吞掉（锚点状态由脉冲的 resume* 字段恢复）
    const selection = this.#select()
    const pulse = createMessage(PetMessageKind.PULSE, {
      sessionId: record.id,
      sourceSeq: event.seq,
      state: PetState.ERROR,
      mood: moodFor(PetState.ERROR, 'tool-error'),
      ttlMs: 3000,
      resumeState: selection.record.state,
      resumeMood: moodFor(selection.record.state, selection.record.payload.phase),
      resumeMessage: selection.record.payload.message,
      resumeDetail: detailFor(selection.record),
      message: statusCopy('toolError', event.seq),
      detail: detailFor(record),
      errorCode: event.data.error.code,
    })
    if ([PetState.WAITING, PetState.ERROR].includes(selection.record.state)) {
      return [...this.#render(selection), pulse]
    }
    this.#remember(selection)
    return [pulse]
  }

  #todo(record, event) {
    const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
    const current = todos.find((todo) => todo?.status === 'in_progress')
      ?? todos.find((todo) => todo?.status === 'pending')
    const progress = progressOf(todos)
    if (!current?.content && !progress) return []
    const nextTask = current?.content ? String(current.content) : record.task
    const unchanged = nextTask === record.task
      && progress?.completed === record.progress?.completed
      && progress?.total === record.progress?.total
    if (unchanged) return []
    record.task = nextTask
    record.progress = progress
    record.updatedAt = ++this.clock
    const selection = this.#select()
    if (selection.record.id !== record.id) return this.#render(selection)
    return [createMessage(PetMessageKind.TASK, {
      sessionId: record.id,
      sourceSeq: event.seq,
      task: record.task,
      progress: record.progress,
      project: record.project,
      message: taskCopy(record.task),
      detail: detailFor(record, '执行阶段'),
    })]
  }

  #turnEnd(record, event) {
    record.turnActive = false
    record.openTools.clear()
    record.askTools.clear()
    record.waits.length = 0
    record.savedState = undefined
    record.savedPayload = undefined
    const kind = String(event.data?.reason?.kind ?? 'completed')

    if (kind === 'blocked') {
      this.#update(record, PetState.WAITING, {
        phase: 'turn-end',
        stage: '等待确认',
        message: statusCopy('waiting', event.seq),
      })
      return this.#render()
    }

    if (kind === 'aborted') {
      this.#update(record, PetState.IDLE, {
        phase: 'turn-end',
        stage: '已停止',
        message: statusCopy('stopped', event.seq),
      })
      return this.#render()
    }

    if (kind === 'disposed') {
      // 会话被销毁/回收（dsh-agent-loop 以 cancel({kind:'disposed'}) 终止轮次）：
      // 静默回待机，不产出误导性“需要处理”错误卡；紧随其后的 session/disposed
      // 会移除记录，这里只负责事件窗口内的过渡状态。
      this.#update(record, PetState.IDLE, {
        phase: 'turn-end',
        stage: '已停止',
        message: statusCopy('stopped', event.seq),
      })
      return this.#render()
    }

    if (kind !== 'completed') {
      this.#update(record, PetState.ERROR, {
        phase: 'turn-end',
        stage: '需要处理',
        reasonKind: kind,
        message: kind === 'max-tokens'
          ? statusCopy('limit', event.seq)
          : statusCopy('error', event.seq),
      })
      return this.#render()
    }

    this.#update(record, PetState.IDLE, {
      phase: 'turn-end',
      stage: '已完成',
      message: statusCopy('idle', event.seq),
    })
    const selection = this.#select()
    const pulse = createMessage(PetMessageKind.PULSE, {
      sessionId: record.id,
      sourceSeq: event.seq,
      state: PetState.SUCCESS,
      mood: '03',
      ttlMs: 5000,
      resumeState: selection.record.state,
      resumeMood: moodFor(selection.record.state, selection.record.payload.phase),
      resumeMessage: selection.record.payload.message,
      resumeDetail: detailFor(selection.record),
      phase: 'turn-end',
      message: statusCopy('success', event.seq),
      detail: detailFor(record, '本轮已完成'),
    })
    if ([PetState.WAITING, PetState.ERROR].includes(selection.record.state)) {
      return [...this.#render(selection), pulse]
    }
    this.#remember(selection)
    return [pulse]
  }

  #record(sessionId) {
    let record = this.sessions.get(sessionId)
    if (record) return record
    record = {
      id: sessionId,
      state: PetState.IDLE,
      payload: { phase: 'session-created', message: '蕾米埃尔待命中' },
      turnActive: false,
      openTools: new Map(),
      askTools: new Set(),
      waits: [],
      savedState: undefined,
      savedPayload: undefined,
      task: undefined,
      progress: undefined,
      project: undefined,
      subagent: false,
      lastSeq: -1,
      updatedAt: ++this.clock,
    }
    this.sessions.set(sessionId, record)
    return record
  }

  #update(record, state, payload) {
    record.state = state
    record.payload = payload
    record.updatedAt = ++this.clock
  }

  /** Enter an identified human wait, remembering what to restore later. */
  #enterWait(record, wait) {
    if (record.waits.length === 0) {
      record.savedState = record.state
      record.savedPayload = record.payload
    }
    const existing = record.waits.findIndex((entry) => entry.kind === wait.kind && entry.id === wait.id)
    if (existing >= 0) record.waits.splice(existing, 1)
    record.waits.push(wait)
    record.state = PetState.WAITING
    record.payload = this.#waitPayload(record)
    record.updatedAt = ++this.clock
  }

  /** Resolve one identified wait and restore work only after all waits settle. */
  #exitWait(record, kind, id) {
    const index = record.waits.findIndex((wait) => wait.kind === kind && wait.id === id)
    if (index < 0) return
    record.waits.splice(index, 1)
    record.updatedAt = ++this.clock
    if (record.waits.length > 0) {
      record.state = PetState.WAITING
      record.payload = this.#waitPayload(record)
      return
    }
    record.state = record.savedState ?? PetState.THINKING
    record.payload = record.savedPayload ?? { phase: 'wait-end', message: '蕾米埃尔待命中' }
    record.savedState = undefined
    record.savedPayload = undefined
  }

  #waitPayload(record) {
    return record.waits.find((wait) => wait.kind === 'approval')?.payload
      ?? record.waits.at(-1)?.payload
      ?? { phase: 'wait-end', message: '蕾米埃尔待命中' }
  }

  #select() {
    const records = [...this.sessions.values()]
    if (records.length === 0) {
      return {
        record: {
          id: 'dsh-host',
          state: PetState.IDLE,
          payload: { phase: 'no-session', message: '蕾米埃尔待命中' },
          updatedAt: ++this.clock,
        },
      }
    }
    records.sort((left, right) => {
      const priority = (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0)
      return priority || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
    })
    return { record: records[0] }
  }

  #render(selection = this.#select()) {
    const signature = this.#signature(selection.record)
    if (signature === this.outputSignature) return []
    this.#remember(selection)
    return [createMessage(PetMessageKind.STATE, {
      sessionId: selection.record.id,
      state: selection.record.state,
      mood: moodFor(selection.record.state, selection.record.payload.phase),
      ...selection.record.payload,
      task: selection.record.task,
      progress: selection.record.progress,
      project: selection.record.project,
      detail: detailFor(selection.record),
    })]
  }

  #remember(selection) {
    this.selectedSessionId = selection.record.id
    this.outputSignature = this.#signature(selection.record)
  }

  #signature(record) {
    return [
      record.id,
      record.state,
      record.payload.phase ?? '',
      record.payload.activity ?? '',
      record.payload.toolName ?? '',
      record.payload.preview ?? '',
      record.payload.message ?? '',
      record.project ?? '',
      record.task ?? '',
      record.progress?.completed ?? '',
      record.progress?.total ?? '',
    ].join('|')
  }
}

export { statePriority, toolActivity }
