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

  // 右键菜单需要比平时更大的窗口空间（平时窗口刚好包住宠物）。菜单打开时渲染
  // 层请求按需扩窗：宽度只向右长、高度只向上长，x 永不移动、y 仅因向上扩展
  // 上移。窗口任何位移都会拖动整个页面内容——渲染层 flex 重排至少滞后
  // setBounds 一帧，间隙里内容按旧布局随窗口一起平移，表现为开/关菜单时宠物
  // 向左上/右下闪现一下再弹回；旧版「对称扩宽」必然移动 x（左侧空间不足时更
  // 甚），正是闪现根源。配合 pet-view.html 的 .pet 固定锚层（fixed left:0
  // bottom:0 400×520）：右缘扩展 x 不动、向上扩展底缘不动，内容屏幕位置全程
  // 恒定、零闪现；右侧工作区空间不足时宁可少加宽，由渲染层 layoutMenu 落到
  // 左侧/上方兜底分支。高度向上空间不足时钳制为 0、绝不向下扩（会压任务栏，
  // 且底缘一动锚层内容跟着移）——此前未钳制时窗口顶部超出工作区（桌宠拖到
  // 屏幕顶端之上，b.y < wa.y）会算出负 growUp：窗口被压矮下移、菜单截断，
  // 关菜单还原时又要把窗口移回屏幕外原位，被 Windows 对屏外窗口的位置钳制
  // 拦回工作区，高度却已恢复，宠物瞬移到屏幕底部。多屏查询异常时不钳制、按
  // 请求值扩（与旧版一致）。force-dsf=1 下 bounds/workArea 同为物理像素（见
  // 文件头 DPI 注释），渲染层传来的 CSS 宽高先乘 uiZoom 换算，返回值再换算回
  // CSS 供直接定位。
  let menuBase = null
  ipcMain.handle('menu-expand', (_event, cssWidth, cssHeight) => {
    const wantW = Math.round((Number(cssWidth) || 0) * uiZoom)
    const wantH = Math.round((Number(cssHeight) || 0) * uiZoom)
    const b = win.getContentBounds()
    if (wantW <= b.width && wantH <= b.height) {
      return { width: Math.round(b.width / uiZoom), height: Math.round(b.height / uiZoom) }
    }
    if (menuBase == null) menuBase = { x: b.x, y: b.y, width: b.width, height: b.height }
    let wa = null
    try {
      wa = screen.getDisplayMatching(b).workArea
    } catch { /* 查询异常时按请求值扩 */ }
    const growR = wantW > b.width
      ? Math.min(wantW - b.width, wa ? (wa.x + wa.width) - (b.x + b.width) : wantW - b.width)
      : 0
    const growUp = wantH > b.height
      ? (wa ? Math.max(0, Math.min(wantH - b.height, b.y - wa.y)) : wantH - b.height)
      : 0
    const nb = { x: b.x, y: b.y - growUp, width: b.width + growR, height: b.height + growUp }
    win.setBounds(nb)
    return { width: Math.round(nb.width / uiZoom), height: Math.round(nb.height / uiZoom) }
  })
  ipcMain.on('menu-restore', () => {
    if (menuBase == null || win.isDestroyed()) return
    const base = menuBase
    menuBase = null
    win.setBounds(base)
  })

  // 无网页客户端在线时点击气泡卡：渲染层只发信号，URL 由这里从宿主给的
  // DSH_PET_URL 推导（同源根路径即 DSH 网页端），用系统默认浏览器拉到前台。
  // 已知限制：固定取 origin 根路径，若宿主部署在子路径（如 http://host/dsh/）
  // 会落到错误页面；当前部署为根路径，待真有子路径需求再传 base path。
  ipcMain.handle('open-dsh-page', () => {
    try {
      const target = new URL('/', url)
      // 只放行 http(s)：DSH_PET_URL 异常时不把其他协议的 URL 交给系统浏览器
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
      return shell.openExternal(target.origin)
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
