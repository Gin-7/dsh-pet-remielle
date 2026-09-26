/**
 * dsh-pet-remielle client core.
 *
 * This file is the body of the browser plugin: the build script wraps it in
 * the web shell's module loader (`window.__ModuleLoader__.load`). Do not add
 * top-level imports here.
 *
 * Three responsibilities:
 *  1. Settings section "宠物管理" (`settings.section` slot, React): the pet
 *     registry — enable/disable pets, rename them, pick the active pet, and
 *     add new ones (drop six GIFs into assets/pets/<id>/ and flip it on).
 *  2. Settings card injected into the DSH settings page
 *     (`settings.plugin.item` slot, React) talking to the host config
 *     endpoint (global enable toggle).
 *  3. The floating sticker pet itself (plain DOM) — instead of scraping the
 *     page DOM for work state, it polls the host state endpoint, which is
 *     driven by real session events through the PetReducer. Sticker GIFs are
 *     served by the host at
 *     /plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif;
 *     scale/opacity/locked/enabled/petId ride along on the snapshot.
 */

var CONFIG_ENDPOINT = '/plugins/dsh-pet-remielle/config'
var STATE_ENDPOINT = '/plugins/dsh-pet-remielle/state'
var COMPLETION_ACK_ENDPOINT = '/plugins/dsh-pet-remielle/completion/ack'
var SESSION_CURRENT_ENDPOINT = '/plugins/dsh-pet-remielle/session/current'
var THEME_ENDPOINT = '/plugins/dsh-pet-remielle/theme'
// 主题上报心跳：宿主侧对上报值有 10 分钟 TTL（index.js 的 HOST_THEME_TTL_MS），
// 5 分钟续一次，留一半余量。
var HOST_THEME_HEARTBEAT_MS = 5 * 60 * 1000
var PETS_ENDPOINT = '/plugins/dsh-pet-remielle/pets'
var ASSETS_PREFIX = '/plugins/dsh-pet-remielle/assets'
var DESKTOP_ENDPOINT = '/plugins/dsh-pet-remielle/desktop'
var CHECK_ENDPOINT = '/plugins/dsh-pet-remielle/check'
var UPDATE_ENDPOINT = '/plugins/dsh-pet-remielle/update'
var PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'
var INFO_ENDPOINT = '/plugins/dsh-pet-remielle/info'
var DEFAULT_PET_ID = 'remielle'

// `require` is provided by the module-loader factory wrapper.
var React = require('react')

var MOODS = {
  '01': '绘制中',
  '02': '摸鱼中',
  '03': '得意中',
  '04': '思考中',
  '05': '等待中',
  '06': '待机中',
}

var MOOD_ORDER = ['01', '02', '03', '04', '05', '06']

var STREAM_ENDPOINT = '/plugins/dsh-pet-remielle/stream'
var POLL_MS = 800
var STABLE_POLL_MS = 3000

// Gateway-prefix detection (fnOS / TRIM app-center style mounting).
// When the dsh web is served under a path prefix (e.g. /app/<appId>/ via the
// NAS webui), the host rewrites static HTML src/href and intercepts
// fetch/EventSource/script-src, but runtime DOM assignments like
// img.src = '/plugins/...' are NOT rewritten and would 404 at the NAS root.
// Detect the prefix from this bundle's own <script> load URL (the bridge
// rewrites it when mounted), falling back to the page path; '' when served
// directly (127.0.0.1:3080).
var RM_GATEWAY_PREFIX = (function () {
  try {
    var scripts = document.querySelectorAll('script[src*="dsh-pet-remielle"]')
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].src || ''
      var idx = s.indexOf('/plugins/dsh-pet-remielle/')
      if (idx > 0) return s.slice(0, idx)
    }
    var m = (location.pathname || '').match(/^\/app\/[^/]+/)
    if (m) return m[0]
  } catch (e) { /* non-browser context */ }
  return ''
})()
function withPrefix(p) { return RM_GATEWAY_PREFIX + p }

var CSS = [
  // Right-click menu — pink palette, matching the status bubble on both the
  // in-page pet and the desktop window (hardcoded, not DSW vars).
  // 宽度定死 240px（原先靠内容撑开，状态行一长菜单就跟着变宽）。行内间距收窄，
  // 滑块行改成「名称列 flex:1 + 定宽滑块 + 定宽百分比」：名称列吃掉余量后，
  // 滑块与百分比被推到行尾，「角色大小」「透明度」两行的滑块左右边缘严格对齐
  // （旧写法两行名称字数不同，space-between 把滑块放在了不同位置）。
  '.rm2-pet-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:240px;background:#fff0f5;border:1px solid rgba(240,120,160,.45);border-radius:10px;corner-shape:round!important;box-shadow:0 8px 24px rgba(190,70,110,.22);padding:6px;font-family:system-ui,sans-serif;font-size:13px;color:#8a2f52;display:none;user-select:none;}',
  '.rm2-pet-menu-item{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 9px;border-radius:7px;corner-shape:round!important;cursor:pointer;white-space:nowrap;}',
  '.rm2-pet-menu-item>span:first-child{flex:1 1 auto;}',
  '.rm2-pet-menu-item:hover{background:rgba(240,120,160,.14);}',
  '.rm2-pet-menu-item .mute{color:#c2607f;font-size:12px;}',
  // line-height:1 不是装饰：勾选符「✓」(U+2713) 在本机走字体回退，字形盒高 19px
  // 而标签只有 16px，line-height:normal 下行框被撑到 33px（未勾选行 30px），
  // 于是「勾上 / 取消」会让整行抖 3px。压掉 tick 自己的行高贡献即可，
  // 实测 tick 盒 19→13px、行高恒为 30px，勾的视觉位置不变（中心偏移 0）。
  // 桌面端 .menu-item .tick 同款（两端必须同步）。
  '.rm2-pet-menu-item .tick{color:#b03a60;font-weight:600;line-height:1;}',
  '.rm2-pet-menu-status{opacity:.85;cursor:default;}',
  '.rm2-pet-menu-status>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-pet-menu-slider{flex:none;width:92px;margin:0 2px;accent-color:#e8508a;}',
  '.rm2-pet-menu-pct{flex:none;min-width:36px;text-align:right;font-size:12px;}',
  '.rm2-pet-menu-sep{height:1px;background:rgba(240,120,160,.25);margin:5px 6px;}',
  '.rm2-pet-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:13px;min-width:200px;max-width:453px;padding:16px 27px 16px 40px;border-radius:29px;corner-shape:round!important;background:#fff0f5;border:1px solid rgba(240,120,160,.45);box-shadow:0 11px 32px rgba(190,70,110,.22);font-size:16px;line-height:1.45;text-align:left;pointer-events:none;white-space:nowrap;text-overflow:ellipsis;cursor:default;}',
  '.rm2-pet-bubble-title{font-weight:600;color:#b03a60;}',
  '.rm2-pet-bubble-detail{color:#c2607f;margin-top:3px;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
  // 自绘悬停提示浮层：原生 title 不吃 setZoomFactor，高缩放屏（如 200%）上文字过小。
  '.rm2-pet-tip{position:fixed;z-index:2147483400;box-sizing:border-box;max-width:min(420px,calc(100vw - 48px));padding:8px 12px;border-radius:10px;corner-shape:round!important;background:#fff0f5;border:1px solid rgba(240,120,160,.45);box-shadow:0 8px 24px rgba(190,70,110,.22);font-family:system-ui,sans-serif;font-size:13px;line-height:1.5;color:#8a2f52;white-space:pre-wrap;word-break:break-all;display:none;pointer-events:none;}',
  'body[data-ds-dark-theme] .rm2-pet-tip{background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;}',
  // 气泡翻页圆点
  '.rm2-bubble-dots{position:absolute;left:13px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;pointer-events:auto;z-index:120;}',
  '.rm2-bubble-dot{width:13px;height:13px;border-radius:50%;corner-shape:round!important;background:#e8508a;cursor:pointer;box-shadow:0 0 0 3px rgba(255,255,255,.65);transition:transform .18s,background .18s;}',
  '.rm2-bubble-dot:hover{transform:scale(1.25);}',
  '.rm2-pet-bubble::after{content:\"\";position:absolute;top:100%;left:50%;transform:translateX(-50%);corner-shape:round!important;border:8px solid transparent;border-top-color:rgba(240,120,160,.45);}',
  'body[data-ds-dark-theme] .rm2-pet-bubble{background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble-title{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble-detail{color:#f0a8c0;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble::after{border-top-color:rgba(255,150,185,.42);}',
  // Progress bar inside confirmation dialog
  '.rm2-pet-dl-text{color:#b03a60;font-weight:600;font-size:12px;font-family:system-ui,sans-serif;}',
  '.rm2-pet-dl-bar{width:100%;height:4px;border-radius:2px;background:rgba(240,120,160,.2);overflow:hidden;}',
  '.rm2-pet-dl-bar-fill{height:100%;width:0%;border-radius:2px;background:#b03a60;transition:width .3s;}',
  'body[data-ds-dark-theme] .rm2-pet-dl-text{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-dl-bar{background:rgba(255,150,185,.2);}',
  'body[data-ds-dark-theme] .rm2-pet-dl-bar-fill{background:#ffd6e4;}',
  // Confirmation dialog — modal overlay matching dsh style
  '.rm2-pet-confirm-overlay{position:fixed;inset:0;z-index:2147483200;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);}',
  '.rm2-pet-confirm{width:min(380px,90vw);background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));border-radius:14px;corner-shape:round!important;box-shadow:0 20px 56px rgba(15,30,72,.34);padding:24px;font-family:system-ui,sans-serif;color:var(--dsw-alias-label-primary,#172347);}',
  '.rm2-pet-confirm-title{font-size:15px;font-weight:600;margin-bottom:8px;color:#b03a60;}',
  '.rm2-pet-confirm-body{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6f7c99);margin-bottom:20px;}',
  '.rm2-pet-confirm-body b{color:#b03a60;}',
  '.rm2-pet-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;}',
  '.rm2-pet-confirm-btn{padding:7px 18px;border-radius:8px;corner-shape:round!important;border:1px solid rgba(240,120,160,.3);background:transparent;color:#8a2f52;font-size:13px;cursor:pointer;font-family:inherit;transition:background .15s;}',
  '.rm2-pet-confirm-btn:hover{background:rgba(240,120,160,.12);}',
  '.rm2-pet-confirm-btn.primary{background:#b03a60;color:#fff;border-color:#b03a60;}',
  '.rm2-pet-confirm-btn.primary:hover{background:#9a2e54;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm{background:rgba(13,25,59,.98);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-title{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-body{color:#96a6c9;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-body b{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-btn{color:#c2a0b8;border-color:rgba(255,150,185,.3);}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-btn:hover{background:rgba(255,150,185,.15);}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-btn.primary{background:#b03a60;color:#fff;}',
  'body[data-ds-dark-theme] .rm2-pet-menu{background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-menu-item .mute{color:#f0a8c0;}',
  'body[data-ds-dark-theme] .rm2-pet-menu-item .tick{color:#ffb3c9;}',
  'body[data-ds-dark-theme] .rm2-pet-menu-item:hover{background:rgba(255,150,185,.16);}',
  // Toggle switch — matches old zzz-pet-switch style
  '.rm2-pet-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;corner-shape:round!important;background:rgba(113,130,166,.45);cursor:pointer;transition:background .15s;border:none;padding:0;}',
  '.rm2-pet-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;corner-shape:round!important;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s;}',
  '.rm2-pet-switch.on{background:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-pet-switch.on::after{left:18px;}',
  'body[data-ds-dark-theme] .rm2-pet-switch{background:rgba(150,166,201,.4);}',
  'body[data-ds-dark-theme] .rm2-pet-switch.on{background:var(--dsw-alias-brand-primary,#8ba4d8);}',
  // Settings section spacing
  '.rm2-pet-settings-field{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06));}',
  '.rm2-pet-settings-field:last-child{border-bottom:none;}',
  '[data-testid="dsh-pet-remielle-settings"]:hover{border-color:var(--dsw-alias-label-dimmed);}',
  // 设置页按钮/输入框 — 只用 DSH 原生 --dsw-alias-* 变量，浅/深色由宿主变量自动切换，
  // 不再手写 body[data-ds-dark-theme] 覆盖（此前用的 --border-color/--danger-color
  // 是不存在的变量，永远落浅色 fallback，深色下边框是浅灰）。
  '.rm2-pet-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s;}',
  '.rm2-pet-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
  '.rm2-pet-btn:disabled{opacity:.45;cursor:default;}',
  '.rm2-pet-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#526aa8);color:var(--dsw-alias-bg-layer-1,#fff);}',
  // 主按钮文字色不用 --dsw-alias-brand-primary-invert：实测它浅色主题下与
  // brand-primary 同值（都是 #0f1115 近黑）→ 黑底黑字。DSH 浅色的强调色是
  // 近黑、深色是近白，bg-layer-1（浅 #fff / 深 #232324）与之天然互反。
  // 主按钮 hover 必须显式写回主色背景：.rm2-pet-btn-primary 元素同时挂 .rm2-pet-btn，
  // 上面那条 .rm2-pet-btn:hover（特异度 0,3,0）会压过 .rm2-pet-btn-primary（0,1,0），
  // 把主按钮悬浮底色换成浅灰 interactive-bg-hover → 白字浅底撞色。
  // 这里同特异度 + 靠后声明取胜，悬浮只做 opacity 减淡、底色不变。
  '.rm2-pet-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#526aa8);opacity:.85;}',
  '.rm2-pet-input{box-sizing:border-box;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:12px;line-height:20px;}',
  '.rm2-pet-input::placeholder{color:var(--dsw-alias-label-quaternary,#9aa5bd);}',
  '.rm2-pet-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-pet-input:disabled{opacity:.45;}',
  // markdown 渲染区（更新卡 + 设置页关于 tab 的 release 说明）。容器底色由使用处
  // 内联给定；这里只排内部元素。半透明白/黑叠色两主题通用，深色只需微调代码底色。
  '.rm2-md h1,.rm2-md h2,.rm2-md h3,.rm2-md h4,.rm2-md h5,.rm2-md h6{margin:10px 0 4px;line-height:1.4;}',
  '.rm2-md h1{font-size:1.25em;}.rm2-md h2{font-size:1.15em;}.rm2-md h3{font-size:1.08em;}.rm2-md h4,.rm2-md h5,.rm2-md h6{font-size:1em;}',
  '.rm2-md p{margin:6px 0;}',
  '.rm2-md ul,.rm2-md ol{margin:6px 0;padding-left:20px;}',
  '.rm2-md li{margin:2px 0;}',
  '.rm2-md code{font-family:ui-monospace,Consolas,monospace;font-size:.95em;background:rgba(103,126,183,.14);border-radius:4px;padding:1px 4px;}',
  '.rm2-md pre{margin:6px 0;padding:8px 10px;overflow:auto;background:rgba(103,126,183,.12);border-radius:6px;}',
  '.rm2-md pre code{background:transparent;padding:0;}',
  '.rm2-md a{color:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2,#d8d8d8);color:var(--dsw-alias-label-secondary,#6f7c99);}',
  '.rm2-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,#d8d8d8);margin:10px 0;}',
  '.rm2-md>:first-child{margin-top:0;}',
  '.rm2-md>:last-child{margin-bottom:0;}',
  'body[data-ds-dark-theme] .rm2-md code{background:rgba(255,255,255,.1);}',
  'body[data-ds-dark-theme] .rm2-md pre{background:rgba(255,255,255,.07);}',
  'body[data-ds-dark-theme] .rm2-pet-menu-sep{background:rgba(255,150,185,.25);}',
  // 堆叠会话卡（状态页）
  '.rm2-pet-bubbles{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:16px;width:fit-content;max-width:min(440px,calc(100vw - 24px));display:flex;flex-direction:column;align-items:center;pointer-events:none;cursor:default;}',
  '.rm2-pet-bubbles .rm2-pet-bubble{position:relative;bottom:auto;left:auto;transform:none;margin:0;box-sizing:border-box;width:fit-content;min-width:200px;max-width:min(440px,calc(100vw - 24px));height:91px;min-height:91px;padding:16px 27px 16px 40px;border-radius:29px;corner-shape:round!important;text-align:left;box-shadow:0 11px 32px rgba(190,70,110,.22);transition:width .18s ease,opacity .18s ease;}',
  '.rm2-pet-bubbles .rm2-pet-bubble::after{display:none;}',
  '.rm2-pet-bubbles .rm2-pet-bubble{pointer-events:auto;cursor:pointer;}',
  '.rm2-pet-bubble-header{display:flex;align-items:center;min-width:0;min-height:29px;}',
  '.rm2-pet-bubble-title{min-width:0;flex:none;white-space:nowrap;overflow:visible;text-overflow:clip;line-height:1.35;}',
  '.rm2-pet-bubble.title-clipped .rm2-pet-bubble-title{flex:1;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-pet-bubble-action{display:inline-flex;flex:none;order:2;align-items:center;justify-content:center;width:29px;height:29px;margin-left:11px;margin-right:0;border-radius:50%;corner-shape:round!important;background:#e8508a;color:#fff;font-size:20px;font-weight:700;line-height:1;}',
  '.rm2-pet-bubble-action img{width:20px;height:20px;display:block;filter:brightness(0) saturate(100%) invert(1);}',
  '.rm2-pet-bubble-completion{display:none;flex:none;width:16px;height:16px;margin-right:13px;border-radius:50%;corner-shape:round!important;background:#35c979;box-shadow:0 0 0 4px rgba(53,201,121,.18);}',
  '.rm2-pet-bubble.completed .rm2-pet-bubble-completion{display:inline-flex;}',
  '.rm2-pet-bubble.idle-placeholder{height:61px;min-height:61px;padding-top:15px;padding-bottom:15px;}',
  '.rm2-pet-bubble-stack-count{display:none;position:absolute;right:21px;bottom:0;height:11px;align-items:center;color:#f0a8c0;font-size:12px;font-weight:700;line-height:11px;}',
  '.rm2-pet-bubble.summary-backboard .rm2-pet-bubble-stack-count{display:flex;}',
  '.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-title,.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-detail,.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-action,.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-completion{visibility:hidden;}',
  '.rm2-pet-bubble.top{border-color:#b03a60;box-shadow:0 8px 24px rgba(190,70,110,.22);}',
  '.rm2-pet-bubble.attention{border-color:#e8508a;animation:rm2-pet-attention 1.6s ease-in-out infinite;}',
  '@keyframes rm2-pet-attention{0%,100%{box-shadow:0 0 0 0 rgba(232,80,138,.35);}50%{box-shadow:0 0 0 6px rgba(232,80,138,0);}}',
  'body[data-ds-dark-theme] .rm2-pet-bubble.top{border-color:#ffb3c9;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble.attention{border-color:#ff6fa8;}',
  // 单气泡（余额页）允许圆点露出到边框外；堆叠卡恢复裁剪，不影响省略号
  // 堆叠卡需要裁剪超长内容（保留省略号），单气泡（余额）不裁剪
  '.rm2-pet-bubbles .rm2-pet-bubble{overflow:hidden;}',
  // 余额气泡复用对话卡工作态：border-box 同 68px 高度、max-width 与对话卡一致(330)、去掉气泡尾三角。
  // 标题行高 22px 对齐对话卡的 header(min-height 22px)。
  '.rm2-bubble-balance{box-sizing:border-box;height:91px;min-height:91px;max-width:440px;}',
  '.rm2-bubble-balance .rm2-pet-bubble-title{line-height:29px;min-width:0;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-bubble-balance::after{display:none;}',
].join('\n')

function mk(tag, style, text) {
  var n = document.createElement(tag)
  if (style) n.style.cssText = style
  if (text !== undefined) n.textContent = text
  return n
}

/** Sticker URL for one pet + mood, served by the host (gateway-prefix aware). */
function gifUrl(petId, mood) {
  return withPrefix(ASSETS_PREFIX) + '/' + encodeURIComponent(petId) + '/' + mood + '.gif'
}

/** Quick semver-ish compare (strips leading v, numeric dot segments). */
function semverGt(a, b) {
  const pa = (a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = (b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y
  }
  return false
}

// ---- self-update UI (proactive bubble + release card) ----
// 模块可能随插件重载被重新求值：更新气泡/卡片与它们的 document 监听
// 用 window 级单例守卫，避免重复挂载时往 body 堆叠游离节点和监听器。
var latestInfo = null
if (!window.__rm2UpdateUi) {
  var updBubbleEl = mk('button', 'display:none;position:fixed;right:20px;bottom:42px;z-index:2147483300;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary,#526aa8);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-brand-primary,#526aa8);cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;', '🆕 有新版本')
  updBubbleEl.title = '查看更新'
  updBubbleEl.addEventListener('click', function () { openUpdateCard() })
  var updCardEl = mk('div', 'display:none;position:fixed;z-index:2147483301;top:50%;left:50%;transform:translate(-50%,-50%);width:min(460px,92vw);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:12px;padding:18px;font-size:13px;color:var(--dsw-alias-label-primary,#172347);font-family:system-ui,sans-serif;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(15,30,72,.28));')
  var appendUpdateUi = function () {
    document.body.appendChild(updBubbleEl)
    document.body.appendChild(updCardEl)
  }
  if (document.body) appendUpdateUi()
  else window.addEventListener('DOMContentLoaded', appendUpdateUi)
  document.addEventListener('pointerdown', function (e) {
    // 更新进行中不允许点外部关闭（只能点 ✕），避免误关后丢失更新状态展示
    if (updateState && updateState.phase === 'running') return
    if (updCardEl.style.display === 'block' && !updCardEl.contains(e.target)) updCardEl.style.display = 'none'
  }, true)
  window.__rm2UpdateUi = { bubble: updBubbleEl, card: updCardEl }
}
var updBubble = window.__rm2UpdateUi.bubble
var updCard = window.__rm2UpdateUi.card
// 更新流程状态：null=空闲；running=请求进行中（禁止点外关闭）；done=成功待重启
var updateState = null
var lastUpdateError = ''
var updatePollTimer = 0
function closeUpdateCard() { updCard.style.display = 'none' }
function setLatestUpdate(info, isNew) {
  latestInfo = info
  if (isNew) updBubble.style.display = 'inline-flex'
  else updBubble.style.display = 'none'
}
// ---- markdown 渲染（release 说明） ----
// GitHub release body 是 markdown，原先当纯文本 <pre> 展示，标题/列表/链接全糊成一行。
// 这里实现一个够用的子集：标题、列表、代码块/行内代码、引用、分隔线、粗斜体、删除线、链接。
// 安全约定：先整体 HTML 转义再做 markdown 变换（转义后的 &lt; 等不会再被二次解释），
// 链接目标只放行 http(s)/mailto，其余一律置为 '#'——release body 来自远端，不可信任。

// ---- md render begin ----（test/settings-section.test.js 按标记切片单测这一段，勿改标记行）
function mdEscapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function mdSafeUrl(url) {
  var u = String(url || '').trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u.replace(/"/g, '%22') : '#'
}
function mdInline(text) {
  var s = mdEscapeHtml(text)
  s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>' })
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
    return '<a href="' + mdSafeUrl(u) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>'
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return s
}
function renderMarkdown(src) {
  var lines = String(src || '').split(/\r?\n/)
  var html = []
  var inCode = false
  var listTag = null
  var para = []
  function flushPara() { if (para.length) { html.push('<p>' + para.join('<br>') + '</p>'); para = [] } }
  function closeList() { if (listTag) { html.push('</' + listTag + '>'); listTag = null } }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (/^\s*```/.test(line)) {
      if (inCode) { html.push('</code></pre>'); inCode = false }
      else { flushPara(); closeList(); html.push('<pre><code>'); inCode = true }
      continue
    }
    if (inCode) { html.push(mdEscapeHtml(line)); continue }
    var h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flushPara(); closeList(); var lv = h[1].length; html.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>'); continue }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html.push('<hr>'); continue }
    var ul = line.match(/^\s*[-*+]\s+(.*)$/)
    var ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      var want = ul ? 'ul' : 'ol'
      if (listTag !== want) { closeList(); html.push('<' + want + '>'); listTag = want }
      html.push('<li>' + mdInline((ul || ol)[1]) + '</li>')
      continue
    }
    var q = line.match(/^\s*>\s?(.*)$/)
    if (q) { flushPara(); closeList(); html.push('<blockquote>' + mdInline(q[1]) + '</blockquote>'); continue }
    if (!line.trim()) { flushPara(); closeList(); continue }
    para.push(mdInline(line))
  }
  if (inCode) html.push('</code></pre>')
  flushPara(); closeList()
  return html.join('')
}
// ---- md render end ----

function baseUpdateNotes() {
  if (latestInfo.needsCleanReinstall) {
    return '版本低于 0.3.0，包名已变更，无法自动更新。\n请先彻底卸载旧版本，再重新安装 dsh-pet-remielle。'
  }
  return latestInfo.notes || '(无更新说明)'
}
function renderUpdateCard() {
  if (!latestInfo) return
  updCard.textContent = ''
  var phase = updateState && updateState.phase
  var titleText = phase === 'done' ? '更新成功' : phase === 'running' ? '正在更新' : '发现新版本'
  var heading = mk('div', 'display:flex;justify-content:space-between;align-items:center;gap:12px;')
  var title = mk('strong', 'font-size:15px;', titleText)
  // ✕ 始终可关；更新中仅它可关（点外部无效）
  var closeX = mk('button', 'border:none;background:transparent;cursor:pointer;font-size:16px;color:var(--dsw-alias-label-tertiary,#6f7c99);', '✕')
  closeX.addEventListener('click', closeUpdateCard)
  heading.appendChild(title)
  heading.appendChild(closeX)
  updCard.appendChild(heading)
  var versions = mk('div', 'display:flex;align-items:center;gap:10px;margin:14px 0 4px;font-weight:600;')
  versions.appendChild(mk('span', 'text-decoration:line-through;color:var(--dsw-alias-label-tertiary,#6f7c99);', (typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : '?')))
  versions.appendChild(mk('span', 'color:var(--dsw-alias-label-tertiary,#6f7c99);', '→'))
  versions.appendChild(mk('span', 'color:var(--dsw-alias-brand-primary,#526aa8);', latestInfo.latest))
  updCard.appendChild(versions)
  // release 说明是 markdown（GitHub release body），渲染成排版而非纯文本；
  // 更新输出 / 失败原因是进程日志，保持等宽 <pre> 原样。
  var notesBox = mk('div', 'margin:8px 0 0;max-height:180px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;')
  notesBox.className = 'rm2-md'
  notesBox.innerHTML = renderMarkdown(baseUpdateNotes())
  updCard.appendChild(notesBox)
  if (phase === 'done') {
    updCard.appendChild(mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', '──── 更新输出 ────\n' + (updateState.output || '(无输出)') + '\n\n请重启 DSH 使新版本生效。'))
  } else if (lastUpdateError) {
    // 失败输出可能是一整段 pnpm 日志，必须限高滚动，否则卡片被拉到离谱长
    updCard.appendChild(mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', '❌ 上次更新失败：' + friendlyUpdateError(lastUpdateError)))
  }
  // 更新进行中：实时展示宿主转发的子进程输出尾部（看门狗每 1s 轮询刷新）
  var prog = phase === 'running' ? (updateState.progress || null) : null
  if (prog && prog.outputTail) {
    var progPre = mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', '──── 实时输出（自动刷新） ────\n' + prog.outputTail)
    progPre.className = 'rm2-upd-progress'
    updCard.appendChild(progPre)
    progPre.scrollTop = progPre.scrollHeight
  }
  var actions = mk('div', 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:14px;min-height:32px;')
  // 手动更新入口**常驻**（所有状态可见，放在左侧）：一键更新一旦失败/超时，
  // 不用等下一轮提示就能直接改走手动路径；原先独立的 GitHub 入口与本按钮
  // 同跳发布页，已合并。needsCleanReinstall 有专属的「查看升级说明」，不重复。
  if (!latestInfo.needsCleanReinstall) {
    var manualBtn = mk('button', 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:transparent;cursor:pointer;font-size:13px;font-family:inherit;margin-right:auto;', '手动更新（GitHub）')
    manualBtn.addEventListener('click', function () { window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank') })
    actions.appendChild(manualBtn)
  }
  if (phase === 'running') {
    // 更新中：纯状态文案——不渲染任何不可点击的假按钮
    var elapsedS = prog && prog.elapsedMs ? Math.round(prog.elapsedMs / 1000) : 0
    actions.appendChild(mk('span', 'color:var(--dsw-alias-label-secondary,#42506b);font-size:13px;', '⏳ 正在更新，请勿关闭 DSH…' + (elapsedS ? '（已进行 ' + elapsedS + ' 秒）' : '')))
  } else if (phase === 'done') {
    actions.appendChild(mk('span', 'color:#2fa24c;font-weight:600;font-size:13px;', '✔ 请重启 DSH 后生效'))
  } else if (latestInfo.needsCleanReinstall) {
    var upgrade = mk('button', 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#526aa8);color:#fff;cursor:pointer;font-size:13px;font-family:inherit;', '查看升级说明')
    upgrade.addEventListener('click', function () { window.open('https://github.com/Gin-7/dsh-pet-remielle#升级', '_blank') })
    actions.appendChild(upgrade)
  } else {
    var updBtn = mk('button', 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#526aa8);color:#fff;cursor:pointer;font-size:13px;font-family:inherit;', '一键更新')
    updBtn.addEventListener('click', function () { runSelfUpdate() })
    actions.appendChild(updBtn)
  }
  updCard.appendChild(actions)
  updCard.style.display = 'block'
}
function openUpdateCard() {
  if (!latestInfo) return
  renderUpdateCard()
}
function stopUpdateWatchdog() {
  if (updatePollTimer) { window.clearInterval(updatePollTimer); updatePollTimer = 0 }
}
// 更新失败提示：只给一句结论（网络慢导致超时 / 建议手动更新），不展开
// pnpm/镜像细节；具体操作交给卡片下方「手动更新（GitHub）」按钮跳转发布页。
function friendlyUpdateError(msg) {
  var s = String(msg || '')
  if (/\[timeout/i.test(s)) {
    return s + '\n\n💡 网络较慢导致下载超时（安装包约 17MB），建议手动更新。'
  }
  return s + '\n\n💡 建议手动更新。'
}
function finishUpdateSuccess(output) {
  stopUpdateWatchdog()
  updateState = { phase: 'done', output: output || '' }
  updBubble.style.display = 'none'
  renderUpdateCard()
}
function failUpdate(message) {
  stopUpdateWatchdog()
  lastUpdateError = message
  updateState = null
  renderUpdateCard()
}
// 看门狗：更新请求的响应可能因代理/连接问题丢失，导致卡片永远停在“正在更新”。
// 更新期间每 1s 做两件事——① 查 /update-progress 拿子进程输出尾部与耗时，刷新
// 进度卡片；② 查 /info——只要已安装版本 ≠ 页面构建版本，即可判定更新实际已完成；
// 超过 3 分钟仍无变化则给出超时提示（可重试）。
var lastProgressKey = ''
function startUpdateWatchdog() {
  stopUpdateWatchdog()
  var startedAt = Date.now()
  var pageVersion = typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : ''
  lastProgressKey = ''
  updatePollTimer = window.setInterval(function () {
    fetchJson(PROGRESS_ENDPOINT + '?t=' + Date.now())
      .then(function (p) {
        if (!updateState || updateState.phase !== 'running') return
        if (p && typeof p.outputTail === 'string') {
          var next = { elapsedMs: p.elapsedMs || 0, outputTail: p.outputTail }
          // 输出或秒数有变化才重绘，避免无意义的卡片重建打断用户滚动
          var key = next.outputTail + '|' + Math.round(next.elapsedMs / 1000)
          if (key !== lastProgressKey) {
            lastProgressKey = key
            updateState.progress = next
            renderUpdateCard()
          }
        }
      })
      .catch(function () { /* 单次查询失败忽略，下个周期再取 */ })
    fetchJson(INFO_ENDPOINT + '?t=' + Date.now())
      .then(function (info) {
        if (!updateState || updateState.phase !== 'running') { stopUpdateWatchdog(); return }
        if (info && info.version && info.version !== pageVersion) {
          finishUpdateSuccess('检测到已安装版本 ' + info.version + '（更新请求的响应未送达，以实际安装结果为准）。')
        } else if (Date.now() - startedAt > 180000) {
          failUpdate('等待更新结果超时。若 DSH 控制台已显示成功请直接重启 DSH；否则可重试。')
        }
      })
      .catch(function () { /* 单次查询失败忽略，下个周期再查 */ })
  }, 1000)
}
function runSelfUpdate() {
  if (updateState && updateState.phase === 'running') return
  lastUpdateError = ''
  updateState = { phase: 'running', output: '' }
  renderUpdateCard()
  startUpdateWatchdog()
  fetch(UPDATE_ENDPOINT, { method: 'POST' })
    .then(function (r) { return r.json().catch(function () { return null }).then(function (j) { return { ok: r.ok, j: j } }) })
    .then(function (res) {
      if (res.ok && res.j && res.j.ok) {
        finishUpdateSuccess(res.j.output || '')
      } else {
        // 失败：回到常规视图（保留重试按钮），错误信息进 notes
        failUpdate((res.j && res.j.output) || ('请求失败' + (res.ok ? '' : '（HTTP 错误）')))
      }
    })
    .catch(function (err) {
      // 响应丢失不打死结论：看门狗继续轮询 /info，以实际安装结果为准
      if (!updateState || updateState.phase !== 'running') return
      stopUpdateWatchdog()
      startUpdateWatchdog()
    })
}

/** Poll the host state endpoint once; resolves to the snapshot or null. */
function fetchState() {
  return fetch(STATE_ENDPOINT, { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('state request failed: ' + response.status)
      return response.json()
    })
    .catch(function () { return null })
}

function fetchJson(url) {
  return fetch(url, { cache: 'no-store' }).then(function (response) {
    if (!response.ok) throw new Error('request failed: ' + response.status)
    return response.json()
  })
}

/** PATCH several config fields in one request（端点收对象、拒未知键）。 */
function patchConfigFields(patch) {
  return fetch(CONFIG_ENDPOINT, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(function () {})
}

function patchConfig(field, next) {
  return patchConfigFields({ [field]: next })
}

function patchPet(id, patch) {
  return fetch(PETS_ENDPOINT + '/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(function () { return null })
}

/** ---------- settings card (React) ---------- */

function Field(props) {
  return React.createElement('label', { className: 'rm2-pet-settings-field', style: props.fieldStyle || undefined },
    React.createElement('span', null,
      React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, props.label),
      React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, props.hint),
    ),
    props.children,
  )
}

function Switch(props) {
  var on = props.checked === true
  return React.createElement('button', {
    type: 'button',
    className: 'rm2-pet-switch' + (on ? ' on' : ''),
    role: 'switch',
    'aria-checked': on,
    disabled: props.disabled,
    onClick: function () { if (!props.disabled && props.onChange) props.onChange(!on) },
  })
}

function RemielleCard() {
  var statusState = React.useState('loading')
  var status = statusState[0]
  var setStatus = statusState[1]
  var valueState = React.useState({})
  var value = valueState[0]
  var setValue = valueState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var patchSeq = React.useRef(0)
  var writable = status === 'ready' && !busy
  React.useEffect(function () {
    var active = true
    fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('settings request failed: ' + response.status)
        return response.json()
      })
      .then(function (next) { if (active) { setValue(next); setStatus('ready') } })
      .catch(function () { if (active) setStatus('unavailable') })
    return function () { active = false }
  }, [])
  var write = function (field, next) {
    var seq = ++patchSeq.current
    setBusy(true)
    fetch(CONFIG_ENDPOINT, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: next }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('settings write failed: ' + response.status)
        return response.json()
      })
      .then(function (updated) {
        if (seq === patchSeq.current) { setValue(updated); setStatus('ready') }
      })
      .catch(function () { if (seq === patchSeq.current) setStatus('unavailable') })
      .finally(function () { if (seq === patchSeq.current) setBusy(false) })
  }
  var cardStyle = {
    listStyle: 'none',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: 12,
    transition: 'border-color .16s, background .16s',
    padding: '14px 16px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    font: 'inherit', color: 'inherit',
  }
  return React.createElement('li', { style: cardStyle, 'data-testid': 'dsh-pet-remielle-settings' },
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 15, fontWeight: 600, lineHeight: 1.4 } }, '蕾米埃尔桌宠'),
      React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5, marginTop: 2 } }, '跟随 DSH 会话实时状态变化而变动的网页桌宠。'),
    ),
    status === 'unavailable'
      ? React.createElement('span', { role: 'status', style: { whiteSpace: 'nowrap', fontSize: 12, opacity: 0.6 } }, '未连接到 Host')
      : status === 'loading'
      ? React.createElement('span', { style: { whiteSpace: 'nowrap', fontSize: 12, opacity: 0.6 } }, '读取中…')
      : React.createElement(Switch, { checked: value.enabled !== false, disabled: !writable, onChange: function (val) {
        setValue(function (prev) { return Object.assign({}, prev, { enabled: val }) }) // 乐观更新，即时反馈
        void write('enabled', val)
      } }),
  )
}

/** ---------- pet management section (React) ---------- */

function petBadge(pet) {
  if (!pet.available) return '目录缺失'
  if (!pet.complete) return '缺图（需 01–06 齐全）'
  if (pet.enabled) return '已启用'
  return '未启用'
}

function RenameButton(props) {
  var editingState = React.useState(false)
  var editing = editingState[0]
  var setEditing = editingState[1]
  var nameState = React.useState(props.pet.name)
  var name = nameState[0]
  var setName = nameState[1]
  var save = function () {
    var next = name.trim() || props.pet.name
    void patchPet(props.pet.id, { name: next }).then(function (result) {
      if (result) { props.refresh(); setEditing(false) }
    })
  }
  // 非编辑态就是宠物名本身：双击进入编辑（不占一整颗按钮位，视觉与普通名字一致）
  if (!editing) {
    return React.createElement('strong', {
      style: { fontSize: 13, cursor: 'text' },
      title: '双击改名',
      onDoubleClick: function () { if (!props.busy) { setName(props.pet.name); setEditing(true) } },
    }, props.pet.name)
  }
  return React.createElement('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
    React.createElement('input', {
      type: 'text', value: name, className: 'rm2-pet-input', style: { width: 120 },
      autoFocus: true,
      onChange: function (event) { setName(event.target.value) },
      onBlur: save,
      onKeyDown: function (event) {
        if (event.key === 'Enter') save()
        if (event.key === 'Escape') setEditing(false)
      },
    }),
    React.createElement('button', {
      type: 'button', className: 'rm2-pet-btn rm2-pet-btn-primary',
      onMouseDown: function (event) { event.preventDefault() }, // 保住 input 焦点，避免 onBlur 先触发保存打两次
      onClick: save,
    }, '保存'),
  )
}

function AddPetForm(props) {
  var idState = React.useState('')
  var id = idState[0]
  var setId = idState[1]
  var nameState = React.useState('')
  var name = nameState[0]
  var setName = nameState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var okId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
  var submit = function () {
    var clean = id.trim()
    if (!okId.test(clean)) {
      setError('id 只能包含字母、数字、下划线和连字符，且不能以符号开头。')
      return
    }
    setError(null)
    void patchPet(clean, { name: name.trim() || clean, enabled: true }).then(function (result) {
      if (result) {
        setId('')
        setName('')
        props.refresh()
      } else {
        setError('添加失败：请确认 DSH Host 正在运行。')
      }
    })
  }
  return React.createElement('div', {
    style: {
      marginTop: 14, padding: 14, border: '1px dashed var(--dsw-alias-border-l2, #d8d8d8)',
      borderRadius: 12, display: 'grid', gap: 10,
    },
  },
    React.createElement('strong', { style: { fontSize: 14 } }, '添加新宠物'),
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: '2px' } },
      React.createElement('span', { style: { padding: '1px 8px', borderRadius: 999, background: 'rgba(212,156,0,.18)', color: '#9a6a00', fontSize: 11, fontWeight: 600 } }, '开发中'),
      React.createElement('span', { style: { opacity: 0.8, fontSize: 12 } }, '上传新桌宠的功能还未完善，当前请按下方说明手动把贴纸放进目录后再登记。'),
    ),
    React.createElement('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } },
      '把 6 张状态贴纸（01.gif–06.gif）放进插件目录 assets/pets/<id>/，然后在这里登记即可。'),
    React.createElement('div', { style: { display: 'grid', gap: 8 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7, minWidth: 60 } }, 'ID'),
        React.createElement('input', {
          type: 'text', placeholder: '目录名（英文数字下划线）', value: id,
          className: 'rm2-pet-input', style: { flex: 1, fontSize: 13 },
          onChange: function (event) { setId(event.target.value) },
        }),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7, minWidth: 60 } }, '名称'),
        React.createElement('input', {
          type: 'text', placeholder: '显示名（可选）', value: name,
          className: 'rm2-pet-input', style: { flex: 1, fontSize: 13 },
          onChange: function (event) { setName(event.target.value) },
        }),
      ),
      React.createElement('button', {
        type: 'button', onClick: submit, className: 'rm2-pet-btn rm2-pet-btn-primary', style: { fontSize: 13, padding: '6px 14px', alignSelf: 'flex-start' },
      }, '添加并启用'),
    ),
    error ? React.createElement('small', { role: 'alert', style: { color: 'var(--dsw-alias-label-error, #c0392b)', fontSize: 12 } }, error) : null,
  )
}

function PetsSection() {
  var tabState = React.useState('appearance')
  var tab = tabState[0]
  var setTab = tabState[1]
  var dataState = React.useState(null)
  var data = dataState[0]
  var setData = dataState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var configState = React.useState(null)
  var config = configState[0]
  var setConfig = configState[1]
  var sliderTimers = React.useRef(new Map())
  var helpState = React.useState(false)
  var tokenHelpOpen = helpState[0]
  var setTokenHelpOpen = helpState[1]
  var updState = React.useState(null)       // { latest, notes } | null
  var updInfo = updState[0]
  var setUpdInfo = updState[1]
  var updCheckingState = React.useState(false)
  var updChecking = updCheckingState[0]
  var setUpdChecking = updCheckingState[1]
  var updMsgState = React.useState(null)    // 'checking' | 'latest' | 'error:...' | null
  var updMsg = updMsgState[0]
  var setUpdMsg = updMsgState[1]
  var currentVersion = (typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : '?')
  var checkUpdate = function () {
    if (updChecking) return
    setUpdChecking(true)
    setUpdMsg('checking')
    fetch(CHECK_ENDPOINT, { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) {
        setUpdChecking(false)
        if (!j || !j.ok || typeof j.latest !== 'string') {
          setUpdInfo(null)
          setUpdMsg(j && j.error === 'no version yet' ? 'no-release' : (j && j.error ? 'error:' + j.error : 'error'))
          return
        }
        var info = { latest: j.latest, notes: j.notes || '', needsCleanReinstall: j.needsCleanReinstall === true }
        var isNew = semverGt(info.latest, currentVersion)
        setUpdInfo(info)
        setUpdMsg(isNew ? 'has-update' : 'latest')
        setLatestUpdate(info, isNew)
        updBubble.style.display = 'none' // 设置页已显示更新信息，不需要气泡
      })
      .catch(function () {
        setUpdChecking(false)
        setUpdInfo(null)
        setUpdMsg('error')
      })
  }
  var refresh = function () {
    fetchJson(PETS_ENDPOINT)
      .then(function (result) { setData(result); setError(null) })
      .catch(function () { setError('无法连接 DSH Host，宠物注册表暂不可用。') })
  }
  React.useEffect(function () { refresh() }, [])
  React.useEffect(function () {
    var active = true
    fetchJson(CONFIG_ENDPOINT)
      .then(function (next) { if (active) setConfig(next) })
      .catch(function () {})
    return function () { active = false; for (var _t of sliderTimers.current.values()) clearTimeout(_t); sliderTimers.current.clear() }
  }, [])
  var write = function (key, val) {
    setConfig(function (prev) { return Object.assign({}, prev, {[key]: val}) })
    void patchConfig(key, val)
  }
  var writeSlider = function (key, val) {
    setConfig(function (prev) { return Object.assign({}, prev, {[key]: val}) })
    var pending = sliderTimers.current.get(key)
    if (pending) clearTimeout(pending)
    sliderTimers.current.set(key, setTimeout(function () { sliderTimers.current.delete(key); void patchConfig(key, val) }, 250))
  }
  var sectionStyle = { display: 'grid', gap: 10, padding: '4px 2px', fontSize: 13, color: 'var(--dsw-alias-label-primary, #172347)' }
  var tabs = [
    { id: 'appearance', label: '外观' },
    { id: 'pets', label: '宠物' },
    { id: 'behavior', label: '行为' },
    { id: 'desktop', label: '桌面悬浮' },
    { id: 'about', label: '关于' },
  ]
  var tabBar = React.createElement('div', { style: { display: 'flex', gap: 2, borderBottom: '1px solid var(--dsw-alias-border-l2, #d8d8d8)', marginBottom: 12 } },
    tabs.map(function (t) {
      var active = tab === t.id
      return React.createElement('button', {
        key: t.id, type: 'button',
        onClick: function () { setTab(t.id) },
        style: {
          flex: 1, padding: '8px 0', border: 'none', borderBottom: active ? '2px solid var(--dsw-alias-brand-primary, #526aa8)' : '2px solid transparent',
          background: 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
          color: active ? 'var(--dsw-alias-brand-primary, #526aa8)' : 'var(--dsw-alias-label-secondary, #6f7c99)',
          fontFamily: 'inherit', transition: 'color .15s',
        },
      }, t.label)
    }),
  )
  var v = config || {}
  // 子设置项：随父开关缩进，表达从属关系（不用强调边框，纯留白缩进）
  var subFieldStyle = { marginLeft: 18, paddingLeft: 12 }
  var appearanceTab = React.createElement('div', null,
    React.createElement(Field, { label: '角色大小', hint: Math.round((v.scale ?? 1) * 100) + '%' },
      React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.scale ?? 1, disabled: !config, onChange: function (e) { writeSlider('scale', Number(e.target.value)) } }),
    ),
    React.createElement(Field, { label: '气泡随桌宠同步缩放', hint: v.bubbleScaleSync !== false ? '气泡大小 = 角色大小 × 相对比例' : '气泡使用固定大小，不随角色缩放' },
      React.createElement(Switch, { checked: v.bubbleScaleSync !== false, disabled: !config, onChange: function (val) { write('bubbleScaleSync', val) } }),
    ),
    v.bubbleScaleSync !== false
      ? React.createElement(Field, { label: '气泡相对桌宠的大小', hint: Math.round((v.bubbleScaleRatio ?? 1) * 100) + '%', fieldStyle: subFieldStyle },
          React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.bubbleScaleRatio ?? 1, disabled: !config, onChange: function (e) { writeSlider('bubbleScaleRatio', Number(e.target.value)) } }),
        )
      : React.createElement(Field, { label: '气泡固定大小', hint: Math.round((v.bubbleFixedSize ?? 1) * 100) + '%', fieldStyle: subFieldStyle },
          React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.bubbleFixedSize ?? 1, disabled: !config, onChange: function (e) { writeSlider('bubbleFixedSize', Number(e.target.value)) } }),
        ),
    React.createElement(Field, { label: '透明度', hint: Math.round((v.opacity ?? 1) * 100) + '%' },
      React.createElement('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: v.opacity ?? 1, disabled: !config, onChange: function (e) { writeSlider('opacity', Number(e.target.value)) } }),
    ),
    React.createElement(Field, { label: '角色左右镜像', hint: v.mirror === true ? '已镜像' : '正常方向' },
      React.createElement(Switch, { checked: v.mirror === true, disabled: !config, onChange: function (val) { write('mirror', val) } }),
    ),
  )
  var petsTab = React.createElement('div', null,
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
      React.createElement('span', { style: { fontWeight: 600 } }, '宠物列表'),
      React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, '管理你的桌宠收藏'),
    ),
      error
        ? React.createElement('div', { role: 'alert' },
            React.createElement('span', null, error),
            React.createElement('button', { type: 'button', onClick: refresh, className: 'rm2-pet-btn', style: { marginLeft: 10 } }, '重试'),
          )
        : data === null
        ? React.createElement('p', { style: { opacity: 0.6, fontSize: 12 } }, '加载宠物列表中…')
        : React.createElement(React.Fragment, null,
            data.pets.map(function (pet) {
              var badge = petBadge(pet)
              return React.createElement('div', {
                key: pet.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
                  border: '1px solid ' + (pet.id === data.activePetId ? 'var(--dsw-alias-brand-primary, #526aa8)' : 'var(--dsw-alias-border-l2, #d8d8d8)'),
                  background: pet.id === data.activePetId ? 'rgba(82,106,168,.06)' : 'transparent',
                  marginBottom: 6,
                },
              },
                React.createElement('img', { src: gifUrl(pet.id, pet.previewMood || '06'), alt: pet.name, style: { width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }, draggable: false }),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    // 名字本身就是改名入口：双击进入编辑。目录缺失的宠物不允许改名
                    // （PATCH /pets/:id 对不存在目录也会失败），保持纯文本展示。
                    pet.available
                      ? React.createElement(RenameButton, { pet: pet, refresh: refresh, busy: busy })
                      : React.createElement('strong', { style: { fontSize: 13 } }, pet.name),
                    React.createElement('span', {
                      style: {
                        fontSize: 11, padding: '1px 8px', borderRadius: 999,
                        border: '1px solid ' + (pet.available && pet.complete ? 'var(--dsw-alias-border-l2, #d8d8d8)' : 'var(--dsw-alias-label-error, #c0392b)'),
                        color: pet.available && pet.complete ? 'inherit' : 'var(--dsw-alias-label-error, #c0392b)',
                      },
                    }, badge),
                    React.createElement('span', { style: { fontSize: 11, opacity: 0.5, fontFamily: 'monospace' } }, pet.id),
                  ),
                  React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                    pet.id !== data.activePetId && pet.available && pet.complete
                      ? React.createElement('button', {
                          type: 'button', disabled: busy, className: 'rm2-pet-btn',
                          onClick: function () { void patchPet(pet.id, { active: true }).then(function (result) { if (result) refresh() }) },
                        }, '设为当前')
                      : null,
                  ),
                ),
                React.createElement(Switch, {
                  checked: pet.enabled === true,
                  disabled: !pet.available || busy,
                  onChange: function (val) {
                    void patchPet(pet.id, { enabled: val }).then(function (result) { if (result) refresh() })
                  },
                }),
              )
            }),
            data.pets.length === 0 ? React.createElement('p', { style: { opacity: 0.7, fontSize: 12 } }, '还没有任何宠物。先添加一只吧！') : null,
            React.createElement(AddPetForm, { refresh: refresh }),
          ),
  )
  var behaviorTab = React.createElement('div', null,
    React.createElement(Field, { label: '启用桌宠', hint: '关闭后宠物立即隐藏。' },
      React.createElement(Switch, { checked: v.enabled !== false, disabled: !config, onChange: function (val) { write('enabled', val) } }),
    ),
    React.createElement(Field, { label: '锁定位置', hint: '开启后宠物不可拖动。' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('button', {
          type: 'button', disabled: !config, className: 'rm2-pet-btn',
          // 旧实现误打 /desktop/start——按「重置位置」反而拉起桌面悬浮窗。
          // 现在与右键菜单同一语义：四个坐标一次清空（页面内 posX/posY +
          // 桌面窗 desktopX/desktopY），下次进入桌面模式即回默认落点。
          onClick: function () { void patchConfigFields({ posX: null, posY: null, desktopX: null, desktopY: null }) },
        }, '重置位置'),
        React.createElement(Switch, { checked: v.locked === true, disabled: !config, onChange: function (val) { write('locked', val) } }),
      ),
    ),
    React.createElement(Field, { label: '暂停动画', hint: '暂停 GIF 动画，宠物保持当前帧静止。' },
      React.createElement(Switch, { checked: v.paused === true, disabled: !config, onChange: function (val) { write('paused', val) } }),
    ),
    React.createElement(Field, { label: '隐藏桌宠', hint: '隐藏宠物。右键菜单里没有这一项（关掉就没入口了），要恢复请回这里关闭开关。' },
      React.createElement(Switch, { checked: v.hidden === true, disabled: !config, onChange: function (val) { write('hidden', val) } }),
    ),
    React.createElement(Field, { label: '响应子 Agent', hint: '默认只跟随顶层任务，避免状态过度跳动。' },
      React.createElement(Switch, { checked: v.includeSubagents === true, disabled: !config, onChange: function (val) { write('includeSubagents', val) } }),
    ),
    // ---- 消息气泡 ----
    React.createElement(Field, { label: '消息气泡', hint: '开启后可在宠物上方显示气泡；子项控制气泡内容（多开时可翻页）。' },
      React.createElement(Switch, { checked: v.showBubble !== false, disabled: !config, onChange: function (val) {
        // 总开关关闭→全部子开关关闭；总开关开启→全部子开关打开，回到状态页
        write('showBubble', val)
        if (!val) { write('showBubbleStatus', false); write('showBubbleUsage', false) }
        else {
          write('showBubbleStatus', true); write('showBubbleUsage', true)
          // 气泡从关到开的页面重置由宠物视图的 updateBubble 处理
        }
      } }),
    ),
    // 气泡子项（始终展开）
    React.createElement('div', { style: { marginLeft: 20, display: 'grid', gap: 8 } },
      React.createElement(Field, { label: '状态', hint: '在气泡中显示会话状态（阶段/待办/进度）' },
        React.createElement(Switch, { checked: v.showBubbleStatus !== false, disabled: !config, onChange: function (val) {
          write('showBubbleStatus', val)
          if (val) write('showBubble', true)
          if (!val && v.showBubbleUsage !== true) write('showBubble', false)
        } }),
      ),
      React.createElement(Field, { label: '用量', hint: 'DeepSeek 余额与今日消耗（需配置 DEEPSEEK_API_KEY）', fieldStyle: { borderBottom: 'none' } },
        React.createElement(Switch, { checked: v.showBubbleUsage === true, disabled: !config, onChange: function (val) {
          write('showBubbleUsage', val)
          if (val) write('showBubble', true)
          if (!val && v.showBubbleStatus !== true) write('showBubble', false)
        } }),
      ),
      // 用量模式（用量子项下方，分割线上方）
      React.createElement('div', { style: { marginLeft: 16, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06))', display: 'grid', gap: 6 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { style: { fontSize: 12, opacity: v.showBubbleUsage === true ? 1 : 0.4 } }, '用量模式'),
            // 实时令牌模式的帮助图标：圆 + 问号，点击打开获取方法弹窗
            v.usageMode === 'token'
              ? React.createElement('button', {
                  type: 'button',
                  title: '如何获取 DEEPSEEK_PLATFORM_TOKEN',
                  onClick: function (e) { e.stopPropagation(); setTokenHelpOpen(true) },
                  style: { width: 16, height: 16, padding: 0, borderRadius: '50%', cornerShape: 'round', border: '1px solid var(--dsw-alias-border-l2, #b8b8b8)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11, lineHeight: '14px', fontFamily: 'inherit', textAlign: 'center', opacity: v.showBubbleUsage === true ? 1 : 0.4 },
                }, '?')
              : null,
          ),
          React.createElement('select', {
            value: v.usageMode === 'token' ? 'token' : 'ledger',
            disabled: !config || v.showBubbleUsage !== true,
            onChange: function (e) { write('usageMode', e.target.value) },
            style: { padding: '4px 8px', width: 160, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #d8d8d8)', background: 'var(--dsw-alias-bg-layer-2, transparent)', cursor: config && v.showBubbleUsage === true ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary, inherit)', opacity: v.showBubbleUsage === true ? 1 : 0.4 },
          },
            React.createElement('option', { value: 'ledger' }, '小鲸鱼记账（免令牌）'),
            React.createElement('option', { value: 'token' }, '实时·令牌（精确）')
          ),
        ),
        React.createElement('p', { style: { margin: 0, opacity: v.showBubbleUsage === true ? 0.5 : 0.25, fontSize: 11 } },
          v.usageMode === 'token'
            ? '直连平台用量接口，精确。令牌优先用下方配置，留空则回落到 DSH 凭据服务。'
            : '记账靠余额差值累计，有误差，免令牌。'
        ),
        // 令牌配置（仅 token 模式且用量开启时显示）
        v.usageMode === 'token'
          ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('input', {
                type: 'password',
                value: v.platformToken || '',
                disabled: !config || v.showBubbleUsage !== true,
                placeholder: 'DEEPSEEK_PLATFORM_TOKEN',
                onChange: function (e) { write('platformToken', e.target.value) },
                className: 'rm2-pet-input',
                style: { flex: 1 },
              }),
            )
          : null,
      ),
    ),
    // ---- 用量模式已移入气泡子项 ----
  )
  var desktopTab = React.createElement('div', null,
    React.createElement(Field, { label: '桌面悬浮模式', hint: '用独立置顶窗口显示宠物（需要 Electron 运行时）。' },
      React.createElement(Switch, { checked: v.desktopMode === true, disabled: !config, onChange: function (val) { write('desktopMode', val) } }),
    ),
    v.desktopMode
      ? React.createElement('p', { style: { margin: '8px 0 0', opacity: 0.6, fontSize: 12 } }, '桌面窗口支持拖动、滚轮缩放、双击画画。关闭后回到页面内展示。')
      : null,
  )
  var aboutTab = React.createElement('div', null,
    React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7 } }, '检查是否有新版本可用，或执行增量更新。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
      React.createElement('span', { style: { fontSize: 13 } }, '当前版本：'),
      React.createElement('span', { style: { fontWeight: 600 } }, currentVersion),
      updMsg === 'has-update'
        ? null
        : React.createElement('button', {
            type: 'button', disabled: updChecking, className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
            onClick: checkUpdate,
          }, updChecking ? '检查中…' : (updMsg === 'latest' ? '重新检查' : '检查更新')),
    ),
    updMsg === 'checking'
      ? React.createElement('p', { style: { margin: '10px 0 0', opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6f7c99)' } }, '正在检查更新…')
      : updMsg === 'latest'
      ? React.createElement('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2e8b57)' } }, '当前已是最新版本。')
      : updMsg === 'no-release'
      ? React.createElement('p', { style: { margin: '10px 0 0', fontSize: 12, opacity: 0.7 } }, '仓库还没有发布过任何版本，无可检查的更新。')
      : updMsg === 'has-update'
      ? updInfo && updInfo.needsCleanReinstall
        ? React.createElement('div', { style: { margin: '10px 0 0' } },
            React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13 } }, '发现新版本 ' + updInfo.latest + '。'),
            React.createElement('p', { style: { margin: '0 0 10px', fontSize: 13, lineHeight: 1.6 } },
              '你的版本低于 0.3.0，0.3.0 起包名已变更，无法自动增量更新。请先彻底卸载旧版本，再重新安装 dsh-pet-remielle。'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', {
                type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
                onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle#升级', '_blank') },
              }, '查看升级说明'),
            ),
          )
        : React.createElement('div', { style: { margin: '10px 0 0' } },
            React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13 } }, '发现新版本 ' + (updInfo ? updInfo.latest : '') + '，可一键更新。'),
            updInfo && updInfo.notes
              ? React.createElement('div', { className: 'rm2-md', style: { margin: '0 0 10px', maxHeight: 200, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-2, rgba(103,126,183,.07))', border: '1px solid var(--dsw-alias-border-l2,#d8d8d8)', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.55 }, dangerouslySetInnerHTML: { __html: renderMarkdown(updInfo.notes) } })
              : null,
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', {
                type: 'button', className: 'rm2-pet-btn rm2-pet-btn-primary', style: { fontSize: 13, padding: '6px 14px' },
                onClick: function () { openUpdateCard() },
              }, '一键更新'),
              React.createElement('button', {
                type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
                onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank') },
              }, '去 GitHub 查看'),
            ),
          )
      : updMsg && updMsg.indexOf('error') === 0
      ? React.createElement('p', { style: { margin: '10px 0 0', opacity: 0.7, fontSize: 12 } }, '检查更新失败：' + (updMsg === 'error' ? '无法连接 GitHub，请稍后重试或检查网络/代理。' : updMsg.replace('error:', '') + '，请稍后重试或检查网络/代理。'))
      : null,
    React.createElement('p', { style: { margin: '14px 0 0', opacity: 0.5, fontSize: 12 } },
      '更新检查通过 GitHub API 获取最新版本；桌面悬浮窗等运行时随插件一同更新。更新完成后需重启 DSH 生效。'),
    // 反馈区（原独立"反馈"标签页并入"关于"）；版本号已在上方展示，不再重复
    React.createElement('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06))' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
        React.createElement('span', { style: { fontWeight: 600 } }, '反馈'),
        React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, '遇到问题或有建议？'),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        React.createElement('button', {
          type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
          onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle/issues/new?template=bug_report.yml', '_blank') },
        }, '提交 Bug'),
        React.createElement('button', {
          type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
          onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle/issues/new?template=feature_request.yml', '_blank') },
        }, '功能建议'),
      ),
    ),
  )
  var tabContent = tab === 'appearance' ? appearanceTab : tab === 'pets' ? petsTab : tab === 'behavior' ? behaviorTab : tab === 'desktop' ? desktopTab : aboutTab
  return React.createElement('section', { style: sectionStyle, 'data-testid': 'dsh-pet-remielle-pets-section' },
    React.createElement('h3', { style: { margin: 0, fontSize: 15 } }, '宠物管理'),
    tabBar,
    tabContent,
    tokenHelpOpen
      ? React.createElement('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483400,
            background: 'rgba(15,20,35,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          },
          onClick: function () { setTokenHelpOpen(false) },
        },
        React.createElement('div', {
          style: {
            background: 'var(--dsw-alias-bg-layer-2,#fff)', border: '1px solid var(--dsw-alias-border-l2,#d8d8d8)',
            borderRadius: 12, padding: '18px 20px', maxWidth: 440, width: '100%', maxHeight: '82vh', overflow: 'auto',
            boxShadow: 'var(--dsw-shadow-lv3,0 24px 64px rgba(15,30,72,.28))', fontFamily: 'system-ui,sans-serif', color: 'var(--dsw-alias-label-primary,#172347)', fontSize: 13, lineHeight: 1.7,
          },
          onClick: function (e) { e.stopPropagation() },
        },
          React.createElement('h4', { style: { margin: '0 0 10px', fontSize: 14 } }, '如何获取 DEEPSEEK_PLATFORM_TOKEN'),
          React.createElement('ol', { style: { margin: '0 0 12px', paddingLeft: 20 } },
            React.createElement('li', null, '用浏览器登录 platform.deepseek.com。'),
            React.createElement('li', null, '按 F12 打开开发者工具 → Application（应用程序）→ Local Storage → https://platform.deepseek.com。'),
            React.createElement('li', null, '找到 userToken，复制它的值，粘贴到上面的输入框。'),
          ),
          React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.6, fontSize: 12 } }, '提示：该令牌为平台登录会话凭证，可能有时效，失效后需重新获取；请勿外传，建议定期重新登录平台以轮换令牌。'),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } },
            React.createElement('button', {
              type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
              onClick: function () { setTokenHelpOpen(false) },
            }, '关闭'),
          ),
        ),
      )
      : null,
  )
}

/** ---------- floating pet (plain DOM) ---------- */

// 隐藏测量节点：复制真实渲染字体来精确测量文字宽度，避免 max-content 撑宽。
// 提升到模块级并懒创建，mountPet 可多次挂载也不会重复往 body 追加节点。
var __petMeasureEl = null
function ensureMeasureEl() {
  if (!__petMeasureEl) {
    __petMeasureEl = document.createElement('span')
    __petMeasureEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;'
    if (document.body) document.body.appendChild(__petMeasureEl)
  }
  return __petMeasureEl
}
function measureTextW(srcEl, text) {
  var el = ensureMeasureEl()
  if (window.getComputedStyle && srcEl) {
    var cs = window.getComputedStyle(srcEl)
    el.style.fontFamily = cs.fontFamily
    el.style.fontSize = cs.fontSize
    el.style.fontWeight = cs.fontWeight
    el.style.letterSpacing = cs.letterSpacing
  }
  el.textContent = text || ''
  return el.offsetWidth || 0
}

function mountPet(ctx) {
  function optionalService(name) {
    if (!ctx) return undefined
    try {
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    } catch (e) {
      return undefined
    }
  }
  // 余额控制器：幂等加载共享客户端脚本（加载失败时移除失效标签，允许下次重试）
  if (!window.__petBalance && !document.querySelector('script[src*="balance-widget.js"]')) {
    var balanceScript = document.createElement('script')
    balanceScript.src = '/plugins/dsh-pet-remielle/balance-widget.js'
    balanceScript.async = true
    balanceScript.onerror = function () { if (balanceScript.parentNode) balanceScript.parentNode.removeChild(balanceScript) }
    document.head.appendChild(balanceScript)
  }
  var root = mk('div', 'position:fixed;right:20px;bottom:20px;z-index:2147483000;pointer-events:auto;user-select:none;display:none;')
  root.setAttribute('data-rm2-pet-root', '')
  var dock = mk('div', 'position:relative;display:inline-block;cursor:grab;touch-action:none;')
  dock.title = '拖动我 · 点击互动 · 右键菜单'
  var img = mk('img', 'width:180px;height:auto;pointer-events:none;display:none;')
  img.alt = '桌宠'
  img.draggable = false
  var bubble = mk('div', 'display:none;')
  // 单气泡（余额页）：复用状态卡 top 的视觉（粗边框/阴影/字重），外观与对话卡一致
  bubble.className = 'rm2-pet-bubble top'
  // 空 title 截断祖先 dock 的原生提示，避免余额页圆点露出边框时冒出「拖动我…」
  bubble.title = ''
  var bubbleTitle = mk('div', '')
  bubbleTitle.className = 'rm2-pet-bubble-title'
  var bubbleDetail = mk('div', '')
  bubbleDetail.className = 'rm2-pet-bubble-detail'
  bubble.appendChild(bubbleTitle)
  bubble.appendChild(bubbleDetail)
  // 堆叠会话卡（状态页）：每会话一张可读卡 + 一张 +N 背板卡
  var bubbleStack = mk('div', 'display:none;')
  bubbleStack.className = 'rm2-pet-bubbles'
  bubbleStack.title = ''
  // 翻页圆点（单个：点击在状态↔余额间切换）
  var bubbleDots = mk('div', '', '')
  bubbleDots.className = 'rm2-bubble-dots'
  bubbleDots.title = ''
  var bubbleDot = mk('div', '', '')
  bubbleDot.className = 'rm2-bubble-dot'
  bubbleDot.title = ''
  bubbleDots.appendChild(bubbleDot)
  bubble.appendChild(bubbleDots)
  // 气泡区域吞掉所有会冒泡到 dock 的桌宠交互事件：
  // pointerdown/mousedown（拖拽）、click（随机表情）、dblclick（双击画画）。
  // 状态页与余额页一致；气泡自身交互（翻页圆点、会话卡点击、滚轮翻页）
  // 在各自处理器里先行处理，不受影响；contextmenu 不拦截，右键气泡仍打开菜单。
  function swallowPetInteraction(el) {
    var types = ['pointerdown', 'mousedown', 'click', 'dblclick']
    for (var i = 0; i < types.length; i++) {
      el.addEventListener(types[i], function (e) { e.stopPropagation() })
    }
  }
  swallowPetInteraction(bubble)
  swallowPetInteraction(bubbleStack)
  // 自绘悬停提示浮层：原生 title 由系统渲染、不随 setZoomFactor 缩放，
  // 高 DPI 屏（200%）上文字过小。文本存卡片 dataset.rm2Tip，悬停时显示浮层。
  var petTip = null
  var petTipAnchor = null
  var __tip = window.__rm2PetTip
  if (!__tip) throw new Error('__rm2PetTip is missing: build-client.mjs pet-tip prepend was broken')
  // 取动态 GIF 当前帧（暂停冻结用）：桌面端同一份实现，见 src/gif-frame.cjs
  var __gifFrame = window.__rm2GifFrame
  if (!__gifFrame) throw new Error('__rm2GifFrame is missing: build-client.mjs gif-frame prepend was broken')
  __gifFrame.watch(img)
  function hidePetTip() {
    petTipAnchor = null
    if (petTip) petTip.style.display = 'none'
  }
  function layoutPetTip(anchor, L, T, R, B) {
    __tip.layoutPetTip(petTip, anchor, L, T, R, B)
  }
  function showPetTip(anchor) {
    var text = anchor && anchor.dataset ? anchor.dataset.rm2Tip : ''
    if (!text) { hidePetTip(); return }
    if (!petTip) {
      petTip = mk('div', '')
      petTip.className = 'rm2-pet-tip'
      document.body.appendChild(petTip)
    }
    petTip.textContent = text
    petTip.style.left = '-9999px'
    petTip.style.top = '0px'
    petTip.style.display = 'block'
    petTipAnchor = anchor
    var W = window.innerWidth || 1280
    var H = window.innerHeight || 800
    layoutPetTip(anchor, 0, 0, W, H)
  }
  function syncDotTip() {
    __tip.applyDotTip(bubbleDot, currentBubblePage, petTipAnchor, showPetTip)
  }
  function onDotLeave(e) {
    __tip.onDotLeave(e, bubbleDot, bubbleDots, showPetTip, hidePetTip)
  }
  function commitBackboardTarget(target, tip) {
    var el = bubbleEls.get(BUBBLE_BACKBOARD_ID)
    if (el && el.node) {
      el.node.dataset.rm2Tip = tip
      if (petTipAnchor === el.node) showPetTip(el.node)
    }
  }
  // 气泡框最小宽度：把标题在常见长度内的宽度变化"吸收"掉，避免方框频繁抖动
  var BUBBLE_MIN_W = 277
  // 两种方框（堆叠对话卡 / 余额气泡）共用同一宽度规则：取"最宽一行" + 内边距(50)，
  // 下限 BUBBLE_MIN_W、上限 min(440, 视口-24)。返回含内边距的总宽。
  function bubbleRowWidth(textW) {
    var vw = Math.max(150, (window.innerWidth || 1280) - 24)
    return Math.min(440, vw, Math.max(BUBBLE_MIN_W, textW + 67))
  }
  var currentBubblePage = 0
  function switchBubblePage(p) {
    currentBubblePage = p
    syncDotTip()
    // 两页都同步重渲：余额页不再等 widget 异步首帧——__petBalance 未就绪时，
    // 旧牌叠会残留到下一个轮询周期才消失
    if (lastSnapshot) updateBubble(lastSnapshot)
    if (p === 0) {
      balanceFrame = null
      balanceRequested = false
      if (window.__petBalance && window.__petBalance.showStatus) window.__petBalance.showStatus()
    } else if (p === 1 && window.__petBalance && window.__petBalance.showBalance) {
      window.__petBalance.showBalance()
    }
  }
  bubbleDot.addEventListener('click', function (e) { e.stopPropagation(); switchBubblePage(currentBubblePage === 0 ? 1 : 0) })
  bubbleDot.addEventListener('mouseenter', function (e) { if (e && e.stopPropagation) e.stopPropagation(); showPetTip(bubbleDot) })
  bubbleDot.addEventListener('mouseleave', onDotLeave)
  syncDotTip()
  // 状态牌叠与单气泡（余额页）都要接住滚轮：翻页，而不是冒泡到 dock 缩放桌宠
  function onBubbleWheel(e) {
    e.preventDefault(); e.stopPropagation()
    // 仅双开时翻页（单开时气泡 pointer-events:none，通常不会触发，这里双重保险）
    if (lastSnapshot) {
      var so = lastSnapshot.showBubble !== false && lastSnapshot.showBubbleStatus !== false
      var uo = lastSnapshot.showBubble !== false && lastSnapshot.showBubbleUsage === true
      if (!(so && uo)) return
    }
    switchBubblePage(currentBubblePage === 0 ? 1 : 0)
  }
  bubble.addEventListener('wheel', onBubbleWheel, { passive: false })
  bubbleStack.addEventListener('wheel', onBubbleWheel, { passive: false })
  // Confirmation dialog
  var confirmOverlay = mk('div')
  confirmOverlay.className = 'rm2-pet-confirm-overlay'
  var confirmBox = mk('div')
  confirmBox.className = 'rm2-pet-confirm'
  var confirmTitle = mk('div', '', '开启桌面悬浮窗')
  confirmTitle.className = 'rm2-pet-confirm-title'
  var confirmBody = mk('div')
  confirmBody.className = 'rm2-pet-confirm-body'
  confirmBody.innerHTML = '需要下载 <b>Electron 运行时（约 221 MB）</b>才能开启桌面悬浮窗。<br>下载将从 npmmirror 镜像或 GitHub 获取。'
  var confirmProgress = mk('div')
  confirmProgress.style.cssText = 'display:none;margin:14px 0 0;'
  var confirmPctText = mk('div', '', '0%')
  confirmPctText.className = 'rm2-pet-dl-text'
  confirmPctText.style.cssText = 'margin-bottom:6px;'
  var confirmBar = mk('div')
  confirmBar.className = 'rm2-pet-dl-bar'
  confirmBar.style.cssText = 'width:100%;'
  var confirmFill = mk('div')
  confirmFill.className = 'rm2-pet-dl-bar-fill'
  confirmBar.appendChild(confirmFill)
  confirmProgress.appendChild(confirmPctText)
  confirmProgress.appendChild(confirmBar)
  var confirmActions = mk('div')
  confirmActions.className = 'rm2-pet-confirm-actions'
  var confirmCancel = mk('button', '', '取消')
  confirmCancel.className = 'rm2-pet-confirm-btn'
  var confirmOk = mk('button', '', '开始下载')
  confirmOk.className = 'rm2-pet-confirm-btn primary'
  confirmActions.appendChild(confirmCancel)
  confirmActions.appendChild(confirmOk)
  confirmBox.appendChild(confirmTitle)
  confirmBox.appendChild(confirmBody)
  confirmBox.appendChild(confirmProgress)
  confirmBox.appendChild(confirmActions)
  confirmOverlay.appendChild(confirmBox)
  document.body.appendChild(confirmOverlay)
  confirmCancel.addEventListener('click', function () {
    confirmOverlay.style.display = 'none'
    fetch(DESKTOP_ENDPOINT + '/cancel-download', { method: 'POST' }).catch(function () {})
    patchConfig('desktopMode', false) // 取消 = 不启用桌面模式，开关回到关闭
  })
  confirmOk.addEventListener('click', function () {
    confirmOk.disabled = true
    confirmOk.textContent = '下载中…'
    confirmCancel.style.display = 'none'
    confirmProgress.style.display = 'block'
    fetch(DESKTOP_ENDPOINT + '/confirm-download', { method: 'POST' }).catch(function () {
      confirmOk.disabled = false
      confirmOk.textContent = '开始下载'
      confirmCancel.style.display = ''
      confirmProgress.style.display = 'none'
    })
  })
  var menu = mk('div', '')
  menu.className = 'rm2-pet-menu'
  var picEl = mk('canvas', 'position:fixed;right:24px;top:24px;z-index:2147483200;width:220px;height:auto;border-radius:10px;display:none;cursor:pointer;')
  picEl.className = 'rm2-pet-pic'
  picEl.title = '点击关闭'
  picEl.addEventListener('click', function () { picStop(); picEl.style.display = 'none' })
  var styleEl = document.createElement('style')
  styleEl.textContent = CSS
  styleEl.setAttribute('data-rm2-pet-css', '')

  dock.appendChild(img)
  dock.appendChild(bubble)
  dock.appendChild(bubbleStack)
  root.appendChild(dock)
  document.body.appendChild(picEl)
  document.head.appendChild(styleEl)
  document.body.appendChild(root)
  document.body.appendChild(menu)

  // ---- pet-local state ----
  var currentMood = '06'
  var displayedMood = null
  var currentPetId = DEFAULT_PET_ID
  var lastSnapshot = null
  var balanceFrame = null
  var balanceRequested = false
  var manualOverride = null
  var paused = false
  // 初始即隐藏：宠物显隐由快照驱动（desktopActive/desktopMode/enabled/hidden），
  // 挂载后先渲染再隐藏会让桌面模式下打开网页时闪现一下右下角宠物。
  var hidden = true
  var pendingDesktopHide = false
  // 桌面模式切换后的宽限期：桌面窗迟迟未激活（Electron 缺失/下载失败/启动崩溃）
  // 时自动取消网页宠物的隐藏，避免“页面隐藏+桌面不存在”双端皆无宠物
  var desktopHideTimer = null
  function armDesktopHideTimer() {
    if (desktopHideTimer) window.clearTimeout(desktopHideTimer)
    desktopHideTimer = window.setTimeout(function () {
      desktopHideTimer = null
      if (!pendingDesktopHide) return
      pendingDesktopHide = false
      if (lastSnapshot) applySnapshot(lastSnapshot)
    }, 15000)
  }
  var lockedNow = false
  var petDragging = false
  function syncPetCursor() {
    // 按住期间保持握拳：快照 applyVisuals 每次都会走到这里，不能无条件打回 grab。
    dock.style.cursor = lockedNow ? 'default' : petDragging ? 'grabbing' : 'grab'
  }
  var positionRestored = false
  var lastTurnEndShown = false
  var intervalId = 0
  var pulseFallbackTimer = 0
  var stream = null

  /** 镜像只作用于宠物图案本身（气泡、圆点不翻转）；applyVisuals 与 applyOffset 共用。 */
  function applyMirror(target, snapshot) {
    target.style.transform = snapshot && snapshot.mirror === true ? 'scaleX(-1)' : ''
  }

  function applyVisuals(snapshot) {
    var scale = snapshot.scale ?? 1
    var opacity = snapshot.opacity ?? 1
    img.style.width = Math.round(180 * scale) + 'px'
    applyMirror(img, snapshot)
    // 气泡缩放口径与桌面端共用 pet-tip.cjs 的 bubbleZoomOf（同步/固定两模式）
    var bubbleZoom = __tip.bubbleZoomOf(snapshot)
    bubble.style.zoom = String(bubbleZoom)
    bubbleStack.style.zoom = String(bubbleZoom)
    img.style.opacity = String(opacity)
    lockedNow = snapshot.locked === true
    syncPetCursor()
  }

  /** 气泡首行：同贴纸最多每 BUBBLE_TITLE_MS 换一次（0.3.1 锁定，避免 think/干活
   *  逐 chunk 翻文案）。贴纸变了，或 WAITING / ERROR / SUCCESS / attention /
   *  完成卡 / 占位卡，立即更新；到期再刷出等待中的 pending。 */
  var BUBBLE_TITLE_MS = 2000
  var prevBubbleVisible = false
  // 牌叠第二层假背板的固定 sessionId（不对应真实会话，仅承载 +N 与点击跳转）。
  var BUBBLE_BACKBOARD_ID = '__pet_backboard__'
  var BACKBOARD_TIP_DEBOUNCE_MS = 400
  // 牌叠第二层（假背板）上移量：卡片高 91px（CSS 里写死）− 80px = 露出 11px；
  // 同步缩放模式下 stack 的 zoom = 角色大小，故 75% 档位露出约 8px（固定模式随
  // bubbleFixedSize，不再等于 8px）。桌面端 pet-view.html 用同一个值，别只改一端。
  var STACK_LIFT_PX = 80
  var backboardStabilizer = __tip.createBackboardStabilizer(
    commitBackboardTarget,
    BACKBOARD_TIP_DEBOUNCE_MS,
    function (fn, ms) { return window.setTimeout(fn, ms) },
    function (timer) { window.clearTimeout(timer) },
  )
  var currentSessionId = undefined
  var lastTopEntry = null
  var bubbleEls = new Map() // sessionId -> { node, title, detail }
  // 排序逻辑与桌面悬浮窗共用 src/session-order.cjs（构建时由 scripts/build-client.mjs
  // 拼接到本文件之前）：审批 > 计划审核 > 等待回答 > 完成卡 > attention > 当前会话 > stateRank > updatedAt。
  var __order = window.__rm2SessionOrder
  // 构建脚本（build-client.mjs）必须把 session-order.cjs 拼接在本文件之前；
  // 拼接被破坏时这里早失败，错误信息可直接定位成因，而不是在首次排序时抛
  // TypeError 让整个宠物模块静默失效。
  if (!__order) throw new Error('__rm2SessionOrder is missing: build-client.mjs session-order prepend was broken')
  var attentionOf = __order.attentionOf
  var completionOf = __order.completionOf
  var targetSessionOf = __order.targetSessionOf
  var approvalOf = __order.approvalOf
  var planReviewOf = __order.planReviewOf
  function orderSessions(sessions) {
    return __order.orderSessions(sessions, currentSessionId)
  }
  // 当前会话上报：fire-and-forget，宿主只存内存并随下次快照带出（空串=清除）
  function isForegroundSurface(snapshot) {
    if (snapshot && snapshot.desktopActive === true) return true
    if (typeof document === 'undefined') return true
    return document.visibilityState !== 'hidden'
  }
  function reportCurrentSession(id, snapshot) {
    if (!isForegroundSurface(snapshot)) return
    fetch(SESSION_CURRENT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id || '' }),
    }).catch(function () {})
  }
  // 页面卸载时清空宿主记忆的当前会话：否则直接关闭页面后桌面端残留陈旧的
  // currentSessionId，排序置顶与自动 ack 都会误判。sendBeacon（Blob 指定
  // application/json）/fetch keepalive 保证卸载过程中请求仍能发出，两者都
  // 不可用时静默放弃；pagehide 与 beforeunload 双保险，重复清空无副作用。
  var CURRENT_CLEAR_BODY = JSON.stringify({ sessionId: '' })
  function clearReportedCurrentSession() {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(SESSION_CURRENT_ENDPOINT, new Blob([CURRENT_CLEAR_BODY], { type: 'application/json' }))
      return
    }
    fetch(SESSION_CURRENT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: CURRENT_CLEAR_BODY,
      keepalive: true,
    }).catch(function () {})
  }
  window.addEventListener('pagehide', clearReportedCurrentSession)
  window.addEventListener('beforeunload', clearReportedCurrentSession)
  window.addEventListener('visibilitychange', function () {
    if (currentSessionId) reportCurrentSession(currentSessionId, lastSnapshot)
  })
  // 宿主主题上报：桌面悬浮窗是独立 Electron 窗口，读不到这里的
  // body[data-ds-dark-theme]——它的菜单/气泡配色只能靠这条上报同步。不报的话它
  // 只能跟系统主题，宿主主题与系统不一致时两端菜单就是两种颜色（实测最常见的
  // 组合：系统深色 + DSH 浅色主题）。宿主只存内存并随快照带出，本地上报本身
  // fire-and-forget，不触发广播。
  var reportedHostTheme = ''
  function currentHostTheme() {
    var body = document.body
    if (!body || typeof body.hasAttribute !== 'function') return ''
    return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  }
  function sendHostTheme(theme) {
    fetch(THEME_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: theme }),
      keepalive: true,
    }).catch(function () {})
  }
  function trackHostTheme() {
    var theme = currentHostTheme()
    if (!theme || theme === reportedHostTheme) return
    reportedHostTheme = theme
    sendHostTheme(theme)
  }
  // 卸载清空：网页关掉后桌面悬浮窗不该继续挂着宿主配色，应回落系统主题。
  // 同 currentSession：页面被杀时不会执行，宿主侧另有 TTL 兜底。
  var HOST_THEME_CLEAR_BODY = JSON.stringify({ theme: '' })
  function clearReportedHostTheme() {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(THEME_ENDPOINT, new Blob([HOST_THEME_CLEAR_BODY], { type: 'application/json' }))
      return
    }
    fetch(THEME_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: HOST_THEME_CLEAR_BODY,
      keepalive: true,
    }).catch(function () {})
  }
  function watchHostTheme() {
    if (typeof MutationObserver !== 'function' || !document.body) return
    trackHostTheme()
    // 宿主切换主题 = body 上 data-ds-dark-theme 的增删，属性一抖就上报一次
    new MutationObserver(trackHostTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme'],
    })
    // 心跳续期：宿主侧上报值带 TTL（页面被强杀时 pagehide 不执行，靠 TTL 兜底），
    // 只在变化时上报会让 TTL 到期后桌面窗静默回落系统主题，与网页端又不同色。
    setInterval(function () {
      var theme = currentHostTheme()
      if (theme) sendHostTheme(theme)
    }, HOST_THEME_HEARTBEAT_MS)
    window.addEventListener('pagehide', clearReportedHostTheme)
    window.addEventListener('beforeunload', clearReportedHostTheme)
  }
  if (document.body) watchHostTheme()
  else document.addEventListener('DOMContentLoaded', watchHostTheme)
  var completionAckPending = new Set()
  function acknowledgeCompletion(sessionId, attempt) {
    if (!sessionId) return
    var retry = attempt || 0
    if (retry === 0 && completionAckPending.has(sessionId)) return
    completionAckPending.add(sessionId)
    fetch(COMPLETION_ACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId }),
    }).then(function (response) {
      if (!response.ok) throw new Error('completion acknowledgement failed')
      completionAckPending.delete(sessionId)
    }).catch(function () {
      if (retry < 2) {
        window.setTimeout(function () { acknowledgeCompletion(sessionId, retry + 1) }, 250 * (retry + 1))
      } else {
        completionAckPending.delete(sessionId)
      }
    })
  }
  function acknowledgeCompletionAfterOpen(sessionId) {
    var attempts = 40
    var confirm = function () {
      if (sessionListSnapshot() === sessionId) {
        acknowledgeCompletion(sessionId)
        return
      }
      if (attempts-- > 0) window.setTimeout(confirm, 50)
    }
    confirm()
  }
  /**
   * 「当前正在看的会话已完成」即已读。这是**副作用**，不能挂在渲染路径里：桌面模式下
   * applySnapshot 会因 `desktopActive` / `pendingDesktopHide` 提前 return（隐藏页面宠物），
   * 渲染连同 ack 一起被跳过，绿点就只剩手动点击才消。所以它在快照入口处独立执行。
   */
  function ackCurrentSessionCompletion(snapshot) {
    if (!isForegroundSurface(snapshot)) return
    var list = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : []
    var completions = list.filter(function (entry) { return entry && completionOf(entry) })
    if (!completions.length) return
    var target = currentSessionId
    if (!target) {
      // selected 不可用（刚加载/多标签互相覆盖）时的保守兜底：页面在前台且只有一张完成卡，
      // 才认定它就是用户正在看的那个；多张时不动手，宁可留给手动点击。
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      if (completions.length !== 1) return
      target = targetSessionOf(completions[0])
    }
    if (!target) return
    for (var i = 0; i < completions.length; i++) {
      if (targetSessionOf(completions[i]) === target) {
        acknowledgeCompletion(target)
        return
      }
    }
  }

  function warnNavigationError(sessionId, error) {
    console.warn('[dsh-pet-remielle] unable to open session', sessionId, error)
  }
  function openLegacySession(sessionId, completed) {
    if (!ctx || !ctx.sessions || typeof ctx.sessions.open !== 'function') return false
    try {
      ctx.sessions.open(sessionId)
    } catch (e) {
      warnNavigationError(sessionId, e)
      return false
    }
    if (completed) acknowledgeCompletionAfterOpen(sessionId)
    return true
  }
  function openSession(sessionId, completed) {
    if (!sessionId) return
    // The sessions service owns selection and mounts the conversation scope.
    // Completion acknowledgement happens only after opening, so an SSE update
    // cannot replace the clicked card with the idle placeholder first.
    var workspace = optionalService('uiWorkspace')
    if (workspace && typeof workspace.openSession === 'function') {
      try {
        workspace.openSession(sessionId)
        if (completed) acknowledgeCompletionAfterOpen(sessionId)
        return
      } catch (e) {
        warnNavigationError(sessionId, e)
      }
    }
    if (openLegacySession(sessionId, completed)) return
    try {
      window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sessionId }))
      window.dispatchEvent(new Event('storage'))
    } catch (e) { /* storage may be unavailable in an embedded shell */ }
  }
  function controlLabel(node) {
    if (!node) return ''
    var aria = typeof node.getAttribute === 'function' ? (node.getAttribute('aria-label') || '') : ''
    return String(node.innerText || node.textContent || aria || '').replace(/\s+/g, ' ').trim()
  }
  function approvalPanels() {
    var frame = typeof document.querySelector === 'function' ? document.querySelector('[data-panel-conversation]') : null
    if (frame && typeof frame.querySelectorAll === 'function') return frame.querySelectorAll('[data-approval-key]')
    if (!document || typeof document.querySelectorAll !== 'function') return []
    var panels = document.querySelectorAll('[data-approval-key]')
    return panels.length === 1 ? panels : []
  }
  function clickNativeAllowOnce(sessionId) {
    if (sessionId && sessionListSnapshot() !== sessionId) return false
    var panels = approvalPanels()
    for (var p = 0; p < panels.length; p++) {
      var nodes = panels[p].querySelectorAll('button, [role="button"]')
      for (var i = 0; i < nodes.length; i++) {
        if (/(允许一次|allow once)/i.test(controlLabel(nodes[i]))) {
          nodes[i].click()
          return true
        }
      }
    }
    return false
  }
  function approveSession(sessionId) {
    // Open the conversation so ApprovalPanel mounts, then click native 「允许一次」.
    if (!sessionId || !ctx) return
    var workspace = optionalService('uiWorkspace')
    var canOpen = workspace && typeof workspace.openSession === 'function'
      || ctx.sessions && typeof ctx.sessions.open === 'function'
    if (!canOpen) return
    openSession(sessionId)
    var attempts = 80
    var tryClick = function () {
      var current = sessionListSnapshot()
      if (current === sessionId && clickNativeAllowOnce(sessionId)) return
      if (current !== sessionId) openSession(sessionId)
      if (attempts-- > 0) window.setTimeout(tryClick, 50)
    }
    window.setTimeout(tryClick, 50)
  }
  function sessionListSnapshot() {
    if (!ctx || !ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.getSnapshot !== 'function') return undefined
    var snapshot = ctx.sessions.list.getSnapshot()
    if (snapshot.current !== undefined) return snapshot.current
    var byId = snapshot.byId || {}
    var ids = Object.keys(byId)
    for (var i = 0; i < ids.length; i++) {
      if ((byId[ids[i]].retainedBy?.mainView ?? 0) > 0) return ids[i]
    }
    return undefined
  }
  function ensureBubbleEl(sessionId) {
    var existing = bubbleEls.get(sessionId)
    if (existing) return existing
    var node = mk('div', 'display:none;')
    node.className = 'rm2-pet-bubble'
    node.setAttribute('role', 'button')
    node.tabIndex = 0
    var header = mk('div', '')
    header.className = 'rm2-pet-bubble-header'
    var completion = mk('span', '')
    completion.className = 'rm2-pet-bubble-completion'
    header.appendChild(completion)
    var action = mk('span', '', '')
    action.className = 'rm2-pet-bubble-action'
    action.setAttribute('aria-label', '蕾米埃尔桌宠')
    var brandImg = document.createElement('img')
    brandImg.src = withPrefix('/favicon.svg')
    brandImg.alt = ''
    action.appendChild(brandImg)
    var title = mk('div', '')
    title.className = 'rm2-pet-bubble-title'
    header.appendChild(title)
    header.appendChild(action)
    var detail = mk('div', '')
    detail.className = 'rm2-pet-bubble-detail'
    var detailText = document.createElement('span')
    detailText.className = 'rm2-pet-detail-text'
    detail.appendChild(detailText)
    var stackCount = document.createElement('span')
    stackCount.className = 'rm2-pet-bubble-stack-count'
    node.appendChild(header)
    node.appendChild(detail)
    node.appendChild(stackCount)
    var el = { node: node, header: header, title: title, detail: detail, detailText: detailText, action: action, brandImg: brandImg, stackCount: stackCount, targetSessionId: sessionId, canApprove: false, lastText: '', lastDetail: '', naturalHeaderWidth: 0, titleMood: '', titleChangedAt: 0, titleTimer: 0, pendingTitle: '', pendingMood: '' }
    var activate = function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (el.node.dataset.idlePlaceholder === 'true') return
      // 假背板：点击时按当帧排序动态解析第 2 名会话并跳转。
      if (el.targetSessionId === BUBBLE_BACKBOARD_ID) {
        var target = backboardStabilizer.target()
        if (target) openSession(target, false)
        return
      }
      openSession(el.targetSessionId, el.completed)
    }
    action.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (el.canApprove) approveSession(el.targetSessionId)
      else openSession(el.targetSessionId, el.completed)
    })
    node.addEventListener('pointerdown', function (event) { event.stopPropagation() })
    node.addEventListener('click', activate)
    node.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') activate(event)
    })
    node.addEventListener('mouseenter', function () { showPetTip(node) })
    node.addEventListener('mouseleave', hidePetTip)
    bubbleStack.appendChild(node)
    bubbleEls.set(sessionId, el)
    return el
  }
  function clearBubbleTitleTimer(el) {
    if (el && el.titleTimer) {
      window.clearTimeout(el.titleTimer)
      el.titleTimer = 0
    }
  }
  function commitBubbleTitle(el, text, mood) {
    clearBubbleTitleTimer(el)
    el.titleMood = mood
    el.titleChangedAt = Date.now()
    el.pendingTitle = ''
    el.pendingMood = ''
    if (text !== el.lastText) {
      el.lastText = text
      el.title.textContent = text
    }
  }
  function applyBubbleTitle(el, entry) {
    var text = entry.message || ''
    var mood = entry.mood || ''
    var state = entry.state || ''
    var immediate = !text
      || state === 'WAITING' || state === 'ERROR' || state === 'SUCCESS'
      || entry.attention === true
      || entry.completionNotification === true
      || entry.idlePlaceholder === true
    if (!el.titleChangedAt) {
      commitBubbleTitle(el, text, mood)
      return
    }
    var moodChanged = mood !== el.titleMood
    var elapsed = Date.now() - el.titleChangedAt
    if (immediate || moodChanged || elapsed >= BUBBLE_TITLE_MS) {
      commitBubbleTitle(el, text, mood)
      return
    }
    if (text === el.lastText) {
      el.pendingTitle = ''
      clearBubbleTitleTimer(el)
      return
    }
    el.pendingTitle = text
    el.pendingMood = mood
    if (!el.titleTimer) {
      el.titleTimer = window.setTimeout(function () {
        el.titleTimer = 0
        if (el.pendingTitle && el.pendingTitle !== el.lastText) {
          commitBubbleTitle(el, el.pendingTitle, el.pendingMood || el.titleMood)
        }
      }, Math.max(16, BUBBLE_TITLE_MS - elapsed))
    }
  }
  function renderBubble(el, entry, index) {
    var text = entry.message || ''
    var detail = entry.detail || ''
    if (entry.backboard) {
      // 假背板：固定高度空方框，仅展示 +N；点击由 activate 动态解析第二层。
      commitBubbleTitle(el, '', '')
      el.detail.style.display = 'none'
      el.action.style.display = 'none'
      el.stackCount.textContent = entry.summaryCount ? '+' + entry.summaryCount : ''
      el.node.className = 'rm2-pet-bubble backboard' + (entry.summaryCount ? ' summary-backboard' : '')
      el.node.setAttribute('aria-disabled', 'false')
      el.node.style.cursor = 'pointer'
      el.node.title = ''
      el.node.dataset.rm2Tip = entry.backboardTip || ''
      if (petTipAnchor === el.node) showPetTip(el.node)
      el.node.style.zIndex = String(100 - index)
      el.node.style.order = String(index)
      el.node.style.marginTop = '-' + STACK_LIFT_PX + 'px'
      el.node.style.width = '100%'
      el.node.style.opacity = String(Math.max(0.46, 0.82 - index * 0.1))
      el.node.style.display = 'block'
      return
    }
    if (!text && !detail) {
      commitBubbleTitle(el, '', entry.mood || '')
      el.node.style.display = 'none'
      if (petTipAnchor === el.node) hidePetTip()
      return
    }
    applyBubbleTitle(el, entry)
    // 详情行为单行文本，用 block 使 overflow/ellipsis 生效（display:flex 会让 text-overflow 失效）
    var detailShown = detail.replace(/^\s*[·•]\s*/, '· ')
    var planSummary = detailShown.replace(/^计划待审\s*·\s*/, '')
    el.detail.style.display = detail ? 'block' : 'none'
    if (detail !== el.lastDetail) {
      el.lastDetail = detail
      el.detailText.textContent = detailShown
    }
    var attention = attentionOf(entry)
    var approval = approvalOf(entry)
    var planReview = planReviewOf(entry)
    var completed = completionOf(entry)
    el.targetSessionId = targetSessionOf(entry)
    el.canApprove = approval
    el.completed = completed
    var actionNotif = approval || planReview || (attention && !completed)
    if (actionNotif) {
      var glyph = approval ? '✓' : (planReview || entry.phase === 'ask') ? '?' : '!'
      if (el.action.textContent !== glyph) el.action.textContent = glyph
      el.action.setAttribute('aria-label', approval ? '允许一次，点击直接确认' : planReview ? '计划待审，点击打开审核' : completed ? '任务已完成，点击查看' : '需要处理，点击跳转')
    } else if (el.action.firstChild !== el.brandImg) {
      el.action.textContent = ''
      el.action.appendChild(el.brandImg)
      el.action.setAttribute('aria-label', '蕾米埃尔桌宠')
    }
    el.stackCount.textContent = entry.summaryCount ? '+' + entry.summaryCount : ''
    el.node.className = 'rm2-pet-bubble' + (index === 0 ? ' top' : '') + (attention ? ' attention' : '') + (approval ? ' approval' : '') + (planReview ? ' plan-review' : '') + (completed ? ' completed' : '') + (entry.idlePlaceholder ? ' idle-placeholder' : '') + (entry.summaryCount ? ' summary-backboard' : '')
    el.node.setAttribute('aria-disabled', entry.idlePlaceholder ? 'true' : 'false')
    el.node.style.cursor = entry.idlePlaceholder ? 'default' : 'pointer'
    el.node.dataset.idlePlaceholder = entry.idlePlaceholder ? 'true' : 'false'
    // 占位卡不可交互（activate 有守卫），提示不能落进「点击跳转」兜底文案。
    // 审批卡悬停用第二行全文（工作区 · preview）：气泡宽度会 CSS 省略，自绘
    // 浮层才能读到请求内容；原生 title 不随 zoom 缩放已废弃；操作说明在勾号
    // aria-label 里。title 置空避免与自绘浮层双重提示。
    el.node.dataset.rm2Tip = entry.idlePlaceholder ? '' : approval ? (detailShown || '') : planReview ? (planSummary ? '计划待审：' + planSummary + '，点击打开同意执行/要求修改' : '计划待审，点击打开同意执行/要求修改') : completed ? '完成啦~ 点击查看结果哦' : attention ? '轮到你啦，点击跳到这里处理呢' : '点击跳到这里看一下~'
    el.node.title = ''
    if (petTipAnchor === el.node) showPetTip(el.node)
    // Deck layout: the front card is readable and background cards expose
    // only a shallow lower edge. Visual order is driven by the flex `order`
    // property (not DOM order), so cards keep their correct stacking even
    // when a session moves between the front and the backboard slot.
    el.node.style.zIndex = String(100 - index)
    el.node.style.order = String(index)
    el.node.style.marginTop = index === 0 ? '0px' : '-' + STACK_LIFT_PX + 'px'
    // All cards share one width: the widest visible card determines the deck,
    // so a short front card never floats above a much wider lower card.
    el.node.style.width = '100%'
    el.node.style.opacity = index === 0 ? '1' : String(Math.max(0.46, 0.82 - index * 0.1))
    el.node.style.display = 'block'
  }
  // 与宿主 src/status-copy.js 的 success 文案池保持一致（网页包不含该模块，此处内联）。
  var SUCCESS_COPY_POOL = ['这次任务搞定啦~', '这一轮顺利完成哦', '任务完成咯，干得漂亮']
  function seedNumberOf(seed) {
    var text = String(seed == null ? '' : seed)
    var total = 0
    for (var i = 0; i < text.length; i++) total += text.charCodeAt(i)
    return Math.abs(total)
  }
  function updateBubbles(snapshot) {
    if (!snapshot) return
    // A present sessions[] is authoritative even when empty. Falling back to
    // the legacy singleton only when the field is absent prevents an IDLE
    // snapshot from resurrecting bubbles for turns that already stopped.
    var sessions = Array.isArray(snapshot.sessions)
      ? snapshot.sessions
      : [snapshot] // legacy single-session snapshot
    var foreground = isForegroundSurface(snapshot)
    // Be defensive against an older Host process that still includes settled
    // records. The browser deck never renders durable inactive sessions.
    sessions = sessions.filter(function (entry) {
      return entry && entry.state !== 'IDLE' && entry.state !== 'DISCONNECTED'
    })
    // 打开该会话即已读：当前对话的耐久 ERROR 不再当提醒卡（与完成绿点同语义）。
    // 宿主会把该会话收成 IDLE；这里先从牌叠拿掉，避免等下一帧 SSE。
    if (foreground && currentSessionId) {
      sessions = sessions.filter(function (entry) {
        return !(entry && entry.state === 'ERROR' && targetSessionOf(entry) === currentSessionId)
      })
    }
    sessions = sessions.map(function (entry) {
      if (!foreground || !entry || !completionOf(entry) || targetSessionOf(entry) !== currentSessionId) return entry
      // 已读不在这里做（见 ackCurrentSessionCompletion：渲染会被桌面模式短路），
      // 这里只负责把已读的卡从牌叠里摘掉。
      if (entry.state === 'SUCCESS' && entry.pulseUntil > Date.now()) {
        return { ...entry, completionNotification: false }
      }
      return null
    }).filter(Boolean)
    // 兜底：插件完成提醒只认 SUCCESS，而 DSH 侧边栏绿点（SessionSummary.completed）涵盖任意"运行结束"
    // （含被中断/停止/异常终止）的会话。这里从 sessions.list.getSnapshot().byId 补入这些"侧边栏有绿点、
    // 但 host 未生成完成卡"的会话；existingIds 去重避免与 host 已生成的 completion:<id> 重复。
    try {
      if (ctx && ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === 'function') {
        var listSnap = ctx.sessions.list.getSnapshot()
        var byId = (listSnap && typeof listSnap.byId === 'object') ? listSnap.byId : null
        var existingIds = new Set()
        for (var ei = 0; ei < sessions.length; ei++) existingIds.add(sessions[ei].sessionId)
        if (byId) {
          for (var sid in byId) {
            if (!Object.prototype.hasOwnProperty.call(byId, sid)) continue
            var item = byId[sid]
            if (!item || item.completed !== true) continue
            // 子会话（subagent）不进牌叠：开关打开时宿主会自己生成 completion:<sid>
            // 卡（reducer 只在 includeSubagents=false 时忽略子会话事件），网页端再兜底
            // 合成一张，会让关掉开关的用户照样看到子 Agent 的完成提醒。
            // 只认 origin，不能连 parentId 一起跳过：fork 出来的会话也带 parentId 但不是
            // 子 Agent，而它被中断/停止时宿主不会生成完成卡（只有正常结束才入队），网页
            // 兜底是那种情况下唯一的提醒来源。
            if (item.origin === 'subagent') continue
            if (existingIds.has(sid) || existingIds.has('completion:' + sid)) continue
            if (item.running === true || (foreground && sid === currentSessionId)) continue
            sessions.push({
              sessionId: 'completion:' + sid,
              targetSessionId: sid,
              state: 'SUCCESS',
              completed: true,
              completionNotification: true,
              // 标题不用 displayTitle/title（那是会话首条用户消息原文，直接上泡
              // 会把原始提问文本泄漏到气泡第一行），改用与宿主 status-copy.js
              // success 同池的固定文案；种子取 sessionId，同一张卡文案保持稳定。
              message: SUCCESS_COPY_POOL[seedNumberOf(sid) % SUCCESS_COPY_POOL.length],
              detail: (item.cwd && String(item.cwd).split(/[\\/]/).filter(Boolean).pop())
                ? '已完成 · ' + String(item.cwd).split(/[\\/]/).filter(Boolean).pop()
                : '已完成',
              title: item.title,
              project: (item.cwd && String(item.cwd).split(/[\\/]/).filter(Boolean).pop()) || undefined,
              mood: '03',
              updatedAt: item.updatedAt || Date.now(),
            })
            existingIds.add('completion:' + sid)
          }
          sessions = sessions.map(function (entry) {
            if (!entry || entry.title) return entry
            var tid = targetSessionOf(entry)
            var row = byId[tid] || byId[entry.sessionId]
            if (!row || !row.title) return entry
            return Object.assign({}, entry, { title: row.title })
          })
        }
      }
    } catch (e) { /* sessions.list 偶发异常不阻断堆叠渲染；缺标题时背板 tip 回落 project / 口吻 */ }
    var liveTargets = new Set()
    for (var li = 0; li < sessions.length; li++) {
      if (!completionOf(sessions[li])) liveTargets.add(targetSessionOf(sessions[li]))
    }
    if (liveTargets.size > 0) {
      sessions = sessions.filter(function (entry) {
        return !completionOf(entry) || !liveTargets.has(targetSessionOf(entry))
      })
    }
    if (sessions.length === 0 && snapshot.enabled !== false) {
      sessions = [{
        sessionId: '__pet_idle__',
        state: 'IDLE',
        mood: snapshot.mood || '06',
        message: snapshot.message || '蕾米埃尔待机中~',
        detail: '',
        phase: 'idle',
        updatedAt: snapshot.updatedAt || 0,
        idlePlaceholder: true,
      }]
    }
    var ordered = orderSessions(sessions)
    lastTopEntry = ordered[0] || null
    // Pet body follows the top bubble's mood; the turn-end "得意中" flash
    // below also keys off the top entry's state.
    if (lastTopEntry && lastTopEntry.mood) snapshot.mood = lastTopEntry.mood
    // 牌叠只渲染首层真卡；第二层是无内容的假背板（仅 +N），不渲染第 2 名的
    // 文字与图标——同级会话的 updatedAt 轮转因此不会造成背景卡闪换。
    // 点击背板时按当帧排序动态解析第 2 名并跳转，这里只需记住它是谁。
    var visibleEntries = ordered.slice(0, 1)
    if (ordered.length > 1) {
      backboardStabilizer.update(
        targetSessionOf(ordered[1]) || '',
        __tip.backboardTipText(ordered[1].project, ordered[1].title),
      )
      visibleEntries.push({
        sessionId: BUBBLE_BACKBOARD_ID,
        state: 'IDLE',
        message: '',
        detail: '',
        phase: '',
        updatedAt: 0,
        backboard: true,
        summaryCount: ordered.length - 1,
        backboardTip: backboardStabilizer.tip(),
      })
    } else {
      backboardStabilizer.update('', '')
    }
    var count = visibleEntries.length
    var seen = new Set()
    var measuredWidth = 150
    bubbleStack.style.width = 'fit-content'
    // Render each card at intrinsic width first, then set the deck width from
    // the TOP card only (lower cards' content is hidden, so only the top
    // card should drive the deck width; this keeps the top card stable).
    for (var i = 0; i < count; i++) {
      var entry = visibleEntries[i]
      seen.add(entry.sessionId)
      var bubbleEl = ensureBubbleEl(entry.sessionId)
      if (bubbleEl.node.parentNode !== bubbleStack) bubbleStack.appendChild(bubbleEl.node)
      renderBubble(bubbleEl, entry, i)
      bubbleEl.node.style.minWidth = '200px'
      bubbleEl.node.style.width = 'max-content'
      bubbleEl.node.style.maxWidth = 'none'
      bubbleEl.node.classList.remove('title-clipped')
      var titleWidth = bubbleEl.title.scrollWidth || bubbleEl.title.offsetWidth || 0
      // 完成时鲸鱼图标保留显示，故恒计入其宽度（原先完成后隐藏鲸鱼时置 0）
      var actionWidth = 40
      var completionWidth = completionOf(entry) ? 29 : 0
      bubbleEl.naturalHeaderWidth = titleWidth + actionWidth + completionWidth
      // 宽度由两行中最宽的一行决定（标题行 或 详情行，取更宽者 + 内边距）；上限由下文 min(330,viewport) 截断，
      // 只有超出该上限时才由详情行的省略号截断，符合「最宽行决定宽度 + 最大宽度限制」的设计。
      var detailW = bubbleEl.detail.scrollWidth || bubbleEl.detail.offsetWidth || 0
      if (i === 0) measuredWidth = Math.max(bubbleEl.naturalHeaderWidth, detailW)
      bubbleEl.node.style.maxWidth = ''
      bubbleEl.node.style.width = '100%'
    }
    var deckWidth = bubbleRowWidth(measuredWidth)
    var deckWidthPx = deckWidth + 'px'
    if (bubbleStack.style.width !== deckWidthPx) bubbleStack.style.width = deckWidthPx
    for (var j = 0; j < count; j++) {
      var renderEntry = visibleEntries[j]
      var renderEl = bubbleEls.get(renderEntry.sessionId)
      renderBubble(renderEl, renderEntry, j)
      renderEl.node.classList.toggle('title-clipped', renderEl.naturalHeaderWidth > Math.max(0, deckWidth - 67))
    }
    for (var key of bubbleEls.keys()) {
      if (!seen.has(key)) {
        var el = bubbleEls.get(key)
        clearBubbleTitleTimer(el)
        if (el && el.node && el.node.remove) el.node.remove()
        bubbleEls.delete(key)
      }
    }
    // 切换圆点对齐顶卡（第一张可读卡）垂直居中，与余额一致（不随整个堆叠区居中）
    if (bubbleDots && ordered[0] && bubbleEls.get(ordered[0].sessionId)) {
      var topNode = bubbleEls.get(ordered[0].sessionId).node
      if (bubbleDots.parentNode !== topNode) topNode.appendChild(bubbleDots)
    }
    bubbleStack.style.display = snapshot.bubble !== false && count > 0 ? 'flex' : 'none'
    if (count === 0) bubbleStack.style.width = ''
  }
  // Follow the user's current conversation so its bubble ranks on top of
  // same-priority peers (the "which dialog is on top" rule).
  if (ctx && ctx.sessions && ctx.sessions.list && typeof ctx.effect === 'function') {
    var sessionList = ctx.sessions.list
    currentSessionId = sessionListSnapshot()
    reportCurrentSession(currentSessionId)
    ctx.effect(function () {
      return sessionList.subscribe(function () {
        var next = sessionListSnapshot()
        if (next !== currentSessionId) {
          currentSessionId = next
          reportCurrentSession(next)
          if (next && lastSnapshot && Array.isArray(lastSnapshot.sessions)) {
            var openedCompletion = lastSnapshot.sessions.some(function (entry) {
              return entry && targetSessionOf(entry) === next && completionOf(entry)
            })
            if (openedCompletion && isForegroundSurface(lastSnapshot)) acknowledgeCompletion(next)
          }
          // 统一走 updateBubble：它带余额页门控，直接调 updateBubbles 会在
          // 停留余额页时把牌叠强制显示出来，与单气泡短暂重叠
          if (lastSnapshot) updateBubble(lastSnapshot)
        }
      })
    })
  }
  function updateBubble(snapshot) {
    if (!snapshot) return
    // 气泡从无到有（总开关从关到开）时，回到状态页
    var bubbleEnabled = snapshot.showBubble !== false && (snapshot.showBubbleStatus !== false || snapshot.showBubbleUsage === true)
    if (bubbleEnabled && !prevBubbleVisible && currentBubblePage !== 0) {
      currentBubblePage = 0
      balanceFrame = null
      balanceRequested = false
    }
    prevBubbleVisible = bubbleEnabled
    // 子开关判定
    var statusOn = snapshot.showBubble !== false && snapshot.showBubbleStatus !== false
    var usageOn = snapshot.showBubble !== false && snapshot.showBubbleUsage === true
    var bothOn = statusOn && usageOn
    var anyOn = statusOn || usageOn
    // 强制页面归属：只开用量→余额页；只开状态→状态页
    var pageBefore = currentBubblePage
    if (!statusOn && usageOn && currentBubblePage === 0) { currentBubblePage = 1 }
    if (statusOn && !usageOn) { currentBubblePage = 0 }
    if (statusOn && usageOn && currentBubblePage > 1) { currentBubblePage = 0 }
    if (currentBubblePage !== pageBefore) {
      if (currentBubblePage === 0) balanceFrame = null
    }
    // 进入余额页且尚无余额数据时，触发一次拉取（延迟执行，避免同步重入 updateBubble）
    if (currentBubblePage === 1 && !(balanceFrame && balanceFrame.kind === 'balance') && window.__petBalance && !balanceRequested) {
      balanceRequested = true
      window.setTimeout(function () { if (window.__petBalance) window.__petBalance.showBalance() }, 0)
    }
    if (currentBubblePage === 0) balanceRequested = false
    // 气泡始终捕获点击/滚轮：避免点击与滚轮穿透到桌宠触发交互/缩放（状态页与余额页一致）。
    // 牌叠容器也要可命中：否则卡片缝隙上的滚轮/点击会落到 dock（缩放/切表情）。
    var bubblePointer = snapshot.showBubble !== false ? 'auto' : 'none'
    bubble.style.pointerEvents = bubblePointer
    bubbleStack.style.pointerEvents = bubblePointer
    // 圆点：仅双开时显示（单圆点，点击切换）
    bubbleDots.style.display = bothOn ? '' : 'none'
    syncDotTip()
    var cur = currentBubblePage
    var show = anyOn && (cur === 0 ? statusOn : usageOn)
    if (cur === 0) {
      // 状态页：显示堆叠会话卡（每会话一张 + +N 背板）
      show = show && statusOn
      bubbleStack.style.display = show ? 'flex' : 'none'
      if (show) updateBubbles(snapshot)
      // 圆点由 updateBubbles 挂到顶卡（第一张可读卡）垂直居中；状态页不显示单气泡，避免与堆叠卡重叠成空气泡
      bubble.style.display = 'none'
      bubble.classList.remove('rm2-bubble-balance')
      bubbleTitle.textContent = ''
      bubbleDetail.textContent = ''
    } else if (cur === 1) {
      // 余额页：隐藏堆叠卡，渲染 balanceFrame 数据
      bubbleStack.style.display = 'none'
      if (bubbleDots.parentNode !== bubble) bubble.appendChild(bubbleDots)
      bubble.classList.add('rm2-bubble-balance')
      show = show && !!balanceFrame && balanceFrame.kind === 'balance'
      // 即使暂无余额数据也显示气泡容器（至少保留圆点，供切回状态页）
      // 单开用量且余额帧未就绪时也保留容器（显示“余额加载中…”），不再整泡消失
      bubble.style.display = 'block'
      if (show) {
        bubbleTitle.textContent = (balanceFrame.label || 'DeepSeek 余额') + '  ' + (balanceFrame.amount || '--')
        bubbleTitle.style.color = ''
        // period 单独着色：textContent + span 组装，杜绝 currency 上游透传的 HTML 注入
        bubbleDetail.textContent = ''
        bubbleDetail.appendChild(document.createTextNode(balanceFrame.detail || ''))
        var periodSpan = document.createElement('span')
        periodSpan.style.color = balanceFrame.color || '#888'
        periodSpan.textContent = ' · ' + (balanceFrame.period || '')
        bubbleDetail.appendChild(periodSpan)
        // 用真实渲染字体精确测量两行文字，宽度复用与对话卡同一规则（最宽行 + 内边距，min/max 截断）
        var titleText = (balanceFrame.label || 'DeepSeek 余额') + '  ' + (balanceFrame.amount || '--')
        var detailText = (balanceFrame.detail || '') + ' · ' + (balanceFrame.period || '')
        var maxTextW = Math.max(measureTextW(bubbleTitle, titleText), measureTextW(bubbleDetail, detailText))
        bubble.style.width = bubbleRowWidth(maxTextW) + 'px'
      } else {
        bubbleTitle.textContent = '余额加载中…'
        bubbleDetail.textContent = ''
      }
    }
  }

  /** After a pulse overlay expires the host falls back to the durable state; schedule one refresh. */
  function schedulePulseFallback(snapshot) {
    if (!snapshot.pulseUntil || snapshot.pulseUntil <= Date.now()) return
    window.clearTimeout(pulseFallbackTimer)
    pulseFallbackTimer = window.setTimeout(function () {
      fetchState().then(applySnapshot)
    }, snapshot.pulseUntil - Date.now() + 60)
  }

  /** Single entry point for both polling and the SSE stream. */
  function applySnapshot(snapshot) {
    if (!snapshot) return
    if (snapshot.kind === 'session-action') {
      if (snapshot.sessionId && snapshot.approve) approveSession(snapshot.sessionId)
      // 桌面悬浮窗点击气泡卡（approve=false）：仅跳转到该对话；完成卡顺带 ack。
      else if (snapshot.sessionId) openSession(snapshot.sessionId, snapshot.completed === true)
      return
    }
    if (snapshot.kind === 'download') {
      if (snapshot.phase === 'confirm') {
        // 弹窗必须整体复位：上一轮 done/error 会隐藏 OK 键、把取消键改成
        // 「关闭」。不复位的话再次弹出的确认框里「开始下载」根本不存在，
        // 用户只能关闭 → 循环弹窗、永远无法下载（DSH Desktop 实测）。
        confirmOk.disabled = false
        confirmOk.style.display = ''
        confirmOk.textContent = '开始下载'
        confirmCancel.disabled = false
        confirmCancel.textContent = '取消'
        confirmCancel.style.display = ''
        confirmProgress.style.display = 'none'
        confirmOverlay.style.display = 'flex'
      } else if (snapshot.phase === 'start') {
        confirmOk.textContent = '下载中…'
        confirmCancel.style.display = 'none'
        confirmProgress.style.display = 'block'
        confirmPctText.textContent = '正在下载 Electron…'
        confirmFill.style.width = '0%'
      } else if (snapshot.phase === 'progress') {
        if (snapshot.percent >= 0) {
          confirmFill.style.width = snapshot.percent + '%'
          confirmPctText.textContent = snapshot.text || ('下载中 ' + snapshot.percent + '%')
        } else {
          confirmPctText.textContent = snapshot.text || '下载中…'
        }
      } else if (snapshot.phase === 'done') {
        confirmFill.style.width = '100%'
        confirmPctText.textContent = 'Electron 已就绪 ✓'
        confirmOk.style.display = 'none'
        confirmCancel.textContent = '关闭'
        confirmCancel.style.display = ''
        setTimeout(function () { confirmOverlay.style.display = 'none' }, 1500)
      } else if (snapshot.phase === 'error') {
        confirmPctText.textContent = snapshot.text || '下载失败，页面内宠物继续可用'
        confirmFill.style.width = '0%'
        confirmOk.style.display = 'none'
        confirmCancel.textContent = '关闭'
        confirmCancel.style.display = ''
      }
      return
    }
    var wasDesktopMode = lastSnapshot && lastSnapshot.desktopMode === true
    lastSnapshot = snapshot
    // 已读是副作用，必须在渲染短路（desktopActive / pendingDesktopHide）之前处理：
    // 桌面模式下页面宠物被隐藏、渲染整段跳过，但"我看着它完成"这件事仍然成立。
    ackCurrentSessionCompletion(snapshot)
    // 余额控制器：初始化/同步用量模式；用量子开关关闭时停掉 60s 轮询
    if (window.__petBalance) {
      var usageEnabled = snapshot.showBubble !== false && snapshot.showBubbleUsage === true
      window.__petBalance.setEnabled(usageEnabled)
      if (!window.__petBalanceInited) {
        window.__petBalanceInited = true
        window.__petBalance.init(snapshot.usageMode || 'ledger')
      } else if (snapshot.usageMode) {
        window.__petBalance.setUsageMode(snapshot.usageMode)
      }
    }
    // The desktop pet window is showing; keep the page pet hidden to avoid
    // two pets on screen. Restores automatically when the window goes away.
    if (snapshot.desktopActive === true) {
      pendingDesktopHide = false
      if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
      if (root.style.display !== 'none') {
        root.style.display = 'none'
        closeMenu()
      }
      return
    }
    if (snapshot.desktopMode === true && !wasDesktopMode) {
      pendingDesktopHide = true
      armDesktopHideTimer()
    }
    if (snapshot.desktopMode !== true) {
      pendingDesktopHide = false
      if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
    }
    if (pendingDesktopHide) {
      if (root.style.display !== 'none') {
        root.style.display = 'none'
        closeMenu()
      }
      return
    }
    if (root.style.display === 'none' && !hidden) {
      setHidden(false)
    }
    applyVisuals(snapshot)
    if (!positionRestored && snapshot.posX != null && snapshot.posY != null) {
      positionRestored = true
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      root.style.left = snapshot.posX + 'px'
      root.style.top = snapshot.posY + 'px'
    }
    if (snapshot.petId && snapshot.petId !== currentPetId) {
      currentPetId = snapshot.petId
      displayedMood = null
    }
    updateBubble(snapshot)
    // Agent 回复完成时短暂"得意中"（仅触发一次，避免重复）
    if (snapshot.state === 'IDLE' && snapshot.phase === 'turn-end' && !manualOverride && !lastTurnEndShown) {
      lastTurnEndShown = true
      manualOverride = { mood: '03', until: Date.now() + 2000 }
    }
    if (snapshot.state !== 'IDLE') lastTurnEndShown = false
    var wantHidden = snapshot.enabled === false || snapshot.hidden === true
    if (wantHidden && !hidden) setHidden(true)
    else if (!wantHidden && hidden) setHidden(false)
    if (wantHidden) return
    if (snapshot.paused === true && !paused) setPaused(true)
    else if (snapshot.paused !== true && paused) setPaused(false)
    sync()
    schedulePulseFallback(snapshot)
  }

  function poll() {
    fetchState().then(applySnapshot)
  }

  /** Subscribe to the host SSE stream; slow the poll down to a fallback. */
  function startStream() {
    if (stream || typeof EventSource === 'undefined') return
    var source
    try {
      source = new EventSource(STREAM_ENDPOINT)
    } catch (e) {
      return
    }
    stream = source
    source.onmessage = function (e) {
      var snapshot
      try {
        snapshot = JSON.parse(e.data)
      } catch (err) {
        return
      }
      applySnapshot(snapshot)
    }
    // EventSource reconnects on its own; the slower poll keeps convergence
    // (registry changes, dead streams) without spamming the server.
    window.clearInterval(intervalId)
    intervalId = window.setInterval(poll, STABLE_POLL_MS)
  }

  function resetPos() {
    root.style.left = ''
    root.style.top = ''
    root.style.right = '20px'
    root.style.bottom = '20px'
    // 两个位置存储一起清：页面内坐标在 posX/posY，桌面窗坐标在 desktopX/desktopY。
    // 只清前者会让「重置位置」在切到桌面模式后失效（桌面窗仍停在上次拖到的位置）。
    void patchConfigFields({ posX: null, posY: null, desktopX: null, desktopY: null })
    positionRestored = true
  }

  function setHidden(v) {
    hidden = v
    if (v) {
      root.style.display = 'none'
    } else {
      root.style.display = ''
    }
    closeMenu()
  }

  function setPaused(v) {
    paused = v
    if (paused) {
      freezeCurrentFrame()
      dock.title = '已暂停（右键菜单恢复）'
    } else {
      var animated = img.dataset.animated
      delete img.dataset.animated
      if (animated && animated !== img.src) img.src = animated
      else showMood(currentMood)
      dock.title = '拖动我 · 点击互动 · 右键菜单'
    }
  }

  // 暂停 = 冻在「点下去那一刻正在显示的那一帧」。
  // 不能直接 canvas.drawImage(img)：Chromium 对动态 GIF 永远只画首帧（实测 20 次
  // 采样签名完全一致，见 src/gif-frame.cjs），旧实现因此会弹回起始造型。
  // 这里先按已播放时长定位当前帧号，解出那一帧再换上去；解不出（非安全上下文
  // 没有 ImageDecoder / 不是 GIF）就退回首帧快照，暂停开关本身不会失效。
  function freezeCurrentFrame() {
    var url = img.src
    if (!__gifFrame.isGif(url)) { snapshotFirstFrame(); return }
    var elapsed = __gifFrame.livedMs(img) // 先取时刻：解码耗时不能算进动画进度
    void __gifFrame.freeze(url, elapsed).then(function (dataUrl) {
      // 期间已恢复播放或换了贴纸：丢掉这次结果，别把宠物按在旧帧上
      if (!paused || img.src !== url) return
      if (!dataUrl) { snapshotFirstFrame(); return }
      img.dataset.animated = url
      img.src = dataUrl
    })
  }

  // 首帧兜底（= 旧行为）：drawImage 拿到的就是首帧。
  function snapshotFirstFrame() {
    try {
      var canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || 180
      canvas.height = img.naturalHeight || 180
      var g = canvas.getContext('2d')
      if (g && img.src) {
        g.drawImage(img, 0, 0, canvas.width, canvas.height)
        img.dataset.animated = img.src
        img.src = canvas.toDataURL('image/png')
      }
    } catch (e) { /* keep animating */ }
  }

  // Per-mood alignment offset (legacy, kept for API compat). Since all GIFs
  // are now the same size, this just sets a consistent width.
  function applyOffset(mood) {
    var scale = (lastSnapshot && lastSnapshot.scale) || 1
    img.style.width = Math.round(180 * scale) + 'px'
    applyMirror(img, lastSnapshot)
  }

  // Sticker URLs resolve per active pet; a missing artwork falls back to the
  // default pet once so a stale petId (deleted dir) still shows something.
  function showMood(mood) {
    var petId = currentPetId
    var src = gifUrl(petId, mood)
    if (img.dataset.mood === mood && img.src) {
      // Same sticker already displayed: update only the alignment offset,
      // keep the running GIF animation untouched.
      applyOffset(mood)
      displayedMood = mood
      return
    }
    img.onerror = function () {
      if (petId !== DEFAULT_PET_ID) {
        petId = DEFAULT_PET_ID
        currentPetId = petId
        img.onerror = null
        img.src = gifUrl(petId, mood)
      } else {
        img.onerror = null
        img.style.display = 'none'
      }
    }
    img.src = src
    img.dataset.mood = mood
    img.style.display = 'block'
    applyOffset(mood)
    displayedMood = mood
  }

  /** Pop a random pic artwork (双击画画): thick brush sweeps from the
   *  top-left corner down to the bottom-right, moving back and forth along the
   *  current diagonal edge and painting the picture only where it passes. */
  var PIC_DRAW_MS = 6000 // 笔刷绘制时长 == 显示“绘制中(01)”的时长
  var picTimer = 0
  var picFadeTimer = 0
  var picHideTimer = 0
  var picRevealRaf = 0
  var picLoads = []
  function picStop() {
    if (picTimer) { window.clearTimeout(picTimer); picTimer = 0 }
    if (picFadeTimer) { window.clearTimeout(picFadeTimer); picFadeTimer = 0 }
    if (picHideTimer) { window.clearTimeout(picHideTimer); picHideTimer = 0 }
    if (picRevealRaf) { window.cancelAnimationFrame(picRevealRaf); picRevealRaf = 0 }
  }
  var picSeq = 0
  function showPic() {
    var snap = lastSnapshot
    var count = snap && snap.pics ? snap.pics : 0
    if (!count) return
    var n = Math.floor(Math.random() * count) + 1
    var src = withPrefix(ASSETS_PREFIX) + '/' + encodeURIComponent(currentPetId) + '/pics/' + n + '.png'
    // 连续双击：picStop 清掉上一轮的动画与全部定时器，立即开始新一轮
    picStop()
    // 并立即清空画布内容：新图尚未加载完成前不得残留显示上一幅
    var pg = picEl.getContext('2d')
    if (pg && picEl.width > 0 && picEl.height > 0) pg.clearRect(0, 0, picEl.width, picEl.height)
    picEl.style.display = 'block'
    picEl.style.opacity = '1'
    picEl.style.transition = 'none'
    var seq = ++picSeq
    var img = new Image()
    img.src = src
    picLoads.push(img)
    if (picLoads.length > 3) picLoads.shift()
    img.onload = function () {
      if (seq !== picSeq) return // 迟到的旧图加载：新一轮已开始，丢弃
      brushReveal(img)
    }
  }

  function brushReveal(img) {
    var W = img.naturalWidth || 220
    var H = img.naturalHeight || 220
    picEl.width = W
    picEl.height = H
    var g = picEl.getContext('2d')
    g.clearRect(0, 0, W, H)
    var D = W + H                // diagonal travel distance
    var r = Math.max(W, H) * 0.15 // brush thickness (粗一点)
    var T = PIC_DRAW_MS           // reveal duration == 绘制中(01) 时长
    var t0 = null

    function lineAt(dd) {
      var ax = Math.max(0, dd - H), ay = dd - ax
      var by = Math.max(0, dd - W), bx = dd - by
      return { ax: ax, ay: ay, bx: bx, by: by }
    }

    function frame(ts) {
      if (t0 === null) t0 = ts
      var p = Math.min(1, (ts - t0) / T)
      if (p >= 1) {
        g.globalAlpha = 1
        g.globalCompositeOperation = 'source-over'
        g.drawImage(img, 0, 0, W, H)
        afterReveal()
        return
      }
      var d = D * p
      var L = lineAt(d)
      // brush travels back and forth along the edge line (ping-pong loop):
      // 右上 (top end) → 左下 (left end) → 右上 → 左下 ... The picture
      // appears along the path the brush has already passed.
      var half = 440                                   // ms per one-way trip
      var ph = (ts - t0) % (half * 2)
      var s = ph < half ? ph / half : 1 - (ph - half) / half
      for (var k = 0; k < 2; k++) {
        var sk = Math.min(1, Math.max(0, s + k * 0.04))
        // s=0 at the top (右上) end, s=1 at the left (左下) end
        var cx = L.bx + (L.ax - L.bx) * sk
        var cy = L.by + (L.ay - L.by) * sk
        // 笔刷路径加一点小小的随机，让刷痕不那么规律
        cx += (Math.random() - 0.5) * r * 0.6
        cy += (Math.random() - 0.5) * r * 0.6
        var rr = r * (0.85 + 0.3 * Math.random())
        // crisp opaque brush stamp: punch the sharp image through a hard clip
        g.save()
        g.beginPath()
        g.arc(cx, cy, rr, 0, Math.PI * 2)
        g.clip()
        g.globalAlpha = 1
        g.globalCompositeOperation = 'source-over'
        g.drawImage(img, 0, 0, W, H)
        g.restore()
      }
      picRevealRaf = window.requestAnimationFrame(frame)
    }
    picRevealRaf = window.requestAnimationFrame(frame)
  }

  function afterReveal() {
    // 绘制一完成立即切“得意中(03)”，避免中间闪现“待机中(06)”。
    manualOverride = { mood: '03', until: Date.now() + 2200 }
    sync()
    picTimer = window.setTimeout(function () {
      picFadeTimer = window.setTimeout(function () {
        picEl.style.transition = 'opacity 0.8s ease-out'
        picEl.style.opacity = '0'
        // 收尾计时也要可取消：新一轮开始后不得把新画布淡出掉
        picHideTimer = window.setTimeout(function () { picEl.style.display = 'none'; picEl.style.transition = '' }, 800)
      }, 2200)
    }, 0)
  }

  function sync() {
    var now = Date.now()
    var mood = currentMood
    if (manualOverride && now < manualOverride.until) {
      mood = manualOverride.mood
    } else {
      manualOverride = null
      if (lastSnapshot && lastSnapshot.mood) mood = lastSnapshot.mood
    }
    if (mood !== currentMood) currentMood = mood
    if (!paused && displayedMood !== currentMood) showMood(currentMood)
  }

  function poll() {
    fetchState().then(function (snapshot) {
      applySnapshot(snapshot)
    })
  }

  intervalId = window.setInterval(poll, POLL_MS)
  poll()
  startStream()

  // ---- interactions ----
  var dragMoved = false
  dock.addEventListener('pointerdown', function (e) {
    if ((e.button !== undefined && e.button !== 0) || lockedNow) return
    e.preventDefault()
    var rect = dock.getBoundingClientRect()
    var startX = e.clientX - rect.left
    var startY = e.clientY - rect.top
    var ox = e.clientX
    var oy = e.clientY
    dragMoved = false
    petDragging = true
    syncPetCursor()
    function onMove(ev) {
      if (Math.abs(ev.clientX - ox) + Math.abs(ev.clientY - oy) > 6) dragMoved = true
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      var w = root.offsetWidth || 180
      var h = root.offsetHeight || 180
      var x = Math.max(0, Math.min(window.innerWidth - w, ev.clientX - startX))
      var y = Math.max(0, Math.min(window.innerHeight - h, ev.clientY - startY))
      root.style.left = x + 'px'
      root.style.top = y + 'px'
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      petDragging = false
      syncPetCursor()
      if (dragMoved) {
        var r = root.getBoundingClientRect()
        patchConfig('posX', Math.round(r.left))
        patchConfig('posY', Math.round(r.top))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  })

  dock.addEventListener('click', function () {
    if (dragMoved) return
    var candidates = MOOD_ORDER.filter(function (m) { return m !== currentMood })
    var pick = candidates[Math.floor(Math.random() * candidates.length)]
    manualOverride = { mood: pick, until: Date.now() + 1800 }
    sync()
  })

  // 余额控制器：把显示帧渲染进自带气泡（脚本异步加载，重试直到就绪）
  var unsubBalance = null
  var balanceWaitTimer = null
  function whenPetBalance(cb) {
    if (window.__petBalance) { cb(); return }
    var tries = 0
    balanceWaitTimer = window.setInterval(function () {
      tries++
      if (window.__petBalance) {
        window.clearInterval(balanceWaitTimer)
        balanceWaitTimer = null
        cb()
      } else if (tries > 60) {
        window.clearInterval(balanceWaitTimer)
        balanceWaitTimer = null
      }
    }, 100)
  }
  whenPetBalance(function () {
    // 保留退订函数：插件卸载时注销，否则旧闭包经 widget 的 listeners 被永久强引用
    unsubBalance = window.__petBalance.subscribe(function (frame) {
      // 只存数据，不直接渲染气泡；气泡渲染统一由 updateBubble 根据 currentBubblePage 决定
      balanceFrame = frame
      // 延迟渲染，避免与快照驱动的 updateBubble 重入竞争
      if (currentBubblePage === 1 && lastSnapshot) {
        window.setTimeout(function () { if (currentBubblePage === 1 && lastSnapshot) updateBubble(lastSnapshot) }, 0)
      }
    })
  })

  // Double-click: play a drawing sticker loop and pop a random artwork.
  // 无画画锁：连续双击时 showPic 内部先 picStop 清掉上一轮（动画帧 + 全部定时器），
  // 立即开始新一轮，不再等待上一轮播完的冷却期。右键菜单「画画」复用同一入口，
  // 两端菜单因此同构（桌面端 pet-view.html 也是菜单与双击共用 playDraw）。
  function playDraw() {
    if (!lastSnapshot || lastSnapshot.pics === 0) return
    manualOverride = { mood: '01', until: Date.now() + PIC_DRAW_MS }
    sync()
    showPic()
  }
  dock.addEventListener('dblclick', playDraw)

  // Mouse wheel: resize the pet (persisted through config).
  dock.addEventListener('wheel', function (e) {
    e.preventDefault()
    if (!lastSnapshot) return
    var delta = e.deltaY < 0 ? 0.05 : -0.05
    var next = Math.min(2, Math.max(0.5, (lastSnapshot.scale ?? 1) + delta))
    next = Math.round(next * 20) / 20
    void patchConfig('scale', next)
  }, { passive: false })

  // ---- context menu ----
  var menuOpen = false
  function makeRow(label, rightText) {
    var row = mk('div', '')
    row.className = 'rm2-pet-menu-item'
    row.appendChild(mk('span', '', label))
    if (rightText) {
      var r = mk('span', '', rightText)
      r.className = 'mute'
      row.appendChild(r)
    }
    return row
  }
  function makeActionRow(label, act) {
    var row = makeRow(label)
    row.addEventListener('click', act)
    return row
  }
  function makeToggleRow(label, on, act) {
    var row = makeRow(label, on ? '✓' : '')
    var r = row.querySelector('.mute')
    if (on && r) r.classList.add('tick')
    row.addEventListener('click', act)
    return row
  }
  function makeSep() {
    var sep = mk('div', '')
    sep.className = 'rm2-pet-menu-sep'
    return sep
  }
  // 滑块行：与桌面端 pet-view.html menuSliderRow 同构（两端同一骨架，只差 DOM 写法）。
  // 宽度/间距/百分比位全走 CSS 类（.rm2-pet-menu-slider / -pct），与桌面端逐项对齐；
  // 名称列由 .rm2-pet-menu-item>span:first-child 的 flex:1 吃掉余量，滑块因此对齐。
  // 名称列**故意不设 min-width:0**：可交互行永不收缩，菜单变窄会变成可见溢出，
  // 而不是把「角色大小」静默截成「角色大…」（截断只留给状态行）。
  function makeSliderRow(label, min, max, value, onInput) {
    var row = mk('div', '')
    row.className = 'rm2-pet-menu-item'
    var slider = mk('input', '')
    slider.className = 'rm2-pet-menu-slider'
    slider.type = 'range'
    slider.min = String(min)
    slider.max = String(max)
    slider.step = '0.05'
    slider.value = String(value)
    var pct = mk('span', '', Math.round(value * 100) + '%')
    pct.className = 'tick rm2-pet-menu-pct'
    slider.addEventListener('input', function () {
      var next = Number(slider.value)
      pct.textContent = Math.round(next * 100) + '%'
      onInput(next)
    })
    row.appendChild(mk('span', '', label))
    row.appendChild(slider)
    row.appendChild(pct)
    return row
  }

  // 统一右键菜单 —— 网页端（这里）与桌面端（pet-view.html buildMenu）同一骨架、
  // 同一顺序、同名条目：
  //   状态信息 │ 角色大小 · 透明度 · 左右镜像 │ 锁定位置 · 暂停动画 · 显示气泡
  //   │ 画画 · 重置位置 │ 桌面悬浮模式
  // 收录标准三条：点完立刻在宠物身上看得见、不想为此跳设置页、关掉后还有出口。
  // 因此启用/隐藏桌宠、宠物管理、响应子 Agent、平台令牌、用量模式、气泡细项与
  // 缩放细项一律只留设置页——它们要么低频，要么会把入口一起关掉。
  function buildMenuContent() {
    menu.textContent = ''
    var snap = lastSnapshot
    var running = snap && (snap.state === 'THINKING' || snap.state === 'WORKING' || snap.state === 'WAITING' || snap.state === 'ERROR')
    // 状态行是**单** span（整串「心情 · 消息 · 运行中」），与桌面端 menuRow 同构：
    // 定宽菜单里只有让整串落在 :first-child 上，才会走那条 min-width:0 + ellipsis
    // 的截断规则；拆成两个 span 时第二段不可收缩，长消息会直接溢出菜单圆角。
    var statusText = (MOODS[currentMood] || MOODS['06']) + ' · ' + (snap ? snap.message : '连接中') + (running ? ' · 运行中' : '')
    var status = makeRow(statusText)
    status.classList.add('rm2-pet-menu-status')
    menu.appendChild(status)
    menu.appendChild(makeSep())
    // ---- 外观：即时可见，全部就地调 ----
    menu.appendChild(makeSliderRow('角色大小', 0.5, 2, (snap && snap.scale) || 1, function (next) {
      void patchConfig('scale', next)
      if (lastSnapshot) {
        lastSnapshot.scale = next
        applyOffset(currentMood)
      }
    }))
    menu.appendChild(makeSliderRow('透明度', 0.3, 1, (snap && snap.opacity) || 1, function (next) {
      void patchConfig('opacity', next)
      if (lastSnapshot) {
        lastSnapshot.opacity = next
        applyVisuals(lastSnapshot)
      }
    }))
    menu.appendChild(makeToggleRow('左右镜像', snap ? snap.mirror === true : false, function () {
      var next = !(lastSnapshot ? lastSnapshot.mirror === true : false)
      void patchConfig('mirror', next)
      if (lastSnapshot) {
        lastSnapshot = { ...lastSnapshot, mirror: next }
        applyVisuals(lastSnapshot)
      }
      buildMenuContent()
    }))
    menu.appendChild(makeSep())
    // ---- 行为：开关即时生效，且一律写配置（否则快照会按配置把本地状态翻回去）----
    menu.appendChild(makeToggleRow('锁定位置', lockedNow, function () {
      var next = !lockedNow
      lockedNow = next
      syncPetCursor()
      void patchConfig('locked', next)
      buildMenuContent()
    }))
    var pauseRow = makeToggleRow('暂停动画', paused, function () {
      var next = !paused
      setPaused(next)
      // 必须写配置：applySnapshot 每次都按 config.paused 校正本地 paused，
      // 只改本地会在下一次快照被翻回去（旧实现点了像没生效）。
      void patchConfig('paused', next)
      buildMenuContent()
    })
    // 悬停就先把帧表解出来（120–160 帧，约 0.1–0.4s），点下去即可立刻冻结
    pauseRow.addEventListener('mouseenter', function () { void __gifFrame.warm(img.src) })
    menu.appendChild(pauseRow)
    menu.appendChild(makeToggleRow('显示气泡', lastSnapshot ? lastSnapshot.bubble !== false : true, function () {
      var next = !(lastSnapshot ? lastSnapshot.bubble !== false : true)
      // 与设置中的总开关逻辑一致：关闭→全部子开关关闭；开启→全部子开关打开。
      // 三项一次 PATCH，避免三次往返的中间态被 SSE 快照读到。
      void patchConfigFields({
        showBubble: next,
        showBubbleStatus: next,
        showBubbleUsage: next,
      })
      if (lastSnapshot) lastSnapshot = { ...lastSnapshot, bubble: next }
      buildMenuContent()
    }))
    menu.appendChild(makeSep())
    // ---- 动作与模式 ----
    menu.appendChild(makeActionRow('画画', function () { playDraw(); closeMenu() }))
    menu.appendChild(makeActionRow('重置位置', function () { resetPos(); closeMenu() }))
    menu.appendChild(makeToggleRow('桌面悬浮模式', lastSnapshot ? lastSnapshot.desktopMode === true : false, function () {
      // 一律以 desktopMode 配置为源：显示即配置值，点击即翻转配置。
      // 不读桌面窗口运行时状态（desktopActive），避免异步失步造成“没同步”。
      // 桌面端菜单同名同义（勾选态就是「当前在桌面模式」），不再一端叫
      // 「桌面悬浮模式」另一端叫「切换到网页模式」。
      var target = lastSnapshot ? !(lastSnapshot.desktopMode === true) : false
      void patchConfig('desktopMode', target)
      if (lastSnapshot) lastSnapshot = { ...lastSnapshot, desktopMode: target }
      if (target) {
        pendingDesktopHide = true
        armDesktopHideTimer()
        if (root.style.display !== 'none') {
          root.style.display = 'none'
          closeMenu()
        }
      } else {
        pendingDesktopHide = false
        if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
      }
      buildMenuContent()
    }))
  }

  // 平时锚角色顶右（紧凑，气泡在 absolute 里不撑 dock）；菜单矩形与气泡相交
  // 才改走包围盒避让。贴边仍是右→左→上。与桌面 pet-view.html 同一套。
  function menuBoxOf(el) {
    if (!el) return null
    var cr = el.getBoundingClientRect()
    if (cr.width < 1 || cr.height < 1) return null
    return { top: cr.top, left: cr.left, right: cr.right, bottom: cr.bottom }
  }
  function unionMenuBox(a, b) {
    if (!a) return b
    if (!b) return a
    return {
      top: Math.min(a.top, b.top),
      left: Math.min(a.left, b.left),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    }
  }
  function sideMenuPos(r, mw, mh, W, H) {
    // 角色盒子拿不到时（贴纸还没解码完 → img 高 0，menuBoxOf 判空）按视口右下角锚定：
    // 网页宠物本来就停在右下角。不加这一层会拿 null 去读 r.right 抛错，菜单停在旧坐标上。
    if (!r) r = { top: H - 48, left: W - 48, right: W - 48, bottom: H - 48 }
    var left, top
    if (r.right + 8 + mw <= W - 4) {
      left = r.right + 8
      top = Math.max(4, Math.min(r.top, H - mh - 4))
    } else if (r.left - 8 - mw >= 4) {
      left = r.left - mw - 8
      top = Math.max(4, Math.min(r.top, H - mh - 4))
    } else {
      left = Math.max(4, Math.min(r.right - mw, W - mw - 4))
      top = Math.max(4, r.top - mh - 8)
    }
    return { left: left, top: top }
  }
  function openMenuAt() {
    buildMenuContent()
    menu.style.display = 'block'
    var mw = menu.offsetWidth
    var mh = menu.offsetHeight
    var W = window.innerWidth || 1280
    var H = window.innerHeight || 800
    var pet = menuBoxOf(img) || menuBoxOf(dock)
    var bubbleBox = unionMenuBox(menuBoxOf(bubbleStack), menuBoxOf(bubble))
    var cluster = unionMenuBox(pet, bubbleBox) || pet
    var pos = sideMenuPos(pet, mw, mh, W, H)
    if (bubbleBox && pos.left < bubbleBox.right && pos.left + mw > bubbleBox.left && pos.top < bubbleBox.bottom && pos.top + mh > bubbleBox.top) {
      pos = sideMenuPos(cluster, mw, mh, W, H)
    }
    menu.style.left = pos.left + 'px'
    menu.style.top = pos.top + 'px'
    menuOpen = true
  }
  function closeMenu() {
    menu.style.display = 'none'
    menuOpen = false
  }

  function outsideDown(e) {
    if (menuOpen && !menu.contains(e.target)) closeMenu()
  }
  document.addEventListener('pointerdown', outsideDown, true)

  dock.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt()
  })

  sync()

  ctx.effect(function () { return function () {
    if (intervalId) window.clearInterval(intervalId)
    document.removeEventListener('pointerdown', outsideDown, true)
    // 断开 SSE、注销余额订阅、清掉全部遗留定时器与游离节点，
    // 否则插件禁用再启用（或 HMR）会累积连接、监听器与 detached DOM
    if (stream) { try { stream.close() } catch (e) { /* already closed */ } stream = null }
    if (unsubBalance) { try { unsubBalance() } catch (e) { /* ignore */ } unsubBalance = null }
    if (balanceWaitTimer) window.clearInterval(balanceWaitTimer)
    if (pulseFallbackTimer) window.clearTimeout(pulseFallbackTimer)
    if (updatePollTimer) window.clearInterval(updatePollTimer)
    if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
    for (const el of bubbleEls.values()) clearBubbleTitleTimer(el)
    bubbleEls.clear()
    try { picStop() } catch (e) { /* ignore */ }
    confirmOverlay.remove()
    picEl.remove()
    styleEl.remove()
    root.remove()
    menu.remove()
  } })
}

/** ---------- plugin entry ---------- */

function apply(ctx) {
  if (typeof document === 'undefined' || !document.body) return

  if (ctx.slots) {
    ctx.slots.inject('settings.section', function () {
      return ctx.slots.register({
        name: 'settings.section', id: 'pets', order: 25,
        label: function () { return '宠物管理' },
        inject: function () { return {} },
      }, PetsSection)
    })
    ctx.slots.inject('settings.plugin.item', function () {
      return ctx.slots.register({
        name: 'settings.plugin.item', id: 'dsh-pet-remielle', key: 'dsh-pet-remielle', order: 30,
        inject: function () { return {} },
      }, RemielleCard)
    })
  }

  mountPet(ctx)
}

module.exports = {
  name: 'dsh-pet-remielle-client',
  inject: ['slots', 'sessions'],
  apply: apply,
}
