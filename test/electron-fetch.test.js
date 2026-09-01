/**
 * electron-fetch tests: on-demand Electron runtime fetch (mirror ordering,
 * idempotency, full download→unzip→place flow, and all-mirrors-fail fallback).
 *
 * These tests never touch the network: fetchImpl / spawnImpl are injected.
 * They are platform-aware: the expected artifact name / binary name come from
 * the current platform/arch via electronArtifact().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { downloadMirrors, ensureElectronRuntime, electronArtifact } from '../src/electron-fetch.mjs'

/** The platform-specific executable name (electron.exe on Windows, electron elsewhere). */
const BIN = electronArtifact().binary

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

/** Fake zip extractor: writes a fake Electron binary into dest. */
function fakeSpawn() {
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
      writeFileSync(join(dest, BIN), 'FAKE_ELECTRON')
      writeFileSync(join(dest, 'LISEZ-moi.txt'), 'fake')
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

test('downloadMirrors: npmmirror first, then github, same artifact name', () => {
  const { platform, arch } = electronArtifact()
  const name = `electron-v33.0.0-${platform}-${arch}.zip`
  const mirrors = downloadMirrors('33.0.0')
  assert.equal(mirrors.length, 2)
  assert.ok(mirrors[0].startsWith('https://registry.npmmirror.com/-/binary/electron/v33.0.0/'))
  assert.ok(mirrors[0].endsWith(`/${name}`))
  assert.ok(mirrors[1].startsWith('https://github.com/electron/electron/releases/download/v33.0.0/'))
  assert.ok(mirrors[1].endsWith(`/${name}`))
})

test('downloadMirrors: platform-specific names (win32 -> .exe, others -> electron)', () => {
  const win = downloadMirrors('33.0.0', 'win32', 'x64')
  assert.ok(win[0].includes('electron-v33.0.0-win32-x64.zip'))
  const linux = downloadMirrors('33.0.0', 'linux', 'x64')
  assert.ok(linux[0].includes('electron-v33.0.0-linux-x64.zip'))
  const linuxArm = downloadMirrors('33.0.0', 'linux', 'arm64')
  assert.ok(linuxArm[0].includes('electron-v33.0.0-linux-arm64.zip'))
})

test('electronArtifact: binary name and vendor dir are platform-specific', () => {
  const win = electronArtifact({ platform: 'win32', arch: 'x64' })
  assert.equal(win.binary, 'electron.exe')
  assert.ok(win.vendorDir.includes('electron-win32-x64'))
  assert.equal(win.zipName, 'electron-v33.0.0-win32-x64.zip')

  const linux = electronArtifact({ platform: 'linux', arch: 'x64' })
  assert.equal(linux.binary, 'electron')
  assert.ok(linux.vendorDir.includes('electron-linux-x64'))
  assert.equal(linux.zipName, 'electron-v33.0.0-linux-x64.zip')
})

test('ensureElectronRuntime is idempotent when the runtime already exists', async () => {
  const { dir, vendor } = tempVendor()
  try {
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, BIN), 'EXISTS')
    let fetchCalls = 0
    const exe = await ensureElectronRuntime({
      vendorDir: vendor,
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch') },
      spawnImpl: () => { throw new Error('must not spawn') },
    })
    assert.equal(exe, resolve(vendor, BIN))
    assert.equal(fetchCalls, 0)
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
      onProgress: (m) => progress.push(m),
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn(),
    })
    assert.ok(existsSync(exe), `${BIN} should be placed`)
    assert.equal(exe, resolve(vendor, BIN))
    assert.match(progress.join(' '), /已就绪/)
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
      fetchImpl: async (url) => {
        tried.push(url)
        if (url.includes('mirror-1')) return { ok: false, status: 503, statusText: 'unavailable', headers: { get: () => null }, body: null }
        return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'content-length' ? '5' : null) }, body: streamOf('hello') }
      },
      spawnImpl: fakeSpawn(),
    })
    assert.equal(tried.length, 2, 'should have tried both mirrors')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
