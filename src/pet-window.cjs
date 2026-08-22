/**
 * Pet window main script — spawned by src/desktop-window.js.
 *
 * CommonJS on purpose: Electron's ESM main script support is unreliable on
 * Windows (crashes with exit -1 during app startup), while .cjs works.
 *
 * Configuration arrives via environment variables (DSH_PET_URL,
 * DSH_PET_PARENT_PID): passing extra CLI args to a spawned Electron on
 * Windows crashes with exit -1, while env is stable.
 *
 * Creates a frameless, transparent, always-on-top window that loads the
 * plugin's pet-view page (pet GIF + status bubble over the SSE stream).
 * The window watches the parent host pid and quits when the host exits, so
 * closing DSH tears the pet down without leaving a stray process.
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Isolate the pet window's userData: sharing the default %APPDATA%/Electron
// with the harness shell locks the disk cache and can serve stale cached
// responses (the page kept running the old right-click-to-close logic).
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-pet-remielle'))

// 拖动漂移诊断：把窗口移动来源写入日志（临时排查用，定位后移除）。
const DRAG_DEBUG_LOG = path.join(app.getPath('temp'), 'dsh-pet-remielle', 'drag-debug.log')
let lastMoveLog = 0
function debugLog(message) {
  try {
    fs.appendFileSync(DRAG_DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch { /* 日志失败不影响功能 */ }
}

const url = process.env.DSH_PET_URL
const parentPid = Number(process.env.DSH_PET_PARENT_PID || 0)

if (!url) {
  console.error('dsh-pet-window: missing DSH_PET_URL')
  app.exit(1)
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400,
    height: 520,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'pet-preload.cjs'),
    },
  })

  // Click-through: transparent margins must not block the desktop. Renderer
  // mousemove + { forward: true } does not work on Windows when only the
  // wallpaper is behind the window, so the main process polls the cursor
  // against hit rects reported by the page.
  let clickThrough = false
  let forceInteractive = false
  let hitRects = null
  let hitTimer = null
  function ensureHitTimer() {
    if (hitTimer != null) return
    hitTimer = setInterval(syncIgnore, 16)
  }
  function stopHitTimer() {
    if (hitTimer == null) return
    clearInterval(hitTimer)
    hitTimer = null
  }
  function applyIgnore(on) {
    on = Boolean(on)
    if (on === clickThrough) return
    clickThrough = on
    if (clickThrough) ensureHitTimer()
    else stopHitTimer()
    try {
      win.setIgnoreMouseEvents(on, { forward: true })
    } catch {
      win.setIgnoreMouseEvents(on)
    }
  }
  function cursorHits() {
    if (forceInteractive) return true
    if (!hitRects || hitRects.length === 0) return false
    const pt = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    const x = pt.x - b.x
    const y = pt.y - b.y
    for (const r of hitRects) {
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return true
    }
    return false
  }
  function syncIgnore() {
    if (!win || win.isDestroyed()) return
    if (forceInteractive) {
      applyIgnore(false)
      return
    }
    // Only recover interactivity. Leaving the pet is driven by renderer
    // mousemove; Windows will not forward those events over the wallpaper.
    if (clickThrough && cursorHits()) applyIgnore(false)
  }
  ipcMain.on('set-click-through', (_event, on) => {
    if (forceInteractive) return
    applyIgnore(Boolean(on))
  })
  ipcMain.on('force-interactive', (_event, on) => {
    forceInteractive = Boolean(on)
    if (forceInteractive) applyIgnore(false)
    else syncIgnore()
  })
  ipcMain.on('hit-rects', (_event, rects) => {
    if (!Array.isArray(rects)) return
    hitRects = []
    for (const r of rects) {
      if (!r) continue
      const x = Number(r.x)
      const y = Number(r.y)
      const w = Number(r.w)
      const h = Number(r.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
      if (w < 1 || h < 1) continue
      hitRects.push({ x, y, w, h })
    }
    syncIgnore()
  })

  // JS-driven dragging from the pet image: closed-loop absolute positioning.
  // The renderer only signals drag lifecycle; the main process keeps the
  // window pinned at (cursor - grab offset). Some Electron/Windows builds
  // return PHYSICAL pixels from getCursorScreenPoint() while bounds APIs are
  // DIP; the ratio is measured at drag start from the known on-page grab
  // point (cursorDip ≈ windowPos + clientX/Y), so either convention works.
  let drag = null
  ipcMain.on('drag-start', (_event, clientX, clientY) => {
    clientX = Number(clientX) || 0
    clientY = Number(clientY) || 0
    const [x, y] = win.getPosition()
    const physical = screen.getCursorScreenPoint()
    const dipX = x + clientX
    const dipY = y + clientY
    const clamp = (v) => Math.min(4, Math.max(0.5, v))
    // 比例按轴独立实测；抓取点太靠边（除数过小）时该轴退回 1。
    const sx = clientX > 4 && Math.abs(physical.x - dipX) > 1 ? clamp(physical.x / dipX) : 1
    const sy = clientY > 4 && Math.abs(physical.y - dipY) > 1 ? clamp(physical.y / dipY) : 1
    drag = { ox: clientX, oy: clientY, sx: sx, sy: sy, tx: NaN, ty: NaN }
    debugLog(`drag-start client=${clientX},${clientY} pos=${x},${y} cursor=${physical.x},${physical.y} scale=${sx.toFixed(3)},${sy.toFixed(3)} dsf=${screen.getPrimaryDisplay().scaleFactor}`)
  })
  ipcMain.on('drag-move', () => {
    if (!drag) return
    const pt = screen.getCursorScreenPoint()
    const nx = Math.round(pt.x / drag.sx - drag.ox)
    const ny = Math.round(pt.y / drag.sy - drag.oy)
    // 关键：以「目标是否变化」为去重依据，而不是 getPosition() 读回值。
    // 非整数缩放（如 110%）下 DIP→物理→DIP 回读存在截断误差，读回值会
    // 永远比目标差 1px；若据此重试，每次合成 mousemove 都会把窗口向右下
    // 再推 1 物理像素，表现为按住不动时窗口持续漂移。
    if (nx === drag.tx && ny === drag.ty) return
    drag.tx = nx
    drag.ty = ny
    debugLog(`drag-move cursor=${pt.x},${pt.y} -> ${nx},${ny}`)
    win.setPosition(nx, ny)
  })
  ipcMain.on('drag-end', () => {
    debugLog('drag-end')
    drag = null
  })
  // 任何"不是 drag-move 发起"的窗口移动都会出现在这里，用于定位漂移来源。
  win.on('move', () => {
    const now = Date.now()
    if (now - lastMoveLog < 150) return
    lastMoveLog = now
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    debugLog(`window-move -> ${x},${y} dragging=${Boolean(drag)}`)
  })

  // Return current window position for persistence.
  ipcMain.handle('get-position', () => {
    const [x, y] = win.getPosition()
    return { x: Math.round(x), y: Math.round(y) }
  })

  // Draw-artwork popup: a separate transparent always-on-top window parked at
  // the desktop (screen) top-right, so the painting never covers the pet or
  // its bubble. The page streams frames as data URLs.
  const ART_HTML = '<html><body style="margin:0;background:transparent;overflow:hidden"><img id="art" style="width:100%;height:100%;display:block;border-radius:10px"></body></html>'
  let artWin = null
  let artPending = null
  let artLoaded = false
  function artSet(dataUrl) {
    if (!artWin || artWin.isDestroyed()) return
    if (!artLoaded) {
      artPending = dataUrl
      return
    }
    artWin.webContents.executeJavaScript(`document.getElementById('art').src = ${JSON.stringify(dataUrl)}`).catch(() => {})
  }
  ipcMain.on('artwork-open', (_event, w, h) => {
    w = Math.max(60, Math.round(Number(w) || 220))
    h = Math.max(60, Math.round(Number(h) || 220))
    if (artWin && !artWin.isDestroyed()) { artWin.setBounds({ width: w, height: h }); return }
    const work = screen.getPrimaryDisplay().workArea
    artWin = new BrowserWindow({
      width: w,
      height: h,
      x: Math.round(work.x + work.width - w - 24),
      y: Math.round(work.y + 24),
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      webPreferences: { sandbox: true },
    })
    artWin.setAlwaysOnTop(true, 'screen-saver')
    artWin.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
    artWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ART_HTML))
    artWin.webContents.once('did-finish-load', () => {
      artLoaded = true
      artWin.show()
      if (artPending) {
        artWin.webContents.executeJavaScript(`document.getElementById('art').src = ${JSON.stringify(artPending)}`).catch(() => {})
        artPending = null
      }
    })
    artWin.on('closed', () => { artWin = null; artPending = null; artLoaded = false })
  })
  ipcMain.on('artwork-set', (_event, dataUrl) => artSet(String(dataUrl)))
  // 连续双击重开：清空画面并复位淡出状态。若在上一幅的得意停留/淡出过程中
  // 重开，img 的 src 还挂着旧图、opacity 可能已被置 0——不清理的话，新一轮
  // 加载完成前会闪现旧画，甚至新画推帧后也因 opacity=0 而不可见。
  const ART_BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  ipcMain.on('artwork-clear', () => {
    artPending = null
    if (!artWin || artWin.isDestroyed() || !artLoaded) return
    artWin.webContents.executeJavaScript(
      `const i=document.getElementById('art');i.style.transition='none';i.style.opacity='1';i.src=${JSON.stringify(ART_BLANK)}`
    ).catch(() => {})
  })
  ipcMain.on('artwork-fade', () => {
    if (!artWin || artWin.isDestroyed() || !artLoaded) return
    artWin.webContents.executeJavaScript(
      `const i=document.getElementById('art');i.style.transition='opacity 0.8s ease-out';i.style.opacity='0'`
    ).catch(() => {})
  })
  ipcMain.on('artwork-close', () => {
    if (artWin && !artWin.isDestroyed()) artWin.close()
    artWin = null
    artPending = null
    artLoaded = false
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
  debugLog(`boot electron=${process.versions.electron} dsf=${screen.getPrimaryDisplay().scaleFactor} displays=${screen.getAllDisplays().map((d) => d.scaleFactor).join(',')}`)

  win.loadURL(url)
  win.webContents.on('did-finish-load', () => console.log('[pet] loaded:', win.webContents.getURL()))
  win.webContents.on('did-fail-load', (_e, code, desc, furl) => console.log('[pet] FAIL:', code, desc, furl))
  win.webContents.on('console-message', (_e, level, msg) => console.log('[pet-console]', level, String(msg).slice(0, 160)))
  win.once('ready-to-show', () => { console.log('[pet] ready-to-show'); win.show() })
  win.on('closed', () => {
    stopHitTimer()
    app.quit()
  })

  // Watchdog: when the DSH host process goes away, take the pet with it.
  if (parentPid) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch {
        clearInterval(timer)
        app.quit()
      }
    }, 3000)
    timer.unref?.()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
