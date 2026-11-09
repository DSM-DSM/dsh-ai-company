import test from 'node:test'
import assert from 'node:assert/strict'
import { nearestOrdinarySession } from '../src/runtime.js'
import { CompanySessions } from '../src/sessions.js'
import { CompanyRuntime } from '../src/runtime.js'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('subagent 报告接收方回退到最近普通祖先', () => {
  const summaries = [
    { sessionId: 'root', origin: undefined },
    { sessionId: 'manager', origin: 'subagent', parentSessionId: 'root' },
    { sessionId: 'worker', origin: 'subagent', parentSessionId: 'manager' },
  ]
  assert.deepEqual(nearestOrdinarySession('worker', summaries), { ok: true, sessionId: 'root', redirected: true })
  assert.equal(nearestOrdinarySession('missing', summaries).ok, false)
})

test('永久报告投递错误进入 dead-letter 而不阻塞队列', async () => {
  const values = new Map()
  const ctx = {
    on: () => () => {},
    logger: { warn: () => {} },
    sessionController: {
      resolveAgent: async () => ({ error: { code: 'session/agent-busy', message: 'owned by subagent routing; use subagent delivery' } }),
    },
  }
  const store = {
    set: (key, value) => values.set(key, value),
    get: (key) => values.get(key),
    tickets: { get: () => undefined },
  }
  const sessions = new CompanySessions({
    context: ctx,
    store,
    effects: { handle: () => {} },
    getEngine: () => ({}),
    config: {},
    lifetime: new AbortController().signal,
  })
  const result = await sessions.promptReport('worker-subagent', 'report-1', '{}', 'steer')
  assert.equal(result.deadLetter, true)
  assert.equal(values.size, 1)
  assert.match([...values.keys()][0], /^company-dead-letter:/)
})

test('Worker 报告与 relay 在同一事务中持久化', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-report-atomic-'))
  const stateDir = join(root, 'state')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const context = {
    logger: { warn: () => {} },
    on: () => () => {},
    agents: { get: () => undefined },
    sessionController: { list: async () => ({ items: [{ sessionId: 'root', cwd }] }) },
    sessionPersistence: { flush: async () => {} },
    subprocess: { spawn: () => { throw new Error('本测试不应启动子进程') } },
  }
  const config = {
    maxWorkers: 1,
    workerPreset: 'ai-company-worker',
    routerPreset: 'standard',
    workerModel: null,
    operatorSessionId: null,
    executionMode: 'workspace',
    prepareCommand: '',
    blockedCommands: [],
    acceptanceTimeoutMs: 5000,
    shadow: { enabled: false, ledgerPath: join(stateDir, 'ledger.jsonl') },
    policy: { enforcement: 'shadow', requiredFields: [], profiles: {} },
    modelPolicy: { maxContextPressure: 0.9, candidates: [] },
  }
  const runtime = new CompanyRuntime(context, config, stateDir)
  t.after(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const created = await runtime.dispatch({
    task: '验证报告事务', goal: '报告原子性', cwd,
    scope: { allow: [cwd] }, acceptance: ['node -e "process.exit(0)"'], evidence: ['result.txt'], model_policy: 'keep',
  }, 'root')
  const definitions = new Map()
  const agent = { ctx: { tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } } } }
  runtime.sessions.registerReportTool(agent, created.ticketId)
  await definitions.get('orchestrator_report').execute({ state: 'ready', summary: '完成', evidence: ['result.txt'], checks: [] })
  assert.equal(runtime.store.tickets.get(created.ticketId).ended.outcome, 'completed')
  assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'relay'").get().n, 1)
  assert.equal(runtime.store.get(`company-reports:${created.ticketId}`).length, 1)
})
