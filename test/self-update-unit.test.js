import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../src/self-update.js'

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) { timer.cleared = true },
  }
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4321
  child.killed = false
  child.kill = () => { child.killed = true }
  return child
}

test('run accepts injected spawn and timers for the normal close path', async () => {
  const timers = fakeTimers()
  const child = fakeChild()
  const calls = []
  const resultPromise = run('fake-command', ['--check'], '.', {
    spawnImpl: (command, args, options) => {
      calls.push({ command, args: Array.isArray(args) ? args : undefined, options: Array.isArray(args) ? options : args })
      queueMicrotask(() => {
        child.stdout.emit('data', 'done\n')
        child.emit('close', 0)
      })
      return child
    },
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  })
  const result = await resultPromise
  assert.equal(result.ok, true)
  assert.equal(result.output, 'done\n')
  assert.equal(calls.length, 1)
  if (process.platform === 'win32') {
    assert.equal(calls[0].command, 'fake-command --check')
    assert.equal(calls[0].options.shell, true)
  } else {
    assert.equal(calls[0].command, 'fake-command')
    assert.deepEqual(calls[0].args, ['--check'])
  }
  assert.equal(timers.timers.length, 3, 'initial idle timer is replaced after output')
  assert.equal(timers.timers.every((timer) => timer.cleared), true, JSON.stringify(timers.timers.map(({ ms, cleared }) => ({ ms, cleared }))))
})

test('run uses the injected timer and kill seam for a timeout', async () => {
  const timers = fakeTimers()
  const child = fakeChild()
  const resultPromise = run('fake-command', [], '.', {
    spawnImpl: () => child,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    killChildTreeImpl: (value) => { value.killed = true },
    idleTimeoutMs: 25,
    totalTimeoutMs: 100,
  })
  const idleTimer = timers.timers.find((timer) => timer.ms === 25)
  assert.ok(idleTimer)
  idleTimer.fn()
  const result = await resultPromise
  assert.equal(result.ok, false)
  assert.equal(child.killed, true)
  assert.match(result.output, /timeout: no output for 1s/)
  assert.equal(timers.timers.every((timer) => timer.cleared), true)
})
