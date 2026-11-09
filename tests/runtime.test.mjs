import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanyRuntime } from '../src/runtime.js'

function mockContext() {
  return {
    logger: { warn: () => {} },
    on: () => () => {},
    agents: { get: () => undefined },
    sessionController: {
      list: async () => ({ items: [] }),
      modelCatalog: async () => ({ default: { provider: 'mock', model: 'default' }, groups: [] }),
    },
    sessionPersistence: { flush: async () => {} },
    subprocess: {
      spawn: ({ cwd }) => ({
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: `OK ${cwd}` }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }),
    },
  }
}

function config(stateDir) {
  return {
    maxWorkers: 2,
    workerPreset: 'ai-company-worker',
    routerPreset: 'standard',
    workerModel: null,
    operatorSessionId: null,
    executionMode: 'workspace',
    prepareCommand: '',
    blockedCommands: [],
    acceptanceTimeoutMs: 5000,
    shadow: { enabled: false, ledgerPath: join(stateDir, 'ledger.jsonl') },
    policy: { enforcement: 'shadow', requiredFields: ['goal', 'scope', 'acceptance', 'evidence'], profiles: {} },
    modelPolicy: { maxContextPressure: 0.9, candidates: [] },
  }
}

function envelope(cwd) {
  return {
    task: '创建一个小型结果文件并报告证据',
    goal: '验证持久化闭环',
    cwd,
    scope: { allow: [cwd] },
    acceptance: ['node -e "process.exit(0)"'],
    evidence: ['result.txt'],
    model_policy: 'keep',
    idempotency_key: 'same-task-v1',
  }
}

test('工单原子创建、幂等、独立验收与重开恢复', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-runtime-'))
  const stateDir = join(root, 'state')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const runtimes = []
  t.after(async () => {
    for (const item of runtimes) await item.stop()
    rmSync(root, { recursive: true, force: true })
  })

  const runtime = new CompanyRuntime(mockContext(), config(stateDir), stateDir)
  runtimes.push(runtime)
  const first = await runtime.dispatch(envelope(cwd), null)
  assert.equal(first.ok, true)
  assert.equal(first.accepted, true)
  assert.ok(first.ticketId)
  assert.equal(runtime.store.tickets.list().length, 1)
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM effect').get().n, 1)

  const second = await runtime.dispatch(envelope(cwd), null)
  assert.equal(second.duplicate, true)
  assert.equal(second.ticketId, first.ticketId)
  assert.equal(runtime.store.tickets.list().length, 1)
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM effect').get().n, 1)

  const ticket = runtime.store.tickets.get(first.ticketId)
  const assignment = ticket.assignments[0]
  runtime.engine.assignmentStarted(ticket.id, assignment.id)
  runtime.engine.report(ticket.id, { state: 'ready', summary: '结果文件已创建' })
  runtime.store.set(`company-reports:${ticket.id}`, [{
    id: 'report-1', at: new Date().toISOString(), state: 'ready', summary: '结果文件已创建', evidence: ['result.txt'], checks: [],
  }])
  assert.equal(runtime.store.tickets.get(ticket.id).ended.outcome, 'completed')
  assert.equal(runtime.verification(ticket.id).status, 'unverified')

  const notRun = await runtime.verify(ticket.id, { runAcceptance: false })
  assert.equal(notRun.verified, false)
  writeFileSync(join(cwd, 'result.txt'), 'ok', 'utf8')
  const verified = await runtime.verify(ticket.id, { runAcceptance: true })
  assert.equal(verified.verified, true)
  assert.equal(verified.checks[0].exitCode, 0)
  await runtime.stop()

  const reopened = new CompanyRuntime(mockContext(), config(stateDir), stateDir)
  runtimes.push(reopened)
  assert.equal(reopened.store.tickets.list().length, 1)
  assert.equal(reopened.store.tickets.get(ticket.id).ended.outcome, 'completed')
  assert.equal(reopened.verification(ticket.id).status, 'verified')
  assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM effect').get().n, 1)
})

test('自动幂等键区分完整任务与验收信封', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-idempotency-'))
  const stateDir = join(root, 'state')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const runtime = new CompanyRuntime(mockContext(), config(stateDir), stateDir)
  t.after(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const shared = '相同前缀'.repeat(100)
  const first = await runtime.dispatch({ ...envelope(cwd), task: `${shared}任务甲`, idempotency_key: undefined }, null)
  const second = await runtime.dispatch({ ...envelope(cwd), task: `${shared}任务乙`, idempotency_key: undefined }, null)
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, false)
  assert.notEqual(first.ticketId, second.ticketId)
  assert.equal(runtime.store.tickets.list().length, 2)
})

test('空证据或缺失文件不能通过独立验收', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-evidence-'))
  const stateDir = join(root, 'state')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const runtime = new CompanyRuntime(mockContext(), config(stateDir), stateDir)
  t.after(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const created = await runtime.dispatch({ ...envelope(cwd), idempotency_key: 'empty-evidence' }, null)
  const ticket = runtime.store.tickets.get(created.ticketId)
  runtime.engine.report(ticket.id, { state: 'ready', summary: '自称完成' })
  runtime.store.set(`company-reports:${ticket.id}`, [{ id: 'bad', state: 'ready', summary: '自称完成', evidence: [''], checks: [] }])
  const result = await runtime.verify(ticket.id, { runAcceptance: true })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'failed')
})

test('Ticket 树记录父子关系并限制 delegation_depth 最大为 3', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-depth-'))
  const stateDir = join(root, 'state')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const runtime = new CompanyRuntime(mockContext(), config(stateDir), stateDir)
  t.after(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  let parentTicketId
  for (let depth = 0; depth <= 3; depth += 1) {
    const result = await runtime.dispatch({
      ...envelope(cwd),
      goal: `层级 ${depth}`,
      parent_ticket_id: parentTicketId,
      idempotency_key: `depth-${depth}`,
    }, null)
    assert.equal(result.ok, true)
    parentTicketId = result.ticketId
    assert.equal(runtime.ticketSummary(runtime.store.tickets.get(parentTicketId)).delegationDepth, depth)
  }
  const rejected = await runtime.dispatch({ ...envelope(cwd), parent_ticket_id: parentTicketId, idempotency_key: 'depth-4' }, null)
  assert.equal(rejected.accepted, false)
  assert.match(rejected.text, /delegation_depth=3/)
})
