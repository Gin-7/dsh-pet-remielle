/**
 * On-demand Electron runtime fetch for the dsh-pet-remielle desktop window.
 *
 * The floating desktop window needs a real Electron binary (~221MB, which is
 * why it is NOT bundled into the Git repo — see README "桌面模式运行时"). This
 * module lets the host fetch it automatically the first time desktop mode is
 * used, instead of making the user hunt down a 221MB zip by hand.
 *
 * Behaviour policy ("用户不一定能访问外网"):
 *  - Tries the npmmirror binary mirror first (fast for CN users), then the
 *    official GitHub release. If every source fails it rejects and the caller
 *    falls back to the in-page pet — never crashes the plugin.
 *  - Concurrency-safe: concurrent calls while a fetch is in flight share one
 *    promise (single in-process lock across the whole host).
 *  - Idempotent: if `vendor/electron-win32-x64/electron.exe` already exists it
 *    resolves immediately without touching the network.
 *
 * Files land exactly where `desktop-window.js`'s `bundledElectron` path points,
 * so a later `resolveBackend()` picks the freshly installed runtime up with no
 * reconfiguration:    <repo>/vendor/electron-win32-x64/electron.exe
 */

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const VENDOR_DIR = resolve(here, '..', 'vendor', 'electron-win32-x64')
export const ELECTRON_EXE = resolve(VENDOR_DIR, 'electron.exe')

/** Electron major we target — a stock win32-x64 build in this range works. */
export const ELECTRON_VERSION = '33.0.0'

/** Download candidates, best first. Each is the full zip URL (win32-x64). */
export function downloadMirrors(version = ELECTRON_VERSION) {
  // npmmirror hosts the exact same release artifacts as GitHub releases and is
  // much faster / reliable from mainland China. Forward slashes only.
  const name = `electron-v${version}-win32-x64.zip`
  return [
    `https://registry.npmmirror.com/-/binary/electron/v${version}/${name}`,
    `https://github.com/electron/electron/releases/download/v${version}/${name}`,
  ]
}

/** In-process lock so concurrent `ensureElectronRuntime` calls share one fetch. */
let inflight = null

/**
 * Ensure the bundled Electron runtime exists, downloading it on demand.
 *
 * @param {object} [options]
 * @param {string[]} [options.mirrors]   zip URLs to try, in order.
 * @param {string}  [options.vendorDir]  target directory for the runtime (defaults to <repo>/vendor/electron-win32-x64).
 * @param {(m: string) => void} [options.onProgress]  human-readable progress callback.
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [options.spawnImpl] injectable spawn (for tests).
 * @returns {Promise<string>}  absolute path to electron.exe on success.
 * @throws  when every mirror fails and no runtime can be placed.
 */
export async function ensureElectronRuntime({
  mirrors = downloadMirrors(),
  vendorDir = VENDOR_DIR,
  onProgress,
  spawnImpl = spawn,
  fetchImpl = fetch,
} = {}) {
  const electronExe = resolve(vendorDir, 'electron.exe')
  if (existsSync(electronExe)) return electronExe
  // Serialise concurrent requests across the whole host process.
  if (inflight) return inflight
  const run = (async () => {
    const work = `${vendorDir}.tmp-${process.pid}-${Date.now()}`
    const zip = `${work}.zip`
    try {
      mkdirSync(work, { recursive: true })
      let lastError = null
      for (let i = 0; i < mirrors.length; i++) {
        const url = mirrors[i]
        const label = `(${i + 1}/${mirrors.length})`
        onProgress?.(`正在下载 Electron ${ELECTRON_VERSION} ${label}…`)
        try {
          await downloadFile(url, zip, onProgress && ((p) => onProgress(`正在下载 Electron ${ELECTRON_VERSION} ${label}：${p}`)), fetchImpl)
          break
        } catch (error) {
          lastError = error
          onProgress?.(`下载源 ${i + 1} 失败（${error.message}），尝试下一个…`)
          try { rmSync(zip, { force: true }) } catch { /* ignore */ }
          if (i === mirrors.length - 1) {
            throw new Error(`所有 Electron 下载源均失败：${lastError.message}`, { cause: lastError })
          }
        }
      }
      onProgress?.('正在解压 Electron…')
      await unzip(zip, work, spawnImpl)
      mkdirSync(vendorDir, { recursive: true })
      await moveContents(work, vendorDir)
      if (!existsSync(electronExe)) {
        throw new Error(`解压后未找到 electron.exe（${electronExe}）`)
      }
      onProgress?.('Electron 已就绪')
      return electronExe
    } finally {
      for (const p of [work, zip]) {
        try { rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      inflight = null
    }
  })()
  inflight = run
  return run
}

/** Stream a URL to disk with a rough percent progress. */
async function downloadFile(url, dest, onProgress, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r))
      }
      received += value.length
      if (onProgress && total > 0) onProgress(`${Math.round((received / total) * 100)}%`)
    }
    await new Promise((resolveFinish, rejectFinish) => {
      out.once('error', rejectFinish)
      out.end(() => resolveFinish())
    })
  } finally {
    reader.releaseLock?.()
  }
  // Fail loudly on a truncated/zero-length download rather than feeding a
  // corrupt zip to the unzip step.
  if (received === 0) throw new Error('下载内容为空')
}

/** Extract a zip via the platform unzip. On win32 use bsdtar (ships with Windows). */
async function unzip(zip, dest, spawnImpl) {
  mkdirSync(dest, { recursive: true })
  await runProgram(spawnImpl, 'tar.exe', ['-xf', zip, '-C', dest, '--strip-components=0'], dest)
}

/** Recursively move directory contents up into `target` (works across drives). */
async function moveContents(src, target) {
  const { readdir, copyFile, mkdir } = await import('node:fs/promises')
  const { join, relative } = await import('node:path')
  await mkdir(target, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      // Recurse and then remove the emptied source dir.
      await moveContents(from, to)
      try { rmSync(from, { recursive: true, force: true }) } catch { /* ignore */ }
    } else {
      await copyFile(from, to)
    }
  }
}

/** Run a child program to completion; reject on non-zero exit. */
function runProgram(spawnImpl, command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(command, args, { cwd, stdio: 'ignore', windowsHide: true })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${command} 退出码 ${code}`))
    })
  })
}
