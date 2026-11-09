import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/repo-manage-entry.js'

function fixture(root, config = {}) {
  const tools = new Map()
  const calls = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    subprocess: {
      spawn: (spec) => {
        calls.push(spec)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: 'CODEGRAPH_OK', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    },
    workspaceRegistry: {},
    sessionController: {},
    logger: { warn: () => {}, info: () => {} },
  }
  apply(ctx, {
    codegraphCommand: 'node',
    codegraphShim: '/mock/codegraph.js',
    companies: { demo: join(root, 'workspace') },
    allowedRoots: [root],
    ...config,
  })
  return { tools, calls }
}

test('资产查询传递 maxFiles，索引默认 dry-run', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-repo-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { tools, calls } = fixture(root)
  const query = await tools.get('company_repo_query').execute({ company: 'demo', query: 'Engine', maxFiles: 7 })
  assert.equal(query.ok, true)
  assert.deepEqual(calls[0].argv, ['node', '/mock/codegraph.js', 'explore', '--max-files', '7', 'Engine'])
  assert.equal(calls[0].env, undefined)
  const index = await tools.get('company_repo_index').execute({ company: 'demo', target: 'codegraph' })
  assert.equal(index.executed, false)
  assert.equal(calls.length, 1)
})

test('allowedRoots 拒绝越界公司路径', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'ai-company-outside-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const { tools } = fixture(root)
  await assert.rejects(
    tools.get('company_repo_status').execute({ company: outside }),
    /allowedRoots/,
  )
})

test('批量公司入口也执行 allowedRoots', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-company-batch-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'ai-company-batch-outside-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const { tools } = fixture(root, { companies: { inside: join(root, 'workspace'), outside } })
  await assert.rejects(tools.get('company_repo_status').execute({}), /allowedRoots/)
  await assert.rejects(tools.get('company_repo_provision').execute({ all: true }), /allowedRoots/)
})
