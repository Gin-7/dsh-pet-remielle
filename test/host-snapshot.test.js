import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateSnapshot } from '../src/index.js'
import { DEFAULT_PET_ID } from '../src/pets.js'
import { PetMessageKind, PetState, createMessage } from '../src/protocol.js'

function snapshotWith({ latest, pulse = null, config = {}, petId }) {
  return createStateSnapshot({
    getLatest: () => latest,
    getPulse: () => pulse,
    getConfig: () => config,
    getPetId: () => petId,
  })()
}

const idle = createMessage(PetMessageKind.STATE, {
  sessionId: 's1',
  state: PetState.IDLE,
  mood: '06',
  phase: 'turn-end',
  message: '任务完成咯，干得漂亮',
  detail: 's1 · 本轮已完成',
})

test('snapshot carries config fields for the client', () => {
  const snapshot = snapshotWith({
    latest: idle,
    config: { enabled: true, scale: 1.25, opacity: 0.8, locked: true, desktopMode: true },
  })
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.scale, 1.25)
  assert.equal(snapshot.opacity, 0.8)
  assert.equal(snapshot.locked, true)
  assert.equal(snapshot.bubble, true)
  assert.equal(snapshot.desktopActive, false)
  assert.equal(snapshot.desktopMode, true)
})

test('snapshot reports the desktop window state', () => {
  const snapshot = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => undefined,
    getDesktopActive: () => true,
  })()
  assert.equal(snapshot.desktopActive, true)
})

test('snapshot defaults config when absent', () => {
  const snapshot = snapshotWith({ latest: idle })
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.scale, 1)
  assert.equal(snapshot.opacity, 1)
  assert.equal(snapshot.locked, false)
  assert.equal(snapshot.bubble, true)
})

test('snapshot exposes showBubble=false and pulse expiry', () => {
  const pulse = {
    ...createMessage(PetMessageKind.PULSE, {
      sessionId: 's1',
      state: PetState.SUCCESS,
      mood: '03',
      ttlMs: 5000,
      resumeState: PetState.IDLE,
      resumeMood: '06',
      resumeMessage: '待命中',
      resumeDetail: 'DSH',
      message: '成功',
      detail: 's1 · 本轮已完成',
    }),
    until: Date.now() + 5000,
  }
  const snapshot = snapshotWith({
    latest: idle,
    pulse,
    config: { showBubble: false },
  })
  assert.equal(snapshot.bubble, false)
  assert.ok(snapshot.pulseUntil > Date.now())
  const settled = snapshotWith({ latest: idle, config: { showBubble: false } })
  assert.equal(settled.pulseUntil, 0)
})

test('snapshot carries the active pet id', () => {
  const snapshot = snapshotWith({ latest: idle, petId: 'cirno' })
  assert.equal(snapshot.petId, 'cirno')
})

test('snapshot defaults the pet id when absent', () => {
  const snapshot = snapshotWith({ latest: idle })
  assert.equal(snapshot.petId, DEFAULT_PET_ID)
})

test('snapshot keeps the pet id stable across pulse overlays', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
  })
  const snapshot = snapshotWith({ latest: idle, pulse, petId: 'remielle' })
  assert.equal(snapshot.petId, 'remielle')
})

test('active pulse overlay wins over durable state', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    message: '这次任务搞定啦~',
    detail: 's1 · 本轮已完成',
  })
  const snapshot = snapshotWith({
    latest: idle,
    pulse: { ...pulse, until: Date.now() + 4000 },
  })
  assert.equal(snapshot.state, PetState.SUCCESS)
  assert.equal(snapshot.mood, '03')
  assert.equal(snapshot.message, '这次任务搞定啦~')
})

test('expired pulse falls back to durable state', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    resumeMessage: '任务完成咯，干得漂亮',
    resumeDetail: 's1 · 本轮已完成',
    message: '这次任务搞定啦~',
    detail: 's1 · 本轮已完成',
  })
  const snapshot = snapshotWith({
    latest: idle,
    pulse: { ...pulse, until: Date.now() - 1000 },
  })
  assert.equal(snapshot.state, PetState.IDLE)
  assert.equal(snapshot.mood, '06')
})

test('disabled config is reflected in the snapshot', () => {
  const snapshot = snapshotWith({ latest: idle, config: { enabled: false } })
  assert.equal(snapshot.enabled, false)
})
