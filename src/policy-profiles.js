// 可跨公司复用的价值规范；公司内部项目规则由使用者在配置中另行提供。
export const CORE_NORMS = [
  { id: 'V1', key: 'evidence-before-claim', title: '证据主义', severity: 'hard', stages: ['dispatch', 'collect', 'report'], statement: '完成、通过或正确的结论必须能回到原始数据、日志、文件、回执或复算证据。' },
  { id: 'V2', key: 'completion-is-verified', title: '完成可验证', severity: 'hard', stages: ['dispatch', 'collect'], statement: 'accepted、已排队或已开始不等于完成；完成必须经过验收或独立复核。' },
  { id: 'V3', key: 'no-irreversible-without-approval', title: '可恢复性优先', severity: 'hard', stages: ['dispatch'], statement: '删除、覆盖、杀进程、重训和提交不可逆动作必须显式授权并保留恢复证据。' },
  { id: 'V4', key: 'plan-then-commit', title: '先规划后承诺', severity: 'hard', stages: ['dispatch'], statement: '先规划、查重、查在跑与已有产物，再分配资源；能复用不重复。' },
  { id: 'V5', key: 'role-and-handoff-gates', title: '角色与门禁', severity: 'hard', stages: ['dispatch', 'collect'], statement: '只由被授权角色执行对应动作，跨角色交接按批次和回执门禁进行。' },
  { id: 'V6', key: 'correction-audit-trail', title: '修正留痕', severity: 'hard', stages: ['collect', 'report'], statement: '误报、剔除、修正和回退必须记录原值、原因和结果，不得覆盖审计链。' },
  { id: 'V7', key: 'external-constraints-first', title: '外部约束优先', severity: 'hard', stages: ['dispatch'], statement: '时间窗口、共享资源、预算和他人任务属于硬边界。' },
  { id: 'V8', key: 'minimum-sufficient-scope', title: '最小充分执行', severity: 'hard', stages: ['dispatch', 'collect'], statement: '只触碰任务需要的范围，不扩大路径或另起未授权替代方案。' },
  { id: 'V9', key: 'raw-data-traceability', title: '原始数据可复算', severity: 'hard', stages: ['dispatch', 'collect', 'report'], statement: '报告保留原始指标、样本量、口径和证据位置，派生量必须可复算。' },
  { id: 'V10', key: 'epistemic-honesty', title: '认识论诚实', severity: 'hard', stages: ['dispatch', 'collect', 'report'], statement: '不知道、未验证、失败和阻塞必须明说，不得把未运行内容说成已完成。' },
]

export function coreProfile() {
  return {
    id: 'core-values-v1',
    norms: CORE_NORMS,
    quietWindows: [],
    roles: {},
    protectedArtifacts: [],
    gates: [],
    preferences: [],
    downloadPolicy: null,
    timeZone: 'Asia/Shanghai',
  }
}

const normalize = (cwd) => String(cwd ?? '').replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase()

export function resolveProfile(cwd, policyConfig = {}) {
  const profiles = policyConfig.profiles ?? {}
  const match = Object.entries(profiles).find(([key]) => normalize(key) === normalize(cwd))?.[1]
  const selected = match ?? profiles.default
  if (selected && typeof selected === 'object') return { ...coreProfile(), ...selected, id: selected.id ?? 'custom-profile' }
  return coreProfile()
}

export function requiredFields(policyConfig = {}) {
  return policyConfig.requiredFields ?? ['goal', 'scope', 'acceptance', 'evidence']
}
