/**
 * Pure, testable state machine that turns DSH session events into pet
 * messages (state / pulse / task). Ported from dsh-dafeiyu's
 * CompanionReducer; the differences are:
 *
 *  - every rendered message carries a `mood` (remielle sticker id), derived
 *    from state + phase (streaming output -> '01', tools -> '02', ...);
 *  - assistant output streaming is tracked as a THINKING phase 'streaming'
 *    so the "疯狂工作" sticker shows while text is being written;
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

function detailFor(record, stage = record.payload.stage) {
  const parts = []
  if (record.project) parts.push(record.project)
  if (record.progress?.total) parts.push(`已完成 ${record.progress.completed}/${record.progress.total} 步`)
  if (record.task) parts.push(record.task)
  else if (stage) parts.push(stage)
  return parts.join(' · ') || stage || 'DSH 任务'
}

/** Remielle sticker for the current durable state + phase. */
export function moodFor(state, phase) {
  if (state === PetState.THINKING && phase === 'streaming') return '01'
  if (state === PetState.THINKING) return '04'
  if (state === PetState.WAITING) return '05'
  if (state === PetState.IDLE) return '06'
  if (state === PetState.DISCONNECTED) return '06'
  // WORKING (tool busy) and ERROR (no dedicated sticker) both read as "干活/有事".
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

      case 'assistant/chunk':
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
        const activity = toolActivity(name)
        record.openTools.set(callId, name)
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

  #toolResult(record, event) {
    const callId = String(event.data?.message?.toolCallId
      ?? event.data?.message?.callId
      ?? event.data?.callId
      ?? '')
    if (callId) record.openTools.delete(callId)
    const next = record.openTools.size > 0 ? PetState.WORKING : PetState.THINKING
    const nextPayload = {
      phase: 'tool-result',
      activity: next === PetState.WORKING
        ? toolActivity(record.openTools.values().next().value)
        : undefined,
      stage: next === PetState.WORKING
        ? activityStage(toolActivity(record.openTools.values().next().value))
        : '整理阶段',
      message: next === PetState.WORKING
        ? activityCopy(toolActivity(record.openTools.values().next().value), event.seq)
        : statusCopy('result', event.seq),
    }
    this.#update(record, next, nextPayload)
    if (!event.data?.error) return this.#render()

    const selection = this.#select()
    if (selection.record.state === PetState.WAITING || selection.record.state === PetState.ERROR) {
      return this.#render(selection)
    }
    this.#remember(selection)
    return [createMessage(PetMessageKind.PULSE, {
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
    })]
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
    if ([PetState.WAITING, PetState.ERROR].includes(selection.record.state)) {
      return this.#render(selection)
    }
    this.#remember(selection)
    return [createMessage(PetMessageKind.PULSE, {
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
    })]
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
      record.payload.message ?? '',
      record.project ?? '',
      record.task ?? '',
      record.progress?.completed ?? '',
      record.progress?.total ?? '',
    ].join('|')
  }
}

export { statePriority, toolActivity }
