import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PKG, setSelfUpdateHooks, updateHandler } from '../src/self-update.js'

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
