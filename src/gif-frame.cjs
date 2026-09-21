/**
 * 取动态 GIF「此刻正在显示的那一帧」——右键菜单的「暂停动画」用它把宠物冻在
 * 点下去那一刻的造型，而不是永远弹回首帧。
 *
 * 为什么需要这个文件：Chromium 的 canvas.drawImage(<img src=动图>) 永远只画首帧。
 * 本地实测（vendor/electron-win32-x64，360x360 / 120 帧的贴纸 06.gif）：
 * 20 次采样跨 462ms、覆盖 7 个完整循环，像素签名完全一致，且等于 ImageDecoder
 * 的第 0 帧。旧实现暂停后宠物会瞬间跳回起始造型，就是这个原因。
 *
 * 解法走 WebCodecs 的 ImageDecoder：读每帧时长 → 按「已播放毫秒数」定位帧号 →
 * 按需解码那一帧（disposal / 局部帧由浏览器合成，结果与屏幕上一致）→ 画成静态 PNG。
 * 它要求安全上下文：127.0.0.1、localhost、https 都算，纯 http 的局域网地址不算。
 * 不可用时 freeze() 返回 null，调用方回退成首帧快照（旧行为）——暂停开关本身
 * 不会失效，只是冻结的造型不精确。
 *
 * 文件用 .cjs：包是 "type":"module"，宿主 ESM 经 createRequire 才能拿到导出。
 * 对外 URL 仍是 gif-frame.js（浏览器 script 不认 .cjs 扩展语义）；
 * 网页端则由 scripts/build-client.mjs 直接拼进 lib/client.js。
 */
;(function (global) {
  'use strict'

  /** 帧时长总和（毫秒）。非法/非正时长按 0 计。 */
  function totalDuration(durations) {
    var total = 0
    if (!durations) return 0
    for (var i = 0; i < durations.length; i++) {
      var d = Number(durations[i])
      if (isFinite(d) && d > 0) total += d
    }
    return total
  }

  /**
   * 已播放 elapsed 毫秒时，GIF 正在显示第几帧。
   * elapsed 可以任意大或为负：按整轮时长取模（GIF 循环播放）。取不了帧时返回 0。
   */
  function indexAt(durations, elapsed) {
    var n = durations ? durations.length : 0
    if (!n) return 0
    var total = totalDuration(durations)
    if (!(total > 0)) return 0
    var t = Number(elapsed)
    if (!isFinite(t)) t = 0
    t = t % total
    if (t < 0) t += total
    var acc = 0
    for (var i = 0; i < n; i++) {
      var d = Number(durations[i])
      if (!isFinite(d) || d <= 0) continue
      acc += d
      if (t < acc) return i
    }
    return n - 1
  }

  /** 只对 GIF 走解码取帧；PNG 贴纸（画画）原样交给调用方的首帧快照兜底。 */
  function isGif(url) {
    return /\.gif(?:[?#]|$)/i.test(String(url || ''))
  }

  function now() {
    if (global.performance && typeof global.performance.now === 'function') return global.performance.now()
    return Date.now()
  }

  /** ImageDecoder 需要安全上下文；缺任何一项就整条链路让位给首帧兜底。 */
  function supported() {
    return typeof global.ImageDecoder === 'function'
      && typeof global.fetch === 'function'
      && !!global.document
  }

  /**
   * 给 <img> 挂动画起表：GIF 的播放进度从「首帧解码完成并绘制」开始算，
   * load 事件正好落在那个时刻之后（这些贴纸每帧 30ms，误差 ≤ 1 帧），
   * 所以直接用 load 时刻当 0 点。每次换 src 都会重新起表。
   */
  function watch(img) {
    if (!img || img.__rm2GifWatch || typeof img.addEventListener !== 'function') return
    img.__rm2GifWatch = true
    img.__rm2GifStart = 0
    img.addEventListener('load', function () {
      img.__rm2GifStart = now()
    })
  }

  /** 该 <img> 当前这张图已经播放了多久（毫秒）。没起过表返回 0 → 等价首帧。 */
  function livedMs(img) {
    var t0 = img && img.__rm2GifStart
    if (!t0) return 0
    return Math.max(0, now() - t0)
  }

  var entries = new Map() // url -> { bytes, promise }
  var MAX_ENTRIES = 3 // 贴纸单张 0.5–2.5MB，只留最近用过的几张

  function trim() {
    while (entries.size > MAX_ENTRIES) {
      var oldest = entries.keys().next()
      if (oldest.done) return
      entries.delete(oldest.value)
    }
  }

  function fetchBytes(url) {
    return global.fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.arrayBuffer()
    })
  }

  /** 逐个解码读时长：只需要数字，读一帧关一帧，不驻留 VideoFrame。 */
  function readDurations(buf) {
    var dec = new global.ImageDecoder({ data: buf, type: 'image/gif' })
    return dec.completed
      .then(function () { return dec.tracks.ready })
      .then(function () {
        var track = dec.tracks.selectedTrack
        var n = (track && track.frameCount) || 0
        var durations = []
        var chain = Promise.resolve()
        for (var i = 0; i < n; i++) chain = stepDuration(chain, dec, durations, i)
        return chain.then(function () {
          try { dec.close() } catch (e) { /* already closed */ }
          if (!durations.length) return null
          return {
            durations: durations,
            total: totalDuration(durations),
            width: (track && track.codedWidth) || 0,
            height: (track && track.codedHeight) || 0,
          }
        })
      })
  }

  function stepDuration(chain, dec, out, index) {
    return chain.then(function () {
      return dec.decode({ frameIndex: index }).then(function (res) {
        out.push(res.image.duration / 1000) // 微秒 -> 毫秒
        res.image.close()
      })
    })
  }

  /**
   * 帧表（含字节缓存）：菜单 hover 时就可以先 warm()，把解帧表的几百毫秒藏到
   * 用户移动到菜单项的那点时间里，点下去基本立刻能冻结。
   * 失败也会被缓存为 null，避免每次暂停都重跑一遍解码。
   */
  function timeline(url) {
    if (!supported() || !isGif(url)) return Promise.resolve(null)
    var hit = entries.get(url)
    if (hit) return hit.promise
    var entry = { bytes: null, promise: null }
    entry.promise = fetchBytes(url).then(function (buf) {
      entry.bytes = buf
      return readDurations(buf)
    }).catch(function () { return null })
    entries.set(url, entry)
    trim()
    return entry.promise
  }

  function warm(url) {
    return timeline(url).catch(function () { return null })
  }

  /** 解出指定帧并转成 PNG data URL（尺寸取 GIF 逻辑屏幕，避免局部帧被裁小）。 */
  function frameDataUrl(url, index, size) {
    var entry = entries.get(url)
    var bytes = entry && entry.bytes
      ? Promise.resolve(entry.bytes)
      : fetchBytes(url).then(function (buf) {
        if (entry) entry.bytes = buf
        return buf
      })
    return bytes.then(function (buf) {
      var dec = new global.ImageDecoder({ data: buf, type: 'image/gif' })
      return dec.completed
        .then(function () { return dec.decode({ frameIndex: index }) })
        .then(function (res) {
          var frame = res.image
          var w = (size && size.width) || frame.displayWidth
          var h = (size && size.height) || frame.displayHeight
          var canvas = global.document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          var g = canvas.getContext('2d')
          g.drawImage(frame, 0, 0, w, h)
          var dataUrl = canvas.toDataURL('image/png')
          frame.close()
          try { dec.close() } catch (e) { /* already closed */ }
          return dataUrl
        })
    }).catch(function () { return null })
  }

  /**
   * 冻结入口：url 是动态 GIF 地址，elapsedMs 是「点下暂停那一刻」它已播放的时长。
   * 返回 PNG data URL；任何一环不可用（非安全上下文、非 GIF、取帧失败）都返回 null。
   */
  function freeze(url, elapsedMs) {
    if (!supported() || !isGif(url)) return Promise.resolve(null)
    return timeline(url).then(function (info) {
      if (!info) return null
      return frameDataUrl(url, indexAt(info.durations, elapsedMs), info)
    }).catch(function () { return null })
  }

  var api = {
    supported: supported,
    isGif: isGif,
    indexAt: indexAt,
    totalDuration: totalDuration,
    watch: watch,
    livedMs: livedMs,
    warm: warm,
    timeline: timeline,
    freeze: freeze,
  }

  global.__rm2GifFrame = api
  // 浏览器 script / 构建拼接里存在 window，不得写 module.exports，否则会盖掉
  // client bundle 的 module.exports。Node require 无 window，可当 CJS 导出。
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
