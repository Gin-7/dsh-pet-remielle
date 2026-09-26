/**
 * release 说明的 markdown 渲染器（src/markdown.cjs）行为单测。
 *
 * 这段实现原先内联在 client.core.js 里，单测只能按 `// ---- md render begin ----`
 * 标记把源码切出来、丢进 vm 求值——测试挂在「源码长什么样」上，标记一改就断。
 * 抽成独立 .cjs 后直接 require，断言一条未减。
 *
 * 安全面是本文件重点：release body 来自 GitHub 远端，不可信任，
 * 因此「先整体 HTML 转义、再做 markdown 变换」的顺序与链接协议白名单
 * 必须由行为断言钉住，不能只靠代码评审。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { mdEscapeHtml, mdInline, mdSafeUrl, renderMarkdown } = require('../src/markdown.cjs')

test('block syntax: headings, lists, quote, rule and paragraphs', () => {
  const html = renderMarkdown('# v0.5.0\n\n## Fixes\n\n- 修复 **撞色** 问题\n- 见 `hover` 规则\n\n1. 第一步\n2. 第二步\n\n> 提示\n\n---\n\n正文一行\n正文二行')
  assert.ok(html.includes('<h1>v0.5.0</h1>'), '应渲染 h1')
  assert.ok(html.includes('<h2>Fixes</h2>'), '应渲染 h2')
  assert.ok(html.includes('<ul><li>'), '无序列表应渲染成 ul/li')
  assert.ok(html.includes('<ol><li>第一步</li><li>第二步</li></ol>'), '有序列表应渲染成 ol/li')
  assert.ok(html.includes('<strong>撞色</strong>'), '粗体应渲染')
  assert.ok(html.includes('<code>hover</code>'), '行内代码应渲染')
  assert.ok(html.includes('<blockquote>提示</blockquote>'), '引用应渲染')
  assert.ok(html.includes('<hr>'), '分隔线应渲染')
  // 段内换行是软换行 → <br>，空行才是分段
  assert.ok(html.includes('<p>正文一行<br>正文二行</p>'), '段内单换行应折成 <br>，空行分段')
  // 列表类型切换必须闭合上一个列表，不能出现 <ul>…<ol> 嵌套
  assert.ok(!/<ul>[^<]*<ol>/.test(html.replace(/<li>[^<]*<\/li>/g, '')), '列表类型切换时必须先闭合前一个列表')
})

test('inline emphasis: bold / italic / strikethrough do not eat each other', () => {
  assert.ok(mdInline('**粗**').includes('<strong>粗</strong>'), '粗体')
  assert.ok(mdInline('*斜*').includes('<em>斜</em>'), '斜体')
  assert.ok(mdInline('~~删~~').includes('<del>删</del>'), '删除线')
  // ** 加粗不应被先执行的 * 斜体规则吃掉
  assert.ok(mdInline('**粗**尾').includes('<strong>粗</strong>尾'), '**…** 必须整体成对，不能被单星规则拆开')
})

test('fenced code block content is escaped and never parsed as markdown', () => {
  const code = renderMarkdown('```\n**不是粗体** <img>\n```')
  assert.ok(code.includes('<pre><code>'), '围栏代码块应渲染为 pre>code')
  assert.ok(code.includes('**不是粗体**') && !code.includes('<strong>'), '代码块内容不得被 markdown 解析')
  assert.ok(code.includes('&lt;img&gt;'), '代码块内容必须转义')
  // 未闭合的围栏：文件末尾仍要闭合标签
  assert.ok(renderMarkdown('```\n未闭合').endsWith('</code></pre>'), '未闭合围栏必须在结尾补齐')
})

test('XSS: escape happens before every markdown transform', () => {
  const xss = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](javascript:x)')
  assert.ok(!xss.includes('<script>'), 'HTML 标签必须被转义为字面文本')
  assert.ok(xss.includes('&lt;script&gt;'), '转义后的标签应可见为纯文本')
  assert.ok(!xss.includes('href="javascript:'), 'javascript: 链接必须被拒绝')
  assert.ok(mdInline('<b>&</b>').includes('&lt;b&gt;&amp;&lt;/b&gt;'), '行内变换前必须先整体 HTML 转义')
  // 转义顺序错了就会出现 "&lt;script&gt;" 被后续规则当标签重新解释的机会
  assert.equal(mdEscapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', '实体与引号必须一并转义')
})

test('mdSafeUrl only allows http(s) and mailto', () => {
  assert.equal(mdSafeUrl('javascript:alert(1)'), '#')
  assert.equal(mdSafeUrl('data:text/html,<script>'), '#')
  assert.equal(mdSafeUrl('  https://ok.example.com/a  '), 'https://ok.example.com/a', '两端空白应先 trim')
  assert.equal(mdSafeUrl('https://ok.example.com/a'), 'https://ok.example.com/a')
  assert.equal(mdSafeUrl('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(mdSafeUrl('HTTPS://OK.EXAMPLE.COM/A'), 'HTTPS://OK.EXAMPLE.COM/A', '协议判定应大小写不敏感')
  assert.equal(mdSafeUrl('https://a.com/"onload="x'), 'https://a.com/%22onload=%22x', 'URL 内的引号必须百分号转义，否则能逃出属性')
  assert.equal(mdSafeUrl(''), '#')
  assert.equal(mdSafeUrl(null), '#')
})

test('rendered links are rel-protected', () => {
  const html = renderMarkdown('[点我](https://github.com/x)')
  assert.ok(html.includes('target="_blank"'), '外链应新开页')
  assert.ok(html.includes('rel="noopener noreferrer"'), '外链必须带 noopener noreferrer，否则目标页能反向操纵本页')
})

test('empty and non-string input degrade instead of throwing', () => {
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown(null), '')
  assert.equal(renderMarkdown(undefined), '')
  // 入口是 String(src || '')：0 这类 falsy 非字符串一并退化成空串，不抛错即可。
  // 调用方 baseUpdateNotes() 本来就只传字符串。
  assert.equal(renderMarkdown(0), '')
  assert.equal(renderMarkdown(12.5), '<p>12.5</p>', '真值非字符串应按字符串渲染')
})
