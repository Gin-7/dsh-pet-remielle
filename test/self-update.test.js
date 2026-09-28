import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PKG, setSelfUpdateHooks, updateHandler, run, getUpdateProgress, progressHandler,
  PROGRESS_ENDPOINT, verifyInstallIntegrity, infoHandler,
} from '../src/self-update.js'

// 一个确定存在的目录，让 existsSync(profileDir) 检查通过
const EXISTING_DIR = fileURLToPath(new URL('.', import.meta.url))

// 真实请求一定带 socket：守卫查的是 TCP 层对端地址（Host 头可被页面伪造）
function request(method, host = '127.0.0.1:3080', extra = {}) {
  const req = Readable.from([])
  req.method = method
  req.headers = { host, ...extra }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body = String(body) },
  }
}

test('registry update stops the desktop window first and runs pnpm update --latest', async () => {
  const calls = []
  setSelfUpdateHooks({
    stopDesktopWindow: async () => { calls.push('stop') },
    run: async (cmd, args, cwd) => {
      calls.push(`run ${cmd} ${args.join(' ')} @ ${cwd}`)
      return { ok: true, output: 'done' }
    },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  // 停窗必须发生在 pnpm 之前，且带 --latest 跨过精确版本锁定
  assert.deepEqual(calls, [
    'stop',
    `run pnpm update --latest ${PKG} @ ${EXISTING_DIR}`,
  ])
})

test('link update runs git pull in the repo dir', async () => {
  const seen = []
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async (cmd, args, cwd) => { seen.push([cmd, args, cwd]); return { ok: false, output: 'boom' } },
    resolveInstall: () => ({ mode: 'link', repoDir: 'D:/repo', version: '0.3.4' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  assert.deepEqual(seen, [['git', ['-C', 'D:/repo', 'pull'], 'D:/repo']])
})

test('a failing desktop-window stop does not block the update', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: async () => { throw new Error('window already gone') },
    run: async () => { ran = true; return { ok: true, output: '' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  assert.equal(ran, true)
})

test('update route rejects non-local hosts', async () => {
  setSelfUpdateHooks({ resolveInstall: () => { throw new Error('must not resolve') } })
  const res = responseRecorder()
  await updateHandler(request('POST', 'evil.example.com:3080'), res)
  assert.equal(res.status, 403)
})

test('successful update runs the onUpdateSuccess hook and appends its note to output', async () => {
  const events = []
  setSelfUpdateHooks({
    run: async () => ({ ok: true, output: 'done' }),
    onUpdateSuccess: () => { events.push('success'); return '桌面模式已自动关闭' },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(body.output.includes('桌面模式已自动关闭'))
  assert.deepEqual(events, ['success'])
})

test('a failed update does not run the onUpdateSuccess hook', async () => {
  let called = 0
  setSelfUpdateHooks({
    run: async () => ({ ok: false, output: 'EPERM' }),
    onUpdateSuccess: () => { called += 1 },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  assert.equal(called, 0)
})

test('an unexpected error inside the handler becomes a 500 instead of crashing', async () => {
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
    run: async () => { throw new Error('pnpm vanished mid-flight') },
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.ok(body.output.includes('pnpm vanished mid-flight'))
})

// ---- 0.4.4：空闲超时（替代固定 90s 硬超时）+ 实时进度 ----
// 真子进程用 process.execPath 驱动，不依赖 PATH；脚本刻意只含空格、不含
// > < & | 等 cmd 元字符（Windows 上 shell:true 会拼进 cmd.exe /c "..."）。


test('updateHandler tracks progress state around the run hook (real or fake)', async () => {
  let duringRun = null
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => {
      duringRun = getUpdateProgress()
      return { ok: true, output: 'done' }
    },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  assert.ok(duringRun, 'progress captured during run')
  assert.equal(duringRun.running, true, 'running flag set while the run hook is in flight')
  assert.ok(typeof duringRun.elapsedMs === 'number')
  assert.equal(getUpdateProgress().running, false, 'running flag cleared after the run finishes')
})

test('progress endpoint serves live state locally and rejects remote hosts', () => {
  const res = responseRecorder()
  progressHandler(request('GET'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(typeof body.outputTail, 'string')
  assert.ok('running' in body && 'elapsedMs' in body)

  const res2 = responseRecorder()
  progressHandler(request('GET', 'evil.example.com:3080'), res2)
  assert.equal(res2.status, 403)
})

// ---- 0.4.4：失败后旧安装完整性自检（更新失败不得让用户旧版也保不住） ----

test('verifyInstallIntegrity: intact package passes, broken package reports problems', async () => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'rm2-integrity-'))
  try {
    // 完好形态：package.json + 入口 + src/
    const good = join(base, 'good')
    await mkdir(good, { recursive: true })
    await writeFile(join(good, 'package.json'), JSON.stringify({ name: 'dsh-pet-remielle', version: '0.4.3', main: 'lib/index.js' }))
    await mkdir(join(good, 'lib'), { recursive: true })
    await writeFile(join(good, 'lib', 'index.js'), 'export {}')
    await mkdir(join(good, 'src'), { recursive: true })
    const goodReport = verifyInstallIntegrity(good)
    assert.equal(goodReport.ok, true, 'intact package must pass: ' + JSON.stringify(goodReport.problems))

    // 破损形态：package.json 缺失（模拟 pnpm 中途被杀）
    const broken = join(base, 'broken')
    await mkdir(join(broken, 'src'), { recursive: true })
    const badReport = verifyInstallIntegrity(broken)
    assert.equal(badReport.ok, false)
    assert.ok(badReport.problems.some((p) => p.includes('package.json')), 'missing package.json must be reported')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a failed update appends an integrity verdict so the user knows the old version still works', async () => {
  setSelfUpdateHooks({
    run: async () => ({ ok: false, output: '[timeout: no output for 60s — 更新进程疑似挂起]' }),
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  // EXISTING_DIR 下没有 node_modules/dsh-pet-remielle，自检必然报异常——
  // 关键断言：失败响应必须带上自检结论，而不是只丢一段 pnpm 日志
  assert.ok(body.output.includes('自检'), 'failed update must include an integrity verdict: ' + body.output.slice(-200))
  assert.ok(/✅|⚠️/.test(body.output), 'verdict must state whether the old install survives')
})

// ---- CSRF 守卫 ----

test('a cross-origin POST to the update route is refused and never runs pnpm/git', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  // 恶意页面的 Host 头与本机一致（浏览器无法伪造，只能由请求目标决定），
  // 只有 Origin 暴露了跨源——这正是过去"只查 Host"漏掉的那一类请求。
  const res = responseRecorder()
  await updateHandler(request('POST', '127.0.0.1:3080', { origin: 'https://evil.example' }), res)
  assert.equal(res.status, 403)
  assert.equal(ran, false, 'cross-origin POST must not reach git/pnpm')
})

test('a request from a non-loopback peer is refused even with a loopback Host header', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  const res = responseRecorder()
  const req = request('POST')
  req.socket = { remoteAddress: '192.168.1.20' }
  await updateHandler(req, res)
  assert.equal(res.status, 403)
  assert.equal(ran, false, 'a remote peer must not trigger the update')
})

test('a same-origin loopback request is still accepted', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }), res)
  assert.equal(res.status, 200)
  assert.equal(ran, true)
})

test('the info route refuses cross-origin callers instead of leaking absolute paths', () => {
  const res = responseRecorder()
  infoHandler(request('GET', '127.0.0.1:3080', { origin: 'https://evil.example' }), res)
  assert.equal(res.status, 403)
  assert.ok(!/profileDir|repoDir/.test(res.body), 'guarded response must not carry install paths')
})

test('the info route still serves its payload to a same-origin caller', () => {
  const res = responseRecorder()
  infoHandler(request('GET', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }), res)
  assert.equal(res.status, 200)
  // resolveInstall 走真实实现（不经 hooks），所以只断言稳定字段
  assert.equal(JSON.parse(res.body).pkg, PKG)
})

// 跨源 GET/HEAD 按 Fetch 规范**不带 Origin**（mode 是 no-cors 而非 cors），
// 而 Host 头又由请求目标决定。三项守卫在这条路径上全部放行——只有把方法钉死
// 成 POST，恶意页面的 <img src=".../update"> 才够不到 hooks.run()。
test('a plain cross-origin GET cannot trigger the update', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'link', repoDir: 'C:/fake/repo', version: '0.4.3' }),
  })
  const res = responseRecorder()
  // 模拟 <img src="http://127.0.0.1:3080/plugins/dsh-pet-remielle/update">：
  // 环回对端、Host 正确、**没有 Origin**。
  await updateHandler(request('GET'), res)
  assert.equal(res.status, 405)
  assert.equal(ran, false, 'GET must not reach git/pnpm')
})

test('HEAD cannot trigger the update either', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'link', repoDir: 'C:/fake/repo', version: '0.4.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('HEAD'), res)
  assert.equal(res.status, 405)
  assert.equal(ran, false)
})

test('the read routes refuse a mutating method', () => {
  for (const [name, handler] of [['info', infoHandler], ['progress', progressHandler]]) {
    const res = responseRecorder()
    handler(request('POST'), res)
    assert.equal(res.status, 405, `${name} must be GET-only`)
  }
})
