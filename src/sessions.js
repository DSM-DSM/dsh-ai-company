// DSH 原生 Session 管理：创建 Worker、幂等投递、注册工单工具与转发报告。
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import {
  AgentDelivery,
  initializeRoleModel,
  key,
  latestReport,
  liveTicket,
  mandateInstructions,
  messageId,
  ticketOfSession,
} from '../vendor/dsh-superagent/lib/company-kernel.js'

const WORK_TOOLS = [
  'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh',
  'job_output', 'job_list', 'job_kill', 'todo_write',
]
const REPORTS_KEY = (ticketId) => `company-reports:${ticketId}`
const textResult = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const page = (text, offset = 0, limit = 8000) => ({
  text: String(text ?? '').slice(offset, offset + limit),
  offset,
  chars: String(text ?? '').length,
  ...(offset + limit < String(text ?? '').length ? { next_offset: offset + limit } : {}),
})

/** 每个 Worker 只能读取自己的工单，不能借资源名窥探其他任务。 */
function ownResource(ticket, resource) {
  if (resource.startsWith(`ticket/${ticket.id}/`)) return true
  if (!resource.startsWith('trigger/')) return false
  const id = resource.slice('trigger/'.length)
  return ticket.origin.triggerIds.includes(id)
    || ticket.inputs.some((input) => input.kind === 'trigger' && input.triggerId === id)
}

export class CompanySessions {
  constructor({ context, store, effects, getEngine, config, lifetime }) {
    this.ctx = context
    this.store = store
    this.effects = effects
    this.getEngine = getEngine
    this.config = config
    this.lifetime = lifetime
    this.delivery = new AgentDelivery(context)
    this.bindings = new Map()
    this.disposers = []
    effects.handle('relay', ({ sessionId, text }, requestId) => this.promptReport(sessionId, requestId, text, 'steer'), { ordered: true })
    effects.handle('notice', ({ sessionId, text, summary }, requestId) => this.promptReport(sessionId, requestId, text, { inject: summary }), { ordered: true })
  }

  install() {
    this.disposers.push(this.ctx.on('agent/created', async ({ agent }) => {
      await this.decorate(agent)
      return undefined
    }))
    this.disposers.push(this.ctx.on('agent/disposed', ({ agent }) => this.release(agent)))
  }

  ticketOf(agent) {
    const id = ticketOfSession(agent.id)
    return id ? this.store.tickets.get(id) : undefined
  }

  modelFor(ticket) {
    const trigger = ticket && this.store.triggers.get(ticket.origin.triggerId)
    return trigger?.meta?.selectedModel ?? this.config.workerModel ?? null
  }

  async ensure(id, cwd, title, role = 'worker') {
    const ticketId = ticketOfSession(id)
    const storedTicket = ticketId ? this.store.tickets.get(ticketId) : undefined
    const storedTrigger = storedTicket && this.store.triggers.get(storedTicket.origin.triggerId)
    let result = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
        ?? await this.ctx.workspaceRegistry.create(cwd)
      await this.ctx.sessionController.create({
        sessionId: id,
        workspaceId: workspace.id,
        agentPreset: storedTrigger?.meta?.agentPreset
          ?? (role === 'worker' ? this.config.workerPreset : this.config.routerPreset),
      })
      result = await this.ctx.sessionController.resolveAgent(id)
    }
    if ('error' in result) throw result.error
    const ticket = this.ticketOf(result.agent)
    await initializeRoleModel(this.ctx, result.agent, this.modelFor(ticket))
    await this.decorate(result.agent)
    await this.ctx.sessionController.rename({ sessionId: id, title: `AI Company · ${title}` })
    return result.agent
  }

  async prompt(sessionId, requestId, text, mode = 'queue', authorize, accepted) {
    if (!sessionId) throw new Error('工单没有可接收报告的请求方 Session')
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) throw result.error
    await this.delivery.send(result.agent, key(requestId), text, mode, this.lifetime, authorize, accepted)
  }

  /** 报告专用投递：永久错误进入 dead-letter，不能阻塞 ordered relay；Worker 的任务投递仍原样抛错。 */
  async promptReport(sessionId, requestId, text, mode = 'queue') {
    try {
      return await this.prompt(sessionId, requestId, text, mode)
    } catch (error) {
      const code = error?.code ?? ''
      const message = String(error?.message ?? error)
      const permanent = code === 'session/not-found'
        || (code === 'session/agent-busy' && /subagent|ownership|routing|use subagent delivery/iu.test(message))
      if (!permanent) throw error
      const record = {
        at: new Date().toISOString(),
        sessionId,
        requestId,
        code,
        reason: message.slice(0, 1000),
        text: String(text).slice(0, 4000),
      }
      this.store.set(`company-dead-letter:${key(requestId)}`, record)
      this.ctx.logger?.warn?.(`ai-company: 报告投递进入 dead-letter：${code}`)
      return { deadLetter: true, ...record }
    }
  }

  promptedId(requestId) { return messageId(key(requestId)) }

  async holds(sessionId, requestId) {
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    return !('error' in result) && await this.delivery.holds(result.agent, key(requestId))
  }

  relay(id, text) {
    let parsed = {}
    try { parsed = JSON.parse(text) } catch { /* 旧格式只保留文本 */ }
    const ticket = parsed.ticket_id ? this.store.tickets.get(parsed.ticket_id) : undefined
    const trigger = ticket && this.store.triggers.get(ticket.origin.triggerId)
    const sessionId = trigger?.meta?.requesterSessionId ?? this.config.operatorSessionId
    if (sessionId) this.effects.enqueue('relay', id, { sessionId, text })
  }

  notify(name, value, summary) {
    const ticketId = typeof value.ticket_id === 'string' ? value.ticket_id : undefined
    const ticket = ticketId ? this.store.tickets.get(ticketId) : undefined
    const trigger = ticket && this.store.triggers.get(ticket.origin.triggerId)
    const sessionId = trigger?.meta?.requesterSessionId ?? this.config.operatorSessionId
    if (sessionId) this.effects.enqueue('notice', name, { sessionId, text: JSON.stringify(value), summary })
  }

  async decorate(agent) {
    if (this.bindings.has(agent)) return
    const ticket = this.ticketOf(agent)
    if (!ticket) return
    const binding = { disposers: [] }
    this.bindings.set(agent, binding)
    binding.disposers.push(agent.ctx.systemPrompt.section({
      name: 'ai-company-ticket-protocol',
      order: 9990,
      interpolate: false,
      text: () => {
        const current = this.store.tickets.get(ticket.id) ?? ticket
        return [
          'You are an AI-Company ticket worker. Work only inside the authorized mandate and declared scope.',
          'Read the full assignment with orchestrator_read when any text names a resource or is truncated.',
          'Run the acceptance checks yourself when possible and keep exact commands, exit codes and evidence paths.',
          'Call orchestrator_report with progress, ready, blocked, failed or dropped. A final prose message is not a verified result.',
          'For ready, include concrete evidence and checks. Never claim success from acceptance alone; independent verification happens later.',
          'If the task exceeds its mandate or needs an irreversible action not approved, stop and report blocked with one concrete question.',
          mandateInstructions(current.mandate),
        ].filter(Boolean).join('\n')
      },
    }))
    binding.disposers.push(this.registerReportTool(agent, ticket.id))
    binding.disposers.push(this.registerReadTool(agent, ticket.id))
    const parent = scopeParentOf(agent)
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    const managerTools = trigger?.meta?.agentPreset === 'ai-company-manager'
      ? ['company_dispatch', 'company_tickets', 'company_collect', 'company_verify', 'company_retry', 'company_stop']
      : []
    const allow = [...WORK_TOOLS, ...managerTools].filter((name) => agent.ctx.tools.get(name, parent))
    binding.disposers.push(agent.ctx.tools.restrict({ allow }))
    binding.disposers.push(agent.ctx.tools.guard(() => {
      const current = this.store.tickets.get(ticket.id)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    }))
  }

  registerReportTool(agent, ticketId) {
    return agent.ctx.tools.register({
      name: 'orchestrator_report',
      description: '回报工单 progress/ready/blocked/failed/dropped，并附原始证据与验收命令结果。ready 会结束执行，但不等于独立验证通过。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'summary'],
        properties: {
          state: { type: 'string', enum: ['progress', 'ready', 'blocked', 'failed', 'dropped'] },
          summary: { type: 'string', minLength: 1 },
          human_action: { type: ['string', 'null'], description: '需要人回答的一个具体问题；ready 时不得提供。' },
          evidence: { type: 'array', items: { type: 'string' }, description: '证据文件、原始值位置、日志或回执。' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['command', 'exit_code'],
              properties: {
                command: { type: 'string' },
                exit_code: { type: 'integer' },
                output: { type: 'string' },
              },
            },
          },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      execute: async (args) => {
        if (args.state === 'ready' && args.human_action) throw new Error('ready 不能同时携带人工问题')
        const evidence = (args.evidence ?? []).map((item) => String(item).trim()).filter(Boolean)
        if (args.state === 'ready' && evidence.length === 0) throw new Error('ready 必须至少提供一项非空证据，由 company_verify 独立复核')
        const current = this.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended; create a new authorized ticket instead')
        const record = {
          id: key('worker-report', ticketId, new Date().toISOString(), args.summary),
          at: new Date().toISOString(),
          state: args.state,
          summary: args.summary,
          evidence,
          checks: args.checks ?? [],
        }
        let updated
        this.store.atomic(() => {
          updated = this.getEngine().report(ticketId, {
            state: args.state,
            summary: args.summary,
            ...(args.human_action !== undefined && args.human_action !== null ? { question: args.human_action } : {}),
          })
          const reports = this.store.get(REPORTS_KEY(ticketId)) ?? []
          this.store.set(REPORTS_KEY(ticketId), [...reports, record])
          this.relay(`report:${record.id}`, JSON.stringify({
            kind: 'worker_report', ticket_id: ticketId, state: args.state, summary: args.summary,
            evidence: record.evidence, checks: record.checks,
          }))
        })
        return { reported: true, ticket_id: ticketId, state: args.state, ended: updated.ended ?? null }
      },
    })
  }

  registerReadTool(agent, ticketId) {
    return agent.ctx.tools.register({
      name: 'orchestrator_read',
      description: '读取本工单的完整任务、Mandate、输入或报告；resource 使用消息中给出的名称，offset/limit 用于分页。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['resource'],
        properties: {
          resource: { type: 'string', minLength: 1 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 8000, default: 4000 },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      execute: async ({ resource, offset = 0, limit = 4000 }) => {
        const ticket = this.store.tickets.get(ticketId)
        if (!ticket || !ownResource(ticket, resource)) throw new Error('该资源不存在，或不属于当前工单')
        if (resource.startsWith('trigger/')) {
          const trigger = this.store.triggers.get(resource.slice('trigger/'.length))
          if (!trigger) throw new Error('Trigger 不存在')
          return page(trigger.text, offset, limit)
        }
        if (resource === `ticket/${ticketId}/assignment`) return page(ticket.execution?.assignment ?? '', offset, limit)
        if (resource === `ticket/${ticketId}/mandate`) return page(JSON.stringify(ticket.mandate, null, 2), offset, limit)
        if (resource === `ticket/${ticketId}/result`) {
          return page(JSON.stringify({ ticket, latest_report: latestReport(ticket), reports: this.store.get(REPORTS_KEY(ticketId)) ?? [] }, null, 2), offset, limit)
        }
        const prefix = `ticket/${ticketId}/input/`
        if (resource.startsWith(prefix)) {
          const inputKey = resource.slice(prefix.length)
          const input = ticket.inputs.find((item) => key(item.id) === inputKey)
          if (!input) throw new Error('Input 不存在')
          const trigger = input.kind === 'trigger' ? this.store.triggers.get(input.triggerId) : undefined
          return page(input.kind === 'text' || input.kind === 'note' ? input.text : trigger?.text ?? JSON.stringify(input), offset, limit)
        }
        throw new Error('不支持的工单资源')
      },
    })
  }

  release(agent) {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch { /* Agent 已销毁，注册随作用域释放 */ }
    }
  }

  dispose() {
    for (const agent of [...this.bindings.keys()]) this.release(agent)
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
  }
}
