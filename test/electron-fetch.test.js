/**
 * electron-fetch tests: on-demand Electron runtime fetch (mirror ordering,
 * idempotency, full download→unzip→place flow, and all-mirrors-fail fallback).
 *
 * These tests never touch the network: fetchImpl / spawnImpl are injected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { downloadMirrors, ensureElectronRuntime, runtimeTarget, electronBinaryIn } from '../src/electron-fetch.mjs'

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

/** Fake `tar -xf zip -C dest`: writes a fake electron.exe into dest (win32). */
function fakeSpawn(platform = 'win32') {
  return (command, args) => {
    const child = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = () => { child.killed = true }
    setImmediate(() => {
      // args = ['-xf', zip, '-C', work]
      const work = args[args.indexOf('-C') + 1]
      mkdirSync(work, { recursive: true })
      if (platform === 'darwin') {
        const bin = join(work, 'Electron.app', 'Contents', 'MacOS', 'Electron')
        mkdirSync(dirname(bin), { recursive: true })
        writeFileSync(bin, 'FAKE_ELECTRON')
        writeFileSync(join(work, 'LICENSE'), 'fake')
      } else {
        writeFileSync(join(work, 'electron.exe'), 'FAKE_ELECTRON')
        writeFileSync(join(work, 'LISEZ-moi.txt'), 'fake')
      }
      child.exitCode = 0
      child.emit('exit', 0)
    })
    return child
  }
}

function tempVendor() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-electron-test-'))
  const vendor = join(dir, 'vendor', 'electron-win32-x64')
  return { dir, vendor }
}

test('downloadMirrors: npmmirror first, then github, same artifact name', () => {
  const mirrors = downloadMirrors('33.0.0', 'win32', 'x64')
  assert.equal(mirrors.length, 2)
  assert.match(mirrors[0], /^https:\/\/registry\.npmmirror\.com\/-\/binary\/electron\/v33\.0\.0\/electron-v33\.0\.0-win32-x64\.zip$/)
  assert.match(mirrors[1], /^https:\/\/github\.com\/electron\/electron\/releases\/download\/v33\.0\.0\/electron-v33\.0\.0-win32-x64\.zip$/)
})

test('downloadMirrors targets darwin-arm64 on Apple Silicon', () => {
  const [m0, m1] = downloadMirrors('33.0.0', 'darwin', 'arm64')
  assert.match(m0, /electron-v33\.0\.0-darwin-arm64\.zip$/)
  assert.match(m1, /electron-v33\.0\.0-darwin-arm64\.zip$/)
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
    writeFileSync(join(vendor, 'electron.exe'), 'EXISTS')
    let fetchCalls = 0
    const exe = await ensureElectronRuntime({
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch') },
      spawnImpl: () => { throw new Error('must not spawn') },
    })
    assert.equal(exe, resolve(vendor, 'electron.exe'))
    assert.equal(fetchCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime downloads, unzips and places electron.exe', async () => {
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
    assert.ok(existsSync(exe), 'electron.exe should be placed')
    assert.equal(exe, resolve(vendor, 'electron.exe'))
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
