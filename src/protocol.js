/**
 * Typed companion protocol for the Remielle web pet (dsh-pet-remielle).
 *
 * Ported from dsh-dafeiyu's protocol.js. The host keeps the reducer's latest
 * message plus any active PULSE overlay and serves them to the browser client
 * through the HTTP state endpoint. The message vocabulary stays
 * transport-agnostic so a native desktop helper (like dafeiyu's PySide6
 * window) could later be attached to the same reducer output.
 */

export const PROTOCOL_VERSION = 1

export const PetState = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
})

/** Remielle sticker moods: 01 疯狂工作(输出) 02 工作间歇(工具) 03 心满意足 04 思考中 05 等待回应 06 待机. */
export const PetMood = Object.freeze({
  OUTPUT: '01',
  TOOL: '02',
  SATISFIED: '03',
  THINKING: '04',
  WAITING: '05',
  IDLE: '06',
})

export const PetMessageKind = Object.freeze({
  HELLO: 'hello',
  STATE: 'state',
  PULSE: 'pulse',
  TASK: 'task',
})

/** Default mood per durable companion state (overridden by phases like streaming). */
export const stateMood = Object.freeze({
  [PetState.IDLE]: PetMood.IDLE,
  [PetState.THINKING]: PetMood.THINKING,
  [PetState.WORKING]: PetMood.TOOL,
  [PetState.WAITING]: PetMood.WAITING,
  [PetState.SUCCESS]: PetMood.SATISFIED,
  [PetState.ERROR]: PetMood.THINKING,
  [PetState.DISCONNECTED]: PetMood.IDLE,
})

const states = new Set(Object.values(PetState))
const kinds = new Set(Object.values(PetMessageKind))

export function createMessage(kind, payload = {}) {
  if (!kinds.has(kind)) throw new TypeError(`Unknown pet message kind: ${kind}`)
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind,
    timestamp: Date.now(),
    ...payload,
  }
}

export function assertPetMessage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pet message must be an object')
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported protocol version: ${String(value.protocolVersion)}`)
  }
  if (!kinds.has(value.kind)) throw new TypeError(`Unknown pet message kind: ${String(value.kind)}`)
  if ((value.kind === PetMessageKind.STATE || value.kind === PetMessageKind.PULSE)
    && !states.has(value.state)) {
    throw new TypeError(`Unknown pet state: ${String(value.state)}`)
  }
  return value
}

export function encodeMessage(message) {
  assertPetMessage(message)
  return `${JSON.stringify(message)}\n`
}
