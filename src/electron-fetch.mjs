/**
 * On-demand Electron runtime fetch for the dsh-pet-remielle desktop window.
 *
 * The floating desktop window needs a real Electron binary (~221MB, which is
 * why it is NOT bundled into the Git repo — see README "桌面模式运行时"). This
 * module lets the host fetch it automatically the first time desktop mode is
 * used, instead of making the user hunt down a large zip by hand.
 *
 * Cross-platform: the artifact layout (vendor dir, executable name, zip name)
 * is resolved from the current platform/arch, so the same code works on
 * Windows, Linux and macOS.
 *
 * Behaviour policy ("用户不一定能访问外网"):
 *  - Tries the npmmirror binary mirror first (fast for CN users), then the
 *    official GitHub release. If every source fails it rejects and the caller
 *    falls back to the in-page pet — never crashes the plugin.
 *  - Concurrency-safe: concurrent calls while a fetch is in flight share one
 *    promise (single in-process lock across the whole host).
 *  - Idempotent: if the runtime binary already exists in the vendor dir it
 *    resolves immediately without touching the network.
 *
 * Files land exactly where `desktop-window.js`'s bundled-Electron lookup points
 * (`electronArtifact().exe`), so a later `resolveBackend()` picks the freshly
 * installed runtime up with no reconfiguration.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Electron major we target — a stock build in this range works on any platform. */
export const ELECTRON_VERSION = '33.0.0'

/**
 * Resolve the Electron artifact layout for a platform/arch. `platform` uses
 * node's tokens ('win32' | 'linux' | 'darwin'), which match Electron's release
 * zip naming. `binary` is the executable name (electron.exe on Windows,
 * electron elsewhere). `vendorDir`/`exe` point where the runtime is installed.
 */
export function electronArtifact({ platform = process.platform, arch = process.arch } = {}) {
  const binary = platform === 'win32' ? 'electron.exe' : 'electron'
  const dir = `electron-${platform}-${arch}`
  return {
    platform,
    arch,
    binary,
    zipName: `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`,
    vendorDir: resolve(here, '..', 'vendor', dir),
    exe: resolve(here, '..', 'vendor', dir, binary),
  }
}

export const VENDOR_DIR = electronArtifact().vendorDir
export const ELECTRON_EXE = electronArtifact().exe

/**
 * Download candidates, best first. Each is the full zip URL for the given
 * platform/arch (defaults to the current one).
 */
export function downloadMirrors(version = ELECTRON_VERSION, platform = process.platform, arch = process.arch) {
  // npmmirror hosts the exact same release artifacts as GitHub releases and is
  // much faster / reliable from mainland China. Forward slashes only.
  const name = `electron-v${version}-${platform}-${arch}.zip`
  return [
    `https://registry.npmmirror.com/-/binary/electron/v${version}/${name}`,
    `https://github.com/electron/electron/releases/download/v${version}/${name}`,
  ]
}

/** In-process lock so concurrent `ensureElectronRuntime` calls share one fetch. */
let inflight = null

/**
 * Ensure the Electron runtime exists, downloading it on demand.
 *
 * @param {object} [options]
 * @param {string[]} [options.mirrors]   zip URLs to try, in order.
 * @param {string}  [options.vendorDir]  target directory for the runtime (defaults to the platform vendor dir).
 * @param {string}  [options.binary]     executable name to place / look for (defaults to the platform binary).
 * @param {(m: string) => void} [options.onProgress]  human-readable progress callback.
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [options.spawnImpl] injectable spawn (for tests).
 * @returns {Promise<string>}  absolute path to the Electron binary on success.
 * @throws  when every mirror fails and no runtime can be placed.
 */
export async function ensureElectronRuntime({
  mirrors = downloadMirrors(),
  vendorDir = VENDOR_DIR,
  binary = electronArtifact().binary,
  onProgress,
  spawnImpl = spawn,
  fetchImpl = fetch,
} = {}) {
  const electronExe = resolve(vendorDir, binary)
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
      const distDir = findDistDir(work, binary)
      mkdirSync(vendorDir, { recursive: true })
      await moveContents(distDir, vendorDir)
      if (!existsSync(electronExe)) {
        throw new Error(`解压后未找到 ${binary}（${electronExe}）`)
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

/**
 * Locate the Electron distribution dir inside `work`: either `work` itself
 * (zip contents at the root) or the single top-level dir the zip contains.
 * The Electron release zips are not consistent about the top-level dir, so
 * handle both.
 */
function findDistDir(work, binary) {
  if (existsSync(join(work, binary))) return work
  const subdirs = readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const sub of subdirs) {
    if (existsSync(join(work, sub.name, binary))) return join(work, sub.name)
  }
  if (subdirs.length === 1) return join(work, subdirs[0].name)
  throw new Error(`未在解压目录找到 ${binary}：${work}`)
}

/**
 * Extract a zip using whichever platform tool is available. On Windows the
 * built-in bsdtar (tar.exe) handles zip; on Linux/macOS prefer `unzip`, then
 * bsdtar, then tar. Tries candidates in order and succeeds on the first that
 * runs cleanly.
 */
async function unzip(zip, dest, spawnImpl) {
  mkdirSync(dest, { recursive: true })
  const isWin = process.platform === 'win32'
  const attempts = isWin
    ? [
        ['tar.exe', ['-xf', zip, '-C', dest, '--strip-components=0']],
        ['unzip', ['-o', zip, '-d', dest]],
      ]
    : [
        ['unzip', ['-o', zip, '-d', dest]],
        ['bsdtar', ['-xf', zip, '-C', dest]],
        ['tar', ['-xf', zip, '-C', dest]],
      ]
  let lastError = null
  for (const [cmd, args] of attempts) {
    try {
      await runProgram(spawnImpl, cmd, args, dest)
      return
    } catch (error) {
      lastError = error
      // Clear any partial extraction before trying the next tool.
      try {
        for (const entry of readdirSync(dest)) {
          rmSync(join(dest, entry), { recursive: true, force: true })
        }
      } catch { /* ignore */ }
    }
  }
  throw lastError
}

/** Recursively move directory contents up into `target` (works across drives). */
async function moveContents(src, target) {
  const { readdir, copyFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
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
