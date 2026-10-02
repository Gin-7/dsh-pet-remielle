/**
 * 插件配置页（PetsSection）结构护栏。
 *
 * 背景：宠物卡片的「改名」与「状态徽章」曾因 PetsSection 内联手写卡片而
 * 成为死代码（petCard/RenameButton/petBadge 无人调用，README 承诺的改名
 * 在 UI 上消失了几个月）。本文件把配置页的关键结构钉住：
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
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const CORE = new URL('../src/client.core.js', import.meta.url)
const src = readFileSync(CORE, 'utf8')
// client.core.js 顶层要求 window.__rm2Markdown 就位（网页端由 build-client.mjs
// 拼接提供）。这里直接注入共享模块，沙箱跑的是 src 而不是产物，故需手工供上。
const markdown = require('../src/markdown.cjs')

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
    __rm2Markdown: markdown,
    window: { addEventListener() {}, __rm2Markdown: markdown },
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

test('legacy settings fallback keeps the section title (宠物管理)', () => {
  const tree = renderTab('appearance')
  assert.ok(collectStrings(tree).includes('宠物管理'), 'section 标题应与左侧导航 label 一致')
})

test('modern DSH uses the plugin bundle page instead of the built-in plugin tab', () => {
  assert.match(src, /plugins\.bundle\.config/, '必须注册插件详情页配置 slot')
  assert.match(src, /function RemielleBundleConfig\(props\)/, '插件详情页必须有独立渲染入口')
  assert.match(src, /props && props\.view === 'summary'/, '插件详情页必须区分卡片摘要和完整配置页')
  assert.doesNotMatch(src, /settings\.plugins\.tab/, '不得再把可写配置挂在内置插件清单 tab')
  assert.match(src, /hostConfigForms\(ctx\)/, '旧版 DSH 必须保留 settings.section 回退判断')
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

/**
 * 配色护栏。CHANGELOG 记的三个真实 bug（深色下浅色系边框/错误色、主按钮黑底黑字、
 * 主按钮悬浮白字浅底）全都出在 CSS 变量取值上，且没有浏览器就复现不了——所以只能
 * 用源码级断言钉住「不得回潮」。
 *
 * 「控件带统一类名」这条**渲染级**断言（className prop）只证明 JSX 传了类名，
 * 不证明那条 CSS 规则存在——规则没了，按钮照样全绿地退化成浏览器默认样式、改名框
 * 变裸 input。所以下面把 CSS 底座本身也钉住。
 *
 * 改名入口同理：假 React 不展开函数组件，拿不到 RenameButton 内部的事件绑定，
 * 只能源码级断言。此前用的是 [\s\S]{0,900} 字符窗口（挪几行就断），改为按函数
 * 边界切片，没有魔法数字。
 */
test('palette guards: no non-existent CSS vars, primary button readable in both themes', () => {
  // 底座规则：.rm2-pet-btn 是所有设置页按钮的样式来源，.rm2-pet-input 是改名编辑态
  // 输入框的。二者都在 client.core.js 注入的 CSS 数组里。
  assert.ok(src.includes("'.rm2-pet-btn{"), 'CSS 注入数组必须定义 .rm2-pet-btn（带 hover/disabled 态）')
  assert.ok(src.includes("'.rm2-pet-input{"), 'CSS 注入数组必须定义 .rm2-pet-input')
  // 改名入口是「双击名字」，不是一颗独立按钮（README 承诺的交互）
  const renameBody = /function RenameButton[\s\S]*?\n\}/.exec(src)?.[0]
  assert.ok(renameBody, '必须能定位 RenameButton')
  assert.ok(renameBody.includes('onDoubleClick'), '改名入口必须是双击名字（onDoubleClick）')
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

/**
 * release 说明走 markdown 渲染器的接线。
 *
 * 渲染行为本身（标题/列表/链接/XSS 转义顺序/协议白名单）由
 * test/markdown.test.js 对共享模块 src/markdown.cjs 直接断言；这里只钉住调用点。
 * 此前这里还有 4 条字符窗口正则（[\s\S]{0,2200} 等）与一条「先 replace 掉再 grep」
 * 的文本启发式——窗口跨度过大，只要上面多写几行就误报或漏报，已全部移除。
 */
test('release notes render as markdown, not plain <pre>', () => {
  assert.ok(src.includes("'.rm2-md p{"), '.rm2-md 排版样式必须注入（release 说明不再是裸 pre）')
  // 设置页「关于」tab：先转义后插入 innerHTML，不得退回纯文本
  assert.ok(
    /dangerouslySetInnerHTML:\s*\{\s*__html:\s*renderMarkdown\(updInfo\.notes\)/.test(src),
    '设置页 release 说明必须经 renderMarkdown 渲染',
  )
})

/**
 * 更新弹窗的三条产品契约：常驻「手动更新（GitHub）」、跳仓库首页而非 releases、
 * 进程输出保持纯文本（见 CHANGELOG 对应条目）。
 *
 * 只能从源码断言：更新卡的渲染依赖 updateState / latestInfo / updateHandler 的一整套
 * 状态，把它们搭出来比断言本身更容易漂。此前这里还有 20 多条——像素级样式
 * （max-height:120px）、字符窗口正则（[\s\S]{0,1600}）、轮询周期 `}, 1000)`。
 * 样式属手工验收，窗口正则一改版就断，均已移除。
 */
test('update card keeps a permanent manual-update button and never markdown-izes process logs', () => {
  assert.ok(
    src.includes("var PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'"),
    '客户端必须定义 update-progress 端点',
  )
  const cardRegion = /function renderUpdateCard[\s\S]*?function openUpdateCard/.exec(src)?.[0]
  assert.ok(cardRegion, '必须能定位 renderUpdateCard')
  assert.ok(cardRegion.includes('手动更新（GitHub）'), '常驻按钮必须在 renderUpdateCard 内')
  assert.ok(!cardRegion.includes('去 GitHub 查看'), '弹窗内「去 GitHub 查看」必须与手动更新按钮合并（避免同跳发布页的两个按钮并存）')
  // 常驻 = 按钮创建在状态分支之外（由 needsCleanReinstall 守卫，不锁进某个 phase）
  assert.ok(/if \(!latestInfo\.needsCleanReinstall\) \{[\s\S]*?var manualBtn/.test(src), '手动更新按钮必须渲染在状态分支之外（常驻）')
  assert.ok(cardRegion.includes("window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank')"), '手动更新按钮必须跳仓库首页')
  assert.ok(!cardRegion.includes('/releases'), '更新弹窗内不得再跳 releases 发布页')
  // 更新输出是进程日志，保持等宽纯文本，不得被 markdown 化（转义后会被 <p>/<br> 重排）
  assert.ok(!/renderMarkdown\(updateState\.output/.test(src), '更新输出必须保持纯文本 pre')
})

/**
 * 超时文案翻译。pnpm/镜像细节必须从失败提示中移除——用户只关心「网络慢」和
 * 「接下来怎么办」，展开 pnpm add / npmmirror / 续传只会让人更困惑。
 *
 * 按函数名切片后真跑：文案分支多（timeout / 未知错误），grep 覆盖不全，
 * 而切片只依赖函数名不依赖它内部的行号。
 */
test('friendlyUpdateError turns a stalled update into a short actionable hint', () => {
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
