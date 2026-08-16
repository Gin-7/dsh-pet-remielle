/**
 * ZZZ sticker pet — published (file-plugin) client.
 *
 * Pure client-side DOM plugin, shaped like the maid-atelier skin:
 *  - GIFs are inlined as data URIs (art.generated.ts), so nothing is fetched
 *    from disk, RPC, or the network.
 *  - Work state is derived from the page's stable DOM hooks (no host RPC):
 *      running  -> a sidebar session StateDot `svg[data-state='ongoing']`
 *      tool     -> a `[data-chat-flow-kind='tool-call']` node appended after
 *                  the run started
 *      think    -> a `[data-variant='think']` block inside a fresh assistant
 *                  step that has no markdown yet
 *      output   -> a markdown block inside the newest fresh assistant step
 *  - Cleanup is a single ctx.effect disposer (interval, style tag, DOM nodes).
 */
import { PET_GIFS } from './art.generated'

const CSS = [
  ".zzz-pet-menu{position:fixed;z-index:2147483000;min-width:190px;background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));border-radius:10px;box-shadow:0 10px 32px rgba(15,30,72,.22);padding:6px;font-family:system-ui,sans-serif;font-size:13px;color:var(--dsw-alias-label-primary,#172347);display:none;user-select:none;}",
  ".zzz-pet-menu-item{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:7px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;}",
  ".zzz-pet-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(103,126,183,.12));}",
  ".zzz-pet-menu-item .mute{color:var(--dsw-alias-label-secondary,#4d5d7f);font-size:12px;}",
  ".zzz-pet-menu-item .tick{color:var(--dsw-alias-brand-primary,#526aa8);font-weight:600;}",
  ".zzz-pet-menu-sublist{padding:2px 6px 6px 18px;}",
  ".zzz-pet-menu-opt{padding:5px 10px;border-radius:6px;cursor:pointer;}",
  ".zzz-pet-menu-opt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(103,126,183,.12));}",
  ".zzz-pet-menu-opt.on{color:var(--dsw-alias-brand-primary,#526aa8);font-weight:600;}",
  ".zzz-pet-settings-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(8,15,39,.45);display:none;}",
  ".zzz-pet-settings{position:fixed;z-index:2147483001;top:50%;left:50%;transform:translate(-50%,-50%);width:min(360px,92vw);background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));border-radius:14px;box-shadow:0 20px 56px rgba(15,30,72,.34);font-size:13px;color:var(--dsw-alias-label-primary,#172347);display:none;overflow:hidden;user-select:none;font-family:system-ui,sans-serif;}",
  ".zzz-pet-settings-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));}",
  ".zzz-pet-settings-title{font-weight:600;font-size:14px;}",
  ".zzz-pet-settings-close{border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#6f7c99);font-size:16px;line-height:1;padding:4px 6px;border-radius:6px;}",
  ".zzz-pet-settings-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(103,126,183,.12));color:var(--dsw-alias-label-primary,#172347);}",
  ".zzz-pet-settings-body{padding:14px 16px;display:flex;flex-direction:column;gap:12px;}",
  ".zzz-pet-settings-section{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6f7c99);margin:4px 0 0;}",
  ".zzz-pet-settings-row{display:flex;align-items:center;gap:12px;}",
  ".zzz-pet-settings-row .lab{width:56px;flex:none;color:var(--dsw-alias-label-secondary,#4d5d7f);}",
  ".zzz-pet-settings-row input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary,#526aa8);cursor:pointer;}",
  ".zzz-pet-settings-row .val{width:44px;flex:none;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4d5d7f);}",
  ".zzz-pet-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;background:rgba(113,130,166,.45);cursor:pointer;transition:background .15s;}",
  '.zzz-pet-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s;}',
  ".zzz-pet-switch.on{background:var(--dsw-alias-brand-primary,#526aa8);}",
  ".zzz-pet-switch.on::after{left:18px;}",
  ".zzz-pet-settings-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));}",
  ".zzz-pet-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));background:var(--dsw-alias-button-elevated-fill,rgba(255,253,248,.88));cursor:pointer;color:inherit;font-size:13px;}",
  ".zzz-pet-btn:hover{background:var(--dsw-alias-button-floating-hover,#ece6d8);}",
  ".zzz-pet-btn.primary{background:var(--dsw-alias-button-info-fill,#536eae);border-color:transparent;color:#fff;}",
  ".zzz-pet-btn.primary:hover{background:var(--dsw-alias-button-info-hover,#405a99);}",
  ".zzz-pet-pill{position:fixed;right:20px;bottom:20px;display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));color:var(--dsw-alias-label-primary,#172347);cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;user-select:none;transition:background .15s,border-color .15s;}",
  ".zzz-pet-pill:hover{background:var(--dsw-alias-button-floating-hover,#ece6d8);border-color:var(--dsw-alias-border-l3,rgba(197,164,104,.64));}",
  'body[data-ds-dark-theme] .zzz-pet-menu,body[data-ds-dark-theme] .zzz-pet-settings{background:rgba(13,25,59,.98);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .zzz-pet-menu-item .mute{color:#bdc9e3;}',
  'body[data-ds-dark-theme] .zzz-pet-menu-item:hover,body[data-ds-dark-theme] .zzz-pet-menu-opt:hover{background:rgba(164,183,229,.14);}',
  'body[data-ds-dark-theme] .zzz-pet-settings-section{color:#96a6c9;}',
  'body[data-ds-dark-theme] .zzz-pet-settings-row .lab,body[data-ds-dark-theme] .zzz-pet-settings-row .val{color:#bdc9e3;}',
  'body[data-ds-dark-theme] .zzz-pet-switch{background:rgba(150,166,201,.4);}',
  'body[data-ds-dark-theme] .zzz-pet-btn{background:rgba(31,49,92,.96);border-color:rgba(151,169,216,.34);}',
  'body[data-ds-dark-theme] .zzz-pet-btn:hover{background:#354d88;}',
  'body[data-ds-dark-theme] .zzz-pet-pill{background:rgba(13,25,59,.98);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .zzz-pet-pill:hover{background:#354d88;border-color:rgba(211,180,119,.66);}',
].join('\n')

const MOODS: Record<string, string> = {
  '01': '正在疯狂工作',
  '02': '疯狂工作·间歇休息',
  '03': '心满意足',
  '04': '思考中',
  '05': '等待回应',
  '06': '待机中',
}

function mk(tag: string, style?: string, text?: string): HTMLElement {
  const n = document.createElement(tag)
  if (style) n.style.cssText = style
  if (text !== undefined) n.textContent = text
  return n
}

export function apply(ctx: any): void {
  if (typeof document === 'undefined' || !document.body) return

  // ---------- preferences (in-memory, process-local) ----------
  let scale = 1
  let opacity = 1
  let locked = false
  let paused = false
  let hidden = false
  let manualOverride: { mood: string; until: number } | null = null

  // ---------- dom state ----------
  let wasRunning = false
  let doneAt = 0
  let idleAt = 0
  let baselineCount = 0
  let currentMood = '06'
  let displayedMood: string | null = null

  // ---------- build dom ----------
  const root = mk('div', 'position:fixed;right:20px;bottom:20px;z-index:2147483000;pointer-events:auto;user-select:none;')
  root.setAttribute('data-zzz-pet-root', '')

  // 记住上次位置（跨重启保留，localStorage）；超出当前窗口时钳制回可视区（双屏场景）
  try {
    const saved = localStorage.getItem('zzz-pet-pos')
    if (saved) {
      const p = JSON.parse(saved)
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        const vw = window.innerWidth || 1280
        const vh = window.innerHeight || 800
        const cx = Math.max(0, Math.min(p.x, vw - 60))
        const cy = Math.max(0, Math.min(p.y, vh - 60))
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        root.style.left = cx + 'px'
        root.style.top = cy + 'px'
      }
    }
  } catch { /* storage unavailable */ }

  const dock = mk('div', 'position:relative;display:inline-block;cursor:grab;touch-action:none;')
  dock.title = '拖动我 · 点击互动 · 右键菜单'

  const img = mk('img', 'width:150px;height:auto;pointer-events:none;display:none;') as HTMLImageElement
  img.alt = '桌宠'
  img.draggable = false
  img.addEventListener('error', () => {
    img.style.display = 'none'
    displayedMood = null // allow retry on the next tick
  })

  const pill = mk('div', 'display:none;', '🐋 桌宠')
  pill.className = 'zzz-pet-pill'
  pill.setAttribute('role', 'button')
  ;(pill as HTMLElement).tabIndex = 0

  const menu = mk('div', '')
  menu.className = 'zzz-pet-menu'
  const settingsMask = mk('div', '')
  settingsMask.className = 'zzz-pet-settings-mask'
  const settings = mk('div', '')
  settings.className = 'zzz-pet-settings'

  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  styleEl.setAttribute('data-zzz-pet-css', '')

  dock.appendChild(img)
  root.appendChild(dock)
  document.head.appendChild(styleEl)
  document.body.appendChild(root)
  document.body.appendChild(pill)
  document.body.appendChild(menu)
  document.body.appendChild(settingsMask)
  document.body.appendChild(settings)

  // ---------- dom state detection ----------
  function isRunning(): boolean {
    try {
      return document.querySelector("svg[data-state='ongoing']") !== null
    } catch {
      return false
    }
  }

  // The phase of the CURRENT run: only nodes appended after the run started.
  function livePhase(): string | null {
    try {
      const nodes = document.querySelectorAll('[data-chat-flow-kind]')
      if (nodes.length <= baselineCount) return null
      const fresh = Array.prototype.slice.call(nodes, baselineCount)
      const last = fresh[fresh.length - 1]
      const kind = last.getAttribute('data-chat-flow-kind')
      if (kind === 'tool-call') return 'tool'
      if (kind === 'assistant-step') {
        if (last.querySelector("[class*='markdown']") !== null) return 'output'
        if (last.querySelector("[data-variant='think']") !== null) return 'think'
      }
      return null
    } catch {
      return null
    }
  }

  // DSH is blocked waiting on the user: a question card, a plan-review card,
  // or a cordis plugin approval prompt is on screen.
  function isWaitingUser(): boolean {
    try {
      return document.querySelector('[data-cordis-approve], [data-question-key], [data-plan-review-key]') !== null
    } catch {
      return false
    }
  }

  function deriveMood(): string {
    const now = Date.now()
    if (isWaitingUser()) return '05'
    const running = isRunning()
    if (running) {
      const phase = livePhase()
      if (phase === 'tool') return '02'
      if (phase === 'think') return '04'
      if (phase === 'output') return '01'
      return '04'
    }
    if (doneAt > 0 && now - doneAt < 6000) return '03'
    if (idleAt > 0 && now - idleAt > 120000) return '05'
    return '06'
  }

  // ---------- visuals ----------
  function applyVisuals(): void {
    img.style.width = Math.round(150 * scale) + 'px'
    img.style.opacity = String(opacity)
    dock.style.cursor = locked ? 'default' : 'grab'
  }

  function resetPos(): void {
    root.style.left = ''
    root.style.top = ''
    root.style.right = '20px'
    root.style.bottom = '20px'
      try { localStorage.removeItem('zzz-pet-pos') } catch { /* storage unavailable */ }
  }

  function setHidden(v: boolean): void {
    hidden = v
    if (v) {
      root.style.display = 'none'
      pill.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483100;display:inline-flex;'
      document.body.appendChild(pill)
    } else {
      pill.style.display = 'none'
      root.style.display = ''
    }
    closeMenu()
  }

  function setPaused(v: boolean): void {
    paused = v
    if (paused) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 150
        canvas.height = img.naturalHeight || 150
        const g = canvas.getContext('2d')
        if (g && img.src) {
          g.drawImage(img, 0, 0, canvas.width, canvas.height)
          img.dataset.animated = img.src
          img.src = canvas.toDataURL('image/png')
        }
      } catch {
        /* canvas unavailable; keep animating */
      }
      dock.title = '已暂停（右键菜单恢复）'
    } else {
      const animated = img.dataset.animated
      delete img.dataset.animated
      if (animated && animated !== img.src) img.src = animated
      else showCurrentGif()
      dock.title = '拖动我 · 点击互动 · 右键菜单'
    }
  }

  function showGif(src: string): void {
    img.src = src
    img.style.display = 'block'
    displayedMood = currentMood
  }

  function showCurrentGif(): void {
    const src = PET_GIFS[currentMood]
    if (src) showGif(src)
  }

  // ---------- mood sync ----------
  function sync(): void {
    const now = Date.now()
    let m: string
    if (manualOverride && now < manualOverride.until) {
      m = manualOverride.mood
    } else {
      manualOverride = null
      m = deriveMood()
    }
    if (m !== currentMood) currentMood = m
    if (!paused && displayedMood !== currentMood) showCurrentGif()
  }

  // ---------- polling ----------
  const tick = (): void => {
    const running = isRunning()
    if (running && !wasRunning) {
      try {
        baselineCount = document.querySelectorAll('[data-chat-flow-kind]').length
      } catch {
        baselineCount = 0
      }
    }
    if (!running && wasRunning) {
      doneAt = Date.now()
      idleAt = Date.now()
    }
    wasRunning = running
    sync()
  }

  let intervalId = 0
  if (typeof window !== 'undefined') intervalId = window.setInterval(tick, 400)
  tick()

  // ---------- interactions ----------
  let dragMoved = false
  dock.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0 || locked) return
    e.preventDefault()
    const rect = dock.getBoundingClientRect()
    const startX = e.clientX - rect.left
    const startY = e.clientY - rect.top
    const ox = e.clientX
    const oy = e.clientY
    dragMoved = false
    const onMove = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientX - ox) + Math.abs(ev.clientY - oy) > 6) dragMoved = true
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      root.style.left = (ev.clientX - startX) + 'px'
      root.style.top = (ev.clientY - startY) + 'px'
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
          if (dragMoved) {
            try {
              localStorage.setItem(
                'zzz-pet-pos',
                JSON.stringify({ x: parseInt(root.style.left, 10) || 0, y: parseInt(root.style.top, 10) || 0 })
              )
            } catch { /* storage unavailable */ }
          }
        }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
  dock.addEventListener('click', () => {
    if (dragMoved) return
    const candidates = Object.keys(MOODS).filter((m) => m !== currentMood)
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    manualOverride = { mood: pick, until: Date.now() + 1800 }
    sync()
  })

  // ---------- context menu ----------
  let expandedRow: HTMLElement | null = null
  let menuOpen = false

  function makeRow(label: string, rightText?: string): HTMLElement {
    const row = mk('div', '')
    row.className = 'zzz-pet-menu-item'
    row.appendChild(mk('span', '', label))
    if (rightText) {
      const r = mk('span', '')
      r.className = 'mute'
      r.textContent = rightText
      row.appendChild(r)
    }
    return row
  }
  function makeActionRow(label: string, act: () => void): HTMLElement {
    const row = makeRow(label)
    row.addEventListener('click', act)
    return row
  }
  function makeToggleRow(label: string, on: boolean, act: () => void): HTMLElement {
    const row = makeRow(label, on ? '✓' : '')
    const r = row.querySelector('.mute') as HTMLElement | null
    if (on && r) r.classList.add('tick')
    row.addEventListener('click', act)
    return row
  }
  function makeExpandRow(label: string, summary: string, opts: Array<{ label: string; on: boolean; act: () => void }>): HTMLElement {
    const wrap = mk('div', '')
    const row = makeRow(label, summary)
    wrap.appendChild(row)
    row.addEventListener('click', () => {
      if (expandedRow === wrap) {
        if (wrap.lastChild) wrap.lastChild.remove()
        expandedRow = null
      } else {
        if (expandedRow && expandedRow.lastChild) expandedRow.lastChild.remove()
        expandedRow = wrap
        const sub = mk('div', '')
        sub.className = 'zzz-pet-menu-sublist'
        opts.forEach((o) => {
          const opt = mk('div', '')
          opt.className = 'zzz-pet-menu-opt' + (o.on ? ' on' : '')
          opt.textContent = (o.on ? '✓ ' : '') + o.label
          opt.addEventListener('click', (e) => { e.stopPropagation(); o.act() })
          sub.appendChild(opt)
        })
        wrap.appendChild(sub)
      }
    })
    return wrap
  }

  function buildMenuContent(): void {
    menu.textContent = ''
    expandedRow = null
    const running = isRunning()
    const statusText = running ? '运行中' : '空闲'
    const status = makeRow(MOODS[currentMood] || MOODS['06'], statusText)
    status.style.opacity = '0.85'
    status.style.cursor = 'default'
    menu.appendChild(status)

    menu.appendChild(makeExpandRow('百分比缩放', Math.round(scale * 100) + '%', [80, 100, 125, 150, 200].map((p) => ({
      label: p + '%',
      on: p === Math.round(scale * 100),
      act: () => { scale = p / 100; applyVisuals(); buildMenuContent() },
    }))))
    menu.appendChild(makeExpandRow('透明度', Math.round(opacity * 100) + '%', [40, 60, 80, 100].map((p) => ({
      label: p + '%',
      on: p === Math.round(opacity * 100),
      act: () => { opacity = p / 100; applyVisuals(); buildMenuContent() },
    }))))
    menu.appendChild(makeToggleRow('锁定位置', locked, () => { locked = !locked; applyVisuals(); buildMenuContent() }))
    menu.appendChild(makeActionRow('重置位置', () => { resetPos(); closeMenu() }))
    menu.appendChild(makeActionRow(hidden ? '唤醒桌宠' : '隐藏桌宠', () => { setHidden(!hidden) }))
    menu.appendChild(makeToggleRow('暂停动画', paused, () => { setPaused(!paused); buildMenuContent() }))
    menu.appendChild(makeActionRow('打开设置面板', () => { closeMenu(); openSettings() }))
  }

  function openMenuAt(x: number, y: number): void {
    buildMenuContent()
    menu.style.display = 'block'
    const mw = menu.offsetWidth
    const mh = menu.offsetHeight
    menu.style.left = Math.max(4, Math.min(x, (window.innerWidth || 1280) - mw - 8)) + 'px'
    menu.style.top = Math.max(4, Math.min(y, (window.innerHeight || 800) - mh - 8)) + 'px'
    menuOpen = true
  }
  function closeMenu(): void {
    menu.style.display = 'none'
    menuOpen = false
    expandedRow = null
  }

  dock.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt(e.clientX, e.clientY)
  })
  pill.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt(e.clientX, e.clientY)
  })
  pill.addEventListener('click', () => setHidden(false))
  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setHidden(false)
    }
  })

  const outsideDown = (e: Event): void => {
    if (menuOpen && !menu.contains(e.target as Node)) closeMenu()
  }
  document.addEventListener('pointerdown', outsideDown, true)

  // ---------- settings panel ----------
  function buildSliderRow(label: string, which: 'scale' | 'opacity'): HTMLElement {
    const row = mk('div', '')
    row.className = 'zzz-pet-settings-row'
    const lab = mk('span', '', label)
    lab.className = 'lab'
    const input = document.createElement('input')
    input.type = 'range'
    const val = mk('span', '')
    val.className = 'val'
    if (which === 'scale') {
      input.min = '50'; input.max = '200'; input.step = '5'
      input.value = String(Math.round(scale * 100))
      val.textContent = Math.round(scale * 100) + '%'
      input.addEventListener('input', () => {
        scale = Number(input.value) / 100
        val.textContent = Math.round(scale * 100) + '%'
        applyVisuals()
      })
    } else {
      input.min = '30'; input.max = '100'; input.step = '5'
      input.value = String(Math.round(opacity * 100))
      val.textContent = Math.round(opacity * 100) + '%'
      input.addEventListener('input', () => {
        opacity = Number(input.value) / 100
        val.textContent = Math.round(opacity * 100) + '%'
        applyVisuals()
      })
    }
    row.appendChild(lab)
    row.appendChild(input)
    row.appendChild(val)
    return row
  }

  function buildSwitchRow(label: string, on: boolean, act: () => void): HTMLElement {
    const row = mk('div', 'justify-content:space-between;')
    row.className = 'zzz-pet-settings-row'
    const lab = mk('span', '', label)
    lab.className = 'lab'
    const sw = mk('div', '')
    sw.className = 'zzz-pet-switch' + (on ? ' on' : '')
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', on ? 'true' : 'false')
    sw.addEventListener('click', act)
    row.appendChild(lab)
    row.appendChild(sw)
    return row
  }

  function buildSettings(): void {
    settings.textContent = ''
    const head = mk('div', '')
    head.className = 'zzz-pet-settings-head'
    const title = mk('span', '', '桌宠设置')
    title.className = 'zzz-pet-settings-title'
    const closeX = mk('button', '', '✕')
    closeX.className = 'zzz-pet-settings-close'
    closeX.title = '关闭'
    closeX.addEventListener('click', closeSettings)
    head.appendChild(title)
    head.appendChild(closeX)
    settings.appendChild(head)

    const body = mk('div', '')
    body.className = 'zzz-pet-settings-body'

    const secA = mk('div', '', '外观')
    secA.className = 'zzz-pet-settings-section'
    body.appendChild(secA)
    body.appendChild(buildSliderRow('缩放', 'scale'))
    body.appendChild(buildSliderRow('透明度', 'opacity'))

    const secB = mk('div', '', '行为')
    secB.className = 'zzz-pet-settings-section'
    body.appendChild(secB)
    body.appendChild(buildSwitchRow('锁定位置', locked, () => { locked = !locked; applyVisuals(); buildSettings() }))
    body.appendChild(buildSwitchRow('暂停动画', paused, () => { setPaused(!paused); buildSettings() }))

    settings.appendChild(body)

    const footer = mk('div', '')
    footer.className = 'zzz-pet-settings-footer'
    const resetBtn = mk('button', '', '重置位置')
    resetBtn.className = 'zzz-pet-btn'
    resetBtn.addEventListener('click', () => { resetPos(); buildSettings() })
    const hideBtn = mk('button', '', '隐藏桌宠')
    hideBtn.className = 'zzz-pet-btn'
    hideBtn.addEventListener('click', () => { closeSettings(); setHidden(true) })
    const closeBtn = mk('button', '', '关闭')
    closeBtn.className = 'zzz-pet-btn primary'
    closeBtn.addEventListener('click', closeSettings)
    footer.appendChild(resetBtn)
    footer.appendChild(hideBtn)
    footer.appendChild(closeBtn)
    settings.appendChild(footer)
  }

  function openSettings(): void {
    settingsMask.style.display = 'block'
    settings.style.display = 'block'
    buildSettings()
  }
  function closeSettings(): void {
    settingsMask.style.display = 'none'
    settings.style.display = 'none'
  }
  settingsMask.addEventListener('click', closeSettings)

  // ---------- boot ----------
  applyVisuals()
  sync()

  ctx.effect(() => () => {
    if (intervalId) window.clearInterval(intervalId)
    document.removeEventListener('pointerdown', outsideDown, true)
    styleEl.remove()
    root.remove()
    pill.remove()
    menu.remove()
    settingsMask.remove()
    settings.remove()
  })
}
