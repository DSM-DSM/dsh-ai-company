import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProfile, CORE_NORMS } from '../src/policy-profiles.js'
import { evaluatePolicy, validateEnvelope } from '../src/policy-check.js'
import { WorkerSlots, Later } from '../vendor/dsh-superagent/lib/company-kernel.js'

test('公开默认 profile 不含公司专属规则', () => {
  const profile = resolveProfile('D:/demo', { profiles: {} })
  assert.equal(profile.id, 'core-values-v1')
  assert.equal(CORE_NORMS.length, 10)
  assert.deepEqual(profile.roles, {})
  assert.deepEqual(profile.quietWindows, [])
  assert.equal(validateEnvelope({ goal: 'x', scope: { allow: ['.'] }, acceptance: ['test'], evidence: ['log'] }).length, 0)
})

test('enforce 所需的风险证据会被标记', () => {
  const profile = resolveProfile('D:/demo', { profiles: {} })
  const report = evaluatePolicy({
    task: '删除整个目录并保证全部完成',
    goal: '全仓重训',
    scope: { allow: ['D:/'] },
    acceptance: ['test'],
    evidence: ['log'],
    approvals: [],
    profile,
    idempotencyKey: 'risk-1',
  })
  assert.equal(report.wouldBlock, true)
  assert.ok(report.findings.some((item) => item.norm === 'V3'))
  assert.ok(report.findings.some((item) => item.norm === 'V8'))
})

test('WorkerSlots 同步预留容量并给人工追加一个槽位', () => {
  const running = ['a', 'b']
  const slots = new WorkerSlots(() => running, () => 2)
  assert.equal(slots.used(), 2)
  assert.throws(() => slots.reserve('c', 'launch'), Later)
  slots.reserve('person', 'person')
  assert.equal(slots.used(), 3)
  slots.free('person')
  running.pop()
  slots.reserve('c', 'launch')
  assert.equal(slots.used(), 2)
})
