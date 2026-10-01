import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopback, localHostOk } from '../src/local-access.js'

function request({ address = '127.0.0.1', host = '127.0.0.1:3080', origin } = {}) {
  const req = Readable.from([])
  req.headers = { host, ...(origin === undefined ? {} : { origin }) }
  req.socket = { remoteAddress: address }
  return req
}

test('local access accepts loopback hosts and matching origins only', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback(address), true)
    assert.equal(localHostOk(request({ address })), true)
  }
  for (const host of ['localhost:3080', '[::1]:3080']) {
    assert.equal(localHostOk(request({ host })), true)
  }
  assert.equal(localHostOk(request({ origin: 'http://127.0.0.1:3080' })), true)
})

test('local access rejects non-loopback peers, arbitrary hosts, and mismatched origins', () => {
  const cases = [
    { address: '192.168.1.20' },
    { host: 'evil.example:3080' },
    { host: '127.0.0.1:3080', origin: 'https://evil.example' },
    { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3081' },
    { host: '127.0.0.1:bad' },
  ]
  for (const value of cases) assert.equal(localHostOk(request(value)), false, JSON.stringify(value))
})
