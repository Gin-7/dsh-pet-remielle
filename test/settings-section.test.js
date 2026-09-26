/**
 * 设置页（PetsSection）结构护栏。
 *
 * 背景：宠物卡片的「改名」与「状态徽章」曾因 PetsSection 内联手写卡片而
 * 成为死代码（petCard/RenameButton/petBadge 无人调用，README 承诺的改名
 * 在 UI 上消失了几个月）。本文件把设置页的关键结构钉住：
 *   1. tab 清单与顺序（外观/宠物/行为/桌面悬浮/关于）
 *   2. 宠物卡片必须渲染改名按钮与状态徽章（防死代码回退）
 *   3. 检查更新的 no-release 状态必须有可见反馈（不许静默）
 *
 * 用假 React 直接驱动 PetsSection()（与 .global_ignored/settings-tree-probe.mjs
 * 同一机制），不需要浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const CORE = new URL('../src/client.core.js', import.meta.url)
const src = readFileSync(CORE, 'utf8')

function makeReact({ tab, data, config, updMsg }) {
  const initial = [tab, data, null, false, config, false, null, false, updMsg]
  let cursor = 0
  return {
    React: {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
      },
      useState(seed) {
        const i = cursor++
        return [i < initial.length ? initial[i] : seed, () => {}]
      },
      useEffect() {},
      useRef(seed) { return { current: seed } },
    },
    reset() { cursor = 0 },
  }
}

function loadPetsSection() {
  const stubs = makeReact({ tab: 'appearance', data: null, config: null, updMsg: null })
  const sandbox = {
    React: stubs.React,
    require: (name) => {
      if (name === 'react') return stubs.React
      throw new Error('unexpected require: ' + name)
    },
    module: { exports: {} },
    RM_PLUGIN_VERSION: '0.0.0-test',
    window: { addEventListener() {} },
    document: {
      createElement: () => ({ style: {}, addEventListener() {}, contains() {}, appendChild() {}, textContent: '' }),
      body: null,
      addEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: () => new Promise(() => {}),
  }
  sandbox.globalThis = sandbox
  runInNewContext(src, sandbox, { filename: 'client.core.js' })
  if (typeof sandbox.PetsSection !== 'function') throw new Error('PetsSection 未导出到沙箱全局')
  return { sandbox, stubs }
}

function renderTab(tab, { data = null, config = null, updMsg = null } = {}) {
  const { sandbox, stubs } = loadPetsSection()
  const fresh = makeReact({ tab, data, config, updMsg })
  sandbox.React = fresh.React
  sandbox.require = (name) => { if (name === 'react') return fresh.React; throw new Error('require ' + name) }
  return sandbox.PetsSection()
}

function nameOf(type) {
  if (typeof type === 'string') return type
  if (typeof type === 'function') return type.name || 'anonymous'
  return String(type)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function collectTabLabels(tree) {
  const labels = []
  walk(tree, (node) => {
    if (nameOf(node.type) === 'button' && typeof node.children?.[0] === 'string' && node.props?.type === 'button') labels.push(node.children[0])
  })
  return labels
}

function collectStrings(tree) {
  const out = []
  walk(tree, (node) => {
    for (const child of node.children || []) {
      if (typeof child === 'string') out.push(child)
    }
  })
  return out
}

function collectComponents(tree, name) {
  const out = []
  walk(tree, (node) => {
    if (typeof node.type === 'function' && node.type.name === name) out.push(node.props)
  })
  return out
}

const SAMPLE_DATA = {
  activePetId: 'remielle',
  pets: [
    { id: 'remielle', name: '蕾米埃尔', enabled: true, available: true, complete: true, previewMood: '06' },
    { id: 'broken', name: '缺图宠物', enabled: false, available: true, complete: false, previewMood: '01' },
  ],
}

test('settings tabs: five tabs in fixed order (外观/宠物/行为/桌面悬浮/关于)', () => {
  const tree = renderTab('appearance')
  const labels = collectTabLabels(tree).filter((l) => ['外观', '宠物', '行为', '桌面悬浮', '关于'].includes(l))
  assert.deepEqual(labels, ['外观', '宠物', '行为', '桌面悬浮', '关于'])
})

test('appearance tab field order (mirror stays below opacity)', () => {
  const tree = renderTab('appearance', { config: { scale: 1, opacity: 1, mirror: false } })
  const labels = collectComponents(tree, 'Field').map((p) => p.label).filter(Boolean)
  // bubbleScaleSync 未配置默认同步 → 子项「气泡相对桌宠的大小」也渲染
  assert.deepEqual(labels, ['角色大小', '气泡随桌宠同步缩放', '气泡相对桌宠的大小', '透明度', '角色左右镜像'])
})

test('settings title matches the nav label (宠物管理)', () => {
  const tree = renderTab('appearance')
  assert.ok(collectStrings(tree).includes('宠物管理'), 'section 标题应与左侧导航 label 一致')
})

test('pet cards render rename-on-double-click and status badges (no dead code fallback)', () => {
  const tree = renderTab('pets', { data: SAMPLE_DATA, config: {} })
  const renames = collectComponents(tree, 'RenameButton')
  assert.equal(renames.length, 2, '每只可用宠物的名字都应是改名入口（双击）')
  assert.deepEqual(renames.map((p) => p.pet.id), ['remielle', 'broken'])
  const strings = collectStrings(tree)
  assert.ok(strings.includes('已启用'), '完整宠物应显示「已启用」徽章')
  assert.ok(strings.includes('缺图（需 01–06 齐全）'), '缺图宠物应显示缺图徽章而不是静默禁用开关')
  const setActive = strings.filter((s) => s === '设为当前')
  assert.equal(setActive.length, 0, '缺图宠物不应出现「设为当前」')
  assert.ok(!strings.includes('改名'), '不应再有独立的「改名」按钮——入口是双击名字')
})

test('update check shows feedback when the repo has no release yet', () => {
  const tree = renderTab('about', { updMsg: 'no-release' })
  assert.ok(
    collectStrings(tree).some((s) => s.includes('仓库还没有发布过任何版本')),
    'no-release 状态必须有可见文案，不能静默',
  )
})

test('source-level guards: petCard stays deleted, RenameButton is referenced', () => {
  assert.ok(!src.includes('function petCard('), 'petCard 是死代码，已删除——别再把它加回来')
  assert.ok(src.includes('React.createElement(RenameButton'), 'RenameButton 必须有活引用')
  assert.ok(src.includes("updMsg === 'no-release'"), 'no-release 渲染分支必须存在')
})

test('settings controls carry the shared button/input classes (host-consistent styling)', () => {
  assert.ok(src.includes("'.rm2-pet-btn{"), 'CSS 注入数组必须定义 .rm2-pet-btn（带 hover/disabled 态）')
  assert.ok(src.includes("'.rm2-pet-input{"), 'CSS 注入数组必须定义 .rm2-pet-input')
  assert.ok(/RenameButton[\s\S]{0,900}?onDoubleClick/.test(src), '改名入口必须是双击名字（onDoubleClick）')
  assert.ok(/RenameButton[\s\S]{0,1600}?className: 'rm2-pet-input'/.test(src), '改名编辑态输入框必须使用 rm2-pet-input 类，不允许裸 input')
  assert.ok(/RenameButton[\s\S]{0,2000}?rm2-pet-btn-primary/.test(src), '改名编辑态的「保存」必须是主按钮')
  // var(--border-color/--danger-color/--surface-color) 是不存在的变量，
  // 永远落浅色 fallback → 深色主题下边框/错误色全是浅色系。禁止回潮。
  assert.ok(!/var\(--(border|danger|surface)-color/.test(src), '禁止使用不存在的 --border-color/--danger-color/--surface-color 变量')
  // 主按钮文字色禁止用 --dsw-alias-brand-primary-invert：实测它在浅色主题下与
  // brand-primary 同值（都是 #0f1115 近黑）→ 黑底黑字不可读。正确做法是用
  // bg-layer-1（与主题强调色天然互反）。
  assert.ok(!/rm2-pet-btn-primary\{[^}]*brand-primary-invert/.test(src), '.rm2-pet-btn-primary 禁止使用 brand-primary-invert 作文字色（与底色同值）')
  assert.ok(/rm2-pet-btn-primary\{[^}]*color:var\(--dsw-alias-bg-layer-1/.test(src), '主按钮文字色必须用 bg-layer-1（主题互反）')
  // 主按钮 hover 必须写回主色背景：主按钮元素同时挂 .rm2-pet-btn，
  // .rm2-pet-btn:hover:not(:disabled)（特异度 0,3,0）会压过 .rm2-pet-btn-primary（0,1,0），
  // 把悬浮底色换成浅灰 → 白字浅底撞色。hover 规则必须同特异度写回 brand-primary。
  assert.ok(/rm2-pet-btn-primary:hover:not\(:disabled\)\{background:var\(--dsw-alias-brand-primary/.test(src), '主按钮 hover 必须写回 brand-primary 背景（否则被 .rm2-pet-btn:hover 换成浅灰底 → 撞色）')
})

test('rendered pet-card buttons use the shared classes', () => {
  const data = {
    activePetId: 'remielle',
    pets: [...SAMPLE_DATA.pets, { id: 'spare', name: '备选宠物', enabled: false, available: true, complete: true, previewMood: '01' }],
  }
  const tree = renderTab('pets', { data, config: {} })
  const buttons = []
  walk(tree, (node) => {
    // 假 React 不展开函数组件，RenameButton 内部的按钮只在源码级断言（上一条测试）；
    // 这里断言的是内联在 PetsSection 里的按钮。
    if (nameOf(node.type) === 'button' && typeof node.children?.[0] === 'string') buttons.push({ label: node.children[0], className: node.props?.className || '' })
  })
  const setActive = buttons.find((b) => b.label === '设为当前')
  assert.ok(setActive, '备选宠物应渲染「设为当前」按钮')
  assert.ok(setActive.className.includes('rm2-pet-btn'), '设为当前按钮必须带 rm2-pet-btn 类')
})

test('release notes render as markdown, not plain <pre>', () => {
  // CSS：.rm2-md 排版类必须存在
  assert.ok(src.includes("'.rm2-md p{"), '.rm2-md 排版样式必须注入（release 说明不再是裸 pre）')
  // 更新卡：说明区用 renderMarkdown + rm2-md；更新输出/失败原因保持等宽纯文本（进程日志不是 markdown）
  assert.ok(/renderUpdateCard[\s\S]{0,2200}?className = 'rm2-md'/.test(src), '更新卡说明区必须挂 rm2-md 类并走 renderMarkdown')
  assert.ok(/renderUpdateCard[\s\S]{0,2600}?renderMarkdown\(baseUpdateNotes\(\)\)/.test(src), '更新卡说明必须经 renderMarkdown 渲染')
  assert.ok(/renderUpdateCard[\s\S]{0,3000}?更新输出/.test(src), '更新输出必须保持为独立的纯文本 pre（不得混进 markdown）')
  assert.ok(!/updInfo\.notes\)/.test(src.replace(/renderMarkdown\(updInfo\.notes\)/g, '')), '设置页不得再把 updInfo.notes 当纯文本渲染')
  // 设置页关于 tab：dangerouslySetInnerHTML + renderMarkdown
  assert.ok(/dangerouslySetInnerHTML:\s*\{\s*__html:\s*renderMarkdown\(updInfo\.notes\)/.test(src), '设置页 release 说明必须经 renderMarkdown 渲染')
  // XSS 面收敛：markdown 变换前必须先整体转义（先 escape 后变换的顺序靠 marker 切片单测兜底）
  assert.ok(src.includes('// ---- md render begin ----') && src.includes('// ---- md render end ----'), 'md 渲染函数必须带切片标记（护栏按标记切片做行为单测）')
})

test('renderMarkdown behavior (slice-evaluated from source)', () => {
  const begin = src.indexOf('// ---- md render begin ----')
  const end = src.indexOf('// ---- md render end ----')
  assert.ok(begin !== -1 && end > begin, 'md 渲染切片标记必须成对出现')
  const code = src.slice(begin, end)
  const sandbox = {}
  runInNewContext(code + '; this.__md = { mdEscapeHtml, mdSafeUrl, mdInline, renderMarkdown }', sandbox)
  const { renderMarkdown, mdInline, mdSafeUrl } = sandbox.__md

  // 标题 / 列表 / 粗体 / 行内代码 / 链接
  const html = renderMarkdown('# v0.5.0\n\n## Fixes\n\n- 修复 **撞色** 问题\n- 见 `hover` 规则\n\n1. 第一步\n2. 第二步\n\n[说明](https://github.com/x) 和 ~~废弃~~。')
  assert.ok(html.includes('<h1>v0.5.0</h1>'), '应渲染 h1')
  assert.ok(html.includes('<h2>Fixes</h2>'), '应渲染 h2')
  assert.ok(html.includes('<ul><li>'), '无序列表应渲染成 ul/li')
  assert.ok(html.includes('<ol><li>第一步</li><li>第二步</li></ol>'), '有序列表应渲染成 ol/li')
  assert.ok(html.includes('<strong>撞色</strong>'), '粗体应渲染')
  assert.ok(html.includes('<code>hover</code>'), '行内代码应渲染')
  assert.ok(html.includes('href="https://github.com/x"'), '链接应渲染')
  assert.ok(html.includes('<del>废弃</del>'), '删除线应渲染')

  // XSS：先转义再变换 —— 标签变成字面文本，不产生可执行的元素
  const xss = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](javascript:x)')
  assert.ok(!xss.includes('<script>'), 'HTML 标签必须被转义为字面文本')
  assert.ok(xss.includes('&lt;script&gt;'), '转义后的标签应可见为纯文本')
  assert.ok(!xss.includes('href="javascript:'), 'javascript: 链接必须被拒绝')

  // mdSafeUrl 只放行 http(s)/mailto
  assert.equal(mdSafeUrl('javascript:alert(1)'), '#')
  assert.equal(mdSafeUrl('https://ok.example.com/a'), 'https://ok.example.com/a')
  assert.equal(mdSafeUrl('mailto:a@b.c'), 'mailto:a@b.c')
  assert.ok(mdInline('<b>&</b>').includes('&lt;b&gt;&amp;&lt;/b&gt;'), '行内变换前必须先整体 HTML 转义')

  // 代码块：内容按纯文本转义，不被 markdown 解析
  const code2 = renderMarkdown('```\n**不是粗体** <img>\n```')
  assert.ok(code2.includes('<pre><code>'), '围栏代码块应渲染为 pre>code')
  assert.ok(code2.includes('**不是粗体**') && !code2.includes('<strong>'), '代码块内容不得被 markdown 解析')
  assert.ok(code2.includes('&lt;img&gt;'), '代码块内容必须转义')
})

test('update card live progress wiring (source guards)', () => {
  // 进度端点常量 + 看门狗轮询
  assert.ok(src.includes("var PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'"), '客户端必须定义 update-progress 端点')
  assert.ok(/PROGRESS_ENDPOINT \+ '\?t='/.test(src), '看门狗必须轮询进度端点（与 /info 并行，1s 周期）')
  assert.ok(/fetchJson\(PROGRESS_ENDPOINT[\s\S]{0,1600}?}, 1000\)/.test(src), '看门狗轮询周期必须是 1s（进度行每秒增长）')
  // running 态渲染实时输出尾部 + 已耗时
  assert.ok(src.includes("progPre.className = 'rm2-upd-progress'"), '更新中必须渲染实时输出尾部 pre')
  assert.ok(/progPre = mk\('pre', '[^']*max-height:120px[^']*', '──── 实时输出（自动刷新）/.test(src), '实时输出区高度必须是 120px（用户要求缩小）')
  assert.ok(src.includes('实时输出（自动刷新）'), '实时输出区必须有可辨识标题')
  // 卡片不得被长输出拉长：失败输出与成功输出区都必须限高滚动
  assert.ok(/else if \(lastUpdateError\) \{[\s\S]{0,120}?mk\('pre', '[^']*max-height:120px;overflow:auto/.test(src), '失败输出必须限高 120px 滚动（pnpm 全量日志不得撑长弹窗）')
  assert.ok(/max-height:120px;overflow:auto[^']*', '──── 更新输出 ────/.test(src), '成功输出必须限高 120px 滚动')
  assert.ok(/notesBox = mk\('div', '[^']*max-height:180px/.test(src), 'release 说明区限高 180px')
  assert.ok(src.includes("已进行 ' + elapsedS + ' 秒"), 'running 态必须显示已耗时')
  // 变化检测：输出或秒数没变不重绘，避免卡片重建打断用户滚动
  assert.ok(/key !== lastProgressKey/.test(src), '进度轮询必须做变化检测')
  // 超时错误翻译成简短提示（不展开 pnpm/镜像细节，手动操作走 GitHub 按钮）
  assert.ok(/function friendlyUpdateError/.test(src), '必须存在超时文案翻译函数')
  assert.ok(/\[timeout/.test(src), '翻译函数必须识别宿主超时标记')
  assert.ok(src.includes('手动更新（GitHub）'), '更新弹窗必须常驻「手动更新（GitHub）」按钮')
  // 合并检查只针对更新弹窗区域：设置页「关于」标签的「去 GitHub 查看」是另一界面，保留
  const cardRegion = /function renderUpdateCard[\s\S]*?function openUpdateCard/.exec(src)?.[0]
  assert.ok(cardRegion && cardRegion.includes('手动更新（GitHub）'), '常驻按钮必须在 renderUpdateCard 内')
  assert.ok(cardRegion && !cardRegion.includes('去 GitHub 查看'), '弹窗内「去 GitHub 查看」必须与手动更新按钮合并（避免同跳发布页的两个按钮并存）')
  // 常驻 = 按钮创建在状态分支之外（由 needsCleanReinstall 守卫，不锁进某个 phase）
  assert.ok(/if \(!latestInfo\.needsCleanReinstall\) \{[\s\S]*?var manualBtn/.test(src), '手动更新按钮必须渲染在状态分支之外（常驻）')
  // GitHub 按钮一律跳仓库首页（用户要求，不跳 releases 发布页）
  assert.ok(cardRegion && cardRegion.includes("window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank')"), '手动更新按钮必须跳仓库首页')
  assert.ok(cardRegion && !cardRegion.includes('/releases'), '更新弹窗内不得再跳 releases 发布页')
  // 更新输出是进程日志，保持等宽纯文本，不得被 markdown 化
  assert.ok(!/renderMarkdown\(updateState\.output/.test(src), '更新输出必须保持纯文本 pre')

  // friendlyUpdateError 行为切片：超时给简短解释，普通错误追加一句手动更新建议；
  // pnpm/镜像细节必须从失败提示中移除（Electron 运行时下载文案里的 npmmirror 与此无关，
  // 所以断言只针对本函数切片，不扫全文）
  const fn = /function friendlyUpdateError[\s\S]*?\n\}/.exec(src)?.[0]
  assert.ok(fn, 'friendlyUpdateError 必须可按源码切片')
  assert.ok(!fn.includes('npmmirror'), '失败提示不得再展开镜像方案（已收敛为手动更新 + GitHub 按钮）')
  assert.ok(!fn.includes('pnpm add'), '失败提示不得再展开 pnpm add 指令（已收敛为手动更新 + GitHub 按钮）')
  const sandbox = {}
  runInNewContext(fn + '; this.__f = friendlyUpdateError', sandbox)
  const timedOut = sandbox.__f('resolved 9\n[timeout: no output for 60s — 更新进程疑似挂起]')
  assert.ok(timedOut.includes('网络较慢导致下载超时'), '超时错误必须说明原因')
  assert.ok(timedOut.includes('手动更新'), '超时错误必须建议手动更新')
  assert.ok(!timedOut.includes('续传'), '不得再声称重试可续传（pnpm 不缓存未完成的下载）')
  assert.ok(!timedOut.includes('npmmirror'), '不得再给出镜像方案')
  assert.equal(sandbox.__f('EPERM: resource busy'), 'EPERM: resource busy\n\n💡 建议手动更新。', '普通错误追加一句手动更新建议')
})
