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

// Isolate the pet window's userData: sharing the default %APPDATA%/Electron
// with the harness shell locks the disk cache and can serve stale cached
// responses (the page kept running the old right-click-to-close logic).
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-pet-remielle'))

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
  function applyIgnore(on) {
    on = Boolean(on)
    if (on === clickThrough) return
    clickThrough = on
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
  const hitTimer = setInterval(syncIgnore, 16)

  // JS-driven dragging from the pet image: move the window by deltas.
  ipcMain.on('move-window', (_event, dx, dy) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
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

  win.loadURL(url)
  win.webContents.on('did-finish-load', () => console.log('[pet] loaded:', win.webContents.getURL()))
  win.webContents.on('did-fail-load', (_e, code, desc, furl) => console.log('[pet] FAIL:', code, desc, furl))
  win.webContents.on('console-message', (_e, level, msg) => console.log('[pet-console]', level, String(msg).slice(0, 160)))
  win.once('ready-to-show', () => { console.log('[pet] ready-to-show'); win.show() })
  win.on('closed', () => {
    clearInterval(hitTimer)
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
