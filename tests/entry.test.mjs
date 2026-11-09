import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../entry.js'

test('Bundle apply 注册工具且只在卸载时停止 Runtime', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ai-company-entry-'))
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    agents: {
      currentInitiator: () => undefined,
      get: () => undefined,
    },
    sessionController: {
      list: async () => ({ items: [] }),
      modelCatalog: async () => ({ default: { provider: 'mock', model: 'default' }, groups: [] }),
    },
    sessionPersistence: { flush: async () => {} },
    workspaceRegistry: {},
    subprocess: { spawn: () => { throw new Error('本测试不应启动子进程') } },
  }
  apply(ctx, { stateDir })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    rmSync(stateDir, { recursive: true, force: true })
  })
  assert.equal(tools.size, 10)
  const health = await tools.get('company_health').execute({})
  assert.equal(health.ok, true)
  assert.equal(health.health.runtime.state, 'ready')
  const dispatched = await tools.get('company_dispatch').execute({
    task: '入口生命周期测试', goal: '入口可用', cwd: stateDir,
    scope: { allow: [stateDir] }, acceptance: ['node -e "process.exit(0)"'], evidence: ['result.txt'], model_policy: 'keep',
  })
  assert.equal(dispatched.accepted, true)
  const tickets = await tools.get('company_tickets').execute({})
  assert.equal(tickets.tickets.length, 1)
})
