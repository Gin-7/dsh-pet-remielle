window.__ModuleLoader__.load({ id: "dsh-pet-remielle", factory: (require) => {
const module = { exports: {} }
const exports = module.exports
const RM_PLUGIN_VERSION = "0.3.3"
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
var PETS_ENDPOINT = '/plugins/dsh-pet-remielle/pets'
var ASSETS_PREFIX = '/plugins/dsh-pet-remielle/assets'
var DESKTOP_ENDPOINT = '/plugins/dsh-pet-remielle/desktop'
var CHECK_ENDPOINT = '/plugins/dsh-pet-remielle/check'
var UPDATE_ENDPOINT = '/plugins/dsh-pet-remielle/update'
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

var CSS = [
  // Right-click menu — pink palette, matching the status bubble on both the
  // in-page pet and the desktop window (hardcoded, not DSW vars).
  '.rm2-pet-menu{position:fixed;z-index:2147483000;min-width:200px;background:#fff0f5;border:1px solid rgba(240,120,160,.45);border-radius:10px;box-shadow:0 8px 24px rgba(190,70,110,.22);padding:6px;font-family:system-ui,sans-serif;font-size:13px;color:#8a2f52;display:none;user-select:none;}',
  '.rm2-pet-menu-item{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:7px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;}',
  '.rm2-pet-menu-item:hover{background:rgba(240,120,160,.14);}',
  '.rm2-pet-menu-item .mute{color:#c2607f;font-size:12px;}',
  '.rm2-pet-menu-item .tick{color:#b03a60;font-weight:600;}',
  '.rm2-pet-menu-sep{height:1px;background:rgba(240,120,160,.25);margin:5px 6px;}',
  '.rm2-pet-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:10px;min-width:170px;max-width:340px;padding:8px 12px;border-radius:10px;background:#fff0f5;border:1px solid rgba(240,120,160,.45);box-shadow:0 6px 20px rgba(190,70,110,.20);font-size:12px;line-height:1.45;text-align:center;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-pet-bubble-title{font-weight:600;color:#b03a60;}',
  '.rm2-pet-bubble-detail{color:#c2607f;margin-top:2px;font-size:11px;}',
  '.rm2-pet-bubble.rm2-balance-mode{min-width:210px;padding:10px 14px;}',
  '.rm2-pet-bubble.rm2-balance-mode .rm2-pet-bubble-title{font-size:18px;font-weight:800;letter-spacing:.02em;color:#8a2f52;}',
  '.rm2-pet-bubble.rm2-balance-mode .rm2-pet-bubble-detail{font-size:12px;margin-top:3px;}',
  '.rm2-pet-bubble::after{content:\"\";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(240,120,160,.45);}',
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
  '.rm2-pet-confirm{width:min(380px,90vw);background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));border-radius:14px;box-shadow:0 20px 56px rgba(15,30,72,.34);padding:24px;font-family:system-ui,sans-serif;color:var(--dsw-alias-label-primary,#172347);}',
  '.rm2-pet-confirm-title{font-size:15px;font-weight:600;margin-bottom:8px;color:#b03a60;}',
  '.rm2-pet-confirm-body{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6f7c99);margin-bottom:20px;}',
  '.rm2-pet-confirm-body b{color:#b03a60;}',
  '.rm2-pet-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;}',
  '.rm2-pet-confirm-btn{padding:7px 18px;border-radius:8px;border:1px solid rgba(240,120,160,.3);background:transparent;color:#8a2f52;font-size:13px;cursor:pointer;font-family:inherit;transition:background .15s;}',
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
  '.rm2-pet-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;background:rgba(113,130,166,.45);cursor:pointer;transition:background .15s;border:none;padding:0;}',
  '.rm2-pet-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s;}',
  '.rm2-pet-switch.on{background:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-pet-switch.on::after{left:18px;}',
  'body[data-ds-dark-theme] .rm2-pet-switch{background:rgba(150,166,201,.4);}',
  'body[data-ds-dark-theme] .rm2-pet-switch.on{background:var(--dsw-alias-brand-primary,#8ba4d8);}',
  // Settings section spacing
  '.rm2-pet-settings-field{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:10px 0;border-bottom:1px solid var(--border-color, rgba(0,0,0,.06));}',
  '.rm2-pet-settings-field:last-child{border-bottom:none;}',
  '[data-testid="dsh-pet-remielle-settings"]:hover{border-color:var(--dsw-alias-label-dimmed);}',
  'body[data-ds-dark-theme] .rm2-pet-menu-sep{background:rgba(255,150,185,.25);}',
].join('\n')

function mk(tag, style, text) {
  var n = document.createElement(tag)
  if (style) n.style.cssText = style
  if (text !== undefined) n.textContent = text
  return n
}

/** Sticker URL for one pet + mood, served by the host. */
function gifUrl(petId, mood) {
  return ASSETS_PREFIX + '/' + encodeURIComponent(petId) + '/' + mood + '.gif'
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
var latestInfo = null
var updBubble = mk('button', 'display:none;position:fixed;right:20px;bottom:42px;z-index:2147483300;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary,#526aa8);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-brand-primary,#526aa8);cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;', '🆕 有新版本')
updBubble.title = '查看更新'
updBubble.addEventListener('click', openUpdateCard)
if (document.body) document.body.appendChild(updBubble)
else window.addEventListener('DOMContentLoaded', function () { document.body.appendChild(updBubble) })

var updCard = mk('div', 'display:none;position:fixed;z-index:2147483301;top:50%;left:50%;transform:translate(-50%,-50%);width:min(460px,92vw);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:12px;padding:18px;font-size:13px;color:var(--dsw-alias-label-primary,#172347);font-family:system-ui,sans-serif;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(15,30,72,.28));')
if (document.body) document.body.appendChild(updCard)
else window.addEventListener('DOMContentLoaded', function () { document.body.appendChild(updCard) })
function closeUpdateCard() { updCard.style.display = 'none' }
document.addEventListener('pointerdown', function (e) {
  if (updCard.style.display === 'block' && !updCard.contains(e.target)) closeUpdateCard()
}, true)
function setLatestUpdate(info, isNew) {
  latestInfo = info
  if (isNew) updBubble.style.display = 'inline-flex'
  else updBubble.style.display = 'none'
}
function openUpdateCard() {
  if (!latestInfo) return
  updCard.textContent = ''
  var heading = mk('div', 'display:flex;justify-content:space-between;align-items:center;gap:12px;')
  var title = mk('strong', 'font-size:15px;', '发现新版本')
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
  var notes = mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:180px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', latestInfo.needsCleanReinstall ? '版本低于 0.3.0，包名已变更，无法自动更新。\n请先彻底卸载旧版本，再重新安装 dsh-pet-remielle。' : (latestInfo.notes || '(无更新说明)'))
  updCard.appendChild(notes)
  var actions = mk('div', 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:14px;')
  if (latestInfo.needsCleanReinstall) {
    var upgrade = mk('button', 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#526aa8);color:#fff;cursor:pointer;font-size:13px;font-family:inherit;', '查看升级说明')
    upgrade.addEventListener('click', function () { window.open('https://github.com/Gin-7/dsh-pet-remielle#升级', '_blank') })
    actions.appendChild(upgrade)
  } else {
    var gh = mk('button', 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:transparent;cursor:pointer;font-size:13px;font-family:inherit;', '去 GitHub 查看')
    gh.addEventListener('click', function () { window.open(latestInfo.htmlUrl || 'https://github.com/Gin-7/dsh-pet-remielle/releases', '_blank') })
    var updBtn = mk('button', 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#526aa8);color:#fff;cursor:pointer;font-size:13px;font-family:inherit;', '更新')
    updBtn.addEventListener('click', function () { runSelfUpdate(updBtn, notes) })
    actions.appendChild(gh)
    actions.appendChild(updBtn)
  }
  updCard.appendChild(actions)
  updCard.style.display = 'block'
}
function runSelfUpdate(btn, notesEl) {
  if (!btn.disabled) { btn.disabled = true; btn.textContent = '更新中…' }
  fetch(UPDATE_ENDPOINT, { method: 'POST' })
    .then(function (r) { return r.json().catch(function () { return null }).then(function (j) { return { ok: r.ok, j: j } }) })
    .then(function (res) {
      btn.disabled = false
      if (res.ok && res.j && res.j.ok) {
        btn.textContent = '更新成功，请重启 dsh web'
        notesEl.textContent = (res.j.output || '') + '\n请重启 DSH 以生效。'
        updBubble.style.display = 'none'
      } else {
        btn.textContent = '更新失败'
        notesEl.textContent = (res.j && res.j.output) || '更新失败，查看控制台'
      }
    })
    .catch(function (err) {
      btn.disabled = false
      btn.textContent = '更新失败'
      notesEl.textContent = String(err)
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

function patchConfig(field, next) {
  return fetch(CONFIG_ENDPOINT, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [field]: next }),
  }).catch(function () {})
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
  return React.createElement('label', { className: 'rm2-pet-settings-field' },
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

function petCard(pet, active, refresh, busy) {
  var badge = petBadge(pet)
  var badgeStyle = {
    fontSize: 12, padding: '2px 8px', borderRadius: 999,
    border: '1px solid var(--border-color, #d8d8d8)', opacity: 0.8,
  }
  var imgStyle = { width: 56, height: 56, objectFit: 'cover', borderRadius: 10, background: 'var(--surface-color, #eee)' }
  return React.createElement('div', {
    key: pet.id,
    style: {
      display: 'flex', alignItems: 'center', gap: 14, padding: 12,
      border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary, #526aa8)' : 'var(--border-color, #d8d8d8)'),
      borderRadius: 12, background: 'var(--surface-color, transparent)',
    },
    'data-pet-id': pet.id,
  },
    React.createElement('img', { src: gifUrl(pet.id, pet.previewMood || '01'), alt: pet.name, style: imgStyle, draggable: false }),
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('strong', null, pet.name),
        React.createElement('span', { style: badgeStyle }, badge),
        active ? React.createElement('span', { style: Object.assign({}, badgeStyle, { borderColor: 'var(--dsw-alias-brand-primary, #526aa8)', color: 'var(--dsw-alias-brand-primary, #526aa8)' }) }, '当前展示') : null,
      ),
      React.createElement('small', { style: { display: 'block', opacity: 0.6, marginTop: 3, fontFamily: 'monospace' } }, pet.id),
      React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        React.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' } },
          React.createElement(Switch, {
            checked: pet.enabled === true,
            disabled: !pet.available || busy,
            onChange: function (val) {
              void patchPet(pet.id, { enabled: val }).then(function (result) {
                if (result) refresh()
              })
            },
          }),
          '启用',
        ),
        !active && pet.available && pet.complete
          ? React.createElement('button', {
              type: 'button', disabled: busy,
              onClick: function () {
                void patchPet(pet.id, { active: true }).then(function (result) { if (result) refresh() })
              },
            }, '设为当前')
          : null,
        pet.available
          ? React.createElement(RenameButton, { pet: pet, refresh: refresh, busy: busy })
          : null,
      ),
    ),
  )
}

function RenameButton(props) {
  var editingState = React.useState(false)
  var editing = editingState[0]
  var setEditing = editingState[1]
  var nameState = React.useState(props.pet.name)
  var name = nameState[0]
  var setName = nameState[1]
  if (!editing) {
    return React.createElement('button', {
      type: 'button', disabled: props.busy,
      onClick: function () { setName(props.pet.name); setEditing(true) },
    }, '改名')
  }
  return React.createElement('span', { style: { display: 'inline-flex', gap: 5 } },
    React.createElement('input', {
      type: 'text', value: name, size: 10,
      onChange: function (event) { setName(event.target.value) },
      onKeyDown: function (event) {
        if (event.key === 'Enter') {
          void patchPet(props.pet.id, { name: name.trim() || props.pet.name }).then(function (result) {
            if (result) { props.refresh(); setEditing(false) }
          })
        }
        if (event.key === 'Escape') setEditing(false)
      },
    }),
    React.createElement('button', {
      type: 'button',
      onClick: function () {
        void patchPet(props.pet.id, { name: name.trim() || props.pet.name }).then(function (result) {
          if (result) { props.refresh(); setEditing(false) }
        })
      },
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
      marginTop: 14, padding: 14, border: '1px dashed var(--border-color, #d8d8d8)',
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
          style: { flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', fontSize: 13, fontFamily: 'inherit' },
          onChange: function (event) { setId(event.target.value) },
        }),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7, minWidth: 60 } }, '名称'),
        React.createElement('input', {
          type: 'text', placeholder: '显示名（可选）', value: name,
          style: { flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', fontSize: 13, fontFamily: 'inherit' },
          onChange: function (event) { setName(event.target.value) },
        }),
      ),
      React.createElement('button', {
        type: 'button', onClick: submit,
        style: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-brand-primary, #526aa8)', background: 'var(--dsw-alias-brand-primary, #526aa8)', color: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', alignSelf: 'flex-start' },
      }, '添加并启用'),
    ),
    error ? React.createElement('small', { role: 'alert', style: { color: 'var(--danger-color, #c0392b)', fontSize: 12 } }, error) : null,
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
  var tokenState = React.useState('')               // 平台令牌输入框
  var tokenValue = tokenState[0]
  var setTokenValue = tokenState[1]
  var tokenOkState = React.useState(null)           // null=未知 true=已配置 false=未配置
  var tokenConfigured = tokenOkState[0]
  var setTokenConfigured = tokenOkState[1]
  var updState = React.useState(null)       // { latest, notes, htmlUrl } | null
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
        var info = { latest: j.latest, notes: j.notes || '', htmlUrl: j.htmlUrl || 'https://github.com/Gin-7/dsh-pet-remielle/releases', needsCleanReinstall: j.needsCleanReinstall === true }
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
    fetch('/plugins/dsh-pet-remielle/platform-token', { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) { if (active && j && typeof j.configured === 'boolean') setTokenConfigured(j.configured) })
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
  var sectionStyle = { display: 'grid', gap: 10, padding: '4px 2px', fontFamily: 'system-ui, sans-serif', fontSize: 13, color: 'var(--dsw-alias-label-primary, #172347)' }
  var tabs = [
    { id: 'appearance', label: '外观' },
    { id: 'behavior', label: '行为' },
    { id: 'desktop', label: '桌面悬浮' },
    { id: 'update', label: '更新' },
    { id: 'feedback', label: '反馈' },
  ]
  var tabBar = React.createElement('div', { style: { display: 'flex', gap: 2, borderBottom: '1px solid var(--border-color, #d8d8d8)', marginBottom: 12 } },
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
  var appearanceTab = React.createElement('div', null,
    React.createElement(Field, { label: '角色大小', hint: Math.round((v.scale ?? 1) * 100) + '%' },
      React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.scale ?? 1, disabled: !config, onChange: function (e) { writeSlider('scale', Number(e.target.value)) } }),
    ),
    React.createElement(Field, { label: '透明度', hint: Math.round((v.opacity ?? 1) * 100) + '%' },
      React.createElement('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: v.opacity ?? 1, disabled: !config, onChange: function (e) { writeSlider('opacity', Number(e.target.value)) } }),
    ),
    React.createElement('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color, rgba(0,0,0,.06))' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
        React.createElement('span', { style: { fontWeight: 600 } }, '宠物管理'),
        React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, '管理你的桌宠收藏'),
      ),
      error
        ? React.createElement('div', { role: 'alert' },
            React.createElement('span', null, error),
            React.createElement('button', { type: 'button', onClick: refresh, style: { marginLeft: 10 } }, '重试'),
          )
        : data === null
        ? React.createElement('p', { style: { opacity: 0.6, fontSize: 12 } }, '加载宠物列表中…')
        : React.createElement(React.Fragment, null,
            data.pets.map(function (pet) {
              return React.createElement('div', {
                key: pet.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
                  border: '1px solid ' + (pet.id === data.activePetId ? 'var(--dsw-alias-brand-primary, #526aa8)' : 'var(--border-color, #d8d8d8)'),
                  background: pet.id === data.activePetId ? 'rgba(82,106,168,.06)' : 'transparent',
                  marginBottom: 6,
                },
              },
                React.createElement('img', { src: gifUrl(pet.id, '06'), alt: pet.name, style: { width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }, draggable: false }),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    React.createElement('strong', { style: { fontSize: 13 } }, pet.name),
                    React.createElement('span', { style: { fontSize: 11, opacity: 0.5, fontFamily: 'monospace' } }, pet.id),
                  ),
                  pet.id !== data.activePetId && pet.available && pet.complete
                    ? React.createElement('button', {
                        type: 'button', disabled: busy,
                        style: { marginTop: 4, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' },
                        onClick: function () { void patchPet(pet.id, { active: true }).then(function (result) { if (result) refresh() }) },
                      }, '设为当前')
                    : null,
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
    ),
  )
  var behaviorTab = React.createElement('div', null,
    React.createElement(Field, { label: '启用桌宠', hint: '关闭后宠物立即隐藏。' },
      React.createElement(Switch, { checked: v.enabled !== false, disabled: !config, onChange: function (val) { write('enabled', val) } }),
    ),
    React.createElement(Field, { label: '锁定位置', hint: '开启后宠物不可拖动。' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('button', {
          type: 'button', disabled: !config,
          style: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: config ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'nowrap' },
          onClick: function () { fetch(DESKTOP_ENDPOINT + '/start', { method: 'POST' }).catch(function () {}) },
        }, '重置位置'),
        React.createElement(Switch, { checked: v.locked === true, disabled: !config, onChange: function (val) { write('locked', val) } }),
      ),
    ),
    React.createElement(Field, { label: '暂停动画', hint: '暂停 GIF 动画，宠物保持当前帧静止。' },
      React.createElement(Switch, { checked: v.paused === true, disabled: !config, onChange: function (val) { write('paused', val) } }),
    ),
    React.createElement(Field, { label: '隐藏桌宠', hint: '隐藏宠物，通过右键菜单或状态栏唤醒。' },
      React.createElement(Switch, { checked: v.hidden === true, disabled: !config, onChange: function (val) { write('hidden', val) } }),
    ),
    React.createElement(Field, { label: '响应子 Agent', hint: '默认只跟随顶层任务，避免状态过度跳动。' },
      React.createElement(Switch, { checked: v.includeSubagents === true, disabled: !config, onChange: function (val) { write('includeSubagents', val) } }),
    ),
    React.createElement(Field, { label: '显示气泡', hint: '在宠物上方显示状态气泡（阶段/待办/进度）。' },
      React.createElement(Switch, { checked: v.showBubble !== false, disabled: !config, onChange: function (val) { write('showBubble', val) } }),
    ),
    React.createElement(Field, { label: '用量模式', hint: '今日已用统计：记账靠余额差值（免令牌，有误差）；实时·令牌直连平台用量接口（精确，需配置 DEEPSEEK_PLATFORM_TOKEN）。' },
      React.createElement('select', {
        value: v.usageMode === 'token' ? 'token' : 'ledger',
        disabled: !config,
        onChange: function (e) { write('usageMode', e.target.value) },
        style: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: config ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit', color: 'inherit' },
      },
        React.createElement('option', { value: 'ledger' }, '小鲸鱼记账（免令牌）'),
        React.createElement('option', { value: 'token' }, '实时·令牌（精确）'),
      ),
    ),
    React.createElement(Field, { label: '平台令牌（DEEPSEEK_PLATFORM_TOKEN）', hint: '用于「实时·令牌」模式（精确统计今日已用）。获取：登录 platform.deepseek.com → F12 → Network → 用量请求的 Authorization 头。令牌仅保存到 DSH 凭据服务，不会写入插件配置。' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
        React.createElement('input', {
          type: 'password',
          value: tokenValue,
          disabled: !config,
          placeholder: tokenConfigured === true ? '已配置 ✓（输入新令牌可覆盖，留空并保存可清除）' : '粘贴平台令牌',
          onChange: function (e) { setTokenValue(e.target.value) },
          style: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', fontSize: 12, fontFamily: 'inherit', color: 'inherit' },
        }),
        React.createElement('button', {
          type: 'button',
          disabled: !config || tokenValue.trim() === '',
          style: { padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: config ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'nowrap' },
          onClick: function () {
            fetch('/plugins/dsh-pet-remielle/platform-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: tokenValue.trim() }),
            })
              .then(function (r) { return r.json().catch(function () { return null }) })
              .then(function (j) {
                if (j && j.ok) {
                  setTokenConfigured(true)
                  setTokenValue('')
                }
              })
              .catch(function () {})
          },
        }, '保存'),
        tokenConfigured === true
          ? React.createElement('button', {
              type: 'button',
              disabled: !config,
              style: { padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: config ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'nowrap' },
              onClick: function () {
                fetch('/plugins/dsh-pet-remielle/platform-token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: '' }),
                })
                  .then(function (r) { return r.json().catch(function () { return null }) })
                  .then(function (j) { if (j && j.ok) setTokenConfigured(false) })
                  .catch(function () {})
              },
            }, '清除')
          : null,
      ),
    ),
  )
  var desktopTab = React.createElement('div', null,
    React.createElement(Field, { label: '桌面悬浮模式', hint: '用独立置顶窗口显示宠物（需要 Electron 运行时）。' },
      React.createElement(Switch, { checked: v.desktopMode === true, disabled: !config, onChange: function (val) { write('desktopMode', val) } }),
    ),
    v.desktopMode
      ? React.createElement('p', { style: { margin: '8px 0 0', opacity: 0.6, fontSize: 12 } }, '桌面窗口支持拖动、滚轮缩放、双击画画。关闭后回到页面内展示。')
      : null,
  )
  var updateTab = React.createElement('div', null,
    React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7 } }, '检查是否有新版本可用，或执行增量更新。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
      React.createElement('span', { style: { fontSize: 13 } }, '当前版本：'),
      React.createElement('span', { style: { fontWeight: 600 } }, currentVersion),
      updMsg === 'has-update'
        ? null
        : React.createElement('button', {
            type: 'button', disabled: updChecking,
            style: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: updChecking ? 'default' : 'pointer', fontSize: 13, fontFamily: 'inherit' },
            onClick: checkUpdate,
          }, updChecking ? '检查中…' : (updMsg === 'latest' ? '重新检查' : '检查更新')),
    ),
    updMsg === 'checking'
      ? React.createElement('p', { style: { margin: '10px 0 0', opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6f7c99)' } }, '正在检查更新…')
      : updMsg === 'latest'
      ? React.createElement('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2e8b57)' } }, '当前已是最新版本。')
      : updMsg === 'has-update'
      ? updInfo && updInfo.needsCleanReinstall
        ? React.createElement('div', { style: { margin: '10px 0 0' } },
            React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13 } }, '发现新版本 ' + updInfo.latest + '。'),
            React.createElement('p', { style: { margin: '0 0 10px', fontSize: 13, lineHeight: 1.6 } },
              '你的版本低于 0.3.0，0.3.0 起包名已变更，无法自动增量更新。请先彻底卸载旧版本，再重新安装 dsh-pet-remielle。'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', {
                type: 'button',
                style: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
                onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle#升级', '_blank') },
              }, '查看升级说明'),
            ),
          )
        : React.createElement('div', { style: { margin: '10px 0 0' } },
            React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13 } }, '发现新版本 ' + (updInfo ? updInfo.latest : '') + '，可一键更新。'),
            updInfo && updInfo.notes
              ? React.createElement('pre', { style: { whiteSpace: 'pre-wrap', margin: '0 0 10px', maxHeight: 140, overflow: 'auto', background: 'rgba(103,126,183,.07)', border: '1px solid var(--border-color,#d8d8d8)', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.55 } }, updInfo.notes)
              : null,
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', {
                type: 'button',
                style: { padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--dsw-alias-brand-primary,#526aa8)', color: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
                onClick: function () { openUpdateCard() },
              }, '一键更新'),
              React.createElement('button', {
                type: 'button',
                style: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
                onClick: function () { window.open((updInfo && updInfo.htmlUrl) || 'https://github.com/Gin-7/dsh-pet-remielle/releases', '_blank') },
              }, '去 GitHub 查看'),
            ),
          )
      : updMsg && updMsg.indexOf('error') === 0
      ? React.createElement('p', { style: { margin: '10px 0 0', opacity: 0.7, fontSize: 12 } }, '检查更新失败：' + (updMsg === 'error' ? '无法连接 GitHub，请稍后重试或检查网络/代理。' : updMsg.replace('error:', '') + '，请稍后重试或检查网络/代理。'))
      : null,
    React.createElement('p', { style: { margin: '14px 0 0', opacity: 0.5, fontSize: 12 } },
      '更新检查通过 GitHub API 获取最新版本；桌面悬浮窗等运行时随插件一同更新。更新完成后需重启 DSH 生效。'),
  )
  var feedbackTab = React.createElement('div', null,
    React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7 } }, '遇到问题或有建议？欢迎反馈，帮助改善桌宠。'),
    React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.6, fontSize: 12 } }, '桌宠版本：' + (typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : 'unknown')),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      React.createElement('button', {
        type: 'button',
        style: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
        onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle/issues/new?template=bug_report.yml', '_blank') },
      }, '提交 Bug'),
      React.createElement('button', {
        type: 'button',
        style: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
        onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle/issues/new?template=feature_request.yml', '_blank') },
      }, '功能建议'),
    ),
  )
  var tabContent = tab === 'appearance' ? appearanceTab : tab === 'behavior' ? behaviorTab : tab === 'desktop' ? desktopTab : tab === 'update' ? updateTab : feedbackTab
  return React.createElement('section', { style: sectionStyle, 'data-testid': 'dsh-pet-remielle-pets-section' },
    React.createElement('h3', { style: { margin: 0, fontSize: 15 } }, '桌宠设置'),
    tabBar,
    tabContent,
  )
}

/** ---------- floating pet (plain DOM) ---------- */

function mountPet(ctx) {
  // 余额控制器：幂等加载共享客户端脚本
  if (!window.__petBalance && !document.querySelector('script[src*="balance-widget.js"]')) {
    var balanceScript = document.createElement('script')
    balanceScript.src = '/plugins/dsh-pet-remielle/balance-widget.js'
    balanceScript.async = true
    document.head.appendChild(balanceScript)
  }
  var root = mk('div', 'position:fixed;right:20px;bottom:20px;z-index:2147483000;pointer-events:auto;user-select:none;')
  root.setAttribute('data-rm2-pet-root', '')
  var dock = mk('div', 'position:relative;display:inline-block;cursor:grab;touch-action:none;')
  dock.title = '拖动我 · 点击互动 · 右键菜单'
  var img = mk('img', 'width:180px;height:auto;pointer-events:none;display:none;')
  img.alt = '桌宠'
  img.draggable = false
  var bubble = mk('div', 'display:none;')
  bubble.className = 'rm2-pet-bubble'
  var bubbleTitle = mk('div', '')
  bubbleTitle.className = 'rm2-pet-bubble-title'
  var bubbleDetail = mk('div', '')
  bubbleDetail.className = 'rm2-pet-bubble-detail'
  bubble.appendChild(bubbleTitle)
  bubble.appendChild(bubbleDetail)
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
  var manualOverride = null
  var paused = false
  var hidden = false
  var lockedNow = false
  var positionRestored = false
  var lastTurnEndShown = false
  var intervalId = 0
  var pulseFallbackTimer = 0
  var stream = null

  function applyVisuals(snapshot) {
    var scale = snapshot.scale ?? 1
    var opacity = snapshot.opacity ?? 1
    img.style.width = Math.round(180 * scale) + 'px'
    img.style.opacity = String(opacity)
    lockedNow = snapshot.locked === true
    dock.style.cursor = lockedNow ? 'default' : 'grab'
  }

  /** Status bubble above the pet: message + detail (project · progress · stage).
   *  The title changes at most once per BUBBLE_TITLE_MS while the mood stays put
   *  (so think 04 / streaming 01 doesn't flip on every chunk, but still refreshes
   *  occasionally), and updates immediately when the mood/phase changes. */
  var BUBBLE_TITLE_MS = 2000
  var lastBubbleMood = ''
  var lastBubbleText = ''
  var lastBubbleTitleAt = 0
  var lastBubbleDetail = ''
  function updateBubble(snapshot) {
    if (!snapshot) return
    // 余额/随机台词模式下，气泡由余额控制器渲染，不被会话状态覆盖
    if (balanceFrame && balanceFrame.kind === 'balance') return
    var drawing = manualOverride && manualOverride.mood === '01' && manualOverride.until > Date.now()
    var show = drawing || (snapshot.bubble !== false && Boolean(snapshot.detail))
    if (show) {
      if (drawing) {
        // 画画中：显示指定文案（离开画画后通过 lastBubbleMood 标记强制恢复会话消息）
        if (lastBubbleMood !== '__drawing__') {
          lastBubbleMood = '__drawing__'
          lastBubbleText = ''
          lastBubbleDetail = ''
        }
        bubbleTitle.textContent = '正在创作隐晦物品'
        bubbleDetail.textContent = ''
      } else {
        var text = snapshot.message || ''
        var detail = snapshot.detail || ''
        var now = Date.now()
        var moodChanged = snapshot.mood !== lastBubbleMood
        if (moodChanged || (text !== lastBubbleText && now - lastBubbleTitleAt >= BUBBLE_TITLE_MS)) {
          lastBubbleTitleAt = now
          lastBubbleMood = snapshot.mood
          lastBubbleText = text
          bubbleTitle.textContent = text
        }
        if (detail !== lastBubbleDetail) {
          lastBubbleDetail = detail
          bubbleDetail.textContent = detail
        }
      }
    }
    bubble.style.display = show ? 'block' : 'none'
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
    // Download progress messages — update the confirmation dialog in-place.
    if (snapshot.kind === 'download') {
      if (snapshot.phase === 'confirm') {
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
    lastSnapshot = snapshot
    // 余额控制器：初始化/同步用量模式
    if (window.__petBalance) {
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
    patchConfig('posX', null)
    patchConfig('posY', null)
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
      dock.title = '已暂停（右键菜单恢复）'
    } else {
      var animated = img.dataset.animated
      delete img.dataset.animated
      if (animated && animated !== img.src) img.src = animated
      else showMood(currentMood)
      dock.title = '拖动我 · 点击互动 · 右键菜单'
    }
  }

  // Per-mood alignment offset (legacy, kept for API compat). Since all GIFs
  // are now the same size, this just sets a consistent width.
  function applyOffset(mood) {
    var scale = (lastSnapshot && lastSnapshot.scale) || 1
    img.style.width = Math.round(180 * scale) + 'px'
    img.style.transform = ''
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
  var picRevealRaf = 0
  var picLoads = []
  function picStop() {
    if (picTimer) { window.clearTimeout(picTimer); picTimer = 0 }
    if (picFadeTimer) { window.clearTimeout(picFadeTimer); picFadeTimer = 0 }
    if (picRevealRaf) { window.cancelAnimationFrame(picRevealRaf); picRevealRaf = 0 }
  }
  function showPic() {
    var snap = lastSnapshot
    var count = snap && snap.pics ? snap.pics : 0
    if (!count) return
    var n = Math.floor(Math.random() * count) + 1
    var src = ASSETS_PREFIX + '/' + encodeURIComponent(currentPetId) + '/pics/' + n + '.png'
    picStop()
    picEl.style.display = 'block'
    picEl.style.opacity = '1'
    picEl.style.transition = 'none'
    var img = new Image()
    img.src = src
    picLoads.push(img)
    if (picLoads.length > 3) picLoads.shift()
    img.onload = function () { brushReveal(img) }
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
        setTimeout(function () { picEl.style.display = 'none'; picEl.style.transition = '' }, 800)
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
      if (dragMoved) {
        var r = root.getBoundingClientRect()
        patchConfig('posX', Math.round(r.left))
        patchConfig('posY', Math.round(r.top))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })

  dock.addEventListener('click', function () {
    if (dragMoved) return
    var candidates = MOOD_ORDER.filter(function (m) { return m !== currentMood })
    var pick = candidates[Math.floor(Math.random() * candidates.length)]
    manualOverride = { mood: pick, until: Date.now() + 1800 }
    sync()
    // 余额：单击宠物切换到余额+时段显示并手动刷新
    if (window.__petBalance) window.__petBalance.click()
  })

  // 余额控制器：把显示帧渲染进自带气泡（脚本异步加载，重试直到就绪）
  function whenPetBalance(cb) {
    if (window.__petBalance) { cb(); return }
    var tries = 0
    var timer = window.setInterval(function () {
      tries++
      if (window.__petBalance) {
        window.clearInterval(timer)
        cb()
      } else if (tries > 60) {
        window.clearInterval(timer)
      }
    }, 100)
  }
  whenPetBalance(function () {
    window.__petBalance.subscribe(function (frame) {
      balanceFrame = frame
      if (frame.kind === 'balance') {
        bubble.style.pointerEvents = 'auto'
        bubble.classList.add('rm2-balance-mode')
        bubbleTitle.textContent = (frame.label || 'DeepSeek 余额') + '  ' + frame.amount
        bubbleTitle.style.color = ''
        bubbleDetail.innerHTML = frame.detail + ' · <span style="color:' + (frame.color || '') + '">' + frame.period + '</span>'
        bubble.style.display = 'block'
      } else if (frame.kind === 'status') {
        balanceFrame = null
        bubble.style.pointerEvents = 'none'
        bubble.classList.remove('rm2-balance-mode')
        // 清掉状态气泡的节流缓存，强制恢复会话状态内容
        lastBubbleMood = ''
        lastBubbleText = ''
        lastBubbleDetail = ''
        if (lastSnapshot) updateBubble(lastSnapshot)
      }
    })
  })

  // Double-click: play a drawing sticker loop and pop a random artwork.
  dock.addEventListener('dblclick', function () {
    if (!lastSnapshot || lastSnapshot.pics === 0) return
    manualOverride = { mood: '01', until: Date.now() + PIC_DRAW_MS }
    sync()
    showPic()
  })

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

  function buildMenuContent() {
    menu.textContent = ''
    var snap = lastSnapshot
    var running = snap && (snap.state === 'THINKING' || snap.state === 'WORKING' || snap.state === 'WAITING' || snap.state === 'ERROR')
    var status = makeRow(MOODS[currentMood] || MOODS['06'], (snap ? snap.message : '连接中') + (running ? ' · 运行中' : ''))
    status.style.opacity = '0.85'
    status.style.cursor = 'default'
    menu.appendChild(status)
    var sep = mk('div', '')
    sep.className = 'rm2-pet-menu-sep'
    menu.appendChild(sep)
    // Size slider: live preview via applyOffset, persisted via /config.
    var sizeRow = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 10px;')
    var sizeLabel = mk('span', '', '角色大小')
    var sizeSlider = mk('input', 'width:110px;margin:0 4px;')
    sizeSlider.type = 'range'
    sizeSlider.min = 0.5
    sizeSlider.max = 2
    sizeSlider.step = 0.05
    var sizePct = mk('span', 'min-width:42px;text-align:right;font-size:12px;color:#b03a60;font-weight:600;', '')
    var sizeCur = (lastSnapshot && lastSnapshot.scale) || 1
    sizeSlider.value = String(sizeCur)
    sizePct.textContent = Math.round(sizeCur * 100) + '%'
    sizeSlider.addEventListener('input', function () {
      var next = Number(sizeSlider.value)
      sizePct.textContent = Math.round(next * 100) + '%'
      void patchConfig('scale', next)
      if (lastSnapshot) {
        lastSnapshot.scale = next
        applyOffset(currentMood)
      }
    })
    sizeRow.appendChild(sizeLabel)
    sizeRow.appendChild(sizeSlider)
    sizeRow.appendChild(sizePct)
    menu.appendChild(sizeRow)
    menu.appendChild(makeToggleRow('锁定位置', lockedNow, function () {
      var next = !lockedNow
      lockedNow = next
      dock.style.cursor = next ? 'default' : 'grab'
      void patchConfig('locked', next)
      buildMenuContent()
    }))
    menu.appendChild(makeToggleRow('显示气泡', lastSnapshot ? lastSnapshot.bubble !== false : true, function () {
      var next = !(lastSnapshot ? lastSnapshot.bubble !== false : true)
      void patchConfig('showBubble', next)
      if (lastSnapshot) lastSnapshot = { ...lastSnapshot, bubble: next }
      buildMenuContent()
    }))
    menu.appendChild(makeToggleRow('桌面悬浮模式', lastSnapshot ? lastSnapshot.desktopMode === true : false, function () {
      // 一律以 desktopMode 配置为源：显示即配置值，点击即翻转配置。
      // 不读桌面窗口运行时状态（desktopActive），避免异步失步造成“没同步”。
      var target = lastSnapshot ? !(lastSnapshot.desktopMode === true) : false
      void patchConfig('desktopMode', target)
      if (lastSnapshot) lastSnapshot = { ...lastSnapshot, desktopMode: target }
      buildMenuContent()
    }))
    menu.appendChild(makeActionRow('重置位置', function () { resetPos(); closeMenu() }))
    menu.appendChild(makeToggleRow('暂停动画', paused, function () { setPaused(!paused); buildMenuContent() }))
  }

  // Menu anchors to the character's top-right corner (outside the pet, never
  // covering it). Falls back: top-left when the right side is too narrow,
  // then above the pet when neither side fits.
  function openMenuAt() {
    buildMenuContent()
    menu.style.display = 'block'
    var mw = menu.offsetWidth
    var mh = menu.offsetHeight
    var W = window.innerWidth || 1280
    var H = window.innerHeight || 800
    var r = dock.getBoundingClientRect()
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
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
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
  inject: ['slots'],
  apply: apply,
}

return module.exports
} })
