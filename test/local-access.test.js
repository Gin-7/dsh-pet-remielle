import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopback, localHostOk } from '../src/local-access.js'

function request({ address = '127.0.0.1', localAddress, host = '127.0.0.1:3080', origin } = {}) {
  const req = Readable.from([])
  req.headers = { host, ...(origin === undefined ? {} : { origin }) }
  req.socket = { remoteAddress: address, ...(localAddress === undefined ? {} : { localAddress }) }
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

// DSH 0.2.1 只允许具体绑定字面量（wildcard 在加载期被拒）：部署绑 LAN IP 时
// 127.0.0.1 不监听，本机桌面窗必须能经该地址连进来，跨机客户端仍要被拒。
test('allowLocalAddress admits the listener bind address for this machine only', () => {
  const options = { allowLocalAddress: true }
  // 本机经 LAN 绑定地址访问：peer 与连接自身的本地地址相同
  assert.equal(
    localHostOk(request({ address: '192.168.1.5', localAddress: '192.168.1.5', host: '192.168.1.5:3080' }), options),
    true,
  )
  // IPv4-mapped 与 IPv6 字面量按同一地址判定，Host 带方括号
  assert.equal(
    localHostOk(request({ address: '::ffff:192.168.1.5', localAddress: '192.168.1.5', host: '192.168.1.5:3080' }), options),
    true,
  )
  assert.equal(
    localHostOk(request({ address: '::1', localAddress: '::1', host: '[::1]:3080' }), options),
    true,
  )
  // 跨机客户端：peer 不等于本地地址
  assert.equal(
    localHostOk(request({ address: '192.168.1.20', localAddress: '192.168.1.5', host: '192.168.1.5:3080' }), options),
    false,
  )
  // 同机但 Host 头不是本部署的绑定权威（DNS rebinding / 伪造）：拒绝
  assert.equal(
    localHostOk(request({ address: '192.168.1.5', localAddress: '192.168.1.5', host: 'evil.example:3080' }), options),
    false,
  )
  // 未开启扩展时保持严格回环：LAN 绑定地址不放行
  assert.equal(
    localHostOk(request({ address: '192.168.1.5', localAddress: '192.168.1.5', host: '192.168.1.5:3080' })),
    false,
  )
})
