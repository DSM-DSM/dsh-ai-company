// AI-Company 原生 Runtime：公司任务入口 + Super-agent 工单内核 + 独立验收。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  DshExecutor,
  Effects,
  Engine,
  HealthBoard,
  key,
  latestReport,
  ticketOfSession,
  ticketStage,
  workerSessionId,
} from '../vendor/dsh-superagent/lib/company-kernel.js'
import { CompanyStore } from './store.js'
import { CompanySessions } from './sessions.js'
import { CompanyOutbox } from './outbox.js'
import { evaluatePolicy, validateEnvelope } from './policy-check.js'
import { resolveProfile } from './policy-profiles.js'
import { estimateTaskComplexity, probeWorkspace } from './complexity.js'
import { createModelPolicy } from './model-policy.js'
import { appendLedger } from './ledger.js'

const REPORTS_KEY = (ticketId) => `company-reports:${ticketId}`
const VERIFY_KEY = (ticketId) => `company-verification:${ticketId}`
const AUDIT_KEY = (ticketId) => `company-audit:${ticketId}`
const IDEMPOTENCY_KEY = (value) => `company-idempotency:${value}`
const errorText = (error) => String(error?.message ?? error)
const safeJson = (value) => JSON.parse(JSON.stringify(value))

function taskDocument({ task, goal, scope, acceptance, evidence, approvals, batchId }) {
  return [
    `GOAL\n${goal}`,
    `TASK\n${task}`,
    `SCOPE\n${JSON.stringify(scope, null, 2)}`,
    `ACCEPTANCE COMMANDS\n${acceptance.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    `REQUIRED EVIDENCE\n${evidence.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    approvals.length ? `APPROVALS\n${approvals.map((item) => `- ${item}`).join('\n')}` : '',
    batchId ? `BATCH\n${batchId}` : '',
  ].filter(Boolean).join('\n\n')
}

function directoryName(goal) {
  const safe = String(goal).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
  return safe || 'company-task'
}

function normalizeLocator(value) {
  return String(value).trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

/** 区分文件证据与原始值定位；Windows 盘符、Unix 路径、file: 前缀和常见扩展名按文件处理。 */
function evidenceFileStatus(value, directory) {
  const raw = String(value).trim()
  const explicit = raw.startsWith('file:') ? raw.slice('file:'.length) : null
  const rawLocator = raw.includes('://') || /^(?:metric|run|record|log|json|url|dataset|experiment):/iu.test(raw)
  const looksLikeFile = explicit !== null || /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('/')
    || (!rawLocator && (raw.includes('/') || raw.includes('\\') || /^[^\\/:*?"<>|]+\.[A-Za-z0-9]{1,16}$/u.test(raw)))
  if (rawLocator && explicit === null) return { kind: 'locator', exists: true }
  if (!looksLikeFile) return { kind: 'locator', exists: true }
  const candidate = explicit ?? raw
  const path = isAbsolute(candidate) ? resolve(candidate) : resolve(directory, candidate)
  if (!isAbsolute(candidate)) {
    const rel = relative(resolve(directory), path)
    if (rel.startsWith('..') || isAbsolute(rel)) return { kind: 'file', path, exists: false, reason: '相对证据路径越过工单目录' }
  }
  return { kind: 'file', path, exists: existsSync(path) }
}

/** 将 subagent 的报告接收方规范化为最近的普通祖先 Session，防止普通 Session API 的 ownership 拒绝。 */
export function nearestOrdinarySession(candidate, summaries) {
  if (!candidate) return { ok: true, sessionId: null, redirected: false }
  const byId = new Map(summaries.map((item) => [item.sessionId, item]))
  const seen = new Set()
  let current = candidate
  while (current) {
    if (seen.has(current)) return { ok: false, reason: 'Session 父子关系形成循环' }
    seen.add(current)
    const summary = byId.get(current)
    if (!summary) return { ok: false, reason: `报告接收 Session 不存在或不可见：${current}` }
    if (summary.origin !== 'subagent') return { ok: true, sessionId: current, redirected: current !== candidate }
    if (!summary.parentSessionId) return { ok: false, reason: `subagent ${current} 没有可用的普通祖先 Session` }
    current = summary.parentSessionId
  }
  return { ok: true, sessionId: null, redirected: false }
}

export class CompanyRuntime {
  constructor(ctx, config, stateDir) {
    this.ctx = ctx
    this.config = config
    this.stateDir = stateDir
    this.closingFlag = false
    this.pausedFlag = false
    this.abort = new AbortController()
    this.lifetime = this.abort.signal
    this.modelPolicy = createModelPolicy(ctx, config.modelPolicy)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const report = (error) => ctx.logger.warn('ai-company: %s', errorText(error))
    this.store = new CompanyStore(join(stateDir, 'company.sqlite'), report)
    const current = this.store.settings() ?? {}
    this.store.saveSettings({
      paused: false,
      sources: { company: { enabled: true, config: {} } },
      policy: { rules: [], sources: { company: { allowed: [{ id: 'local-operator' }], admission: {} } } },
      eval: { mode: 'off', timeoutSeconds: 120, model: null },
      ...current,
      executor: {
        model: null,
        maxWorkers: config.maxWorkers,
        directory: '',
        prepare: config.prepareCommand,
        blockedCommands: config.blockedCommands,
        ...(current.executor ?? {}),
        maxWorkers: config.maxWorkers,
        prepare: config.prepareCommand,
        blockedCommands: config.blockedCommands,
      },
    })
    this.board = new HealthBoard()
    this.effects = new Effects(this.store, this.board)
    const runtime = this
    this.sessions = new CompanySessions({
      context: ctx,
      store: this.store,
      effects: this.effects,
      getEngine: () => runtime.engine,
      config,
      lifetime: this.lifetime,
    })
    this.executor = new DshExecutor({
      context: ctx,
      get engine() { return runtime.engine },
      store: this.store,
      effects: this.effects,
      health: this.board.claim('worker'),
      machine: { stateDir },
      lifetime: this.lifetime,
      sessions: this.sessions,
      closing: () => this.closing(),
      paused: () => this.paused(),
      environment: (ticket) => this.environment(ticket),
      sourceLink: async () => ({}),
      repliedTo: () => undefined,
    })
    this.outbox = new CompanyOutbox({
      store: this.store,
      effects: this.effects,
      sessions: this.sessions,
      paused: () => this.paused(),
    })
    const scope = {
      scope: ({ source }) => source === 'company'
        ? { listened: true, observed: false, row: 'dispatch' }
        : { listened: false, reason: 'unknownSource' },
    }
    this.engine = new Engine({
      repo: this.store,
      scope,
      policy: () => this.policy(),
      assessor: { request: () => { throw new Error('AI-Company 内部显式任务不需要模型 Eval') } },
      executor: this.executor,
      outbox: this.outbox,
      prepareTicket: (ticket, outcome) => this.prepareTicket(ticket, outcome),
      emit: (event) => this.recordDomainEvent(event),
    })
  }

  policy() {
    const runtime = this
    return {
      version: 'ai-company-explicit-v1',
      get paused() { return runtime.paused() },
      evalTimeoutMs: 120_000,
      gate(trigger) {
        const valid = trigger.source === 'company' && trigger.human && trigger.addressed === 'direct'
          && trigger.actor?.source === 'company' && trigger.actor?.id === 'local-operator'
        return valid
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', source: 'company', row: 'dispatch', sender: 'local-operator' } }
          : { admissible: false, reason: 'notAdmitted' }
      },
      revalidate(mandate) {
        return mandate.actor?.source === 'company' && mandate.actor?.id === 'local-operator'
          && mandate.basis?.via === 'addressed' && mandate.strength === 'explicit'
      },
      admitsInferred: () => false,
    }
  }

  start() {
    this.sessions.install()
    this.executor.install()
    this.executor.resume()
    this.effects.start()
    this.board.claim('runtime', { state: 'ready', detail: 'AI-Company runtime is ready', at: new Date().toISOString() })
  }

  closing() { return this.closingFlag }
  paused() { return this.pausedFlag || this.closingFlag }

  environment(ticket) {
    const values = {
      DSH_SUPERAGENT_DIR: ticket.execution?.directory ?? '',
      DSH_SUPERAGENT_NAME: ticket.execution?.name ?? '',
      DSH_SUPERAGENT_TICKET: ticket.id,
      DSH_SUPERAGENT_BLOCKED_COMMANDS: this.config.blockedCommands.join(' '),
    }
    return Object.entries(values).map(([keyName, value]) => ({ key: keyName, value, description: 'AI-Company ticket execution variable', owner: 'ai-company' }))
  }

  prepareTicket(ticket, outcome) {
    const prepared = this.executor.prepare(ticket, outcome)
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    const mode = trigger?.meta?.executionMode ?? this.config.executionMode
    const directory = mode === 'workspace' ? trigger.meta.cwd : prepared.execution.directory
    return {
      ...prepared,
      execution: {
        ...prepared.execution,
        directory,
        assignment: trigger?.meta?.taskDocument ?? prepared.execution.assignment,
      },
    }
  }

  recordDomainEvent(event) {
    if (!event.data?.ticketId) return
    const ticketId = event.data.ticketId
    const history = this.store.get(AUDIT_KEY(ticketId)) ?? []
    this.store.set(AUDIT_KEY(ticketId), [...history, event])
  }

  async resolveTarget(args) {
    const sessionId = args.sessionId
    const candidate = sessionId ?? args.requesterSessionId ?? this.config.operatorSessionId ?? null
    let summary
    let summaries = []
    if (sessionId || candidate) {
      const value = await this.ctx.sessionController.list({ _request: {} }, this.lifetime)
      summaries = value.items
    }
    if (sessionId) {
      summary = summaries.find((item) => item.sessionId === sessionId)
      if (!summary) throw new Error('目标 sessionId 不存在或不可见')
    }
    const requester = nearestOrdinarySession(candidate, summaries)
    if (!requester.ok) throw new Error(requester.reason)
    const cwd = args.cwd ?? summary?.cwd
    if (!cwd || !isAbsolute(cwd)) throw new Error('必须提供绝对路径 cwd，或一个能解析出 cwd 的 sessionId')
    return {
      cwd: resolve(cwd),
      summary,
      requesterSessionId: requester.sessionId,
      requesterOriginalSessionId: candidate,
      requesterRedirected: requester.redirected,
    }
  }

  async dispatch(args, requesterSessionId) {
    if (this.paused()) return { ok: false, accepted: false, text: 'AI-Company 正在停止或暂停，未创建工单' }
    const task = String(args.task ?? '').trim()
    const goal = String(args.goal ?? '').trim()
    const scope = args.scope ?? {}
    const acceptance = Array.isArray(args.acceptance) ? args.acceptance.filter((item) => typeof item === 'string' && item.trim()) : []
    const evidence = Array.isArray(args.evidence) ? args.evidence.map((item) => String(item).trim()).filter(Boolean) : []
    const approvals = Array.isArray(args.approvals) ? args.approvals : []
    const missing = validateEnvelope({ goal, scope, acceptance, evidence })
    if (!task) missing.push('task')
    if (missing.length) return { ok: false, accepted: false, policyRejected: true, missing, text: `任务信封缺少 ${missing.join('、')}` }
    const parentTicketId = args.parent_ticket_id ?? ticketOfSession(requesterSessionId ?? '')
    const parentTicket = parentTicketId ? this.store.tickets.get(parentTicketId) : undefined
    if (parentTicketId && !parentTicket) return { ok: false, accepted: false, text: `父工单不存在：${parentTicketId}` }
    const parentTrigger = parentTicket && this.store.triggers.get(parentTicket.origin.triggerId)
    const delegationDepth = parentTicket ? Number(parentTrigger?.meta?.delegationDepth ?? 0) + 1 : 0
    if (delegationDepth > 3) return { ok: false, accepted: false, text: '已达到 delegation_depth=3 的组织上限，未创建子工单' }
    const target = await this.resolveTarget({ ...args, requesterSessionId })
    const profile = resolveProfile(target.cwd, this.config.policy)
    const idempotencyKey = String(args.idempotency_key ?? '').trim() || createHash('sha256')
      .update(JSON.stringify({
        cwd: target.cwd,
        goal,
        task,
        scope,
        acceptance,
        evidence,
        approvals,
        batchId: String(args.batch_id ?? '').trim(),
        executionMode: args.execution_mode ?? this.config.executionMode,
        agentPreset: args.agentPreset ?? this.config.workerPreset,
      })).digest('hex').slice(0, 32)
    const policyReport = evaluatePolicy({
      task, goal, scope, acceptance, evidence, approvals,
      cwd: target.cwd,
      sessionId: args.sessionId,
      profile,
      ledgerEntries: [],
      idempotencyKey,
    })
    if (this.config.policy.enforcement === 'enforce' && policyReport.wouldBlock) {
      return { ok: false, accepted: false, policyRejected: true, policyReport, text: '任务被当前价值规范拒绝，未创建 Worker' }
    }
    if (this.store.get(IDEMPOTENCY_KEY(idempotencyKey))) {
      const existing = this.store.get(IDEMPOTENCY_KEY(idempotencyKey))
      return { ok: true, accepted: true, duplicate: true, ...existing, policyReport, text: '同一幂等键已有工单，未重复派发' }
    }
    const explicit = args.provider ? { provider: args.provider, model: args.model } : null
    if (Boolean(args.provider) !== Boolean(args.model)) return { ok: false, accepted: false, modelBlocked: true, text: 'provider 与 model 必须一起提供' }
    const modelDecision = args.model_policy === 'keep'
      ? { ok: true, changed: false, selection: null, reason: '调用方要求保留 DSH 默认模型' }
      : await this.modelPolicy.evaluate({ summary: target.summary, explicit, thresholds: args })
    if (!modelDecision.ok) return { ok: false, accepted: false, modelBlocked: true, modelDecision, policyReport, text: modelDecision.reason }

    let shadow = null
    if (this.config.shadow.enabled) {
      try {
        const workspace = await probeWorkspace(target.cwd)
        shadow = estimateTaskComplexity({ task, summary: target.summary, workspace, sessionsInCwd: 0 })
      } catch (error) {
        shadow = { error: errorText(error) }
      }
    }
    const batchId = String(args.batch_id ?? '').trim()
    const document = taskDocument({ task, goal, scope, acceptance, evidence, approvals, batchId })
    const triggerId = key('company-trigger', idempotencyKey)
    const threadId = createHash('sha256').update(`${target.cwd}|${idempotencyKey}`).digest('hex').slice(0, 24)
    const trigger = {
      id: triggerId,
      source: 'company',
      threads: [{ source: 'company', id: threadId }],
      actor: { source: 'company', id: 'local-operator' },
      human: true,
      addressed: 'direct',
      at: new Date().toISOString(),
      text: document,
      ...(target.requesterSessionId ? { channel: { source: 'company', thread: `company:${threadId}`, address: { sessionId: target.requesterSessionId } } } : {}),
      meta: {
        task,
        goal,
        scope,
        acceptance,
        evidence,
        approvals,
        batchId,
        idempotencyKey,
        parentTicketId: parentTicket?.id ?? null,
        delegationDepth,
        cwd: target.cwd,
        requesterSessionId: target.requesterSessionId,
        requesterOriginalSessionId: target.requesterOriginalSessionId,
        requesterRedirected: target.requesterRedirected,
        taskDocument: document,
        executionMode: args.execution_mode ?? this.config.executionMode,
        agentPreset: args.agentPreset ?? this.config.workerPreset,
        selectedModel: modelDecision.selection ? { provider: modelDecision.selection.provider, model: modelDecision.selection.model } : null,
        shadow,
        policyReport,
      },
    }
    const result = this.store.atomic(() => {
      const previous = this.store.get(IDEMPOTENCY_KEY(idempotencyKey))
      if (previous) return { duplicate: true, ...previous }
      this.engine.receive(trigger)
      const decision = this.engine.decide(triggerId, {
        kind: 'accept',
        title: goal,
        scope: JSON.stringify({ goal, scope, acceptance, evidence, approvals }),
        reason: 'AI-Company explicit dispatch',
        name: directoryName(goal),
        note: batchId ? `Batch: ${batchId}` : undefined,
        audit: { shadow, policyReport, modelDecision },
      })
      const ticketId = decision.ticketId
      const receipt = { ticketId, triggerId, sessionId: workerSessionId(ticketId), acceptedAt: new Date().toISOString() }
      this.store.set(IDEMPOTENCY_KEY(idempotencyKey), receipt)
      this.store.set(VERIFY_KEY(ticketId), { status: 'unverified', evidence: [], checks: [] })
      return receipt
    })
    if (result.duplicate) return { ok: true, accepted: true, ...result, policyReport, text: '同一幂等键已有工单，未重复派发' }
    const ledgerRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ok: true,
      accepted: true,
      ticketId: result.ticketId,
      sessionId: result.sessionId,
      cwd: target.cwd,
      goal,
      scope,
      acceptance,
      evidence,
      approvals,
      idempotencyKey,
      batchId,
      shadow,
      policyReport,
      modelDecision,
      actualModel: modelDecision.selection,
      modelChanged: Boolean(modelDecision.changed),
    }
    let ledger = null
    if (this.config.shadow.enabled) ledger = { path: appendLedger(this.config.shadow.ledgerPath, ledgerRecord) }
    return {
      ok: true,
      accepted: true,
      duplicate: false,
      ...result,
      cwd: target.cwd,
      reporting: {
        sessionId: target.requesterSessionId,
        originalSessionId: target.requesterOriginalSessionId,
        redirectedToOrdinaryAncestor: target.requesterRedirected,
      },
      modelDecision,
      shadowDecision: shadow,
      policyReport,
      ledger,
      text: `已创建工单 ${result.ticketId}；accepted 仅表示已持久化并排入执行队列，不代表完成。`,
    }
  }

  verification(ticketId) {
    return this.store.get(VERIFY_KEY(ticketId)) ?? { status: 'unverified', evidence: [], checks: [] }
  }

  ticketSummary(ticket) {
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    return {
      ticketId: ticket.id,
      title: ticket.title,
      goal: trigger?.meta?.goal ?? ticket.title,
      cwd: trigger?.meta?.cwd ?? null,
      sessionId: workerSessionId(ticket.id),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      stage: ticketStage(ticket),
      ended: ticket.ended ?? null,
      latestReport: latestReport(ticket) ?? null,
      verification: this.verification(ticket.id),
      batchId: trigger?.meta?.batchId || null,
      parentTicketId: trigger?.meta?.parentTicketId ?? null,
      delegationDepth: trigger?.meta?.delegationDepth ?? 0,
    }
  }

  listTickets({ cwd, limit = 50 } = {}) {
    return this.store.tickets.list()
      .filter((ticket) => !cwd || this.store.triggers.get(ticket.origin.triggerId)?.meta?.cwd === cwd)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((ticket) => this.ticketSummary(ticket))
  }

  collect(ticketId) {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return { ok: false, text: '工单不存在', ticketId }
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    return {
      ok: true,
      ...this.ticketSummary(ticket),
      mandate: ticket.mandate,
      execution: ticket.execution ?? null,
      assignments: ticket.assignments,
      evidence: this.store.get(REPORTS_KEY(ticketId)) ?? [],
      acceptance: trigger?.meta?.acceptance ?? [],
      requiredEvidence: trigger?.meta?.evidence ?? [],
      audit: this.store.get(AUDIT_KEY(ticketId)) ?? [],
      model: trigger?.meta?.selectedModel ?? null,
      shadow: trigger?.meta?.shadow ?? null,
    }
  }

  async runAcceptance(command, directory, timeoutMs) {
    const argv = process.platform === 'win32'
      ? ['pwsh', '-NoProfile', '-Command', command]
      : ['sh', '-c', command]
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(timeoutMs)])
    try {
      const handle = this.ctx.subprocess.spawn({
        argv,
        cwd: directory,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 262144 },
          stderr: { maxBytes: 65536 },
        },
        graceMs: 3000,
        signal,
      })
      const outcome = await handle.done
      return {
        command,
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text?.slice(-16_000) ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text?.slice(-8000) ?? '',
      }
    } catch (error) {
      return { command, exitCode: null, error: errorText(error) }
    }
  }

  async verify(ticketId, { runAcceptance = true, timeoutMs } = {}) {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return { ok: false, verified: false, text: '工单不存在', ticketId }
    if (ticket.ended?.outcome !== 'completed') {
      return { ok: false, verified: false, status: 'unverified', text: '只有执行器报告 completed 的工单才能进入独立验收', ticketId }
    }
    const previous = this.verification(ticketId)
    if (previous.status === 'verified' && !runAcceptance) return { ok: true, ...previous, ticketId }
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    const reports = this.store.get(REPORTS_KEY(ticketId)) ?? []
    const workerEvidence = reports.flatMap((report) => report.evidence ?? [])
    const commands = trigger?.meta?.acceptance ?? []
    const checks = []
    if (runAcceptance) {
      for (const command of commands) {
        const check = await this.runAcceptance(command, ticket.execution?.directory ?? trigger.meta.cwd, timeoutMs ?? this.config.acceptanceTimeoutMs)
        checks.push({ acceptance: command, ...check })
      }
    }
    const requiredEvidence = trigger?.meta?.evidence ?? []
    const normalizedWorkerEvidence = workerEvidence.map(normalizeLocator)
    const evidenceCoverage = requiredEvidence.map((required) => ({
      required,
      coveredBy: normalizedWorkerEvidence.filter((candidate) => candidate === normalizeLocator(required)),
      ...evidenceFileStatus(required, ticket.execution?.directory ?? trigger.meta.cwd),
    }))
    const evidenceComplete = requiredEvidence.length > 0
      && evidenceCoverage.every((item) => item.coveredBy.length > 0 && item.exists)
    const passed = runAcceptance && commands.length > 0 && checks.every((check) => check.exitCode === 0)
    const verified = passed && evidenceComplete
    const result = {
      status: verified ? 'verified' : runAcceptance ? 'failed' : 'unverified',
      independent: runAcceptance,
      verifiedAt: verified ? new Date().toISOString() : null,
      checkedAt: new Date().toISOString(),
      evidence: workerEvidence,
      requiredEvidence,
      evidenceCoverage,
      checks,
      reason: verified
        ? '全部独立验收命令退出码为 0，且所有必需证据均已覆盖'
        : !workerEvidence.length
          ? 'Worker 尚未提供可定位证据'
          : !evidenceComplete
            ? '至少一项必需证据未被精确覆盖，或文件证据不存在'
            : !runAcceptance
              ? '尚未运行独立验收命令'
              : '至少一条独立验收命令未通过',
    }
    this.store.set(VERIFY_KEY(ticketId), result)
    return { ok: verified, verified, ticketId, ...result }
  }

  retry(ticketId) {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return { ok: false, text: '工单不存在', ticketId }
    const updated = this.store.atomic(() => {
      this.store.set(VERIFY_KEY(ticketId), { status: 'unverified', evidence: [], checks: [] })
      return this.engine.retryTicket(ticketId)
    })
    return { ok: true, ticketId, ...this.ticketSummary(updated), text: '已创建新的 Assignment；仍需重新执行与验收' }
  }

  stop(ticketId, reason) {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return { ok: false, text: '工单不存在', ticketId }
    const updated = this.engine.stopTicket(ticketId, reason)
    return { ok: true, ...this.ticketSummary(updated) }
  }

  policyFor(cwd) {
    const profile = resolveProfile(cwd, this.config.policy)
    return {
      profile,
      enforcement: { mode: this.config.policy.enforcement, requiredFields: this.config.policy.requiredFields },
    }
  }

  health() { return safeJson(this.board.all) }

  async stop() {
    if (this.closingFlag) return
    this.closingFlag = true
    this.abort.abort()
    await Promise.allSettled([this.effects.drain(), this.executor.shutdown()])
    this.executor.dispose()
    this.sessions.dispose()
    await this.ctx.sessionPersistence.flush()
    this.store.close()
  }
}
