/**
 * Desktop-window bridge: discover an Electron backend and spawn the pet
 * window process (src/pet-window.cjs, which loads the pet-view page).
 *
 * Electron backends, in preference order:
 *   1. DSH_PET_ELECTRON env var override.
 *   2. The bundled Electron runtime (vendor/electron-win32-x64) — ships with
 *      the plugin, so every user (plain web DSH host included) gets the same
 *      floating window with browser-engine GIF animation.
 *   3. The harness's own Electron install (desktop/node_modules/electron) —
 *      fallback when the bundled runtime is absent (e.g. a dev checkout that
 *      did not download the vendor directory).
 *
 * Configuration travels via environment variables (DSH_PET_URL /
 * DSH_PET_PARENT_PID): passing extra CLI args to a spawned Electron on
 * Windows crashes with exit -1, while env is stable.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundledElectron = resolve(here, '..', 'vendor', 'electron-win32-x64', 'electron.exe')

/**
 * Candidate Electron backends, in preference order. Platform and cwd are
 * injectable for tests.
 * @returns `[{ kind: 'electron', command, args }]`.
 */
export function backendCandidates({ platform = process.platform, cwd = process.cwd() } = {}) {
  const candidates = []
  if (process.env.DSH_PET_ELECTRON) {
    candidates.push({ kind: 'electron', command: process.env.DSH_PET_ELECTRON, args: [resolve(here, 'pet-window.cjs')] })
  }
  const electron = platform === 'win32' ? 'electron.exe' : 'electron'
  if (platform === 'win32' && existsSync(bundledElectron)) {
    candidates.push({ kind: 'electron', command: bundledElectron, args: [resolve(here, 'pet-window.cjs')] })
  }
  for (const base of [
    resolve(cwd, 'desktop/node_modules/electron/dist'),
    resolve(cwd, 'node_modules/electron/dist'),
  ]) {
    const command = resolve(base, electron)
    if (existsSync(command)) {
      candidates.push({ kind: 'electron', command, args: [resolve(here, 'pet-window.cjs')] })
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
 * the fallback). `stop()` tears the process down; `running` reflects whether
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
      stdio: 'ignore',
      // GUI backends have no console of their own; CREATE_NO_WINDOW
      // (windowsHide) crashes some Electron launches on Windows, keep it off.
      windowsHide: false,
      env: {
        ...process.env,
        // Never inherit the harness shell's Electron-as-node mode: some
        // shells launch their gateway through ELECTRON_RUN_AS_NODE, which
        // would make our bundled electron.exe run the window script as plain
        // node and exit without creating a window. undefined keys are dropped
        // by Node's spawn, so this sanitizes the child environment.
        ELECTRON_RUN_AS_NODE: undefined,
        // Cache-busting nonce: a fresh query every spawn forces Electron to
        // re-fetch the pet-view page instead of serving a stale cached copy.
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

  stop(reason = 'stopped') {
    const child = this.child
    this.child = undefined
    if (!child) return
    try {
      child.kill()
    } catch (error) {
      this.logger.warn?.(`dsh-pet-remielle: pet window kill failed (${reason}): ${String(error)}`)
    }
  }
}
