/**
 * Pet window main script — spawned by src/desktop-window.js.
 *
 * CommonJS on purpose: Electron's ESM main script support is unreliable on
 * Windows (crashes with exit -1 during app startup), while .cjs works.
 *
 * Configuration arrives via environment variables (DSH_PET_URL,
 * DSH_WEB_URL, DSH_PET_PARENT_PID): passing extra CLI args to a spawned
 * Electron on Windows crashes with exit -1, while env is stable.
 *
 * Creates a frameless, transparent, always-on-top window that loads the
 * plugin's pet-view page (pet GIF + status bubble over the SSE stream).
 * The window watches the parent host pid and quits when the host exits, so
 * closing DSH tears the pet down without leaving a stray process.
 */

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Isolate the pet window's userData: sharing the default %APPDATA%/Electron
// with the harness shell locks the disk cache and can serve stale cached
// responses (the page kept running the old right-click-to-close logic).
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-pet-remielle'))

const url = process.env.DSH_PET_URL
const parentPid = Number(process.env.DSH_PET_PARENT_PID || 0)

// 该 vendor 运行时在部分 100% 缩放的机器上会把 scaleFactor 误报为 1.1，
// 导致 DIP↔物理换算有损：窗口随每次定位按 ~1.1 倍膨胀、拖动坐标漂移。
// 真实屏幕缩放由系统决定；这里强制按 1 处理，使所有边界换算无损。
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// 拖动定位时同时锁定的内容尺寸（与 BrowserWindow 创建参数一致），
// 防止任何 bounds 往返误差累积改变窗口大小。
const PET_CONTENT_W = 400
const PET_CONTENT_H = 520

// 从注册表读真实系统 DPI 缩放（96=100%），任何失败返回 null 由调用方回退。
// 为什么不能信 screen API：上方 appendSwitch('force-device-scale-factor','1')
// 生效后，screen.getPrimaryDisplay().scaleFactor 会被一起钉成 1（实测 200%
// 屏上无此开关返回 2、加上开关变成 1），拿它算补偿恒为 1、完全失效——
// 这正是高缩放屏上桌宠物理尺寸减半的根因。因此改读注册表的 AppliedDPI
// （REG_DWORD，十六进制如 0xc0=192），它不受 force-dsf 开关影响。
function readSystemScaleFactor() {
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop\\WindowMetrics', '/v', 'AppliedDPI'],
      { encoding: 'utf8' }
    )
    const m = /AppliedDPI\s+REG_DWORD\s+(0x[0-9a-fA-F]+)/i.exec(out)
    const dpi = m ? Number.parseInt(m[1], 16) : NaN
    return Number.isFinite(dpi) && dpi > 0 ? dpi / 96 : null
  } catch {
    return null
  }
}

if (!url) {
  console.error('dsh-pet-window: missing DSH_PET_URL')
  app.exit(1)
}

app.whenReady().then(() => {
  // UI 缩放补偿：上方 force-device-scale-factor=1 把渲染钉在 100%，高缩放屏
  // （真实缩放 R，如 200%）上网页端元素物理大小 = CSS×R，桌宠若不补偿就只有
  // 一半。坐标系事实（Per-Monitor-V2 感知进程实测，200% 屏）：force-dsf=1 下
  // BrowserWindow bounds、getCursorScreenPoint、display.workArea 全部同属
  // 物理像素世界、1:1 直通——此前「bounds = 物理×R 的镜像世界」结论是
  // DPI-unaware 测量进程被 Windows 按 ÷R 虚拟化读数造成的假象，已废弃。
  // 因此 zoom 因子取 R 即可同时满足：窗口物理 = PET_CONTENT×R（网页端基线）、
  // CSS 视口 = 物理/R = PET_CONTENT（布局不变）、元素物理 = CSS×R 与网页一致。
  // R 不能取自 screen API：force-dsf=1 会把 scaleFactor 一起钉成 1（见
  // readSystemScaleFactor 注释），故优先从注册表读真实值，读不到才回退主屏
  // scaleFactor；对 R 按 [0.5,2] 夹取（上限防极端缩放下窗口超出常规显示器）。
// 不采用「去掉 force-dsf 让 Electron 按
  // 真实缩放渲染」的做法：非整数缩放下 DIP↔物理往返有截断误差，拖拽闭环会
  // 复发持续漂移（见 drag-move 去重注释）；保持 dsf=1 的无损换算再补偿。
  // 局限：多显示器缩放不同时以主屏为准，不做跨屏动态切换。
  const scaleRoot = Math.min(2, Math.max(0.5, readSystemScaleFactor() || screen.getPrimaryDisplay().scaleFactor || 1))
  const uiZoom = scaleRoot
  const petW = Math.round(PET_CONTENT_W * uiZoom)
  const petH = Math.round(PET_CONTENT_H * uiZoom)
  const win = new BrowserWindow({
    width: petW,
    height: petH,
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
  // 实测：构造不带 x/y 时 Electron 会把窗口自动 fit 进 workArea；窗口高超过
  // 工作区时会被钳制裁底。setBounds 显式坐标不受此钳制，故创建后立即按当前
  // 位置补回完整尺寸。
  {
    const [px, py] = win.getPosition()
    win.setBounds({ x: px, y: py, width: petW, height: petH })
  }

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
    // hitRects 由渲染层按 CSS px 上报；光标与 bounds 同为物理像素（force-dsf=1
    // 直通），相减得窗口内物理偏移，除 uiZoom 回 CSS。
    const x = (pt.x - b.x) / uiZoom
    const y = (pt.y - b.y) / uiZoom
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
    // 抓取偏移按 CSS px 上报，乘 uiZoom 换算到物理像素世界（与 bounds 同系）
    const dipX = x + clientX * uiZoom
    const dipY = y + clientY * uiZoom
    // force-dsf=1 下光标与 bounds 同为物理像素，physical/dipX 恒为 1；此自校准
    // 仅作为跨 Electron/Windows 构建差异的兜底（见 drag-start 英文注释），
    // 夹取 [0.25,4] 防异常测量值放大位移。
    const clamp = (v) => Math.min(4, Math.max(0.25, v))
    // 比例按轴独立实测；抓取点太靠边（除数过小）时该轴退回 1。
    const sx = clientX > 4 && Math.abs(physical.x - dipX) > 1 ? clamp(physical.x / dipX) : 1
    const sy = clientY > 4 && Math.abs(physical.y - dipY) > 1 ? clamp(physical.y / dipY) : 1
    drag = { ox: clientX * uiZoom, oy: clientY * uiZoom, sx: sx, sy: sy, tx: NaN, ty: NaN }
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
    win.setBounds({ x: nx, y: ny, width: petW, height: petH })
  })
  ipcMain.on('drag-end', () => {
    drag = null
  })

  // Return current window position for persistence.
  ipcMain.handle('get-position', () => {
    const [x, y] = win.getPosition()
    return { x: Math.round(x), y: Math.round(y) }
  })

  // 右键菜单：渲染层按工作区用与网页相同的右→左→上公式选出落点，再把窗口
  // 扩到菜单+光晕的包围盒。优先只增加宽/高（原点不动）：.pet 顶左锚 400×520，
  // 向右/下长时内容屏幕位置不变。贴右翻左才会减小 x，返回 dx/dy 让渲染层把
  // .pet 推回。force-dsf=1 下 bounds/workArea 同为物理像素，CSS 先乘 uiZoom。
  let menuBase = null
  ipcMain.handle('get-work-area', () => {
    const b = win.getContentBounds()
    let wa = null
    try { wa = screen.getDisplayMatching(b).workArea } catch { /* 无工作区时退回当前窗 */ }
    if (!wa) {
      return { left: 0, top: 0, right: b.width / uiZoom, bottom: b.height / uiZoom }
    }
    return {
      left: (wa.x - b.x) / uiZoom,
      top: (wa.y - b.y) / uiZoom,
      right: (wa.x + wa.width - b.x) / uiZoom,
      bottom: (wa.y + wa.height - b.y) / uiZoom,
    }
  })
  const applyShiftInPage = (dx, dy) => {
    const dxN = Number(dx) || 0
    const dyN = Number(dy) || 0
    return win.webContents.executeJavaScript(
      `void (window.__rm2ApplyPetShift && window.__rm2ApplyPetShift(${dxN},${dyN}))`,
    ).catch(() => {})
  }
  // resizable:false 时 Windows 常忽略 setBounds 的 x，只从当前左上角改宽；
  // 透明窗 opacity:0 时 DWM 还可能在揭回时把位置弹回隐藏前的 bounds。
  const applyBounds = (bounds) => {
    if (win.isDestroyed()) return
    let locked = false
    try { locked = !win.isResizable(); if (locked) win.setResizable(true) } catch { locked = false }
    try {
      win.setContentBounds(bounds)
    } finally {
      try { if (locked) win.setResizable(false) } catch { /* 还原失败也不要抛 */ }
    }
  }
  const withHiddenMove = async (originMoves, run) => {
    if (originMoves && !win.isDestroyed()) {
      try { win.setOpacity(0) } catch { /* 透明窗仍可 setOpacity */ }
    }
    try {
      await run()
      // 只等一帧让 DWM 吃下 bounds+shift；揭回后再写 bounds 会在可见时挪窗=闪动。
      if (originMoves) await new Promise((r) => setTimeout(r, 16))
    } finally {
      if (originMoves && !win.isDestroyed()) {
        try { win.setOpacity(1) } catch { /* 必须揭回，否则宠物会消失 */ }
      }
    }
  }
  ipcMain.handle('menu-expand', async (_event, cssLeft, cssTop, cssRight, cssBottom) => {
    const b = win.getContentBounds()
    const left = Math.round((Number(cssLeft) || 0) * uiZoom)
    const top = Math.round((Number(cssTop) || 0) * uiZoom)
    const right = Math.round((Number(cssRight) || 0) * uiZoom)
    const bottom = Math.round((Number(cssBottom) || 0) * uiZoom)
    let x = Math.min(0, left)
    let y = Math.min(0, top)
    let rgt = Math.max(b.width, right)
    let bot = Math.max(b.height, bottom)
    let wa = null
    try { wa = screen.getDisplayMatching(b).workArea } catch { /* 查询异常时按请求值扩 */ }
    if (wa) {
      const waL = wa.x - b.x
      const waT = wa.y - b.y
      const waR = wa.x + wa.width - b.x
      const waB = wa.y + wa.height - b.y
      x = Math.max(x, waL)
      y = Math.max(y, waT)
      rgt = Math.min(Math.max(rgt, b.width), waR)
      bot = Math.min(Math.max(bot, b.height), waB)
      if (x > 0) x = 0
      if (y > 0) y = 0
      if (rgt < b.width) rgt = b.width
      if (bot < b.height) bot = b.height
    }
    const nb = { x: b.x + x, y: b.y + y, width: rgt - x, height: bot - y }
    const dx = Math.round(-x / uiZoom)
    const dy = Math.round(-y / uiZoom)
    if (nb.width === b.width && nb.height === b.height && x === 0 && y === 0) {
      return { width: Math.round(b.width / uiZoom), height: Math.round(b.height / uiZoom), dx: 0, dy: 0 }
    }
    if (menuBase == null) menuBase = { x: b.x, y: b.y, width: b.width, height: b.height }
    const originMoves = x !== 0 || y !== 0
    await withHiddenMove(originMoves, async () => {
      if (originMoves) await applyShiftInPage(dx, dy)
      applyBounds(nb)
      if (originMoves) applyBounds(nb)
    })
    return {
      width: Math.round(nb.width / uiZoom),
      height: Math.round(nb.height / uiZoom),
      dx,
      dy,
    }
  })
  ipcMain.handle('menu-restore', async () => {
    if (menuBase == null || win.isDestroyed()) return
    const base = menuBase
    menuBase = null
    const b = win.getContentBounds()
    const originMoved = base.x !== b.x || base.y !== b.y
    await withHiddenMove(originMoved, async () => {
      // 先搬回窗口（此时页面 shift 仍在，视觉位置正确），再清 shift。
      // 若先清 shift 而 x 没写回去，宠物会停在扩窗后的左侧。
      applyBounds(base)
      if (originMoved) await applyShiftInPage(0, 0)
      applyBounds(base)
    })
  })

  // 无网页客户端在线时点击气泡卡：渲染层只发信号，URL 由宿主经 DSH_WEB_URL
  // 传入（DSH 0.1.2+ 为带进程 token 的根路径；旧宿主为 origin）。
  // 用 href 而不是 origin：token 在 query 上，303 换 cookie 时也会丢掉其它参数。
  ipcMain.handle('open-dsh-page', () => {
    try {
      const target = new URL(process.env.DSH_WEB_URL || new URL('/', url).origin)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
      return shell.openExternal(target.href)
    } catch {
      return Promise.resolve(false)
    }
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
    // 渲染层按 CSS px 上报尺寸；force-dsf=1 下 artWin 内容 1 CSS px = 1 物理
    // 像素，不乘 uiZoom 会在高缩放屏上比网页端显示偏小，与主窗口同倍放大。
    w = Math.max(60, Math.round((Number(w) || 220) * uiZoom))
    h = Math.max(60, Math.round((Number(h) || 220) * uiZoom))
    if (artWin && !artWin.isDestroyed()) { artWin.setBounds({ width: w, height: h }); return }
    const work = screen.getPrimaryDisplay().workArea
    artWin = new BrowserWindow({
      width: w,
      height: h,
      // workArea 与窗口定位同为物理像素，直接算停靠点（右上留 24 物理间隙）。
      x: Math.round(work.x + work.width - 24 - w),
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

  win.loadURL(url)
  // zoom 必须在导航完成后设置：loadURL 之前调用的 setZoomFactor 会在导航提交
  // 时被重置回 1（活体实测：内容未放大、图案只剩一半大，且拖动自校准随之测出
  // ~0.54 的错误系数，位移被放大近一倍、一拖就冲出屏幕），故挂在导航完成后。
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(uiZoom)
    // 阴影 CSS 按 1/zoom 反缩放，使透明窗光晕物理尺寸不随 DPI 膨胀。
    win.webContents.insertCSS(`:root{--rm2-ui-zoom:${uiZoom};}`).catch(() => {})
  })
  win.webContents.on('did-fail-load', (_e, code, desc, furl) => console.log('[pet] FAIL:', code, desc, furl))
  win.webContents.on('console-message', (_e, level, msg) => console.log('[pet-console]', level, String(msg).slice(0, 160)))
  win.once('ready-to-show', () => {
    win.show()
    // show 时 Electron 可能对超出 workArea 的窗口再做一次 fit 钳制；显示稳定
    // 后重申完整尺寸兜底。
    setTimeout(() => {
      if (win.isDestroyed()) return
      try {
        const [lx, ly] = win.getPosition()
        win.setBounds({ x: lx, y: ly, width: petW, height: petH })
      } catch { /* 窗口销毁竞态，忽略 */ }
    }, 250)
  })
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
