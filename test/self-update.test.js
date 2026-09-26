import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PKG, setSelfUpdateHooks, updateHandler, run, getUpdateProgress, progressHandler,
  PROGRESS_ENDPOINT, IDLE_TIMEOUT_MS, TOTAL_TIMEOUT_MS, verifyInstallIntegrity,
} from '../src/self-update.js'

// 一个确定存在的目录，让 existsSync(profileDir) 检查通过
const EXISTING_DIR = fileURLToPath(new URL('.', import.meta.url))

function request(method, host = '127.0.0.1:3080') {
  const req = Readable.from([])
  req.method = method
  req.headers = { host }
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

test('run(): periodic output resets the idle timer so slow downloads are not killed', async () => {
  // 首行立即输出（模拟 pnpm 元数据解析），随后周期输出（模拟下载进度）——
  // 进程总时长（~3s）超过 idle 阈值（3s），但空闲计时器不断被重置，不得被杀。
  // 间隔 500ms 对 idle 3s 留 6 倍余量：全量测试并行跑时 cmd.exe 冷启动可超 1s。
  const script = "console.log('boot'); let n = 0; const t = setInterval(function () { n++; console.log('tick' + n); if (n === 6) { clearInterval(t) } }, 500)"
  const result = await run(process.execPath, ['-e', script], EXISTING_DIR, { idleTimeoutMs: 3000, totalTimeoutMs: 20000 })
  assert.equal(result.ok, true, 'periodic output must keep the process alive, got: ' + result.output)
  assert.ok((result.output.match(/tick/g) || []).length >= 6, 'all ticks captured: ' + result.output)
  assert.ok(!result.output.includes('[timeout'), 'no timeout marker')
})

test('run(): a silent process is killed by the idle timeout', async () => {
  const started = Date.now()
  const result = await run(process.execPath, ['-e', 'setTimeout(function () {}, 5000)'], EXISTING_DIR, { idleTimeoutMs: 500, totalTimeoutMs: 10000 })
  assert.equal(result.ok, false)
  assert.ok(result.output.includes('[timeout'), 'timeout marker present: ' + result.output)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4000, `killed near the idle threshold (took ${elapsed}ms, not the full 5s)`)
})

test('run(): live child output feeds the progress tail buffer', async () => {
  const script = "console.log('progress-line-1'); console.log('progress-line-2')"
  await run(process.execPath, ['-e', script], EXISTING_DIR, { idleTimeoutMs: 5000, totalTimeoutMs: 10000 })
  const prog = getUpdateProgress()
  assert.ok(prog.outputTail.includes('progress-line-1'), 'tail has line 1: ' + prog.outputTail)
  assert.ok(prog.outputTail.includes('progress-line-2'), 'tail has line 2: ' + prog.outputTail)
  assert.equal(prog.running, false, 'bare run() does not flip the update-level running flag')
})

test('run(): default timeouts are exposed and generous (idle 60s, total 10min)', () => {
  assert.equal(IDLE_TIMEOUT_MS, 60000)
  assert.equal(TOTAL_TIMEOUT_MS, 600000)
})

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
