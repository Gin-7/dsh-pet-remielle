/**
 * 桌面 UI 的跨端接线、几何和主题检查，在普通单测中运行一次。
 * Electron 后端及进程生命周期由 test/platform/desktop-window.test.js 验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { cardHeightOf } from './helpers/card-height.mjs'

test('pet-view ships the stacked bubble deck and a single page-switch dot', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 气泡缩放走共享 bubbleZoomOf、planReviewOf 走共享 __order、tip 文案走共享
  // bubble-title.cjs —— 它们的算术与文案分别由 test/pet-tip.test.js、
  // test/session-order.test.js、test/bubble-title.test.js 覆盖，这里只留结构护栏。
  assert.match(html, /SESSION_OPEN_ENDPOINT/)
  assert.doesNotMatch(html, /id="dot1"/, '页切换指示器应是单个 dot，不得回潮成多 id 版本')
  // 气泡卡文案/样式已抽到共享模块 bubble-title.cjs：两端只调用，不再各带一份副本。
  // 文案内容本身由 test/bubble-title.test.js 对纯函数逐条做行为断言（planSummaryOf /
  // tipTextOf），这里只钉结构——共享模块存在、两端确实调用、两端不留副本。
  // （早前这里还有两条 match(shared, /PLAN_MARKER…/) / match(shared, /…点击打开…/) 的
  // 字面量断言，与那份行为断言重复，改名即报红，已删。）
  const shared = readFileSync(new URL('../src/bubble-title.cjs', import.meta.url), 'utf8')
  // 消费端必须加载共享脚本；宿主路由是否注册由 host-transport 的真实路由测试覆盖。
  assert.match(html, /\/plugins\/dsh-pet-remielle\/bubble-title\.js/)
  for (const [name, src] of [['pet-view.html', html], ['client.core.js', readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')]]) {
    assert.match(src, /__bubbleTitle\.applyCardChrome\(/, `${name} 应调用共享的 applyCardChrome`)
    assert.match(src, /__bubbleTitle\.applyBackboardChrome\(/, `${name} 应调用共享的 applyBackboardChrome`)
    assert.doesNotMatch(src, /点击打开同意执行\/要求修改/, `${name} 不得自带计划待审提示副本`)
    // plan-review / approval 类名没有任何 CSS 规则消费，classNameOf 已不再产出它们；
    // 护栏钉住「不回归」：谁再往两端源码里写回 ' plan-review' 字面量，这里会报红。
    // 这里刻意断言字面量而不是某个表达式形状——classNameOf 是共享模块里的
    // `function classNameOf(view, index)` 声明，/classNameOf\s*=\s*'rm2-pet-bubble'\s*+/
    // 那类形状在任何源码里都不存在，断言永远不会失败，看着有覆盖实则零覆盖。
    assert.doesNotMatch(src, /' plan-review'/, `${name} 不得自带 plan-review 类名副本`)
  }
  assert.match(html, /clearPulse:\s*true/)
  // SSE 订阅带 ?client=pet：宿主据此把桌宠窗口排除在 session-action 重放计数之外
  // （与 index.js streamClientOf 的约定一致），否则"无网页在线"判定永远不成立。
  assert.match(html, /\/plugins\/dsh-pet-remielle\/stream\?client=pet/)
  // 桌面窗只展示提醒，不代替后台 DSH 标签页自动已读；完成状态只在该标签页
  // 切回可见、或用户显式点击完成卡时清除。
  assert.doesNotMatch(html, /autoAckedCompletions/)
  assert.doesNotMatch(html, /acknowledgeCompletion\(currentSessionId\)/)
  assert.match(html, /requestSessionOpen\(el\.targetSessionId, el\.completed\)/)
  assert.match(html, /if \(el\.completed\) acknowledgeCompletion\(el\.targetSessionId\)/)
  assert.match(html, /entry\.state === 'ERROR' && targetSessionOf\(entry\) === currentSessionId/)
  // 审批卡悬停提示的文案分支由 test/bubble-title.test.js 覆盖（tipTextOf），
  // 这里只钉住：提示改由自绘浮层承载（原生 title 不随 zoom 缩放已废弃），
  // 以及 tip 模块确实接上了。
  assert.match(html, /id="bubbleDot" title=""/)
  assert.doesNotMatch(html, /切到余额/)
  assert.match(html, /\/plugins\/dsh-pet-remielle\/pet-tip\.js/)
  assert.match(html, /__rm2PetTip/)
  assert.doesNotMatch(html, /允许一次：点击圆形勾号直接确认/)
  // 按住宠物时快照 apply 不得把 grabbing 打回 grab
  assert.match(html, /lockedNow \? 'default' : dragState \? 'grabbing' : 'grab'/)
  // 松手只信 pointerup/cancel + capture，不再用 mousemove 的 buttons 猜测
  assert.match(html, /setPointerCapture\(e\.pointerId\)/)
  assert.match(html, /addEventListener\('pointerup'/)
  assert.match(html, /addEventListener\('pointercancel'/)
  assert.doesNotMatch(html, /e\.buttons & 1/)
  // 二层露出量 = 卡高 − 上移量，两端都必须成立，所以**两端卡高都要钉住**。
  // 卡高真值在 CSS 里（harness stub 的 offsetHeight=68 只是近似值），因此从两端
  // 各自的 CSS 解析，而不是写死 91——写死的话改 CSS 后断言照绿，两端却已漂移。
  // 解析函数放在 test/helpers/card-height.mjs：两端各有一份 CSS 规则，各写一遍正则
  // 必然漂移。
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const liftOf = (src) => Number(/STACK_LIFT_PX = (\d+)/.exec(src)?.[1])
  assert.equal(liftOf(shared), 80)
  assert.doesNotMatch(html, /STACK_LIFT_PX = \d+/, 'pet-view.html 不得再自带上移量常量')
  assert.doesNotMatch(core, /STACK_LIFT_PX = \d+/, 'client.core.js 不得再自带上移量常量')
  assert.equal(cardHeightOf(html, 'pet-view.html'), 91, '桌面端卡高')
  assert.equal(cardHeightOf(core, 'client.core.js'), 91, '网页端卡高')
  // 假背板分支 + 三元式分支两处上移都必须引用常量、不得写死数值。
  const calls = [...shared.matchAll(/style\.marginTop = [^\n]*/g)].map((match) => match[0])
  assert.equal(calls.length, 2, '共享模块应有两处 marginTop 调用点')
  for (const call of calls) {
    assert.match(call, /STACK_LIFT_PX/, `调用点必须引用常量：${call}`)
    assert.doesNotMatch(call, /'-\d+px'/, `调用点不得写死上移量：${call}`)
  }
})

test('desktop idle-bubble click defers to an open web client but says so', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 有网页在线时不重复调 openExternal（浏览器不会复用已有标签，只会越堆越多）；
  // webClients 来自宿主快照的 SSE 订阅计数。
  assert.match(html, /if \(!\(lastSnapshot && lastSnapshot\.webClients > 0\)\) __tip\.openIdleDshPage\(window\.petBridge\)/)
  // 但「不打开」不等于「不响应」。原先这条路径直接 return，点击完全静默，用户分不清
  // 是卡住了还是被拦下了。必须给一句说明去哪儿看——这条判据本身还有已知缺口
  // （Chromium 的 tab discarding 会冻结后台标签页，SSE 连接不 close，订阅计数虚高），
  // 正是因为那个缺口会让用户看到「点了没反应」，提示才更不能少。
  assert.match(html, /else showTransientTip\(el\.node, /)
  assert.match(html, /function showTransientTip\(anchor, text, ms\)/, '一次性提示的辅助函数必须存在')
  // 提示用完要还原，否则会污染该卡后续的悬停 tooltip。
  assert.match(html, /if \(had\) anchor\.dataset\.rm2Tip = prev/)
  assert.match(html, /else delete anchor\.dataset\.rm2Tip/)
})

test('pet-view menu expands to the work-area box and restores on close', () => {
  // 打开菜单先离屏测量再定位：扩窗 ipc 往返期间菜单不能闪现在 fixed 默认位置。
  // 落点计算（锚角色 / 包围盒 / MENU_GLOW / 400×520 锚框）是 pet-view.html 的内部
  // 几何，随 Chromium 版与缩放口径变，不适合当断言对象。这里只钉住「主进程这一侧真的接得住」
  // ——渲染层与 preload 那一侧由 test/pet-preload.test.js 用 vm 注入假 electron 真调方法验证
  // （通道名 + 参数归一化 + promise 返回），比匹配源码字符串更强，故不再重复断言那三条。
  const petWindow = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.match(petWindow, /ipcMain\.handle\('get-work-area'/)
  assert.match(petWindow, /ipcMain\.handle\('menu-expand', async \(_event, cssLeft, cssTop, cssRight, cssBottom\)/)
  assert.match(petWindow, /ipcMain\.handle\('menu-restore'/)
  // 扩窗必须真的把窗口变大且可缩放，否则菜单定位算对了也会被窗口边界裁掉
  assert.match(petWindow, /setResizable\(true\)/)
  assert.match(petWindow, /setContentBounds\(bounds\)/)
  // uiZoom 注入：渲染层按缩放系数算坐标，主进程必须把同一个值下发
  assert.match(petWindow, /insertCSS\(`:root\{--rm2-ui-zoom:/)
})

// 位置持久化链路（issue #21）：三段各自的钥匙必须同时在场——
// 主进程建窗定位 + 渲染层拖动结束回写 + preload 通道；缺一段记忆就断。
test('pet window position persistence is wired across main, preload and renderer', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 恢复钳制必须是「虚拟桌面并集 + 最小可见边条」而不是单屏 workArea 整窗
  // 钳制：宠物图贴窗口底部，拖到屏幕顶缘时窗口必然部分伸出屏幕外（实测
  // y=-381），整窗钳制会把它拽回 y=0，表现为位置没记忆（issue #21 追加）。
  assert.match(main, /for \(const d of screen\.getAllDisplays\(\)\)/)
  assert.match(main, /ipcMain\.handle\('get-initial-position', \(\) => persistedPos\)/)
  // 主进程兜底回写（issue #21 "有时不记忆"）：drag-end IPC 是渲染层唯一必然
  // 发出的时点，主进程在此直接 PATCH 宿主 config，渲染层 fetch 失手也有兜底。
  // 但必须以「真实拖动」（drag 非空）为前提：渲染层对任何左键抬起都发
  // drag-end，菜单贴右扩窗会左移 x，无条件回写会把扩窗坐标存档（表现为
  // y 记忆而 x 丢失，issue #21 追加反馈）。
  assert.match(main, /const wasDragging = drag !== null/)
  assert.match(main, /if \(wasDragging\) persistPosition\(\)/)
  assert.match(main, /desktopX: Math\.round\(x\), desktopY: Math\.round\(y\)/)
  // DSH Desktop 渲染进程准入头：宿主 env 提供头名/值时，主进程必须在建窗前
  // 给同源请求自注入（否则 DSH Desktop 未开「浏览器访问」时全部 403 forbidden）。
  assert.match(main, /session\.defaultSession\.webRequest\.onBeforeSendHeaders/)
  // preload：两条 IPC 通道都暴露给渲染层
  assert.match(preload, /getInitialPosition: \(\) => ipcRenderer\.invoke\('get-initial-position'\)/)
  assert.match(preload, /getPosition: \(\) => ipcRenderer\.invoke\('get-position'\)/)
  // 渲染层：拖动结束才回写（moved 且未锁定），位置以宿主坐标为准
  assert.match(html, /dragState && dragState\.moved && !lockedNow/)
  assert.match(html, /desktopX: pos\.x, desktopY: pos\.y/)
})

// pet-window 的 userData 目录（issue #21 追加建议）：原实现落在 %TEMP%，会被
// 系统磁盘清理整目录删掉（Electron 缓存 + 渲染层 localStorage 位置兜底一起丢）；
// 直接与宿主共用默认的 %APPDATA%/Electron 又会锁住磁盘缓存、服务到陈旧响应。
// 现改用稳定目录 + 占用标记，稳定目录被活跃实例占用时退避到带 pid 的兄弟目录。
// 决策细节由 test/pet-window-paths.test.js 覆盖，这里钉住主进程真的把这条
// 链路接上了 —— 也钉住「宿主看门狗」的判据与间隔，它是重叠窗口的另一半。
test('pet window userData is stable, host-isolated and held by one instance at a time', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /getPath\('temp'\)/, 'userData 不得再落在 %TEMP%')
  assert.match(main, /require\('\.\/pet-window-paths\.cjs'\)/, '选目录逻辑必须走共享模块')
  assert.match(main, /app\.setPath\('userData', userData\.dir\)/, '主进程必须真的把选定的目录设成 userData')
  // 宿主看门狗：ESRCH 才算宿主没了（EPERM = 进程仍在，当成「已退」会让桌面窗
  // 自己消失），轮询 1000ms —— 宿主退出后窗口最多滞留 1 秒。
  assert.match(main, /return Boolean\(error && error\.code === 'ESRCH'\)/)
  assert.match(main, /\}, 1000\)/)
  assert.doesNotMatch(main, /\}, 3000\)/, '看门狗间隔不应回到 3000ms')
})

// 右键菜单两端必须同骨架、**同顺序**、同名、同写入目标。
// 历史病：曾经网页端只有「暂停动画 / 重置位置 / 桌面悬浮模式」，桌面端只有
// 「画画 / 用量模式 / 切换到网页模式」——同一份配置在两端显示不同名字。也曾经
// 只改一端的几何/条目而另一端点没跟着改，没人发现（改动只落在一端）。
// 所以这里做三层断言，任一层破即报红：
//   ① 条目与顺序相等（不只是同一堆条目的集合）
//   ② 每项写回的配置键相同（同名条目改同一份配置，避免一端写 A 另一端写 B）
//   ③ 关键项的写入目标逐个钉死（否则两端一起写错也算“一致”）
test('in-page and desktop right-click menus keep the same rows, order and write targets', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')

  // 菜单是 IIFE 闭包，只能按相邻函数名切片取菜单构造函数体。边界失效会当场
  // 抛错（而不是静默返回空数组让后面的断言假通过）。
  const slice = (src, from, to) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a + 1)
    assert.ok(a >= 0 && b > a, `菜单切片失败，测试边界名需随源码更新：${from} .. ${to}`)
    return src.slice(a, b)
  }
  const webBody = slice(core, 'function buildMenuContent()', 'function menuBoxOf(')
  const deskBody = slice(html, 'function buildMenu() {', 'function menuBoxOf(')

  // 条目的构造函数：网页端 makeToggleRow/makeActionRow/makeSliderRow，桌面端
  // menuRow/menuSliderRow。状态行文案是动态拼接的，不属于条目。
  const WEB_ROW = /(?:makeToggleRow|makeActionRow|makeSliderRow)\(\s*'([^']+)'/g
  const DESK_ROW = /(?:menuRow|menuSliderRow)\(\s*'([^']+)'/g
  const rowsOf = (body, re) => [...body.matchAll(re)].map((m) => m[1])

  // 条目、顺序、写回的配置键全部由这一张表表达。原先条目名散在 EXPECTED、
  // 写回对比和逐项钉死里各写 2~3 遍，改一个菜单项要同步改三处；现在只改这里。
  //
  // keys 为空表示「菜单构造里不写配置」——「画画」「重置位置」的写在各自的动作
  // 函数里（playDraw / resetPos / 关窗），两端一致地不写，这里一并钉住防止以后
  // 一端偷偷改成直接写配置。
  const MENU = [
    { label: '角色大小', keys: ['scale'] },
    { label: '透明度', keys: ['opacity'] },
    { label: '左右镜像', keys: ['mirror'] },
    { label: '锁定位置', keys: ['locked'] },
    { label: '暂停动画', keys: ['paused'] },
    { label: '显示气泡', keys: ['showBubble', 'showBubbleStatus', 'showBubbleUsage'] },
    { label: '画画', keys: [] },
    { label: '重置位置', keys: [] },
    { label: '桌面悬浮模式', keys: ['desktopMode'] },
  ]

  // ① 条目与顺序：两端都必须与表一致（不只是同一堆条目，是同一顺序）
  const labels = MENU.map((row) => row.label)
  assert.deepEqual(rowsOf(webBody, WEB_ROW), labels, '网页端右键菜单条目/顺序与约定不符')
  assert.deepEqual(rowsOf(deskBody, DESK_ROW), labels, '桌面端右键菜单条目/顺序与约定不符')

  // 每项写回的配置键：网页端写 patchConfig('x', v) / patchConfigFields({ x: v })，
  // 桌面端写 patchConfig({ x: v })，「显示气泡」另用 body.x = ... 追加两个子开关。
  // 取「本条目的标签到下一个条目标签」之间的片段来判定，两端因此可比。
  const writesOf = (body, re) => {
    const rowLabels = rowsOf(body, re)
    const marks = [...body.matchAll(re)].map((m) => m.index)
    const keys = marks.map((at, i) => {
      const chunk = body.slice(at, i + 1 < marks.length ? marks[i + 1] : body.length)
      const found = new Set()
      for (const m of chunk.matchAll(/patchConfig(?:Fields)?\(\s*'([A-Za-z]+)'/g)) found.add(m[1])
      for (const m of chunk.matchAll(/patchConfig(?:Fields)?\(\s*\{([\s\S]*?)\}/g)) {
        for (const k of m[1].matchAll(/([A-Za-z]+)\s*:/g)) found.add(k[1])
      }
      for (const m of chunk.matchAll(/body = \{([\s\S]*?)\}/g)) {
        for (const k of m[1].matchAll(/([A-Za-z]+)\s*:/g)) found.add(k[1])
      }
      for (const m of chunk.matchAll(/\bbody\.([A-Za-z]+)\s*=/g)) found.add(m[1])
      return [...found].sort()
    })
    return Object.fromEntries(rowLabels.map((l, i) => [l, keys[i]]))
  }
  const webWrites = writesOf(webBody, WEB_ROW)
  const deskWrites = writesOf(deskBody, DESK_ROW)

  // ② + ③ 一次循环同时钉住：两端写回同一组键、且就是约定的那组。
  // 分开写「两端一致」与「等于约定」两条断言会漏掉「两端一起写错」——
  // 而那正是历史上出过的 bug（同名条目一端写 A 一端写 B）。
  for (const { label, keys } of MENU) {
    assert.deepEqual(webWrites[label], keys, `网页端「${label}」写回的配置键`)
    assert.deepEqual(deskWrites[label], keys, `桌面端「${label}」写回的配置键`)
  }

  // 判定为「只留设置页」的项不得回流到任一端菜单
  assert.doesNotMatch(core, /Row\('用量模式'/)
  assert.doesNotMatch(html, /menuRow\('用量模式'|menuRow\('切换到网页模式'/)
})

// 「重置位置」必须同时覆盖页面内坐标与桌面窗坐标，并在桌面端清掉渲染层
// localStorage 兜底存档——否则下次启动渲染层会拿旧存档 moveTo，把重置撤销。
test('reset position covers both position stores and clears the localStorage fallback', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const ALL_FOUR = /\{\s*posX: null,\s*posY: null,\s*desktopX: null,\s*desktopY: null\s*\}/
  assert.match(core, ALL_FOUR, '网页端「重置位置」应清空四个坐标')
  // 设置页那枚「重置位置」按钮曾经误打 /desktop/start，按下去反而拉起桌面窗
  assert.doesNotMatch(core, /DESKTOP_ENDPOINT \+ '\/start'/)
  assert.match(html, /localStorage\.removeItem\('dsh-pet-window-pos'\)/)
  assert.match(html, /window\.petBridge\.resetPosition\(\)/)
  assert.match(preload, /resetPosition: \(\) => ipcRenderer\.invoke\('reset-position'\)/)
  assert.match(main, /ipcMain\.handle\('reset-position'/)
  assert.match(main, ALL_FOUR)
  // 菜单仍开着时点重置：必须先作废 menuBase，否则 closeMenu → menu-restore
  // 会按它把窗口搬回重置前的位置
  assert.match(main, /ipcMain\.handle\('reset-position'[\s\S]{0,200}menuBase = null/)
})

// 暂停必须停在「当前帧」。canvas.drawImage(动态 GIF) 在 Chromium 里永远只画首帧
// （vendor/electron-win32-x64 实测：20 次采样跨 462ms 签名完全一致，且等于第 0 帧），
// 所以两端都要走 gif-frame 的取帧链路，并且保留首帧兜底（非安全上下文没有 ImageDecoder）。
test('pause freezes on the current frame through the shared gif-frame helper', () => {
  // 取帧算术本身由 test/gif-frame.test.js 覆盖；这里只钉住「两端真的接上了
  // 这条链路」与「宿主把脚本发得出去」，不重复验证实现细节。
  for (const [name, file] of [
    ['网页端', '../src/client.core.js'],
    ['桌面端', '../src/pet-view.html'],
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, /__gifFrame\.isGif\(/, `${name}应只在 GIF 上走取帧链路`)
    assert.match(src, /__gifFrame\.freeze\(/, `${name}应调用 freeze 取当前帧`)
  }
  // 桌面端必须有脚本标签、宿主必须把这份脚本发出去，否则整条取帧链路静默失效
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(html, /\/plugins\/dsh-pet-remielle\/gif-frame\.js/)
  assert.match(index, /'\/plugins\/dsh-pet-remielle\/gif-frame\.js'/)
})

/**
 * 两端深色配色必须由同一个来源触发。桌面悬浮窗是独立 Electron 窗口，读不到宿主
 * 页面的 body[data-ds-dark-theme]，只能吃网页端上报的 hostTheme——没有这条链路时
 * 它跟系统主题走，「系统深色 + DSH 浅色主题」就成了两端菜单/气泡不同色的最常见场景。
 */
function desktopThemeOf(theme, systemDark) {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const block = html.match(/var systemDarkQuery = [\s\S]*?^\s*syncHostTheme\(''\)/m)
  assert.ok(block, 'missing syncHostTheme block in pet-view.html')
  const attrs = {}
  vm.runInNewContext(`${block[0]}\nsyncHostTheme(${JSON.stringify(theme)})`, {
    document: { documentElement: { setAttribute: (key, value) => { attrs[key] = value } } },
    window: { matchMedia: () => ({ matches: systemDark, addEventListener() {} }) },
  })
  return attrs['data-host-theme']
}

test('desktop pet view takes dark from the host report and falls back to the system', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // 深色规则只认属性，不许再用 prefers-color-scheme 媒体查询：媒体查询与属性同时
  // 命中时谁赢取决于源顺序，两套规则同时存在就等于把配色交给规则顺序去掷骰子。
  assert.equal(
    /@media\s*\(prefers-color-scheme:\s*dark\)/.test(html),
    false,
    'pet-view.html 不应再用深色媒体查询（改用 html[data-host-theme]，由 syncHostTheme 折算）',
  )
  for (const selector of ['.menu', '.rm2-pet-bubble', '.rm2-pet-tip', '.rm2-pet-toast']) {
    assert.ok(
      html.includes(`html[data-host-theme="dark"] ${selector} {`),
      `${selector} 缺少深色规则（应写成 html[data-host-theme="dark"] ${selector} { … }）`,
    )
  }
  // 快照字段是桌面窗唯一的宿主主题来源；离开这条 link 上面的样式就永远挂不上
  assert.match(html, /syncHostTheme\(snapshot\.hostTheme\)/)

  // 真实执行抽取出的折算逻辑：宿主上报优先，没有上报（字段缺失/空串）才看系统偏好
  assert.equal(desktopThemeOf('dark', false), 'dark', '宿主深色时不该被系统浅色翻回')
  assert.equal(desktopThemeOf('light', true), 'light', '宿主浅色时不该被系统深色翻回')
  assert.equal(desktopThemeOf('', true), 'dark', '未上报时应回落系统深色')
  assert.equal(desktopThemeOf('', false), 'light')
  assert.equal(desktopThemeOf(undefined, true), 'dark', '字段缺失（无网页在线）应回落系统深色')
  assert.equal(desktopThemeOf('Dark', true), 'dark', '非法值视为未上报')
})

// 宿主侧的存储 / 清理 / TTL / 拒绝坏值已由 test/host-transport.test.js 的
// 「theme uplink」与「snapshot carries reported host theme」以行为方式覆盖，
// 这里只钉住网页端独有的三件事。
test('host theme uplink is wired end to end between web client and host', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  // 端点必须与宿主导出的 THEME_ENDPOINT 同名
  assert.match(core, /var THEME_ENDPOINT = '\/plugins\/dsh-pet-remielle\/theme'/)
  // 宿主主题切换 = body 上 data-ds-dark-theme 的增删，必须监听属性变化而不是只在启动读一次
  assert.match(core, /attributeFilter: \['data-ds-dark-theme'\]/)
  // 网页关闭后清空上报，桌面窗回落系统主题
  assert.match(core, /function clearReportedHostTheme\(\)/)
})
