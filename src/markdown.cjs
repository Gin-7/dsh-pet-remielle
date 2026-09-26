/**
 * release 说明的 markdown 渲染器（设置页「关于」tab 与一键更新的更新卡共用）。
 *
 * GitHub release body 是 markdown，原先当纯文本 <pre> 展示，标题/列表/链接全糊成一行。
 * 这里实现一个够用的子集：标题、列表、代码块/行内代码、引用、分隔线、粗斜体、删除线、链接。
 *
 * 安全约定：先整体 HTML 转义再做 markdown 变换（转义后的 &lt; 等不会再被二次解释），
 * 链接目标只放行 http(s)/mailto，其余一律置为 '#'——release body 来自远端，不可信任。
 *
 * 文件用 .cjs：包是 "type":"module"，宿主 ESM 经 createRequire 才能拿到导出；
 * 网页端由 scripts/build-client.mjs 拼在 client.core.js 之前，经 window.__rm2Markdown 取用。
 * 纯函数，无需 DOM 桩即可单测（见 test/markdown.test.js）。
 */
;(function (global) {
  'use strict'

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

  global.__rm2Markdown = {
    mdEscapeHtml: mdEscapeHtml,
    mdSafeUrl: mdSafeUrl,
    mdInline: mdInline,
    renderMarkdown: renderMarkdown,
  }
  // 浏览器 script / 构建拼接里存在 window，不得写 module.exports，否则会盖掉
  // client bundle 的 module.exports。Node require 无 window，可当 CJS 导出。
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2Markdown
  }
})(typeof window !== 'undefined' ? window : globalThis)
