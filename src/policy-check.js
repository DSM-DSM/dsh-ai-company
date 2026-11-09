// 价值规范检查：只产出 policyReport，是否阻断由调用方按 enforcement 决定。
const DESTRUCTIVE = /删除|清空|覆盖|移除|rm\s+-rf|kill|scancel|重训|重新训练|retrain|drop\s+table|truncate|git\s+add\s+-A|强制提交/iu
const DOWNLOAD = /下载|传输|同步|rsync|scp|sftp|大文件|拉取|回传/iu
const ABSOLUTE = /一定|保证|绝对|完全正确|全部完成|确保完成|肯定|毫无疑问|百分之百/iu
const BROAD_SCOPE = /替代方案|另一套|另一份|顺便|全部|所有|整个|全仓|全库|新会话|额外训练/iu
const ROLE_HINTS = [
  { role: 'web', pattern: /网页|组会|web_receipt|weekly_updates/iu },
  { role: 'qc', pattern: /质控|复核|qc_confirm|confirmed|验收/iu },
  { role: 'summary', pattern: /汇总|summary_receipt|实验结果汇总/iu },
  { role: 'repo', pattern: /仓库|索引|repo_archive|codegraph|aoci/iu },
]

const asArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []

export function validateEnvelope({ goal, scope, acceptance, evidence }) {
  const missing = []
  if (!String(goal ?? '').trim()) missing.push('goal')
  if (!scope || !Array.isArray(scope.allow) || scope.allow.filter((item) => typeof item === 'string' && item.trim()).length === 0) {
    missing.push('scope.allow')
  }
  if (asArray(acceptance).length === 0) missing.push('acceptance')
  if (asArray(evidence).length === 0) missing.push('evidence')
  return missing
}

function taskKind(goal, task) {
  const text = `${goal ?? ''} ${task ?? ''}`
  for (const hint of ROLE_HINTS) {
    if (hint.pattern.test(text)) return hint.role
  }
  if (/训练|gpu|实验|eval|跑臂|slurm/iu.test(text)) return 'research'
  if (/代码|函数|脚本|bug|编译/iu.test(text)) return 'code'
  return 'general'
}

function minutesInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

function parseClock(value) {
  const [hour, minute] = String(value).split(':').map(Number)
  return hour * 60 + minute
}

function inQuietWindow(now, profile) {
  const current = minutesInTimeZone(now, profile.timeZone ?? 'Asia/Shanghai')
  for (const window of profile.quietWindows ?? []) {
    const start = parseClock(window.start)
    const end = parseClock(window.end)
    const inside = start <= end
      ? current >= start && current < end
      : current >= start || current < end
    if (inside) return window
  }
  return null
}

function hasApproval(approvals, pattern) {
  return asArray(approvals).some((item) => pattern.test(item))
}

function roleOwner(profile, sessionId) {
  return Object.entries(profile.roles ?? {})
    .find(([, id]) => id === sessionId)?.[0] ?? null
}

/**
 * 评估十条价值规范。影子模式下 wouldBlock 只作为建议，不阻断派发。
 * @param {object} input
 * @returns {object}
 */
export function evaluatePolicy({
  task,
  goal,
  scope,
  acceptance,
  evidence,
  approvals,
  cwd,
  sessionId,
  profile,
  ledgerEntries = [],
  idempotencyKey,
  now = new Date(),
}) {
  const findings = []
  const normStatus = Object.fromEntries((profile.norms ?? []).map((norm) => [norm.id, 'pass']))
  const add = (normId, wouldBlock, reason) => {
    const norm = (profile.norms ?? []).find((item) => item.id === normId)
    if (!norm) return
    findings.push({
      norm: norm.id,
      key: norm.key,
      title: norm.title,
      severity: norm.severity,
      wouldBlock: Boolean(wouldBlock),
      reason,
    })
    normStatus[norm.id] = wouldBlock ? 'would-block' : 'finding'
  }

  const missing = validateEnvelope({ goal, scope, acceptance, evidence })
  if (missing.length > 0) {
    add('V1', true, `任务信封缺少字段：${missing.join('、')}`)
  }

  const destructive = DESTRUCTIVE.test(`${goal ?? ''}\n${task ?? ''}`)
  if (destructive && !hasApproval(approvals, /删除|覆盖|kill|重训|提交|授权|approve/iu)) {
    add('V3', true, '任务包含删除/覆盖/重训/提交等不可逆动作，但没有 approvals')
  }

  if (idempotencyKey) {
    const duplicate = ledgerEntries.find((entry) => entry.idempotencyKey === idempotencyKey && entry.ok !== false)
    if (duplicate) add('V4', true, `同一唯一键已有台账记录：${duplicate.id ?? 'unknown'}`)
  }

  const owner = roleOwner(profile, sessionId)
  const kind = taskKind(goal, task)
  if (owner && kind !== 'general' && owner !== kind) {
    add('V5', true, `任务类型 ${kind} 与目标角色 ${owner} 不匹配`)
  }

  if (DOWNLOAD.test(`${goal ?? ''}\n${task ?? ''}`)) {
    const window = inQuietWindow(now, profile)
    if (window) {
      add('V7', true, `当前处于 ${window.start}–${window.end}（${window.reason}）；该时段为下载硬禁，不接受普通任务授权绕过`)
    }
  }

  const allow = asArray(scope?.allow)
  const broadPath = allow.some((item) => /^[a-z]:[\\/]?$/iu.test(item) || item === '/' || item === '**' || item === '*')
  if (broadPath || BROAD_SCOPE.test(`${goal ?? ''}\n${task ?? ''}`)) {
    add('V8', true, 'scope 或任务文本显示可能超出最小范围，请确认边界')
  }

  if (ABSOLUTE.test(`${goal ?? ''}\n${task ?? ''}`)) {
    add('V10', true, '任务包含绝对化表述，需要证据或改成可验证的措辞')
  }

  // 这三条只能在结果阶段验证；派发阶段明确标记 deferred，而不是假装通过。
  for (const id of ['V2', 'V6', 'V9']) {
    if (normStatus[id] === 'pass') normStatus[id] = 'deferred'
  }

  return {
    version: 'policy-shadow-v1',
    profile: profile.id,
    mode: 'shadow',
    enforced: false,
    cwd: cwd ?? null,
    sessionId: sessionId ?? null,
    taskKind: kind,
    requiredFields: ['goal', 'scope', 'acceptance', 'evidence'],
    missing,
    findings,
    wouldBlock: findings.some((finding) => finding.wouldBlock),
    normStatus,
    checkedAt: now.toISOString(),
  }
}
