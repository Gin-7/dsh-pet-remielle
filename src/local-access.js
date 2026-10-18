const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/** 去掉 IPv4-mapped 前缀（::ffff:）与接口 zone id 后的地址文本。 */
function bareAddress(address) {
  if (typeof address !== 'string') return ''
  const zone = address.indexOf('%')
  const value = zone === -1 ? address : address.slice(0, zone)
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
}

export function isLoopback(address) {
  const value = bareAddress(address)
  return value === '127.0.0.1' || value === '::1'
}

/** 绑定字面量在 Host 头里的权威形式；IPv6 文本带方括号。 */
function authorityOf(address) {
  const value = bareAddress(address)
  if (!value) return ''
  return value.includes(':') ? `[${value}]` : value
}

function hostMatches(host, authority) {
  if (LOOPBACK_HOST_RE.test(host)) return true
  return authority !== '' && (host === authority || host.startsWith(`${authority}:`))
}

/**
 * 接受来自本机、经回环地址或（可选）监听器自身绑定地址发起的请求。
 *
 * Host 栅栏是 DNS rebinding 防御：Host 取自浏览器认为自己在访问的 URL，被
 * rebound 的页面带的是攻击者域名，哪怕 socket 落在本机。带 Origin 时必须与
 * Host 同源，挡掉跨站调用。DSH 0.2.1 只绑定具体地址字面量（wildcard 在加载期
 * 被拒），所以部署可能绑 LAN IP、此时 127.0.0.1 根本不监听：`allowLocalAddress`
 * 让同一台机器经该监听器访问，判据是连接自身的本地地址（内核给出），不是请求头。
 *
 * @param req - 入站 HTTP 请求。
 * @param options.allowLocalAddress - 同时接受连接自身的绑定地址作为 peer 与
 *   Host；带副作用的端点保持默认的严格回环。
 */
export function localHostOk(req, { allowLocalAddress = false } = {}) {
  const peer = req.socket?.remoteAddress
  const local = allowLocalAddress ? bareAddress(req.socket?.localAddress) : ''
  const sameMachine = isLoopback(peer) || (local !== '' && bareAddress(peer) === local)
  if (!sameMachine) return false
  const host = req.headers?.host || ''
  if (!hostMatches(host, local === '' ? '' : authorityOf(local))) return false
  const origin = req.headers?.origin
  if (origin) {
    let originHost
    try { originHost = new URL(origin).host } catch { return false }
    if (!originHost || originHost !== host) return false
  }
  return true
}
