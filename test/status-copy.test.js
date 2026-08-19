import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityCopy, activityStage, statusCopy, statusCopyLibrary, taskCopy } from '../src/status-copy.js'

test('every group has at least one variant', () => {
  for (const [group, variants] of Object.entries(statusCopyLibrary)) {
    assert.ok(Array.isArray(variants) && variants.length > 0, `empty group ${group}`)
  }
})

test('seeded selection is stable and varies', () => {
  const first = statusCopy('thinking', 1)
  const again = statusCopy('thinking', 1)
  assert.equal(first, again)
  const variants = new Set([0, 1, 2, 3, 4, 5].map((seed) => statusCopy('thinking', seed)))
  assert.ok(variants.size > 1, 'expected variation across seeds')
})

test('unknown group falls back to working', () => {
  assert.ok(typeof statusCopy('does-not-exist') === 'string')
})

test('activityCopy maps activities', () => {
  assert.equal(activityCopy('searching'), statusCopy('searching', 0))
  assert.ok(typeof activityStage('editing') === 'string')
})

test('taskCopy formats task text', () => {
  assert.match(taskCopy('完善项目文档'), /^正在处理「完善项目文档」呢$/)
  assert.match(taskCopy('修改登录逻辑'), /^正在修改登录逻辑呢$/)
  assert.equal(taskCopy(''), statusCopy('working', 0))
  assert.match(taskCopy('继续完成剩余部分'), /继续完成剩余部分呢/)
})
