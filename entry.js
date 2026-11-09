// AI-Company 公开 Bundle 入口：仅注册工具与 Runtime，不读取本机凭据。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CompanyRuntime } from './src/runtime.js'
import { readLedger, summarizeLedger } from './src/ledger.js'

export const inject = [
  'tools', 'agents', 'agentLoop', 'llm', 'sessionController', 'sessionPersistence',
  'workspaceRegistry', 'subprocess', 'systemPrompt',
]

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const json = (value) => JSON.parse(JSON.stringify(value))

function defaultStateDir() {
  const home = process.env.DSH_HOME?.trim()
  return home ? resolve(home, 'ai-company') : join(homedir(), '.dsh', 'ai-company')
}

function configure(config = {}) {
  const stateDir = config.stateDir ? resolve(config.stateDir) : defaultStateDir()
  return {
    stateDir,
    maxWorkers: Math.max(1, Math.min(32, Number(config.maxWorkers) || 3)),
    workerPreset: config.workerPreset ?? 'ai-company-worker',
    routerPreset: config.routerPreset ?? 'standard',
    workerModel: config.workerModel ?? null,
    operatorSessionId: config.operatorSessionId ?? null,
    executionMode: config.executionMode === 'directory' ? 'directory' : 'workspace',
    prepareCommand: config.prepareCommand ?? '',
    blockedCommands: Array.isArray(config.blockedCommands) ? config.blockedCommands : [],
    acceptanceTimeoutMs: Math.max(1000, Number(config.acceptanceTimeoutMs) || 120_000),
    shadow: {
      enabled: config.shadow?.enabled === true,
      ledgerPath: config.shadow?.ledgerPath ?? join(stateDir, 'dispatch-ledger.jsonl'),
    },
    policy: {
      enforcement: config.policy?.enforcement === 'enforce' ? 'enforce' : 'shadow',
      requiredFields: config.policy?.requiredFields ?? ['goal', 'scope', 'acceptance', 'evidence'],
      profiles: config.policy?.profiles ?? { default: 'core-values-v1' },
    },
    modelPolicy: {
      maxContextPressure: Number(config.modelPolicy?.maxContextPressure) || 0.9,
      candidates: Array.isArray(config.modelPolicy?.candidates) ? config.modelPolicy.candidates : [],
    },
  }
}

function registerTool(ctx, definition) {
  return ctx.tools.register({
    output: { schema: OUTPUT_SCHEMA, render },
    ...definition,
    async execute(args) {
      try {
        return json(await definition.execute(args))
      } catch (error) {
        return { ok: false, text: `${definition.name} 失败：${String(error?.message ?? error)}` }
      }
    },
  })
}

export function apply(ctx, supplied = {}) {
  const config = configure(supplied)
  const runtime = new CompanyRuntime(ctx, config, config.stateDir)

  ctx.effect(() => registerTool(ctx, {
    name: 'company_list',
    description: '列出 DSH 工作区（公司）、会话数量以及持久化工单数量，只读。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        include_sessions: { type: 'boolean', default: false },
      },
    },
    async execute(args) {
      const value = await ctx.sessionController.list({ _request: {} }, runtime.lifetime)
      const grouped = new Map()
      for (const session of value.items) {
        const cwd = session.cwd ?? '(unknown)'
        if (args.cwd && cwd !== args.cwd) continue
        const row = grouped.get(cwd) ?? { cwd, sessionCount: 0, runningCount: 0, blankCount: 0, sessions: [] }
        row.sessionCount += 1
        if (session.running) row.runningCount += 1
        if (session.blank) row.blankCount += 1
        if (args.include_sessions) row.sessions.push({
          sessionId: session.sessionId,
          running: session.running,
          blank: session.blank,
          title: session.projections?.values?.title ?? '(未命名)',
        })
        grouped.set(cwd, row)
      }
      const companies = [...grouped.values()].map((row) => ({
        ...row,
        sessions: args.include_sessions ? row.sessions : undefined,
        ticketCount: runtime.listTickets({ cwd: row.cwd, limit: 200 }).length,
      }))
      return { ok: true, companyCount: companies.length, companies }
    },
  }), 'ai-company: company_list')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_dispatch',
    description: '创建持久化公司工单并交给独立 Worker 执行。事务内写入 Trigger/Decision/Ticket/Assignment/launch effect；accepted 不等于完成。并行数由 maxWorkers 限制。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'goal', 'scope', 'acceptance', 'evidence'],
      properties: {
        task: { type: 'string', description: '完整任务正文。' },
        goal: { type: 'string', description: '可验收的一句话目标。' },
        scope: {
          type: 'object', additionalProperties: false, required: ['allow'],
          properties: {
            allow: { type: 'array', minItems: 1, items: { type: 'string' } },
            deny: { type: 'array', items: { type: 'string' } },
          },
        },
        acceptance: { type: 'array', minItems: 1, items: { type: 'string' }, description: '独立验收命令；company_verify 会重新执行。' },
        evidence: { type: 'array', minItems: 1, items: { type: 'string' }, description: '必须交付的证据路径或原始值位置。' },
        approvals: { type: 'array', items: { type: 'string' } },
        idempotency_key: { type: 'string' },
        batch_id: { type: 'string' },
        parent_ticket_id: { type: 'string', description: '可选父工单；部门 Worker 派发时自动记录，delegation_depth 最大为 3。' },
        sessionId: { type: 'string', description: '可选：用于解析公司 cwd、原模型和报告接收方；不会直接在该会话执行。' },
        cwd: { type: 'string', description: '公司工作区绝对路径；与 sessionId 至少提供一个。' },
        agentPreset: { type: 'string', description: '本工单 Worker preset，默认 ai-company-worker。' },
        execution_mode: { type: 'string', enum: ['workspace', 'directory'], description: 'workspace 使用公司 cwd；directory 使用独立空目录。' },
        model_policy: { type: 'string', enum: ['auto', 'keep'], default: 'auto' },
        provider: { type: 'string' },
        model: { type: 'string' },
        max_context_pressure: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    execute: (args) => runtime.dispatch(args, ctx.agents.currentInitiator()?.id ?? null),
  }), 'ai-company: company_dispatch')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_tickets',
    description: '列出持久化工单及其执行/验收状态，可按公司 cwd 过滤。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { cwd: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    },
    execute: (args) => ({ ok: true, tickets: runtime.listTickets(args) }),
  }), 'ai-company: company_tickets')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_collect',
    description: '收集一个工单的 Mandate、Assignment、Worker 报告、原始证据、验收命令和独立验证状态；不把 accepted 当完成。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ticket_id'],
      properties: { ticket_id: { type: 'string' } },
    },
    execute: (args) => runtime.collect(args.ticket_id),
  }), 'ai-company: company_collect')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_verify',
    description: '在工单目录独立重跑 acceptance 命令并核对 Worker 证据；全部命令为 0 且证据存在时才返回 verified。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ticket_id'],
      properties: {
        ticket_id: { type: 'string' },
        run_acceptance: { type: 'boolean', default: true },
        timeout_ms: { type: 'integer', minimum: 1000 },
      },
    },
    execute: (args) => runtime.verify(args.ticket_id, {
      runAcceptance: args.run_acceptance !== false,
      timeoutMs: args.timeout_ms,
    }),
  }), 'ai-company: company_verify')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_retry',
    description: '为 failed/blocked/投递失败的开放工单创建新 Assignment，保留原 Mandate 与历史，验收状态重置为 unverified。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ticket_id'],
      properties: { ticket_id: { type: 'string' } },
    },
    execute: (args) => runtime.retry(args.ticket_id),
  }), 'ai-company: company_retry')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_stop',
    description: '停止工单并撤销 Mandate；保留 Session、执行目录和审计记录。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ticket_id'],
      properties: { ticket_id: { type: 'string' }, reason: { type: 'string' } },
    },
    execute: (args) => runtime.stop(args.ticket_id, args.reason),
  }), 'ai-company: company_stop')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_policy',
    description: '查询公司当前价值规范 profile、必填任务信封与 shadow/enforce 模式，不修改配置。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { cwd: { type: 'string' } },
    },
    execute: (args) => ({ ok: true, ...runtime.policyFor(args.cwd) }),
  }), 'ai-company: company_policy')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_ledger',
    description: '读取可选复杂度/派发台账；默认 shadow.enabled=false，不记录任务文本。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }, summary_only: { type: 'boolean', default: false } },
    },
    execute: (args) => ({
      ok: true,
      enabled: config.shadow.enabled,
      path: config.shadow.ledgerPath,
      summary: summarizeLedger(config.shadow.ledgerPath),
      entries: config.shadow.enabled && !args.summary_only ? readLedger(config.shadow.ledgerPath, args.limit).entries : [],
    }),
  }), 'ai-company: company_ledger')

  ctx.effect(() => registerTool(ctx, {
    name: 'company_health',
    description: '读取 Runtime、Worker 与持久副作用队列健康状态。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: () => ({ ok: true, stateDir: config.stateDir, maxWorkers: config.maxWorkers, health: runtime.health() }),
  }), 'ai-company: company_health')

  ctx.effect(() => {
    runtime.start()
    return () => runtime.stop()
  })
}
