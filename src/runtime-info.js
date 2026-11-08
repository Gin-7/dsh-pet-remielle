/**
 * 桌面运行时信息（设置页「桌面运行时」区块的纯逻辑）。
 *
 * 这块只回答两个问题：
 *   1. Electron 运行时缓存和桌宠 userData 目录在哪、各占多少；
 *   2. 用户点「清除」时该删哪些、删了多少。
 *
 * 与 Electron 无关、不 require electron，便于直接单测。真正的删除仍然由调用方
 * （src/index.js 的路由）在确认「桌面窗没在跑」之后触发，避免删掉正在用的
 * Chromium profile / 正在运行的 electron.exe。
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 递归统计文件数与总字节；目录不存在返回 { exists: false }。 */
export async function measureDir(dir, { maxFiles = 20000 } = {}) {
  let info
  try {
    info = await stat(dir)
  } catch {
    return { exists: false, bytes: 0, files: 0 }
  }
  if (!info.isDirectory()) return { exists: true, bytes: info.size, files: 1 }
  let bytes = 0
  let files = 0
  let truncated = false
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(target)
        continue
      }
      try {
        const file = await stat(target)
        bytes += file.size
        files++
      } catch {
        // 统计期间被删/无权限：跳过，不影响其余结果。
      }
      if (files >= maxFiles) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  return { exists: true, bytes, files, truncated }
}

/** 各平台的应用数据根目录（与 Electron app.getPath('appData') 同义）。 */
export function appDataRoot({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME || env.USERPROFILE || homedir()
  if (platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

/** 桌宠 userData 目录：<appData>/dsh-pet-remielle（与 pet-window-paths.cjs 同名）。 */
export function userDataDirOf({ platform = process.platform, env = process.env } = {}) {
  return join(appDataRoot({ platform, env }), 'dsh-pet-remielle')
}

/**
 * 汇总设置页要展示的运行时信息。
 * @param {object} options
 * @param {string} options.cacheDir Electron 运行时缓存目录
 * @param {string} [options.userDataDir] 桌宠 userData 目录
 * @returns {Promise<{cache: object, userData: object}>}
 */
export async function runtimeInfo({ cacheDir, userDataDir, platform = process.platform, env = process.env }) {
  const userDir = userDataDir ?? userDataDirOf({ platform, env })
  const [cache, userData] = await Promise.all([measureDir(cacheDir), measureDir(userDir)])
  return {
    cache: { path: cacheDir, ...cache },
    userData: { path: userDir, ...userData },
  }
}

/**
 * 清理运行时目录。只接受明确的两个目标，不做通配删除。
 *
 * @param {object} options
 * @param {'cache'|'userData'} options.target 要清理的目录
 * @param {string} options.cacheDir Electron 缓存目录
 * @param {string} [options.userDataDir] 桌宠 userData 目录
 * @returns {Promise<{ok: boolean, target: string, path: string, freedBytes: number, files: number, error?: string}>}
 */
export async function clearRuntime({ target, cacheDir, userDataDir, platform = process.platform, env = process.env }) {
  const userDir = userDataDir ?? userDataDirOf({ platform, env })
  const path = target === 'cache' ? cacheDir : target === 'userData' ? userDir : null
  if (!path) return { ok: false, target: String(target), path: '', freedBytes: 0, files: 0, error: 'unknown target' }
  const before = await measureDir(path)
  if (!before.exists) return { ok: true, target, path, freedBytes: 0, files: 0 }
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    return {
      ok: false,
      target,
      path,
      freedBytes: 0,
      files: before.files,
      error: String((error && error.message) || error).slice(0, 200),
    }
  }
  return { ok: true, target, path, freedBytes: before.bytes, files: before.files }
}
