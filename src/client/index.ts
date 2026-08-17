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
import { PET_VERSION } from './version.generated'

const REPO = 'Gin-7/dsh-pet-remielle'
const GITHUB_RELEASES = `https://api.github.com/repos/${REPO}/releases/latest`
const GITHUB_TAGS = `https://api.github.com/repos/${REPO}/tags`
const UPD_KEY = 'zzz-pet-upd-checked'
const UPD_PREFS_KEY = 'zzz-pet-upd-prefs'
const CHECK_COOLDOWN_MS = 60 * 60 * 1000 // 1h between automatic checks

interface UpdatePrefs {
  auto: boolean
}
interface UpdateInfo {
  latest: string
  notes: string
  htmlUrl: string
}

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
  ".zzz-pet-settings-mask{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1,rgba(8,15,39,.5));backdrop-filter:var(--dsw-mask-blur,blur(3px));display:none;}",
  ".zzz-pet-settings{position:fixed;z-index:2147483001;top:50%;left:50%;transform:translate(-50%,-50%);width:800px;max-width:calc(100vw - 48px);height:min(620px,100vh - 48px);background:var(--dsw-alias-bg-layer-2,#f4f6fc);box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(15,30,72,.28));border-radius:24px;font-size:14px;color:var(--dsw-alias-label-primary,#172347);display:none;overflow:hidden;user-select:none;font-family:system-ui,sans-serif;flex-direction:row;}",
  ".zzz-pet-settings-head{display:flex;align-items:center;justify-content:space-between;padding:0 12px;}",
  ".zzz-pet-settings-title{font-size:16px;font-weight:500;line-height:24px;}",
  ".zzz-pet-settings-close{display:none;}",
  ".zzz-pet-settings-side{flex:none;width:188px;padding:22px 12px 22px;display:flex;flex-direction:column;gap:18px;box-sizing:border-box;border-right:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.16));}",
  ".zzz-pet-settings-navlist{display:flex;flex-direction:column;gap:4px;}",
  ".zzz-pet-settings-tab{box-sizing:border-box;cursor:pointer;height:40px;color:var(--dsw-alias-label-primary,#172347);text-align:left;background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex;}",
  ".zzz-pet-settings-tab:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(103,126,183,.12));}",
  ".zzz-pet-settings-tab.on{background:var(--dsw-specific-sidebar-nav-item-active,rgba(103,126,183,.18));color:var(--dsw-alias-label-primary,#172347);font-weight:500;}",
  ".zzz-pet-settings-pane{flex:1;min-width:0;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column;gap:16px;}",
  ".zzz-pet-settings-desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#4d5d7f);}",
  ".zzz-pet-settings-link{color:var(--dsw-alias-brand-primary,#526aa8);word-break:break-all;}",
  ".zzz-pet-feedback-btn{align-self:flex-start;}",
  ".zzz-pet-upd-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#6f7c99);white-space:nowrap;}",
  ".zzz-pet-upd-status.has-update{color:var(--dsw-alias-brand-primary,#526aa8);font-weight:600;cursor:pointer;}",
  ".zzz-pet-upd-status.ok{color:var(--dsw-alias-state-success-primary,#2e8b57);}",
  'body[data-ds-dark-theme] .zzz-pet-upd-status{color:#96a6c9;}',
  'body[data-ds-dark-theme] .zzz-pet-upd-status.has-update{color:#9db8ff;}',
  'body[data-ds-dark-theme] .zzz-pet-upd-status.ok{color:#6fd39a;}',
  ".zzz-pet-settings-section{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6f7c99);margin:4px 0 0;}",
  ".zzz-pet-settings-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:36px;}",
  ".zzz-pet-settings-row .lab{width:auto;min-width:64px;flex:none;color:var(--dsw-alias-label-secondary,#4d5d7f);white-space:nowrap;}",
  ".zzz-pet-settings-row input[type=range]{flex:1;max-width:240px;min-width:120px;accent-color:var(--dsw-alias-brand-primary,#526aa8);cursor:pointer;}",
  ".zzz-pet-settings-row .val{width:44px;flex:none;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4d5d7f);}",
  ".zzz-pet-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;background:rgba(113,130,166,.45);cursor:pointer;transition:background .15s;}",
  '.zzz-pet-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s;}',
  ".zzz-pet-switch.on{background:var(--dsw-alias-brand-primary,#526aa8);}",
  ".zzz-pet-switch.on::after{left:18px;}",
  ".zzz-pet-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));background:var(--dsw-alias-button-elevated-fill,rgba(255,253,248,.88));cursor:pointer;color:inherit;font-size:13px;}",
  ".zzz-pet-btn:hover{background:var(--dsw-alias-button-floating-hover,#ece6d8);}",
  ".zzz-pet-btn.primary{background:var(--dsw-alias-button-info-fill,#536eae);border-color:transparent;color:#fff;}",
  ".zzz-pet-btn.primary:hover{background:var(--dsw-alias-button-info-hover,#405a99);}",
  ".zzz-pet-pill{position:fixed;right:20px;bottom:20px;display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));color:var(--dsw-alias-label-primary,#172347);cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;user-select:none;transition:background .15s,border-color .15s;}",
  ".zzz-pet-pill:hover{background:var(--dsw-alias-button-floating-hover,#ece6d8);border-color:var(--dsw-alias-border-l3,rgba(197,164,104,.64));}",
  'body[data-ds-dark-theme] .zzz-pet-menu,body[data-ds-dark-theme] .zzz-pet-settings{background:var(--dsw-alias-bg-layer-2,#0f1a36);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .zzz-pet-menu-item .mute{color:#bdc9e3;}',
  'body[data-ds-dark-theme] .zzz-pet-menu-item:hover,body[data-ds-dark-theme] .zzz-pet-menu-opt:hover{background:rgba(164,183,229,.14);}',
  'body[data-ds-dark-theme] .zzz-pet-settings-section{color:#96a6c9;}',
  'body[data-ds-dark-theme] .zzz-pet-settings-row .lab,body[data-ds-dark-theme] .zzz-pet-settings-row .val{color:#bdc9e3;}',
  'body[data-ds-dark-theme] .zzz-pet-settings-side{border-color:rgba(151,169,216,.22);}',
  'body[data-ds-dark-theme] .zzz-pet-settings-tab{color:#bdc9e3;}',
  'body[data-ds-dark-theme] .zzz-pet-settings-tab:hover{background:rgba(164,183,229,.14);}',
  'body[data-ds-dark-theme] .zzz-pet-settings-tab.on{background:rgba(164,183,229,.2);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .zzz-pet-settings-desc{color:#bdc9e3;}',
  'body[data-ds-dark-theme] .zzz-pet-switch{background:rgba(150,166,201,.4);}',
  'body[data-ds-dark-theme] .zzz-pet-btn{background:rgba(31,49,92,.96);border-color:rgba(151,169,216,.34);}',
  'body[data-ds-dark-theme] .zzz-pet-btn:hover{background:#354d88;}',
  'body[data-ds-dark-theme] .zzz-pet-pill{background:rgba(13,25,59,.98);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .zzz-pet-pill:hover{background:#354d88;border-color:rgba(211,180,119,.66);}',
  '.zzz-pet-upd-bubble{position:absolute;right:0;top:-30px;display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-brand-primary,#526aa8);color:var(--dsw-alias-brand-primary,#526aa8);font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(15,30,72,.2);user-select:none;white-space:nowrap;}',
  '.zzz-pet-upd-bubble:hover{background:var(--dsw-alias-button-floating-hover,#ece6d8);}',
  '.zzz-pet-upd-bubble .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#526aa8);animation:zzzPetPulse 1.6s ease-in-out infinite;}',
  '@keyframes zzzPetPulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '.zzz-pet-upd-card{position:fixed;z-index:2147483001;top:50%;left:50%;transform:translate(-50%,-50%);width:min(420px,92vw);max-height:min(600px,86vh);overflow:auto;background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));border-radius:14px;box-shadow:0 20px 56px rgba(15,30,72,.34);font-size:13px;color:var(--dsw-alias-label-primary,#172347);display:none;user-select:none;font-family:system-ui,sans-serif;}',
  '.zzz-pet-upd-card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));}',
  '.zzz-pet-upd-card-title{font-weight:600;font-size:14px;}',
  '.zzz-pet-upd-card-body{padding:14px 16px;display:flex;flex-direction:column;gap:12px;}',
  '.zzz-pet-upd-versions{display:flex;align-items:center;gap:10px;font-weight:600;}',
  '.zzz-pet-upd-versions .old{color:var(--dsw-alias-label-tertiary,#6f7c99);text-decoration:line-through;}',
  '.zzz-pet-upd-versions .arrow{color:var(--dsw-alias-label-tertiary,#6f7c99);}',
  '.zzz-pet-upd-versions .new{color:var(--dsw-alias-brand-primary,#526aa8);}',
  '.zzz-pet-upd-notes{background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;max-height:220px;overflow:auto;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#4d5d7f);font-size:12px;line-height:1.55;}',
  '.zzz-pet-upd-output{background:rgba(8,15,39,.82);color:#cfe3ff;font-family:ui-monospace,Consolas,monospace;font-size:11px;border-radius:8px;padding:10px 12px;max-height:160px;overflow:auto;white-space:pre-wrap;display:none;}',
  '.zzz-pet-upd-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));}',
  '.zzz-pet-upd-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#6f7c99);line-height:1.5;}',
  '.zzz-pet-toast{position:fixed;z-index:2147483100;left:50%;bottom:26px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:rgba(13,25,59,.95);color:#e7ecf7;font-size:12px;box-shadow:0 8px 24px rgba(15,30,72,.3);display:none;user-select:none;pointer-events:none;font-family:system-ui,sans-serif;white-space:nowrap;}',
  'body[data-ds-dark-theme] .zzz-pet-upd-bubble{background:rgba(13,25,59,.98);color:#9db8ff;}',
  'body[data-ds-dark-theme] .zzz-pet-upd-card{background:rgba(13,25,59,.98);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .zzz-pet-upd-versions .old,body[data-ds-dark-theme] .zzz-pet-upd-hint{color:#96a6c9;}',
  'body[data-ds-dark-theme] .zzz-pet-upd-notes{color:#bdc9e3;background:rgba(164,183,229,.08);}',
].join('\n')

const MOODS: Record<string, string> = {
  '01': '工作ing',
  '02': '摸鱼ing',
  '03': '得意ing',
  '04': '思考ing',
  '05': '等待ing',
  '06': '待机ing',
}

function mk(tag: string, style?: string, text?: string): HTMLElement {
  const n = document.createElement(tag)
  if (style) n.style.cssText = style
  if (text !== undefined) n.textContent = text
  return n
}

export function apply(ctx: any): void {
  if (typeof document === 'undefined' || !document.body) return

  // ---------- preferences (persisted to localStorage) ----------
  const PREFS_KEY = 'zzz-pet-prefs'
  interface PetPrefs {
    scale: number
    opacity: number
    locked: boolean
    paused: boolean
    hidden: boolean
  }
  function readPrefs(): PetPrefs {
    const def: PetPrefs = { scale: 1, opacity: 1, locked: false, paused: false, hidden: false }
    try {
      const raw = localStorage.getItem(PREFS_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (p && typeof p === 'object') {
          if (typeof p.scale === 'number' && p.scale >= 0.5 && p.scale <= 2) def.scale = p.scale
          if (typeof p.opacity === 'number' && p.opacity >= 0.3 && p.opacity <= 1) def.opacity = p.opacity
          if (typeof p.locked === 'boolean') def.locked = p.locked
          if (typeof p.paused === 'boolean') def.paused = p.paused
          if (typeof p.hidden === 'boolean') def.hidden = p.hidden
        }
      }
    } catch { /* storage unavailable */ }
    return def
  }
  function writePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ scale, opacity, locked, paused, hidden }))
    } catch { /* storage unavailable */ }
  }
  const prefs = readPrefs()
  let scale = prefs.scale
  let opacity = prefs.opacity
  let locked = prefs.locked
  let paused = prefs.paused
  let hidden = prefs.hidden
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

  const updCard = mk('div', '')
  updCard.className = 'zzz-pet-upd-card'
  const toast = mk('div', '')
  toast.className = 'zzz-pet-toast'

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
  document.body.appendChild(updCard)
  document.body.appendChild(toast)

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
    writePrefs()
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

  function freezeCurrentGif(): void {
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
  }

  function applyPausedUI(): void {
    if (paused) {
      freezeCurrentGif()
      dock.title = '已暂停（右键菜单恢复）'
    } else {
      const animated = img.dataset.animated
      delete img.dataset.animated
      if (animated && animated !== img.src) img.src = animated
      else showCurrentGif()
      dock.title = '拖动我 · 点击互动 · 右键菜单'
    }
  }

  function setPaused(v: boolean): void {
    paused = v
    writePrefs()
    applyPausedUI()
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

  // ---------- polling (event-driven, with low-frequency fallback) ----------
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

  // State changes are DOM changes; observe the body subtree instead of
  // hammering it with querySelector at 400ms. A low-frequency interval is kept
  // as a safety net for changes the observer can't see (e.g. style-only).
  let observer: MutationObserver | null = null
  let observeTimer = 0
  const scheduleObserve = (): void => {
    if (observeTimer) return
    observeTimer = window.setTimeout(() => {
      observeTimer = 0
      tick()
    }, 300) // debounce bursts of mutations into one tick (≈ original 400ms cadence)
  }

  const intervalId = window.setInterval(tick, 2000) // fallback: catch anything the observer misses
  try {
    observer = new MutationObserver(scheduleObserve)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'data-chat-flow-kind', 'data-cordis-approve', 'data-question-key', 'data-plan-review-key'],
    })
  } catch {
    /* MutationObserver unavailable; rely on the interval */
  }
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
      act: () => { scale = p / 100; applyVisuals(); writePrefs(); buildMenuContent() },
    }))))
    menu.appendChild(makeExpandRow('透明度', Math.round(opacity * 100) + '%', [40, 60, 80, 100].map((p) => ({
      label: p + '%',
      on: p === Math.round(opacity * 100),
      act: () => { opacity = p / 100; applyVisuals(); writePrefs(); buildMenuContent() },
    }))))
    menu.appendChild(makeToggleRow('锁定位置', locked, () => { locked = !locked; applyVisuals(); writePrefs(); buildMenuContent() }))
    menu.appendChild(makeActionRow('重置位置', () => { resetPos(); closeMenu() }))
    menu.appendChild(makeActionRow(hidden ? '唤醒桌宠' : '隐藏桌宠', () => { setHidden(!hidden) }))
    menu.appendChild(makeToggleRow('暂停动画', paused, () => { setPaused(!paused); writePrefs(); buildMenuContent() }))
    menu.appendChild(makeActionRow('检查更新', () => { closeMenu(); checkForUpdate(true) }))
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
    const row = mk('div', 'justify-content:space-between;')
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
      input.addEventListener('change', writePrefs)
    } else {
      input.min = '30'; input.max = '100'; input.step = '5'
      input.value = String(Math.round(opacity * 100))
      val.textContent = Math.round(opacity * 100) + '%'
      input.addEventListener('input', () => {
        opacity = Number(input.value) / 100
        val.textContent = Math.round(opacity * 100) + '%'
        applyVisuals()
      })
      input.addEventListener('change', writePrefs)
    }
    row.appendChild(lab)
    const ctrl = mk('div', 'display:flex;align-items:center;gap:10px;justify-content:flex-end;flex:1;min-width:0;')
    ctrl.appendChild(input)
    ctrl.appendChild(val)
    row.appendChild(ctrl)
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

  // ---------- settings panel (sidebar + content, dsh-style) ----------
  let settingsTab = 'appearance'
  const SETTING_TABS: Array<{ key: string; label: string }> = [
    { key: 'appearance', label: '外观' },
    { key: 'behavior', label: '行为' },
    { key: 'update', label: '更新' },
    { key: 'feedback', label: '反馈' },
  ]

  function buildSettings(): void {
    settings.textContent = ''

    // ---- left column: title + category menu ----
    const nav = mk('div', '')
    nav.className = 'zzz-pet-settings-side'
    const navTitle = mk('div', '')
    navTitle.className = 'zzz-pet-settings-head'
    const title = mk('span', '', '桌宠设置')
    title.className = 'zzz-pet-settings-title'
    navTitle.appendChild(title)
    nav.appendChild(navTitle)
    const navList = mk('div', '')
    navList.className = 'zzz-pet-settings-navlist'
    SETTING_TABS.forEach((tab) => {
      const item = mk('div', '')
      item.className = 'zzz-pet-settings-tab' + (settingsTab === tab.key ? ' on' : '')
      item.textContent = tab.label
      item.addEventListener('click', () => {
        settingsTab = tab.key
        buildSettings()
      })
      navList.appendChild(item)
    })
    nav.appendChild(navList)
    settings.appendChild(nav)

    // ---- right content ----
    const pane = mk('div', '')
    pane.className = 'zzz-pet-settings-pane'

    if (settingsTab === 'appearance') {
      const secA = mk('div', '', '外观')
      secA.className = 'zzz-pet-settings-section'
      pane.appendChild(secA)
      pane.appendChild(buildSliderRow('缩放', 'scale'))
      pane.appendChild(buildSliderRow('透明度', 'opacity'))
    } else if (settingsTab === 'behavior') {
      const secB = mk('div', '', '行为')
      secB.className = 'zzz-pet-settings-section'
      pane.appendChild(secB)
      pane.appendChild(buildSwitchRow('锁定位置', locked, () => { locked = !locked; applyVisuals(); writePrefs(); buildSettings() }))
      pane.appendChild(buildSwitchRow('暂停动画', paused, () => { setPaused(!paused); writePrefs(); buildSettings() }))
      pane.appendChild(buildSwitchRow('隐藏桌宠', hidden, () => { setHidden(!hidden); buildSettings() }))

      const resetRow = mk('div', 'justify-content:space-between;')
      resetRow.className = 'zzz-pet-settings-row'
      const resetLab = mk('span', '', '重置位置')
      resetLab.className = 'lab'
      resetRow.appendChild(resetLab)
      const resetBtn = mk('button', '', '重置到右下角')
      resetBtn.className = 'zzz-pet-btn'
      resetBtn.addEventListener('click', () => { resetPos(); showToast('位置已重置'); buildSettings() })
      resetRow.appendChild(resetBtn)
      pane.appendChild(resetRow)
    } else if (settingsTab === 'update') {
      const secC = mk('div', '', '更新')
      secC.className = 'zzz-pet-settings-section'
      pane.appendChild(secC)
      pane.appendChild(buildSwitchRow('自动检查更新', updPrefs.auto, () => { updPrefs.auto = !updPrefs.auto; writeUpdPrefs(updPrefs); buildSettings() }))

      const checkBtnRow = mk('div', 'justify-content:space-between;')
      checkBtnRow.className = 'zzz-pet-settings-row'
      const checkLab = mk('span', '', '当前版本')
      checkLab.className = 'lab'
      checkBtnRow.appendChild(checkLab)
      // status text: 有可用更新(可点击) / 已是最新 / 尚未检查 / 检查失败
      const hasUpdate = updInfo !== null && semverGt(updInfo.latest, PET_VERSION)
      const statusWrap = mk('span', 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;justify-content:flex-end;')
      const ver = mk('span', '', PET_VERSION)
      ver.style.color = 'var(--dsw-alias-label-secondary,#4d5d7f)'
      statusWrap.appendChild(ver)
      const updStatus = mk('span', '')
      updStatus.className = 'zzz-pet-upd-status'
      if (hasUpdate) {
        updStatus.textContent = `有可用更新 ${updInfo!.latest} ›`
        updStatus.classList.add('has-update')
        updStatus.title = '查看更新内容'
        updStatus.addEventListener('click', () => { openUpdateCard() })
      } else if (updChecked && updInfo === null) {
        updStatus.textContent = updNetworkHint || '检查更新失败'
      } else if (updChecked) {
        updStatus.textContent = '当前版本已是最新版本'
        updStatus.classList.add('ok')
      } else {
        updStatus.textContent = '尚未检查'
      }
      statusWrap.appendChild(updStatus)
      checkBtnRow.appendChild(statusWrap)
      const checkBtn = mk('button', '', hasUpdate ? '更新' : '检查更新')
      checkBtn.className = 'zzz-pet-btn' + (hasUpdate ? ' primary' : '')
      checkBtn.addEventListener('click', async () => {
        if (hasUpdate) {
          // 有新版本: 直接执行更新 (同原一键更新逻辑)
          checkBtn.disabled = true
          checkBtn.textContent = '更新中…'
          const ok = await runAutoUpdate((t) => { /* output shown in card */ })
          checkBtn.disabled = false
          if (ok) checkBtn.textContent = '更新成功'
          else checkBtn.textContent = '更新失败'
          if (ok) { showToast('更新成功，请重启 dsh web'); hideUpdBubble() }
          else showToast('更新失败，查看详情')
          buildSettings()
        } else {
          checkBtn.disabled = true
          checkBtn.textContent = '检查中…'
          await checkForUpdate(true)
          checkBtn.disabled = false
          checkBtn.textContent = '检查更新'
          buildSettings()
        }
      })
      checkBtnRow.appendChild(checkBtn)
      pane.appendChild(checkBtnRow)
    } else if (settingsTab === 'feedback') {
      const secF = mk('div', '', '反馈')
      secF.className = 'zzz-pet-settings-section'
      pane.appendChild(secF)

      const intro = mk('div', '')
      intro.className = 'zzz-pet-settings-desc'
      intro.textContent = '遇到问题或有建议？欢迎反馈，帮助改善桌宠。'
      pane.appendChild(intro)

      const issueBtn = mk('button', '', '提交反馈')
      issueBtn.className = 'zzz-pet-btn primary'
      issueBtn.title = '在 GitHub Issues 提交（需账号）'
      issueBtn.addEventListener('click', () => {
        // Open the repo's issue form with the bug template applied
        // (the template pre-fills version/description/reproduction fields).
        window.open(`https://github.com/${REPO}/issues/new?template=bug_report.yml`, '_blank')
      })
      const fbRow = mk('div', 'justify-content:flex-end;')
      fbRow.className = 'zzz-pet-settings-row'
      fbRow.appendChild(issueBtn)
      pane.appendChild(fbRow)

      const repoRow = mk('div', 'justify-content:space-between;')
      repoRow.className = 'zzz-pet-settings-row'
      const repoLab = mk('span', '', '仓库')
      repoLab.className = 'lab'
      repoRow.appendChild(repoLab)
      const repoLink = mk('a', 'flex:1;text-align:right;text-decoration:none;cursor:pointer;')
      repoLink.className = 'zzz-pet-settings-link'
      repoLink.textContent = `github.com/${REPO}`
      repoLink.href = `https://github.com/${REPO}`
      repoLink.target = '_blank'
      repoRow.appendChild(repoLink)
      pane.appendChild(repoRow)

      const verRow = mk('div', 'justify-content:space-between;')
      verRow.className = 'zzz-pet-settings-row'
      const verLab = mk('span', '', '版本')
      verLab.className = 'lab'
      verRow.appendChild(verLab)
      verRow.appendChild(mk('span', 'flex:1;text-align:right;color:var(--dsw-alias-label-secondary,#4d5d7f);', PET_VERSION))
      pane.appendChild(verRow)

      const copyright = mk('div', '')
      copyright.className = 'zzz-pet-settings-desc'
      copyright.textContent = '素材来自《绝区零》「初代虚狩，回归」活动表情包，版权归米哈游/HoYoverse 所有；本插件仅供个人学习娱乐，禁止商用。'
      pane.appendChild(copyright)
    }

    settings.appendChild(pane)
  }

  function openSettings(): void {
    settingsMask.style.display = 'block'
    settings.style.display = 'flex'
    buildSettings()
  }
  function closeSettings(): void {
    settingsMask.style.display = 'none'
    settings.style.display = 'none'
  }
  settingsMask.addEventListener('click', closeSettings)

  // ---------- update checks ----------
  const updBubble = mk('div', '')
  updBubble.className = 'zzz-pet-upd-bubble'
  updBubble.style.display = 'none'
  const updDot = mk('span', '')
  updDot.className = 'dot'
  updBubble.appendChild(updDot)
  updBubble.appendChild(mk('span', '', '新版本'))
  dock.appendChild(updBubble)

  let updInfo: UpdateInfo | null = null
  let updChecking = false
  let updChecked = false
  let updNetworkHint = ''

  function readUpdPrefs(): UpdatePrefs {
    try {
      const raw = localStorage.getItem(UPD_PREFS_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (p && typeof p === 'object') {
          return { auto: p.auto !== false }
        }
      }
    } catch { /* ignore */ }
    return { auto: true }
  }
  function writeUpdPrefs(prefs: UpdatePrefs): void {
    try { localStorage.setItem(UPD_PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
  }
  const updPrefs = readUpdPrefs()

  function semverGt(a: string, b: string): boolean {
    const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
    const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x !== y) return x > y
    }
    return false
  }

  async function fetchGitHubJson(url: string): Promise<any> {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  /** Ask the host (Node, with proxy fallback) for the newest remote version. */
  async function checkViaHost(): Promise<UpdateInfo | null> {
    try {
      const res = await fetch('/api/pet-remielle/check', { headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const j = await res.json()
      if (j && j.ok && typeof j.latest === 'string' && j.latest) {
        return {
          latest: j.latest,
          notes: typeof j.notes === 'string' ? j.notes : '',
          htmlUrl: typeof j.htmlUrl === 'string' ? j.htmlUrl : `https://github.com/${REPO}/releases`,
        }
      }
      if (j && !j.ok && j.error === 'no version yet') {
        updNetworkHint = '已连接 GitHub，但仓库还没有发布版本（无 tag/release）。'
      } else if (j && !j.ok && j.error === 'network unreachable' && j.direct === false && Array.isArray(j.proxiesUp) && j.proxiesUp.length === 0) {
        updNetworkHint = '直连被阻断且未检测到可用通道（本地代理 127.0.0.1:7890 / Steam++ 加速未开启）。请先开启代理或加速服务再重试。'
      } else if (j && !j.ok) {
        updNetworkHint = '网络连接失败，请稍后重试。'
      }
      return null
    } catch {
      return null
    }
  }

  /** Browser-direct GitHub check (used only when the host route is unavailable). */
  async function checkViaBrowser(): Promise<UpdateInfo | null> {
    let latest: string | null = null
    let notes = ''
    let htmlUrl = ''
    try {
      const rel = await fetchGitHubJson(GITHUB_RELEASES)
      latest = rel?.tag_name || null
      notes = rel?.body || ''
      htmlUrl = rel?.html_url || ''
    } catch {
      // no releases yet -> fall back to the newest tag
      try {
        const tags = await fetchGitHubJson(GITHUB_TAGS)
        if (Array.isArray(tags) && tags.length > 0) {
          latest = tags[0].name || null
          htmlUrl = `https://github.com/${REPO}/releases`
        }
      } catch { /* offline */ }
    }
    if (!latest) return null
    return { latest, notes, htmlUrl }
  }

  /** Run the update via the host (POST /api/pet-remielle/update).
   *  onOutput receives incremental output lines; resolves true on success. */
  async function runAutoUpdate(onOutput: (text: string) => void): Promise<boolean> {
    onOutput('正在执行更新…')
    try {
      const res = await fetch('/api/pet-remielle/update', { method: 'POST' })
      const j = await res.json().catch(() => null)
      onOutput((j && j.output) || 'HTTP ' + res.status)
      if (res.ok && j && j.ok) {
        showToast('更新成功，请重启 dsh web')
        hideUpdBubble()
        return true
      }
      return false
    } catch (e) {
      onOutput(String(e))
      return false
    }
  }

  async function checkForUpdate(force: boolean): Promise<boolean> {
    if (updChecking) return false
    updChecking = true
    // A check was performed regardless of outcome; the settings pane shows
    // "已是最新" / "有可用更新" / "检查失败" instead of "尚未检查".
    updChecked = true
    try {
      if (!force) {
        try {
          const last = Number(localStorage.getItem(UPD_KEY) || '0')
          if (Date.now() - last < CHECK_COOLDOWN_MS) return false
        } catch { /* ignore */ }
      }
      const viaHost = await checkViaHost()
      const info = viaHost || await checkViaBrowser()
      try { localStorage.setItem(UPD_KEY, String(Date.now())) } catch { /* ignore */ }
      if (!info) {
        updInfo = null
        updNetworkHint = updNetworkHint || '检查更新失败：无法连接 GitHub'
        if (force) showToast(updNetworkHint)
        return false
      }
      updInfo = info
      if (!semverGt(info.latest, PET_VERSION)) {
        if (force) showToast('当前版本已是最新版本')
        return false
      }
      showUpdBubble()
      return true
    } catch {
      updInfo = null
      updNetworkHint = updNetworkHint || '检查更新失败：无法连接 GitHub'
      if (force) showToast(updNetworkHint)
      return false
    } finally {
      updChecking = false
    }
  }

  function showToast(text: string): void {
    toast.textContent = text
    toast.style.display = 'block'
    clearTimeout((toast as any)._t)
    ;(toast as any)._t = setTimeout(() => { toast.style.display = 'none' }, 2400)
  }

  function showUpdBubble(): void {
    updBubble.style.display = 'inline-flex'
  }
  function hideUpdBubble(): void {
    updBubble.style.display = 'none'
  }

  updBubble.addEventListener('click', () => { openUpdateCard() })

  function openUpdateCard(): void {
    if (!updInfo) return
    updCard.textContent = ''
    const head = mk('div', '')
    head.className = 'zzz-pet-upd-card-head'
    const title = mk('span', '', '发现新版本')
    title.className = 'zzz-pet-upd-card-title'
    const closeX = mk('button', '', '✕')
    closeX.className = 'zzz-pet-settings-close'
    closeX.title = '关闭'
    closeX.addEventListener('click', closeUpdateCard)
    head.appendChild(title)
    head.appendChild(closeX)
    updCard.appendChild(head)

    const body = mk('div', '')
    body.className = 'zzz-pet-upd-card-body'

    const versions = mk('div', '')
    versions.className = 'zzz-pet-upd-versions'
    versions.appendChild(mk('span', 'old', PET_VERSION))
    versions.appendChild(mk('span', 'arrow', '→'))
    versions.appendChild(mk('span', 'new', updInfo.latest))
    body.appendChild(versions)

    if (updInfo.notes && updInfo.notes.trim()) {
      const notes = mk('div', '')
      notes.className = 'zzz-pet-upd-notes'
      notes.textContent = updInfo.notes.trim().slice(0, 1200)
      body.appendChild(notes)
    }

    const hint = mk('div', '')
    hint.className = 'zzz-pet-upd-hint'
    hint.textContent = '更新由你决定：桌宠只负责检测和提示。更新完成后重启 dsh web 生效。'
    body.appendChild(hint)

    const output = mk('div', '')
    output.className = 'zzz-pet-upd-output'
    body.appendChild(output)
    const actions = mk('div', '')
    actions.className = 'zzz-pet-upd-actions'
    const hint2 = mk('span', '')
    hint2.className = 'zzz-pet-upd-hint'
    hint2.style.flex = '1'
    hint2.textContent = '更新会执行增量拉取命令'
    actions.appendChild(hint2)
    const ghBtn = mk('button', '', '打开发布页')
    ghBtn.className = 'zzz-pet-btn'
    ghBtn.addEventListener('click', () => { window.open(updInfo?.htmlUrl || `https://github.com/${REPO}/releases`, '_blank') })
    actions.appendChild(ghBtn)
    const updBtn = mk('button', '', '更新')
    updBtn.className = 'zzz-pet-btn primary'
    updBtn.addEventListener('click', async () => {
      if (updBtn.disabled) return
      updBtn.disabled = true
      updBtn.textContent = '更新中…'
      output.style.display = 'block'
      const ok = await runAutoUpdate((t) => { output.textContent = t })
      if (ok) updBtn.textContent = '更新成功'
      else {
        updBtn.textContent = '更新失败'
        updBtn.disabled = false
      }
    })
    actions.appendChild(updBtn)
    updCard.appendChild(body)
    updCard.appendChild(actions)

    updCard.style.display = 'block'
  }
  function closeUpdateCard(): void {
    updCard.style.display = 'none'
  }

  // ---------- boot ----------
  applyVisuals()
  if (hidden) {
    // restore hidden state (pill shown, pet hidden)
    root.style.display = 'none'
    pill.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483100;display:inline-flex;'
    document.body.appendChild(pill)
  }
  sync()
  if (paused) {
    // Restore the paused state: sync() skips showing the GIF while paused, so
    // force the current frame on screen, then freeze it into a static image.
    // Freeze after the frame actually decodes (data-URI GIFs are large).
    showCurrentGif()
    const doFreeze = (): void => { freezeCurrentGif(); dock.title = '已暂停（右键菜单恢复）' }
    if (img.complete && img.naturalWidth > 0) doFreeze()
    else img.addEventListener('load', doFreeze, { once: true })
  }
  if (updPrefs.auto) {
    // silent check shortly after boot (never blocks the pet)
    window.setTimeout(() => { checkForUpdate(false) }, 2500)
  }

  ctx.effect(() => () => {
    if (intervalId) window.clearInterval(intervalId)
    if (observeTimer) window.clearTimeout(observeTimer)
    if (observer) observer.disconnect()
    document.removeEventListener('pointerdown', outsideDown, true)
    styleEl.remove()
    root.remove()
    pill.remove()
    menu.remove()
    settingsMask.remove()
    settings.remove()
    updCard.remove()
    toast.remove()
  })
}
