/**
 * Host half of the self-update flow: version check + one-click update.
 *
 * Ported from the pre-rewrite version's host logic:
 *   GET  /plugins/dsh-pet-remielle/check   -> query GitHub for the newest
 *                                             release/tag (direct, then local
 *                                             HTTP proxies / Steam++-style pins)
 *   POST /plugins/dsh-pet-remielle/update  -> run the update (git pull for a
 *                                             linked checkout, pnpm update --latest
 *                                             for a registry install) and return
 *                                             output; stops the desktop pet window
 *                                             first so its electron.exe does not
 *                                             lock the package directory
 *   GET  /plugins/dsh-pet-remielle/info    -> install mode, versions, command
 *
 * All routes only accept local-loopback requests (CSRF guard).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, sep } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

export const REPO = 'Gin-7/dsh-pet-remielle'
export const PKG = 'dsh-pet-remielle'
export const GITHUB = `https://github.com/${REPO}`
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const TAGS_API = `https://api.github.com/repos/${REPO}/tags`

export const CHECK_ENDPOINT = '/plugins/dsh-pet-remielle/check'
export const UPDATE_ENDPOINT = '/plugins/dsh-pet-remielle/update'
export const INFO_ENDPOINT = '/plugins/dsh-pet-remielle/info'

// 包名/行 id 自 0.3.0 起变动（0.2.0 之前为 @dsh-external/dsh-client-ui-pet-remielle，
// 0.2.0–0.3.0 为 dsh-pet-remielle）：低于该版本的安装形态不同，无法增量更新，必须卸载重装。
export const PACKAGE_RENAME_MIN = '0.3.0'

function semverLt(a, b) {
  const pa = (a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = (b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y
  }
  return false
}

export function needsCleanReinstallFor(version) {
  return semverLt(version, PACKAGE_RENAME_MIN)
}

/** 无法自动增量更新：要么版本 < 0.3.0（包名已变更），要么非 link 安装（未发布到
 *  npm/pnpm，pnpm update 不可用）。此时应引导用户彻底卸载重装。 */
const isWin = process.platform === 'win32'

/** Local HTTP proxy candidates (in priority order) for reaching GitHub from CN networks. */
export function proxyCandidates() {
  const out = []
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

function isProxyUp(hostPort, timeoutMs = 600) {
  const [host, port] = hostPort.split(':')
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolvePromise(v)
    }
    // RFC 6066: never send SNI for an IP literal.
    const servername = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host
    const sock = tls.connect({ host, port: Number(port) || 443, servername, rejectUnauthorized: false, timeout: timeoutMs })
    sock.once('secureConnect', () => { sock.destroy(); finish(true) })
    sock.once('timeout', () => { sock.destroy(); finish(false) })
    sock.once('error', () => { sock.destroy(); finish(false) })
  })
}

/** HTTPS GET through an HTTP proxy (CONNECT tunnel) using OpenSSL TLS. */
export function httpsGetViaProxy(url, proxyHostPort, timeoutMs = 12000) {
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
      const tlsSocket = tls.connect({
        socket,
        servername: /^\d+\.\d+\.\d+\.\d+$/.test(targetHost) ? undefined : targetHost,
        timeout: timeoutMs,
      }, () => {
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
          resp.on('data', (d) => (body += String(d)))
          resp.on('end', () => resolvePromise({ status: resp.statusCode || 0, body }))
        })
        req.on('error', (err) => rejectPromise(err))
        req.end()
      })
      tlsSocket.on('error', (err) => rejectPromise(err))
    })
    connectReq.on('timeout', () => { connectReq.destroy(); rejectPromise(new Error('proxy connect timeout')) })
    connectReq.on('error', (err) => rejectPromise(err))
    connectReq.end()
  })
}

/** Direct GET via the global fetch. */
export async function httpsGetDirect(url, timeoutMs = 5000) {
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

/** Fetch the newest release (falling back to the newest tag), trying direct then proxies. */
export async function fetchRemoteLatest() {
  const attempt = async (fetchFn) => {
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
  // 2) classic HTTP proxy (CONNECT)
  for (const hostPort of proxyCandidates()) {
    if (!(await isProxyUp(hostPort))) continue
    const via = await attempt((u) => httpsGetViaProxy(u, hostPort))
    if (via) return via
  }
  return null
}

/** True when we reached GitHub's API (even a 404 = repo exists but no release). */
export async function githubReachable() {
  try {
    const r = await httpsGetDirect(RELEASES_API, 4000)
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

export function resolveInstall() {
  const here = fileURLToPath(import.meta.url)
  const pkgDir = dirname(dirname(here))
  let version = '0.0.1'
  try {
    const pj = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
    if (pj && typeof pj.version === 'string') version = pj.version
  } catch { /* keep default */ }
  const marker = `${sep}node_modules${sep}`
  const idx = pkgDir.indexOf(marker)
  if (idx === -1) return { mode: 'link', repoDir: pkgDir, version }
  return { mode: 'github', profileDir: pkgDir.slice(0, idx), version }
}

export function run(cmd, args, cwd) {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (ok, output) => {
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
    child.stdout?.on('data', (d) => (out += String(d)))
    child.stderr?.on('data', (d) => (out += String(d)))
    child.on('error', (err) => finish(false, out + '\n' + String(err.message)))
    child.on('close', (code) => finish(code === 0, out))
    // hard cap so a hung git/pnpm never wedges the request
    setTimeout(() => finish(false, out + '\n[timeout after 90s]'), 90000).unref()
  })
}

export function localHostOk(req) {
  const host = req.headers.host || ''
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function infoHandler(_req, res) {
  const info = resolveInstall()
  const needsReinstall = needsCleanReinstallFor(info.version)
  const cmd = needsReinstall
    ? '（版本低于 0.3.0：包名已变更，需彻底卸载后重新安装）'
    : info.mode === 'link' && info.repoDir
      ? `cd /d "${info.repoDir}" && git pull`
      : info.profileDir
        ? `cd /d "${info.profileDir}" && pnpm update --latest ${PKG}`
        : ''
  json(res, 200, {
    pkg: PKG,
    repo: REPO,
    github: GITHUB,
    mode: info.mode,
    version: info.version,
    profileDir: info.profileDir || null,
    repoDir: info.repoDir || null,
    needsCleanReinstall: needsReinstall,
    updateCommand: cmd,
  })
}

export async function checkHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: check route is local-only' })
    return
  }
  const remote = await fetchRemoteLatest()
  if (!remote) {
    const reachable = await githubReachable()
    if (reachable) {
      json(res, 200, { ok: false, error: 'no version yet', reachable: true })
      return
    }
    let direct = false
    let proxiesUp = []
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
  json(res, 200, { ok: true, ...remote, needsCleanReinstall: needsCleanReinstallFor(resolveInstall().version) })
}

// ---- 注入点（宿主注册路由时设置，测试可覆盖）----
// - stopDesktopWindow：更新前停掉桌面宠物窗并等待其进程退出。桌宠窗的
//   electron.exe 就住在插件包目录里（vendor/electron-win32-x64），进程不退出时
//   Windows 会锁住文件——pnpm/git 替换包内容直接 EPERM。未注入（单测/无桌面窗）则跳过。
// - run / resolveInstall：测试注入假实现用。
const hooks = { stopDesktopWindow: null, run, resolveInstall }
export function setSelfUpdateHooks(next = {}) {
  if ('stopDesktopWindow' in next) {
    hooks.stopDesktopWindow = typeof next.stopDesktopWindow === 'function' ? next.stopDesktopWindow : null
  }
  if ('run' in next) hooks.run = typeof next.run === 'function' ? next.run : run
  if ('resolveInstall' in next) {
    hooks.resolveInstall = typeof next.resolveInstall === 'function' ? next.resolveInstall : resolveInstall
  }
}

async function quiesceDesktopWindow() {
  if (typeof hooks.stopDesktopWindow !== 'function') return
  try { await hooks.stopDesktopWindow() } catch { /* 停不掉也继续尝试更新 */ }
}

export async function updateHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, output: 'forbidden: update route is local-only' })
    return
  }
  const info = hooks.resolveInstall()
  // 仅版本 < 0.3.0（包名已变更）需彻底卸载重装；>= 0.3.0 的 link 与 registry 安装
  // 都支持一键增量更新（link→git pull，registry→pnpm update --latest）。
  if (needsCleanReinstallFor(info.version)) {
    json(res, 500, {
      ok: false,
      needsCleanReinstall: true,
      output: '版本低于 0.3.0，包名/行 id 已变更，无法自动增量更新。\n请先卸载当前安装、再重装最新版：\n  · 若旧版为 0.2.0 及之前：dsh plugin --profile web remove @dsh-external/dsh-client-ui-pet-remielle\n  · 若旧版为 0.2.0–0.3.0：dsh plugin --profile web remove dsh-pet-remielle\n  然后：dsh plugin --profile web add dsh-pet-remielle\n（详见 README 的升级说明。）',
    })
    return
  }
  // 先停掉桌面宠物窗并等待其退出：electron.exe 运行中会锁住插件目录内的文件，
  // 否则 pnpm/git 替换包内容时报 EPERM（link 模式的 git pull 同理）
  await quiesceDesktopWindow()
  let result
  if (info.mode === 'link' && info.repoDir) {
    result = await hooks.run('git', ['-C', info.repoDir, 'pull'], info.repoDir)
  } else if (info.profileDir && existsSync(info.profileDir)) {
    // --latest：跨出 package.json 里可能被钉死的精确版本号（如 "0.3.3"）。
    // 普通 pnpm update 只在声明范围内升级，精确锁会永远原地重装旧版却报成功。
    result = await hooks.run('pnpm', ['update', '--latest', PKG], info.profileDir)
  } else {
    json(res, 500, { ok: false, output: 'unknown install shape' })
    return
  }
  json(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output.slice(-6000) })
}
