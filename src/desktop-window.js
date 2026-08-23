/**
 * Desktop-window bridge: discover an Electron backend and spawn the pet
 * window process (src/pet-window.cjs, which loads the pet-view page).
 *
 * Electron backends, in preference order:
 *   1. DSH_PET_ELECTRON env var override.
 *   2. The bundled Electron runtime (vendor/electron-win32-x64) — ships with
 *      the plugin, so every user (plain web DSH host included) gets the same
 *      floating window with browser-engine GIF animation.
 *   3. npm global install (`npm install -g electron`) — find via
 *      `npm prefix -g` → node_modules/electron/dist/.
 *   4. The dsh binary root (derived from process.argv[1]) →
 *      node_modules/electron/dist/ or desktop/node_modules/electron/dist/.
 *   5. cwd fallback — the profile directory's own node_modules, or a local
 *      dev checkout that has electron in its tree.
 *
 * Configuration travels via environment variables (DSH_PET_URL /
 * DSH_PET_PARENT_PID): passing extra CLI args to a spawned Electron on
 * Windows crashes with exit -1, while env is stable.
 */

import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundledElectron = resolve(here, '..', 'vendor', 'electron-win32-x64', 'electron.exe')

/**
 * Walk up from `startDir` looking for a directory containing the given
 * `marker` path (relative to the candidate root). Returns the first
 * matching root, or `null` after `maxDepth` levels.
 */
export function findRoot(startDir, marker, maxDepth = 10) {
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(resolve(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Locate the dsh binary root by walking up from process.argv[1] (the main
 * script, typically `@deepseek-ai/dsh/lib/bin.js`). Falls back to cwd.
 */
export function findDshRoot(fallbackCwd) {
  const argv1 = process.argv[1]
  if (argv1) {
    const root = findRoot(dirname(resolve(argv1)), 'package.json')
    if (root) {
      if (existsSync(resolve(root, 'lib', 'bin.js')) || existsSync(resolve(root, 'node_modules', '@deepseek-ai', 'dsh'))) {
        return root
      }
    }
  }
  return fallbackCwd ?? null
}

/**
 * Try to find the npm global prefix by running `npm prefix -g`.
 * Returns the prefix path on success, null on failure.
 */
function getNpmGlobalPrefix() {
  try {
    const out = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * Candidate Electron backends, in preference order. Platform and cwd are
 * injectable for tests.
 * @returns `[{ kind: 'electron', command, args }]`.
 */
export function backendCandidates({ platform = process.platform, cwd = process.cwd() } = {}) {
  const candidates = []
  const electron = platform === 'win32' ? 'electron.exe' : 'electron'
  const args = [resolve(here, 'pet-window.cjs')]

  // --- 1. DSH_PET_ELECTRON env var override (highest priority) ---
  if (process.env.DSH_PET_ELECTRON) {
    candidates.push({ kind: 'electron', command: process.env.DSH_PET_ELECTRON, args })
  }

  // --- 2. Bundled vendor runtime (shipped with the plugin) ---
  if (platform === 'win32' && existsSync(bundledElectron)) {
    candidates.push({ kind: 'electron', command: bundledElectron, args })
  }

  // --- 3. npm global install — user ran `npm install -g electron` somewhere ---
  const npmPrefix = getNpmGlobalPrefix()
  if (npmPrefix) {
    const globalElectron = resolve(npmPrefix, 'node_modules', 'electron', 'dist', electron)
    if (existsSync(globalElectron)) {
      candidates.push({ kind: 'electron', command: globalElectron, args })
    }
  }

  // --- 4. dsh binary root (from process.argv[1]) — the harness or any
  //     sibling project that happens to have electron in its node_modules ---
  const dshRoot = findDshRoot(cwd)
  if (dshRoot) {
    for (const base of [
      resolve(dshRoot, 'node_modules', 'electron', 'dist'),
      resolve(dshRoot, 'desktop', 'node_modules', 'electron', 'dist'),
    ]) {
      const command = resolve(base, electron)
      if (existsSync(command)) {
        candidates.push({ kind: 'electron', command, args })
        break
      }
    }
  }

  // --- 5. cwd fallback — profile directory or local dev checkout ---
  for (const base of [
    resolve(cwd, 'desktop/node_modules/electron/dist'),
    resolve(cwd, 'node_modules/electron/dist'),
  ]) {
    const command = resolve(base, electron)
    if (existsSync(command)) {
      candidates.push({ kind: 'electron', command, args })
      break
    }
  }

  return candidates
}

/** First usable backend, or null when none is available. */
export function resolveBackend(options) {
  return backendCandidates(options)[0] ?? null
}

/**
 * Manages the spawned pet window process. `start()` is a no-op when the
 * window already runs or when no backend was found (the browser pet stays
 * as the fallback). `stop()` tears the process down; `running` reflects whether
 * a window process is alive; `onExit` fires when the window dies.
 */
export class DesktopWindow {
  constructor({
    url,
    backend = resolveBackend(),
    parentPid = process.pid,
    logger = console,
    spawnImpl = spawn,
    onExit,
  } = {}) {
    if (!url) throw new Error('DesktopWindow requires a --url')
    this.url = url
    this.backend = backend
    this.parentPid = parentPid
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.onExit = onExit
    this.child = undefined
    this.startNonce = Date.now()
  }

  get running() {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  start() {
    if (this.running) return this.child
    if (!this.backend) {
      this.logger.info?.('dsh-pet-remielle: no Electron backend found, browser pet remains')
      return undefined
    }
    const child = this.spawnImpl(this.backend.command, this.backend.args, {
      cwd: dirname(this.backend.command),
      // inherit：让 pet 进程的诊断日志（[pet-geo:*]/[pet-drag] 等）直达宿主
      // 控制台；此前 'ignore' 曾把现场取证所需的全部输出吞掉。
      stdio: 'inherit',
      windowsHide: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        DSH_PET_URL: this.url + (this.url.includes('?') ? '&' : '?') + 'v=' + this.startNonce,
        DSH_PET_PARENT_PID: String(this.parentPid),
      },
    })
    this.child = child
    child.once('error', (error) => {
      this.logger.error?.(`dsh-pet-remielle: pet window failed to start: ${error.message}`)
      this.child = undefined
    })
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
      this.onExit?.()
    })
    return child
  }

  /** Stop the pet window and resolve once its process has exited (immediately
   *  when it was not running). Callers that must release file locks before
   *  replacing plugin files (self-update) await the returned promise. */
  stop(reason = 'stopped') {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      // 兜底定时：万一 kill 失败且 exit 事件不来，也不能把更新流程卡死
      const fallback = setTimeout(resolve, 5000)
      if (typeof fallback.unref === 'function') fallback.unref()
      child.once('exit', () => {
        clearTimeout(fallback)
        resolve()
      })
      try {
        child.kill()
      } catch (error) {
        this.logger.warn?.(`dsh-pet-remielle: pet window kill failed (${reason}): ${String(error)}`)
      }
    })
  }
}
