/**
 * createStreamHub unit tests: subscriber bookkeeping, immediate first frame,
 * broadcast delivery, and close cleanup. The res object is stubbed to the
 * Node http.ServerResponse surface the hub uses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamHub } from '../src/index.js'

function stubRes() {
  const writes = []
  let closed = false
  const res = {
    writes,
    closed: () => closed,
    write(chunk) {
      writes.push(String(chunk))
      return true
    },
    end() {
      closed = true
    },
    on(event, fn) {
      this.listeners ??= {}
      this.listeners[event] = fn
      return this
    },
  }
  return res
}

function framesOf(res) {
  return res.writes
    .join('')
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)))
}

test('add sends the current snapshot immediately', () => {
  const hub = createStreamHub({ serve: () => ({ state: 'IDLE', ts: 1 }) })
  const res = stubRes()
  hub.add(res)
  const frames = framesOf(res)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].state, 'IDLE')
  assert.equal(frames[0].ts, 1)
  assert.equal(hub.size, 1)
  hub.close()
})

test('broadcast pushes the latest snapshot to every subscriber', () => {
  let value = { state: 'IDLE' }
  const hub = createStreamHub({ serve: () => value })
  const a = stubRes()
  const b = stubRes()
  hub.add(a)
  hub.add(b)
  value = { state: 'WORKING', task: '写文档' }
  hub.broadcast()
  for (const res of [a, b]) {
    const frames = framesOf(res)
    assert.equal(frames.length, 2)
    assert.equal(frames[1].state, 'WORKING')
    assert.equal(frames[1].task, '写文档')
  }
  hub.close()
})

test('close ends every subscriber and stops delivery', () => {
  const hub = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const res = stubRes()
  hub.add(res)
  hub.close()
  assert.equal(res.closed(), true)
  assert.equal(hub.size, 0)
  // Broadcasting after close must not throw.
  hub.broadcast()
})

test('subscriber removal on close event', () => {
  const hub = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const res = stubRes()
  hub.add(res)
  assert.equal(hub.size, 1)
  res.listeners?.close?.()
  assert.equal(hub.size, 0)
  hub.close()
})
