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
 *  - Idempotent: if the runtime binary for the current platform already exists it
 *    resolves immediately without touching the network.
 *
 * Files land exactly where `desktop-window.js`'s `bundledElectron` path points,
 * so a later `resolveBackend()` picks the freshly installed runtime up with no
 * reconfiguration:    <repo>/vendor/electron-<platform>-<arch>/<binary>
 */

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Map an OS/arch to the Electron release artifact triple plus the on-disk
 * folder name and the path (relative to that folder) of the launchable
 * Electron binary.
 *
 * Windows keeps the exact original layout (`electron-win32-x64/electron.exe`)
 * so Windows behaviour is byte-for-byte unchanged. macOS uses the `.app`
 * bundle binary; Linux uses the bare `electron` binary.
 *
 * @param {string} [platform]  process.platform (injectable for tests).
 * @param {string} [arch]      process.arch (injectable for tests).
 */
export function runtimeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return { tag: 'win32-x64', folder: 'electron-win32-x64', sub: ['electron.exe'] }
  }
  if (platform === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x64'
    return { tag: `darwin-${a}`, folder: `electron-darwin-${a}`, sub: ['Electron.app', 'Contents', 'MacOS', 'Electron'] }
  }
  if (platform === 'linux') {
    return { tag: 'linux-x64', folder: 'electron-linux-x64', sub: ['electron'] }
  }
  return { tag: `${platform}-${arch}`, folder: `electron-${platform}-${arch}`, sub: ['electron'] }
}

/** Absolute path to the launchable Electron binary inside a dist/vendor root. */
export function electronBinaryIn(dir, platform = process.platform, arch = process.arch) {
  return resolve(dir, ...runtimeTarget(platform, arch).sub)
}

export const VENDOR_DIR = resolve(here, '..', 'vendor', runtimeTarget().folder)
export const ELECTRON_EXE = electronBinaryIn(VENDOR_DIR)

/** Electron major we target — a stock build in this range works on any OS. */
export const ELECTRON_VERSION = '33.0.0'

/** Download candidates, best first. Each is the full zip URL for the current
 *  platform/arch (npmmirror first: fast in mainland China, then GitHub). */
export function downloadMirrors(version = ELECTRON_VERSION, platform = process.platform, arch = process.arch) {
  const name = `electron-v${version}-${runtimeTarget(platform, arch).tag}.zip`
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
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const electronExe = electronBinaryIn(vendorDir, platform, arch)
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
      // 直接解压进 vendorDir，而不是先解到临时目录再逐文件 moveContents：
      // macOS 的 Electron.app bundle 内含符号链接/特殊文件，copyFile 会因
      // ENOTSUP 失败；bsdtar/tar 解压会原样保留它们。vendorDir 是全新目录
      //（下载前已 rm），解压后直接校验可执行文件即可。
      rmSync(vendorDir, { recursive: true, force: true })
      mkdirSync(vendorDir, { recursive: true })
      await unzip(zip, vendorDir, spawnImpl, platform)
      if (!existsSync(electronExe)) {
        const target = runtimeTarget(platform, arch)
        throw new Error(`解压后未找到 Electron 可执行文件（${electronExe}）——期望安装包内含 ${target.tag} 的 ${target.sub.join('/')}`)
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

/** Extract a zip via the platform unzip. On win32 use bsdtar (ships with
 *  Windows); on macOS/Linux use the standard `tar` (bsdtar on macOS). */
async function unzip(zip, dest, spawnImpl, platform = process.platform) {
  mkdirSync(dest, { recursive: true })
  const tar = platform === 'win32' ? 'tar.exe' : 'tar'
  await runProgram(spawnImpl, tar, ['-xf', zip, '-C', dest, '--strip-components=0'], dest)
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
