/**
 * electron-fetch tests: on-demand Electron runtime fetch (mirror ordering,
 * idempotency, full download→unzip→place flow, and all-mirrors-fail fallback).
 *
 * These tests never touch the network: fetchImpl / spawnImpl are injected.
 * They are platform-aware: the expected artifact name / binary name come from
 * the current platform/arch via electronArtifact() / runtimeTarget().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { downloadMirrors, ensureElectronRuntime, electronArtifact, runtimeTarget, electronBinaryIn, requiredRuntimeFiles, missingRuntimeFiles, ELECTRON_VERSION } from '../../src/electron-fetch.mjs'

/**
 * 本文件下方的 ensureElectronRuntime 用例一律按 `platform: 'win32'` 驱动，所以夹具
 * 必须落 win32 的可执行名。此前这里取的是 `electronArtifact().binary`（不带参数 =
 * 运行平台），于是夹具在 Windows runner 上写 electron.exe、在 Ubuntu 上写 electron，
 * 而生产代码是按**传入的** platform 查找的 —— 非 Windows runner 上两者对不上，
 * 直接报「未在解压目录找到 electron.exe」。上游 0.4.4 一直只在 Windows 上跑，
 * 这个缺口此前没暴露过。
 */
const BIN = electronArtifact({ platform: 'win32' }).binary

/** Minimal web ReadableStream carrying one chunk of payload. */
function streamOf(chunk) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
}

/**
 * A stream that dies *after* handing over a first chunk — the shape a flaky CDN
 * actually produces (200 OK + Content-Length, then the connection resets).
 * The existing fall-through test only covers a mirror that fails at the HTTP
 * status level, so this one covers the mid-transfer case.
 */
function brokenStream() {
  const enc = new TextEncoder()
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(enc.encode('hel')); return }
      controller.error(new Error('connection reset by peer'))
    },
  })
}

function fakeFetch(ok) {
  return async (url) => {
    if (!ok) return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, body: null }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k) => (k === 'content-length' ? '5' : null) },
      body: streamOf('hello'),
    }
  }
}

/**
 * Fake zip extractor (platform-aware): on darwin writes the Electron.app bundle
 * binary, otherwise writes the platform binary (BIN) into dest.
 * issue #24: must emit the full required-file set (resources/default_app.asar
 * etc.), otherwise isUsableElectronRoot rejects the freshly extracted runtime.
 */
function fakeSpawn(platform = 'win32') {
  return (command, args) => {
    const child = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = () => { child.killed = true }
    setImmediate(() => {
      // args end with '-C', <dest> (both bsdtar/tar and unzip land files in dest)
      const idx = args.indexOf('-C')
      const dest = idx >= 0 ? args[idx + 1] : args[args.indexOf('-d') + 1]
      mkdirSync(dest, { recursive: true })
      if (platform === 'darwin') {
        const app = join(dest, 'Electron.app', 'Contents')
        const bin = join(app, 'MacOS', 'Electron')
        mkdirSync(dirname(bin), { recursive: true })
        mkdirSync(join(app, 'Resources'), { recursive: true })
        writeFileSync(bin, 'FAKE_ELECTRON')
        writeFileSync(join(app, 'Resources', 'default_app.asar'), 'FAKE_ASAR')
        writeFileSync(join(app, 'Info.plist'), 'fake')
        writeFileSync(join(dest, 'LICENSE'), 'fake')
      } else {
        // 按本解压器被要求的 platform 落可执行名，而不是全局的 BIN：fakeSpawn 是个
        // 接受 platform 的通用夹具，将来若有用例走 linux，得落无后缀的 electron。
        writeFileSync(join(dest, electronArtifact({ platform }).binary), 'FAKE_ELECTRON')
        mkdirSync(join(dest, 'resources'), { recursive: true })
        writeFileSync(join(dest, 'resources', 'default_app.asar'), 'FAKE_ASAR')
        writeFileSync(join(dest, 'resources.pak'), 'fake')
        writeFileSync(join(dest, 'snapshot_blob.bin'), 'fake')
        writeFileSync(join(dest, 'v8_context_snapshot.bin'), 'fake')
        writeFileSync(join(dest, 'LISEZ-moi.txt'), 'fake')
      }
      child.exitCode = 0
      child.emit('exit', 0)
    })
    return child
  }
}

function tempVendor() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-electron-test-'))
  const vendor = join(dir, 'vendor', 'electron-test')
  return { dir, vendor }
}

test('missingRuntimeFiles lists exactly the absent required files (residue diagnosis)', () => {
  const { dir, vendor } = tempVendor()
  try {
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, 'electron.exe'), 'EXE')
    writeFileSync(join(vendor, 'resources.pak'), 'PAK')
    const missing = missingRuntimeFiles(vendor, 'win32')
    assert.ok(missing.includes('resources/default_app.asar'))
    assert.ok(missing.includes('snapshot_blob.bin'))
    assert.ok(missing.includes('v8_context_snapshot.bin'))
    assert.ok(!missing.includes('electron.exe'))
    assert.ok(!missing.includes('resources.pak'))
    // 完整根目录 → 空清单
    mkdirSync(join(vendor, 'resources'), { recursive: true })
    writeFileSync(join(vendor, 'resources', 'default_app.asar'), 'ASAR')
    writeFileSync(join(vendor, 'snapshot_blob.bin'), 'SNAP')
    writeFileSync(join(vendor, 'v8_context_snapshot.bin'), 'SNAP2')
    assert.deepEqual(missingRuntimeFiles(vendor, 'win32'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 镜像与文件名断言一律从 ELECTRON_VERSION 派生，并且**不**显式传版本号——
 * 生产代码走的就是 `downloadMirrors()` 的默认参数路径，测试传字面量 '33.0.0'
 * 既覆盖不到那条路径，升 Electron 时还要同步改一堆魔法字符串。
 *
 * 原来这里是三条：镜像顺序、win32/linux 文件名、darwin-arm64。第三条是前两条的
 * 子集，且三者断言的是同一样东西（zip 名由 platform+arch 决定），已合为这一张
 * 表。可执行文件名（electron.exe / electron）是 electronArtifact 的事，另有一条。
 */
test('downloadMirrors: npmmirror first then github, artifact name per platform/arch', () => {
  const cases = [
    ['win32', 'x64'], ['win32', 'arm64'],
    ['linux', 'x64'], ['linux', 'arm64'],
    ['darwin', 'x64'], ['darwin', 'arm64'],
  ]
  for (const [platform, arch] of cases) {
    const name = `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`
    const mirrors = downloadMirrors(undefined, platform, arch)
    assert.equal(mirrors.length, 2, `${platform}/${arch} 应有两个镜像`)
    assert.ok(
      mirrors[0].startsWith(`https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VERSION}/`),
      `${platform}/${arch} 首选镜像应是 npmmirror`,
    )
    assert.ok(
      mirrors[1].startsWith(`https://github.com/electron/electron/releases/download/`),
      `${platform}/${arch} 备选镜像应是 GitHub releases`,
    )
    // 两端文件名必须逐字一致，否则第一个镜像挂掉后回退会去拉一个不存在的产物
    assert.ok(mirrors[0].endsWith(`/${name}`), `${platform}/${arch} npmmirror 文件名应为 ${name}`)
    assert.ok(mirrors[1].endsWith(`/${name}`), `${platform}/${arch} GitHub 文件名应为 ${name}`)
  }
})

test('electronArtifact: binary name and vendor dir are platform-specific', () => {
  const win = electronArtifact({ platform: 'win32', arch: 'x64' })
  assert.equal(win.binary, 'electron.exe')
  assert.ok(win.vendorDir.includes('electron-win32-x64'))
  assert.equal(win.zipName, `electron-v${ELECTRON_VERSION}-win32-x64.zip`)

  const linux = electronArtifact({ platform: 'linux', arch: 'x64' })
  assert.equal(linux.binary, 'electron')
  assert.ok(linux.vendorDir.includes('electron-linux-x64'))
  assert.equal(linux.zipName, `electron-v${ELECTRON_VERSION}-linux-x64.zip`)
})

test('runtimeTarget/electronBinaryIn map the launchable binary per platform', () => {
  assert.deepEqual(runtimeTarget('win32', 'x64').sub, ['electron.exe'])
  assert.equal(electronBinaryIn('/v', 'win32', 'x64'), resolve('/v', 'electron.exe'))
  assert.deepEqual(runtimeTarget('darwin', 'arm64').sub, ['Electron.app', 'Contents', 'MacOS', 'Electron'])
  assert.equal(electronBinaryIn('/v', 'darwin', 'arm64'), resolve('/v', 'Electron.app', 'Contents', 'MacOS', 'Electron'))
  assert.deepEqual(runtimeTarget('darwin', 'x64').sub, ['Electron.app', 'Contents', 'MacOS', 'Electron'])
})

test('ensureElectronRuntime is idempotent when the runtime already exists', async () => {
  const { dir, vendor } = tempVendor()
  try {
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, BIN), 'EXISTS')
    // issue #24: 快速路径要求完整关键文件集，只有 exe 会被判残缺并触发重装。
    for (const rel of requiredRuntimeFiles('win32')) {
      const p = join(vendor, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'fake')
    }
    let fetchCalls = 0
    const exe = await ensureElectronRuntime({
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch') },
      spawnImpl: () => { throw new Error('must not spawn') },
    })
    assert.equal(exe, resolve(vendor, BIN))
    assert.equal(fetchCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exe-only residue is treated as broken and repaired by reinstalling (issue #24)', async () => {
  const { dir, vendor } = tempVendor()
  try {
    // 复制中断的典型残留：electron.exe 已就位、resources/default_app.asar 缺失。
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, BIN), 'EXE_ONLY')
    const exe = await ensureElectronRuntime({
      mirrors: ['https://mirror.test/electron.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn('win32'),
    })
    assert.equal(exe, resolve(vendor, BIN))
    // 重装后运行时完整。
    assert.ok(existsSync(join(vendor, 'resources', 'default_app.asar')), 'missing default_app.asar should be restored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('incomplete extraction aborts the install without polluting vendorDir (issue #24)', async () => {
  const { dir, vendor } = tempVendor()
  try {
    // 假解压器只落 exe（模拟解压中断/缺文件）：staging 校验必须拒绝发布。
    await assert.rejects(
      ensureElectronRuntime({
        mirrors: ['https://mirror.test/electron.zip'],
        vendorDir: vendor,
        platform: 'win32',
        arch: 'x64',
        fetchImpl: fakeFetch(true),
        spawnImpl: (command, args) => {
          const child = new EventEmitter()
          setImmediate(() => {
            const idx = args.indexOf('-C')
            const dest = idx >= 0 ? args[idx + 1] : args[args.indexOf('-d') + 1]
            mkdirSync(dest, { recursive: true })
            writeFileSync(join(dest, BIN), 'EXE_ONLY')
            child.exitCode = 0
            child.emit('exit', 0)
          })
          return child
        },
      }),
      /运行时不完整/,
    )
    assert.ok(!existsSync(vendor), 'vendorDir must stay clean when staging validation fails')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime downloads, unzips and places the Electron binary', async () => {
  const { dir, vendor } = tempVendor()
  const progress = []
  try {
    const exe = await ensureElectronRuntime({
      mirrors: ['https://mirror.test/electron.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      onProgress: (m) => progress.push(m),
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn('win32'),
    })
    assert.ok(existsSync(exe), `${BIN} should be placed`)
    assert.equal(exe, resolve(vendor, BIN))
    assert.match(progress.join(' '), /已就绪/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime places the Electron.app bundle binary on macOS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-electron-test-'))
  const vendor = join(dir, 'vendor', 'electron-darwin-arm64')
  try {
    const exe = await ensureElectronRuntime({
      mirrors: ['https://mirror.test/electron.zip'],
      vendorDir: vendor,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn('darwin'),
    })
    assert.equal(exe, resolve(vendor, 'Electron.app', 'Contents', 'MacOS', 'Electron'))
    assert.ok(existsSync(exe), 'macOS Electron binary should be placed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime rejects when every mirror fails', async () => {
  const { dir, vendor } = tempVendor()
  try {
    await assert.rejects(
      ensureElectronRuntime({
        mirrors: ['https://a.test/x.zip', 'https://b.test/y.zip'],
        vendorDir: vendor,
        platform: 'win32',
        arch: 'x64',
        fetchImpl: fakeFetch(false),
        spawnImpl: () => { throw new Error('must not spawn') },
      }),
      /所有 Electron 下载源均失败/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime falls through to the second mirror after the first fails', async () => {
  const { dir, vendor } = tempVendor()
  const tried = []
  try {
    await ensureElectronRuntime({
      mirrors: ['https://mirror-1.test/a.zip', 'https://mirror-2.test/b.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        tried.push(url)
        if (url.includes('mirror-1')) return { ok: false, status: 503, statusText: 'unavailable', headers: { get: () => null }, body: null }
        return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'content-length' ? '5' : null) }, body: streamOf('hello') }
      },
      spawnImpl: fakeSpawn('win32'),
    })
    assert.equal(tried.length, 2, 'should have tried both mirrors')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime falls through when a mirror answers 200 but dies mid-transfer', async () => {
  const { dir, vendor } = tempVendor()
  const tried = []
  try {
    await ensureElectronRuntime({
      mirrors: ['https://mirror-1.test/a.zip', 'https://mirror-2.test/b.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        tried.push(url)
        // 头部声明 5 字节、实际只吐 3 字节就断——这正是 CDN 抽风时的形状，
        // 只测「首个字节就 404」会漏掉它，而截断的 zip 喂给解压步骤必然失败。
        if (url.includes('mirror-1')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: (k) => (k === 'content-length' ? '5' : null) },
            body: brokenStream(),
          }
        }
        return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'content-length' ? '5' : null) }, body: streamOf('hello') }
      },
      spawnImpl: fakeSpawn('win32'),
    })
    assert.equal(tried.length, 2, '中途断开的镜像应被跳过并回退到下一个')
    assert.ok(tried[0].includes('mirror-1') && tried[1].includes('mirror-2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
