/**
 * pet-window 的 userData 目录决策（issue #21 追加建议）。
 *
 * 这个目录要同时满足三条互相拉扯的约束：
 *
 *  ① 与宿主的 Electron 隔离。共享默认的 %APPDATA%/Electron 会锁住磁盘缓存、
 *     服务到陈旧响应（历史 bug：桌宠页面继续跑已经删掉的旧右键逻辑），所以
 *     必须是独立目录，不能图省事直接用默认路径。
 *  ② 落在稳定位置。原实现用 %TEMP%/dsh-pet-remielle —— 系统磁盘清理会整目录
 *     删掉，Electron 缓存与渲染层 localStorage 的位置兜底一起丢。
 *  ③ 同一时刻只被一个 pet-window 进程使用。宿主退出靠看门狗探测，快速重启
 *     宿主时新旧实例会重叠；两个进程共用一个 Chromium profile 会重新引出 ①
 *     的陈旧缓存问题。故用占用标记记录 pid，被活跃进程占用时退避到带自己 pid
 *     的兄弟目录。
 *
 * 退避是「尽力而为」：它只保证两个实例不打架，代价是这一次的 localStorage
 * 位置兜底从零开始（宿主持久化的窗口坐标不受影响，走的是另一条链路）。
 *
 * 本文件只做纯逻辑、不 require electron，便于直接单测。
 */

const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

/** 稳定目录名（与插件同名，便于用户在 %APPDATA% 里辨认）。 */
const DIR_NAME = 'dsh-pet-remielle'
/** 占用标记文件名。 */
const LOCK_FILE = 'pet-window.lock'

/** 稳定目录：`<appData>/dsh-pet-remielle`。 */
function baseDirOf(appDataDir) {
  return path.join(appDataDir, DIR_NAME)
}

/** 退避目录：`<appData>/dsh-pet-remielle-<pid>`（稳定目录被活跃实例占用时用）。 */
function fallbackDirOf(appDataDir, pid) {
  return `${baseDirOf(appDataDir)}-${pid}`
}

/** 占用标记路径。始终落在稳定目录里，退避实例也要读它。 */
function lockPathOf(appDataDir) {
  return path.join(baseDirOf(appDataDir), LOCK_FILE)
}

/**
 * pid 是否仍存活。ESRCH = 进程不存在；EPERM = 存在但无权发信号——后者恰恰
 * 说明进程还在（DSH Desktop 的 NodeService 宿主就是这种），绝不能当成已退出。
 * 判据与 pet-window.cjs 的宿主看门狗保持一致。
 */
function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** 读占用标记里的 pid；文件缺失 / JSON 损坏 / 内容非法一律返回 null（视为空闲）。 */
function readOccupantPid(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    const pid = Number(parsed && parsed.pid)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 写占用标记（父目录不存在则建）。失败不抛——退化成「不互斥」而不是起不来。 */
function writeLock(lockPath, pid) {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: Number(pid), startedAt: Date.now() }), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 释放占用标记。只在标记仍属于自己时才删——否则会把接手者的标记误删，让下一次
 * 启动失去互斥保护。
 */
function releaseLock(lockPath, pid) {
  try {
    if (readOccupantPid(lockPath) !== Number(pid)) return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 选出本次要用的 userData 目录。
 *
 * @param {object} options
 * @param {string} options.appDataDir 稳定根目录（Electron 的 `app.getPath('appData')`）
 * @param {number} options.pid 本进程 pid
 * @param {number|null} [options.occupantPid] 占用标记里的 pid（可先读好传入）
 * @param {(pid: number) => boolean} [options.isAlive] 存活探测（默认真探测，测试可注入）
 * @returns {{dir: string, baseDir: string, lockPath: string, fallback: boolean, occupantPid: number|null, ownsLock: boolean}}
 */
function resolveUserDataDir({ appDataDir, pid, occupantPid = null, isAlive = isProcessAlive }) {
  const baseDir = baseDirOf(appDataDir)
  const seen = Number(occupantPid)
  // 只有「别的、还活着的进程占着稳定目录」才退避：占用者是自己上次的残留
  // （pid 相同）或已经死掉（崩溃残留）都直接复用稳定目录，实现自愈。
  const busy = Number.isInteger(seen) && seen > 0 && seen !== Number(pid) && isAlive(seen)
  return {
    dir: busy ? fallbackDirOf(appDataDir, pid) : baseDir,
    baseDir,
    lockPath: lockPathOf(appDataDir),
    fallback: busy,
    occupantPid: busy ? seen : null,
    // 退避者不去动稳定目录的标记：那个标记属于稳定目录的使用者，退避者覆盖它
    // 会让真正的主人退出时误判「不是我的」而把坏标记留在盘上。
    ownsLock: !busy,
  }
}

module.exports = {
  DIR_NAME,
  LOCK_FILE,
  baseDirOf,
  fallbackDirOf,
  isProcessAlive,
  lockPathOf,
  readOccupantPid,
  releaseLock,
  resolveUserDataDir,
  writeLock,
}
