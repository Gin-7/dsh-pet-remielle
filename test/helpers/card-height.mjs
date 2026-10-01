/**
 * 牌叠卡片的真实高度来自 CSS：测试 stub 的 offsetHeight 只是近似值，不能当卡高用。
 * 网页端写在 client.core.js 的内联 CSS 字符串里，桌面端写在 pet-view.html 的
 * <style> 里，两端各写一份正则必然漂移，所以放在这里共用。
 *
 * min-height 的坑：CSS 规则里通常写成 `height:91px;min-height:91px`，而浏览器在
 * 两者不一致时按 max(height, min-height) 渲染。只用 /(?<!-)height:/ 匹配（负向后顾
 * 跳过 min-height）的话，改了 height 改不动、或者只改 min-height，断言都会照绿——
 * 而真实卡高已经变了。所以这里两个都取，不一致直接报错：声明不一致本身就可疑，
 * 不该让测试挑一个信。
 */

/** 从一段源码里取出 `.rm2-pet-bubbles .rm2-pet-bubble` 规则的声明体。 */
function bubbleRule(src) {
  return /\.rm2-pet-bubbles \.rm2-pet-bubble\s*\{[^}]*\}/.exec(src)?.[0] ?? ''
}

function pxOf(rule, prop) {
  return Number(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(rule)?.[1])
}

export function cardHeightOf(src, where = '') {
  const rule = bubbleRule(src)
  const at = where ? `（${where}）` : ''
  const height = pxOf(rule, 'height')
  const minHeight = pxOf(rule, 'min-height')
  if (!Number.isFinite(height) && !Number.isFinite(minHeight)) {
    throw new Error(`cardHeightOf${at}: 找不到 .rm2-pet-bubbles .rm2-pet-bubble 的 height/min-height`)
  }
  if (Number.isFinite(height) && Number.isFinite(minHeight) && height !== minHeight) {
    throw new Error(
      `cardHeightOf${at}: 卡高声明不一致——height=${height}px 但 min-height=${minHeight}px，` +
      '浏览器按两者较大值渲染，断言不能只挑一个',
    )
  }
  return Number.isFinite(minHeight) ? minHeight : height
}
