import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PetMessageKind,
  PetState,
  assertPetMessage,
  createMessage,
  encodeMessage,
  stateMood,
} from '../src/protocol.js'

test('createMessage builds a valid state message', () => {
  const message = createMessage(PetMessageKind.STATE, { state: PetState.WORKING, mood: '02' })
  assert.equal(message.protocolVersion, 1)
  assert.equal(message.kind, 'state')
  assert.equal(message.state, 'WORKING')
  assert.equal(message.mood, '02')
  assert.ok(Number.isFinite(message.timestamp))
})

test('createMessage rejects unknown kinds', () => {
  assert.throws(() => createMessage('nope'), /Unknown pet message kind/)
})

test('assertPetMessage accepts valid messages', () => {
  const message = createMessage(PetMessageKind.PULSE, { state: PetState.SUCCESS, mood: '03', ttlMs: 5000 })
  assert.equal(assertPetMessage(message).kind, 'pulse')
})

test('assertPetMessage rejects wrong protocol version', () => {
  assert.throws(() => assertPetMessage({ protocolVersion: 999, kind: 'state' }), /Unsupported protocol version/)
})

test('assertPetMessage rejects unknown states', () => {
  assert.throws(
    () => assertPetMessage({ protocolVersion: 1, kind: 'state', state: 'HACKING' }),
    /Unknown pet state/,
  )
})

test('encodeMessage appends a newline', () => {
  const line = encodeMessage(createMessage(PetMessageKind.STATE, { state: PetState.IDLE, mood: '06' }))
  assert.ok(line.endsWith('\n'))
  assert.equal(JSON.parse(line).kind, 'state')
})

test('stateMood maps every durable state to a sticker', () => {
  for (const state of Object.values(PetState)) {
    assert.ok(stateMood[state], `no mood for ${state}`)
  }
})
