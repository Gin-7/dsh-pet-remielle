/**
 * Build the browser client bundle: wrap src/client.core.js in the web
 * shell's module loader. Sticker GIFs are NOT inlined anymore — the host
 * serves them at /plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif so
 * pets can be added at runtime without rebuilding (see src/pets.js).
 *
 * Run with: node scripts/build-client.mjs  (or `pnpm build:client`)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outFile = resolve(root, 'lib', 'client.js')
const pkgFile = resolve(root, 'package.json')
const pluginId = 'dsh-pet-remielle'

/**
 * 读 src 下的源码段并把行尾归一化成 LF。
 *
 * Windows 上工作区检出的是 CRLF，而 banner / 分隔符 / footer 里的 '\n' 是 LF，
 * 直接拼起来产物的行尾就是 mixed 的——在 git 里会在「全 LF」和「mixed」之间横跳，
 * diff 被行尾噪声淹没。这里统一成 LF，产物行尾单一，交给 .gitattributes 归一化。
 */
const readSrc = (name) => readFileSync(resolve(root, 'src', name), 'utf8').replace(/\r\n/g, '\n')

const core = readSrc('client.core.js')
// 共享的气泡排序逻辑（桌面悬浮窗与网页客户端同一份实现）拼在核心代码之前，
// 使 window.__rm2SessionOrder 在 client.core.js 执行时已就绪。
const order = readSrc('session-order.cjs')
const tip = readSrc('pet-tip.cjs')
// 取 GIF 当前帧（暂停冻结用）：与桌面窗同一份实现，拼在核心代码前
const gifFrame = readSrc('gif-frame.cjs')
// 气泡会话卡的标题节流与状态文案（审批 / 计划待审 / 完成）：与桌面窗同一份实现
const bubbleTitle = readSrc('bubble-title.cjs')
// release 说明的 markdown 渲染（设置页「关于」与更新卡共用）：纯函数，网页端独占
const markdown = readSrc('markdown.cjs')
const { version } = JSON.parse(readFileSync(pkgFile, 'utf8'))
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {
const module = { exports: {} }
const exports = module.exports
const RM_PLUGIN_VERSION = ${JSON.stringify(String(version || '0.0.0'))}
`
const footer = 'return module.exports\n} })'

const output = `${banner}${order}\n${tip}\n${gifFrame}\n${bubbleTitle}\n${markdown}\n${core}\n${footer}\n`

// 拼接顺序护栏：这些共享模块必须排在 client.core.js 之前，否则 core 执行到
// `window.__rm2Xxx` 的消费端时它们还不存在，早失败守卫会抛错、整个宠物模块失效。
//
// 放在构建期而不是单测：顺序错了就直接构建失败（产物根本写不出去），而单测要
// 等下一次 `pnpm test` 才发现，且容易误判成「改了 src 没 build」。下面的
// test/client-interactions.test.js 只负责跑真 bundle，不再重复断言这个顺序。
const mountAt = output.indexOf('function mountPet')
if (mountAt === -1) {
  throw new Error('build-client: client.core.js 里找不到 mountPet，无法校验拼接顺序')
}
for (const marker of ['__rm2SessionOrder', '__rm2PetTip', '__rm2GifFrame', '__rm2BubbleTitle', '__rm2Markdown']) {
  // 锚在「模块把实现挂到 global 上」的那次赋值，而不是裸 marker。裸 marker 在
  // client.core.js 的消费端守卫里同样出现（`if (!__md) throw new Error('__rm2Markdown
  // is missing…')`），indexOf 会先命中 core 内部那处，而它恒在 mountPet 之前——
  // 于是「模块被拼到 core 之后」这种真实的顺序错误反而漏检，构建照常成功，
  // 要到浏览器加载产物时才炸。markdown 的消费端在 core 第 287 行，比 mountPet
  // 早约 800 行，正是这个坑的实例。
  const at = output.indexOf(`global.${marker} = `)
  if (at === -1) throw new Error(`build-client: 产物里找不到 ${marker} 的挂载语句`)
  if (at > mountAt) throw new Error(`build-client: ${marker} 必须拼在 mountPet 之前（当前 ${at} > ${mountAt}）`)
}

writeFileSync(outFile, output)
console.log(`lib/client.js written (${Math.round(Buffer.byteLength(output) / 1024)} KiB)`)
