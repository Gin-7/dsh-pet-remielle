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
 *   GET  /plugins/dsh-pet-remielle/update-progress
 *                                          -> running state, elapsed time and the
 *                                             tail of live output while updating
 *
 * Every route requires a loopback peer, a pinned HTTP method (POST for
 * `update`, GET for the reads), *and*, when the browser sends one, a
 * same-origin Origin — see `localHostOk` below. Host-header checking alone is
 * not a CSRF guard, and neither is the Origin check on its own: browsers omit
 * `Origin` on cross-origin GET/HEAD, so the method pin is what makes the
 * missing header unreachable for a hostile page.
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
export const PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'
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

// ---- 更新进度（环形缓冲 + 实时端点） ----
// 固定 90s 硬超时的教训（0.4.3 慢网用户大量被误杀）：pnpm 解析元数据 + 下载
// tarball 本来就可能超过 90s（国内直连 npmjs 时单个包解析就能花 13s+），但只要
// 子进程还在持续输出就说明它没挂。改为「空闲超时」：每收到一段输出就重置计时器，
// 连续 60s 无任何输出才判定挂起；另设 10 分钟总上限兜底（防输出不断但永远不结束）。
export const IDLE_TIMEOUT_MS = 60000
export const TOTAL_TIMEOUT_MS = 600000

// 进度只保留末尾 ~50 行：进度卡片只需要最近的下载/安装动态，全量输出仍在
// 最终响应里返回（done 态展示）。pnpm 进度条用 \r 刷新，这里按行切开后自然会
// 只留最后一帧附近的内容。
const PROGRESS_TAIL_LINES = 50

let updateProgress = { running: false, startedAt: 0, lastActivityAt: 0, tail: [] }

/** 追加一段子进程输出到进度缓冲（按行切分，超出保留窗口的旧行丢弃）。 */
function pushProgressOutput(text) {
  const lines = String(text).split(/\r?\n|\r/)
  for (const ln of lines) {
    if (!ln) continue
    updateProgress.tail.push(ln)
  }
  while (updateProgress.tail.length > PROGRESS_TAIL_LINES) updateProgress.tail.shift()
  updateProgress.lastActivityAt = Date.now()
}

function beginUpdateProgress() {
  updateProgress = { running: true, startedAt: Date.now(), lastActivityAt: Date.now(), tail: [] }
}

function endUpdateProgress() {
  updateProgress.running = false
}

/** 进度端点负载：更新是否进行中、已耗时、最近输出尾部。 */
export function getUpdateProgress() {
  return {
    running: updateProgress.running,
    elapsedMs: updateProgress.running ? Date.now() - updateProgress.startedAt : 0,
    outputTail: updateProgress.tail.join('\n'),
  }
}

export function progressHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: progress route is local-only' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method not allowed (GET only)' })
    return
  }
  json(res, 200, { ok: true, ...getUpdateProgress() })
}

/** Windows 上 shell:true 包了层 cmd.exe，taskkill /T 连树一起杀，避免 pnpm.exe 孤儿。 */
function killChildTree(child) {
  try {
    if (isWin && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on?.('error', () => { try { child.kill() } catch { /* ignore */ } })
    } else {
      child.kill()
    }
  } catch {
    try { child.kill() } catch { /* ignore */ }
  }
}

export function run(cmd, args, cwd, opts) {
  const idleTimeoutMs = (opts && opts.idleTimeoutMs) || IDLE_TIMEOUT_MS
  const totalTimeoutMs = (opts && opts.totalTimeoutMs) || TOTAL_TIMEOUT_MS
  return new Promise((resolvePromise) => {
    let settled = false
    let idleTimer = null
    let totalTimer = null
    const finish = (ok, output) => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      if (activeChild === child) activeChild = null
      resolvePromise({ ok, output })
    }
    // 超时终止：先杀进程树再落结论——挂死的 pnpm 若继续活着改写 node_modules，
    // 用户重试更新就是在半成品上叠半成品
    const finishTimedOut = (output) => {
      killChildTree(child)
      finish(false, output)
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
    activeChild = child
    let out = ''
    // 空闲超时：任何一段输出（stdout/stderr）都重置计时器。慢网下载期间 pnpm
    // 持续产出进度行，不会被误杀；真正挂死的进程 60s 内无输出、被终止。
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => finishTimedOut(out + `\n[timeout: no output for ${Math.max(1, Math.round(idleTimeoutMs / 1000))}s — 更新进程疑似挂起]`),
        idleTimeoutMs,
      )
      idleTimer.unref?.()
    }
    child.stdout?.on('data', (d) => { out += String(d); pushProgressOutput(String(d)); armIdleTimer() })
    child.stderr?.on('data', (d) => { out += String(d); pushProgressOutput(String(d)); armIdleTimer() })
    child.on('error', (err) => finish(false, out + '\n' + String(err.message)))
    child.on('close', (code) => finish(code === 0, out))
    // 总上限兜底：输出一直有但进程永不结束（如交互式提示卡住）也能退出
    totalTimer = setTimeout(
      () => finishTimedOut(out + `\n[timeout: exceeded total ${Math.max(1, Math.round(totalTimeoutMs / 1000))}s]`),
      totalTimeoutMs,
    )
    totalTimer.unref?.()
    armIdleTimer()
  })
}

/** 进行中的更新子进程（pnpm/git）。宿主退出时 killActiveUpdate() 终止它——
 *  否则孤儿进程继续改写 node_modules，半成品包会让下一次启动崩溃。 */
let activeChild = null
export function killActiveUpdate() {
  const child = activeChild
  if (!child || child.exitCode !== null) return
  killChildTree(child)
}

// ---- 失败后旧安装完整性自检 ----
// pnpm 被超时/宿主退出中途杀掉时，node_modules 可能已被动到一半（pnpm 无回滚）：
// 旧版当下还能跑（代码在内存里），但下次重启可能加载失败。更新失败时立即检测
// 自己的包目录并如实上报，让用户马上知道旧版还能不能继续用，而不是等重启才炸。
export function verifyInstallIntegrity(pkgDir) {
  const dir = pkgDir || dirname(dirname(fileURLToPath(import.meta.url)))
  const problems = []
  let pj = null
  try {
    pj = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  } catch (err) {
    problems.push(`package.json 不可读（${String((err && err.message) || err).slice(0, 80)}）`)
  }
  if (pj) {
    const entry = typeof pj.main === 'string' && pj.main ? pj.main : 'src/index.js'
    if (!existsSync(`${dir}/${entry}`)) problems.push(`入口文件缺失: ${entry}`)
  }
  if (!existsSync(`${dir}/src`)) problems.push('src/ 目录缺失')
  return { ok: problems.length === 0, problems, pkgDir: dir }
}

/**
 * Loopback + same-origin guard, same standard as `localOnly` in src/index.js.
 *
 * The Host header alone is not a CSRF guard: it is derived from the request
 * target, so a hostile page reaching `http://127.0.0.1:<port>/…` produces a
 * request that passes a Host check while coming from somewhere else entirely.
 * Only `socket.remoteAddress` is unforgeable by page script.
 *
 * The Origin check is the second layer, and it is **not sufficient alone**:
 * browsers only attach `Origin` to a cross-origin request when the request is
 * CORS-tainted or the method is outside GET/HEAD/POST-with-simple-headers. A
 * hostile page's `<img src="…/update">` arrives with no `Origin` at all and
 * passes everything below. That is why every handler here also pins its
 * method — see `updateHandler`, which is the one route with side effects.
 */
export function localHostOk(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers?.host || ''
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers?.origin
  if (origin) {
    let originHost
    try { originHost = new URL(origin).host } catch { return false }
    if (!originHost || originHost !== host) return false
  }
  return true
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function infoHandler(req, res) {
  // The payload carries absolute profileDir / repoDir paths. Guard it like every
  // other route here instead of leaving it as the one unguarded read endpoint.
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: info route is local-only' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method not allowed (GET only)' })
    return
  }
  try {
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
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
  }
}

export async function checkHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: check route is local-only' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method not allowed (GET only)' })
    return
  }
  try {
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
  } catch (err) {
    json(res, 500, { ok: false, error: 'check failed: ' + String(err && err.message ? err.message : err) })
  }
}

// ---- 注入点（宿主注册路由时设置，测试可覆盖）----
// - stopDesktopWindow：更新前停掉桌面宠物窗并等待其进程退出。桌宠窗的
//   Electron 运行时就住在插件包目录里（vendor/electron-<platform>-<arch>，
//   由 electronArtifact 按平台解析）；Windows 上进程不退出会锁住文件——pnpm/git
//   替换包内容直接 EPERM。未注入（单测/无桌面窗）则跳过。
// - run / resolveInstall：测试注入假实现用。
const hooks = {
  stopDesktopWindow: null,
  onUpdateSuccess: null,
  run,
  resolveInstall,
}
export function setSelfUpdateHooks(next = {}) {
  if ('stopDesktopWindow' in next) {
    hooks.stopDesktopWindow = typeof next.stopDesktopWindow === 'function' ? next.stopDesktopWindow : null
  }
  if ('onUpdateSuccess' in next) {
    hooks.onUpdateSuccess = typeof next.onUpdateSuccess === 'function' ? next.onUpdateSuccess : null
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
  // 方法必须钉死：Fetch 规范下跨源 GET/HEAD（<img src=...>、<form method=GET>）不带
  // Origin 头，mode 是 no-cors 而非 cors，于是上面三项守卫全部通过。不钉方法的话，
  // 恶意页面一个 <img> 就能触发 git pull / pnpm update（后者会跑依赖 lifecycle scripts）。
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, output: 'method not allowed (POST only)' })
    return
  }
  // 全量兜底：更新链路上任何意外异常（如包目录正处于被替换的中间态）
  // 都必须落成 500 响应——异步路由抛未处理拒绝会直接拖垮宿主进程
  try {
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
    // 进度跟踪围着 hooks.run 包一层（真/假 run 都被覆盖）：running 态期间
    // 客户端看门狗会轮询 /update-progress 拿输出尾部实时展示。
    beginUpdateProgress()
    try {
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
    } finally {
      endUpdateProgress()
    }
    // 成功后置回调：宿主借此收尾（如关闭桌面模式——运行时已随更新被移除）。
    // 返回字符串则追加到输出里展示给用户。
    if (result.ok && typeof hooks.onUpdateSuccess === 'function') {
      try {
        const note = hooks.onUpdateSuccess()
        if (typeof note === 'string' && note) result = { ok: true, output: result.output + '\n' + note }
      } catch { /* 收尾失败不影响更新结果 */ }
    }
    // 失败自检：pnpm 中途被杀可能留下半成品 node_modules——旧版当下不受影响
    // （代码已加载进内存），但要立刻告诉用户磁盘上的旧安装是否还能撑到下次重启
    if (!result.ok) {
      try {
        const pkgDir = info.mode === 'link' && info.repoDir
          ? info.repoDir
          : info.profileDir
            ? `${info.profileDir}/node_modules/${PKG}`
            : null
        if (pkgDir) {
          const integrity = verifyInstallIntegrity(pkgDir)
          result.output += integrity.ok
            ? '\n\n✅ 自检：当前安装完好，旧版本可继续正常使用，稍后可重试更新。'
            : `\n\n⚠️ 自检：当前安装完整性异常（${integrity.problems.join('；')}）——旧版本重启后可能无法加载，建议到 GitHub Releases 按指引手动重装。`
        }
      } catch { /* 自检失败不影响原有错误响应 */ }
    }
    json(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output.slice(-6000) })
  } catch (err) {
    try { json(res, 500, { ok: false, output: 'update failed: ' + String(err && err.message ? err.message : err) }) } catch { /* response already sent */ }
  }
}
