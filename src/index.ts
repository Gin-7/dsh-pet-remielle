/**
 * Host half of the Remielle pet bundle.
 *
 * The pet itself is a pure client plugin, but the host half provides three
 * small webServer routes so the client can offer a self-update flow:
 *
 *   GET  /api/pet-remielle/info    -> install mode, versions, and the exact
 *                                    update command for this install shape
 *   GET  /api/pet-remielle/check   -> query GitHub for the newest release/tag
 *                                    (direct, then local HTTP proxies), so the
 *                                    browser never needs outbound GitHub access
 *   POST /api/pet-remielle/update  -> run the update (git pull for a linked
 *                                    checkout, pnpm update for a registry/git
 *                                    install) and return the output
 *
 * All routes only accept requests from the local GUI (Host check), so a random
 * website cannot trigger an update (CSRF guard).
 */
import { fileURLToPath } from 'node:url'
import { dirname, sep } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'

const REPO = 'Gin-7/dsh-pet-remielle'
const PKG = 'dsh-pet-remielle'
const GITHUB = `https://github.com/${REPO}`
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const TAGS_API = `https://api.github.com/repos/${REPO}/tags`

const isWin = process.platform === 'win32'

/** Local HTTP proxy candidates (in priority order) for reaching GitHub from CN networks. */
function proxyCandidates(): string[] {
  const out: string[] = []
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[key]
    if (v && typeof v === 'string' && v.includes('://')) {
      try {
        const u = new URL(v)
        out.push(`${u.hostname}:${u.port || (u.protocol === 'http:' ? 80 : 443)}`)
      } catch { /* skip malformed */ }
    }
  }
  for (const p of ['127.0.0.1:7890', '127.0.0.1:7897', '127.0.0.1:10809', '127.0.0.1:1080']) {
    if (!out.includes(p)) out.push(p)
  }
  return out
}

function isProxyUp(hostPort: string, timeoutMs = 600): Promise<boolean> {
  const [host, port] = hostPort.split(':')
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (v: boolean): void => {
      if (done) return
      done = true
      resolvePromise(v)
    }
    // Probe whether a proxy port answers TLS. Never pass an IP as servername
    // (RFC 6066 forbids SNI on IP literals; Node warns DEP0123).
    const servername = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host
    const sock = tls.connect({ host, port: Number(port) || 443, servername, rejectUnauthorized: false, timeout: timeoutMs })
    sock.once('secureConnect', () => { sock.destroy(); finish(true) })
    sock.once('timeout', () => { sock.destroy(); finish(false) })
    sock.once('error', () => { sock.destroy(); finish(false) })
  })
}

/** HTTPS GET through an HTTP proxy (CONNECT tunnel) using OpenSSL TLS. */
function httpsGetViaProxy(url: string, proxyHostPort: string, timeoutMs = 12_000): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url)
    const [ph, pp] = proxyHostPort.split(':')
    const targetHost = u.hostname
    const targetPort = u.port || '443'
    const connectReq = http.request({
      host: ph,
      port: Number(pp) || 8080,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        rejectPromise(new Error(`proxy CONNECT failed: ${res.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: /^\d+\.\d+\.\d+\.\d+$/.test(targetHost) ? undefined : targetHost, timeout: timeoutMs }, () => {
        const req = https.request({
          socket: tlsSocket,
          method: 'GET',
          path: u.pathname + u.search,
          headers: {
            'User-Agent': 'dsh-pet-remielle',
            Accept: 'application/vnd.github+json',
            Host: targetHost,
          },
        }, (resp) => {
          let body = ''
          resp.on('data', (d: Buffer) => (body += String(d)))
          resp.on('end', () => resolvePromise({ status: resp.statusCode || 0, body }))
        })
        req.on('error', (err: Error) => rejectPromise(err))
        req.end()
      })
      tlsSocket.on('error', (err: Error) => rejectPromise(err))
    })
    connectReq.on('timeout', () => { connectReq.destroy(); rejectPromise(new Error('proxy connect timeout')) })
    connectReq.on('error', (err: Error) => rejectPromise(err))
    connectReq.end()
  })
}

/** Direct GET via the global fetch (honours env proxy only when the host sets NODE_USE_ENV_PROXY). */
async function httpsGetDirect(url: string, timeoutMs = 5000): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-pet-remielle', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    })
    return { status: res.status, body: await res.text() }
  } finally {
    clearTimeout(t)
  }
}

/** GET a URL through a fixed host:port while keeping the real SNI + Host header
 *  (Steam++/Watt-style: hosts pins GitHub domains to 127.0.0.1 and a local
 *  reverse proxy terminates TLS on :443). */
function httpsGetPinned(url: string, hostPort: string, timeoutMs = 12_000): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url)
    const [ph, pp] = hostPort.split(':')
    // RFC 6066: SNI must not be an IP literal.
    const servername = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ? undefined : u.hostname
    const req = https.request(
      {
        host: ph,
        port: Number(pp) || 443,
        servername,
        rejectUnauthorized: false,
        method: 'GET',
        path: u.pathname + u.search,
        headers: { Host: u.hostname, 'User-Agent': 'dsh-pet-remielle', Accept: 'application/vnd.github+json' },
        timeout: timeoutMs,
      },
      (resp) => {
        let body = ''
        resp.on('data', (d: Buffer) => (body += String(d)))
        resp.on('end', () => resolvePromise({ status: resp.statusCode || 0, body }))
      },
    )
    req.on('timeout', () => { req.destroy(); rejectPromise(new Error('pinned request timeout')) })
    req.on('error', (err: Error) => rejectPromise(err))
    req.end()
  })
}

interface RemoteLatest {
  latest: string
  notes: string
  htmlUrl: string
}

/** Fetch the newest release (falling back to the newest tag), trying direct then proxies. */
async function fetchRemoteLatest(): Promise<RemoteLatest | null> {
  const attempt = async (fetchFn: (url: string) => Promise<{ status: number; body: string }>): Promise<RemoteLatest | null> => {
    try {
      const rel = await fetchFn(RELEASES_API)
      if (rel.status === 200) {
        const j = JSON.parse(rel.body)
        if (j && typeof j.tag_name === 'string') {
          return {
            latest: j.tag_name,
            notes: typeof j.body === 'string' ? j.body : '',
            htmlUrl: typeof j.html_url === 'string' ? j.html_url : GITHUB + '/releases',
          }
        }
      }
      const tags = await fetchFn(TAGS_API)
      if (tags.status === 200) {
        const arr = JSON.parse(tags.body)
        if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0].name === 'string') {
          return { latest: arr[0].name, notes: '', htmlUrl: GITHUB + '/releases' }
        }
      }
      return null
    } catch {
      return null
    }
  }

  // 1) plain direct fetch
  const direct = await attempt(httpsGetDirect)
  if (direct) return direct
  // 2) Steam++/Watt pinned-tunnel (hosts pins GitHub -> 127.0.0.1:443)
  try {
    const pinned = await attempt((u) => httpsGetPinned(u, '127.0.0.1:443'))
    if (pinned) return pinned
  } catch { /* fall through */ }
  // 3) classic HTTP proxy (CONNECT)
  for (const hostPort of proxyCandidates()) {
    if (!(await isProxyUp(hostPort))) continue
    const via = await attempt((u) => httpsGetViaProxy(u, hostPort))
    if (via) return via
  }
  return null
}

/** True when we reached GitHub's API (even a 404 = repo exists but no release). */
async function githubReachable(): Promise<boolean> {
  try {
    const r = await httpsGetDirect(RELEASES_API, 4000)
    if (r.status === 200 || r.status === 404) return true
  } catch { /* keep trying */ }
  try {
    const r = await httpsGetPinned(RELEASES_API, '127.0.0.1:443', 4000)
    if (r.status === 200 || r.status === 404) return true
  } catch { /* keep trying */ }
  for (const hostPort of proxyCandidates()) {
    if (!(await isProxyUp(hostPort))) continue
    try {
      const r = await httpsGetViaProxy(RELEASES_API, hostPort, 4000)
      if (r.status === 200 || r.status === 404) return true
    } catch { /* try next */ }
  }
  return false
}

interface InstallInfo {
  mode: 'link' | 'github'
  version: string
  profileDir?: string
  repoDir?: string
}

function resolveInstall(): InstallInfo {
  const here = fileURLToPath(import.meta.url)
  const pkgDir = dirname(dirname(here))
  let version = '0.0.1'
  try {
    const pj = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
    if (pj && typeof pj.version === 'string') version = pj.version
  } catch {
    /* keep default */
  }
  const marker = `${sep}node_modules${sep}`
  const idx = pkgDir.indexOf(marker)
  if (idx === -1) return { mode: 'link', repoDir: pkgDir, version }
  return { mode: 'github', profileDir: pkgDir.slice(0, idx), version }
}

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (ok: boolean, output: string): void => {
      if (settled) return
      settled = true
      resolvePromise({ ok, output })
    }
    let child
    try {
      if (isWin) {
        // .cmd shims (pnpm, git may resolve through PATHEXT) need cmd.exe.
        const quoted = [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
        child = spawn(quoted, { cwd, windowsHide: true, shell: true })
      } else {
        child = spawn(cmd, args, { cwd, windowsHide: true })
      }
    } catch (err) {
      finish(false, String(err))
      return
    }
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += String(d)))
    child.stderr?.on('data', (d: Buffer) => (out += String(d)))
    child.on('error', (err: Error) => finish(false, out + '\n' + String(err.message)))
    child.on('close', (code: number | null) => finish(code === 0, out))
    // hard cap so a hung git/pnpm never wedges the request
    setTimeout(() => finish(false, out + '\n[timeout after 90s]'), 90_000).unref()
  })
}

function localHostOk(req: IncomingMessage): boolean {
  const host = req.headers.host || ''
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function infoHandler(_req: IncomingMessage, res: ServerResponse): void {
  const info = resolveInstall()
  const cmd =
    info.mode === 'link' && info.repoDir
      ? `cd /d "${info.repoDir}" && git pull`
      : info.profileDir
        ? `cd /d "${info.profileDir}" && pnpm update ${PKG}`
        : ''
  json(res, 200, {
    pkg: PKG,
    repo: REPO,
    github: GITHUB,
    mode: info.mode,
    version: info.version,
    profileDir: info.profileDir || null,
    repoDir: info.repoDir || null,
    updateCommand: cmd,
  })
}

async function checkHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: check route is local-only' })
    return
  }
  const remote = await fetchRemoteLatest()
  if (!remote) {
    const reachable = await githubReachable()
    if (reachable) {
      // GitHub reachable but no release/tag yet -> not "network failure".
      json(res, 200, { ok: false, error: 'no version yet', reachable: true })
      return
    }
    // Diagnose for a helpful message.
    let direct = false
    let proxiesUp: string[] = []
    try {
      await fetch('https://api.github.com', { signal: AbortSignal.timeout(3000) })
      direct = true
    } catch { /* direct blocked */ }
    for (const hp of proxyCandidates()) {
      if (await isProxyUp(hp)) proxiesUp.push(hp)
    }
    json(res, 200, { ok: false, error: 'network unreachable', direct, proxiesUp })
    return
  }
  json(res, 200, { ok: true, ...remote })
}

async function updateHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, output: 'forbidden: update route is local-only' })
    return
  }
  const info = resolveInstall()
  let result: { ok: boolean; output: string }
  if (info.mode === 'link' && info.repoDir) {
    result = await run('git', ['-C', info.repoDir, 'pull'], info.repoDir)
  } else if (info.profileDir && existsSync(info.profileDir)) {
    result = await run('pnpm', ['update', PKG], info.profileDir)
  } else {
    json(res, 500, { ok: false, output: 'unknown install shape' })
    return
  }
  json(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output.slice(-6000) })
}

/** Host half: registers the update/check webServer routes (pure client pet otherwise). */
export const inject = ['webServer']

export function apply(ctx: any): void {
  const webServer = ctx.get('webServer')
  // Fail loud instead of silently no-op'ing: if the bundle row loads but the
  // webServer service is missing (wrong scope / too early), we want the error.
  if (webServer === undefined) throw new Error('pet-remielle: webServer service unavailable')
  const disposeInfo = webServer.register({ kind: 'exact', path: '/api/pet-remielle/info', handler: infoHandler })
  const disposeCheck = webServer.register({ kind: 'exact', path: '/api/pet-remielle/check', handler: checkHandler })
  const disposeUpdate = webServer.register({ kind: 'exact', path: '/api/pet-remielle/update', handler: updateHandler })
  // cordis ctx.effect(execute, label): execute runs NOW and may return a
  // disposer. Return the cleanup as the disposer — never call it inline.
  ctx.effect(() => () => {
    disposeInfo()
    disposeCheck()
    disposeUpdate()
  })
}
