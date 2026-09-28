import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PKG, setSelfUpdateHooks, updateHandler, run, getUpdateProgress, progressHandler,
  PROGRESS_ENDPOINT, verifyInstallIntegrity, infoHandler,
} from '../../src/self-update.js'

// 平台集成测试：以下用例启动真实子进程；注入 spawn/时钟的单元覆盖在默认套件。
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
