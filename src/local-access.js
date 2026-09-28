const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Accept only a loopback TCP peer addressed through a local HTTP host. */
export function localHostOk(req) {
  if (!isLoopback(req.socket?.remoteAddress)) return false
  const host = req.headers?.host || ''
  if (!LOCAL_HOST_RE.test(host)) return false
  const origin = req.headers?.origin
  if (origin) {
    let originHost
    try { originHost = new URL(origin).host } catch { return false }
    if (!originHost || originHost !== host) return false
  }
  return true
}
