// 任务复杂度影子估算：只记录建议，不改变实际派发模型。
// 信号设计参考 E3（Estimate–Execute–Expand）与 taskgauge 的确定性估算器，并补充中文与 DSH 上下文特征。
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const LOW_EFFORT_EN = ['typo', 'rename', 'comment', 'bump', 'format', 'lint', 'tweak']
const LOW_EFFORT_ZH = ['改错', '重命名', '注释', '格式化', '微调', '补丁', '排版']
const HIGH_EFFORT_EN = ['refactor', 'redesign', 'migrate', 'architect', 'rewrite', 'integrate', 'debug', 'investigate']
const HIGH_EFFORT_ZH = ['重构', '重写', '迁移', '架构', '整合', '调试', '排查', '实现', '设计', '优化', '分析']
const VAGUE_EN = ['thing', 'things', 'stuff', 'something', 'issue', 'issues', 'problem', 'problems', 'changes', 'behavior', 'functionality']
const VAGUE_ZH = ['一些', '某些', '相关', '情况', '东西', '问题', '看看', '研究一下', '处理一下', '搞一下', '完善一下']
const ACCEPTANCE_EN = [/run\s+(?:the\s+)?tests?/iu, /keep\s+(?:the\s+)?tests?\s+green/iu, /(?:tests?|ci|build)\s+(?:still\s+)?pass(?:es|ing)?/iu, /ensure\s+.+?pass(?:es)?/iu]
const ACCEPTANCE_ZH = ['跑测试', '测试通过', '保持测试', '验收', '确保通过', '验证通过']
const BROAD_ZH = ['整个', '全部', '所有', '全仓', '全库', '每一处']
const HISTORY_HINTS = ['参考', '沿用', '根据', '之前', '历史', '上次', '已有', 'readme', '文档', 'previous', 'reuse', 'existing']
const RISK_HINTS = ['生产', '线上', '删除', '部署', '上线', '不可逆', '紧急', '生产环境', 'production', 'rm -rf']

const TASK_TYPES = {
  code: ['代码', '函数', '仓库', '编译', '测试', '重构', 'python', 'typescript', 'javascript', 'bug', '修复', '文件'],
  research: ['论文', '文献', '实验', '数据分析', '统计', '评估', '研究', 'baseline', '消融'],
  writing: ['写', '报告', '文档', '总结', 'ppt', '讲稿', '润色', '摘要'],
  ops: ['部署', '服务器', 'gpu', '训练', '环境', 'docker', 'ssh', 'nas', '集群'],
  retrieval: ['搜索', '检索', '查找', '调研', '网页', '链接', '资料'],
}

const countCjk = (text) => (text.match(/[\u4e00-\u9fff]/gu) ?? []).length
const countLatinWords = (text) => (text.match(/[A-Za-z0-9_]+/gu) ?? []).length
const countTerm = (text, term) => {
  if (/^[A-Za-z ]+$/u.test(term)) return new RegExp(`\\b${term.replace(/\s+/gu, '\\s+')}\\b`, 'iu').test(text) ? 1 : 0
  return text.includes(term) ? 1 : 0
}
const countTerms = (text, terms) => terms.reduce((count, term) => count + countTerm(text, term), 0)
const clip = (value, min, max) => Math.max(min, Math.min(max, value))
const round = (value, digits = 2) => Number(value.toFixed(digits))

function lengthWeight(units) {
  if (units <= 6) return -10
  if (units <= 18) return 0
  if (units <= 38) return 8
  if (units <= 80) return 16
  return 25
}

function pathCounts(task) {
  const paths = task.match(/(?:\.{0,2}\/|\/)?(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:[cm]?js|mjs|ts|tsx|jsx|json|md|css|scss|html|ya?ml|toml|py|rb|go|rs|java|kt|swift)\b/giu) ?? []
  return [...new Set(paths)]
}

function scopeBreadth(task, explicitPaths) {
  let weight = 0
  const across = task.match(/\bacross\s+(\d+)\s+files?\b/iu) ?? task.match(/(\d+)\s*个文件/iu)
  if (across) {
    const count = Number(across[1])
    weight = count >= 10 ? 30 : count >= 5 ? 24 : 18
  }
  if (/\b(?:the\s+whole|every)\b/iu.test(task) || BROAD_ZH.some((term) => task.includes(term))) {
    weight = Math.max(weight, 22)
  }
  if (explicitPaths.length >= 2) {
    weight = Math.max(weight, Math.min(18, 10 + (explicitPaths.length - 2) * 3))
  }
  return weight
}

function ambiguityWeight(task) {
  let weight = 0
  if (/\bfigure\s+out\b/iu.test(task) || task.includes('想办法') || task.includes('搞清楚')) weight = 45
  if (/\bsomehow\b/iu.test(task)) weight = Math.max(weight, 34)
  if (/\bexplore\b/iu.test(task) || task.includes('探索')) weight = Math.max(weight, 30)
  const vague = countTerms(task, [...VAGUE_EN, ...VAGUE_ZH])
  if (vague > 0) weight += Math.min(24, 10 + (vague - 1) * 3)
  return weight
}

function stepWeight(task) {
  const numbered = task.match(/^\s*(?:\d+[.)、]|[-*])\s+/gmu)?.length ?? 0
  const connectors = task.match(/\b(?:and\s+then|then)\b|然后|接着|之后|再/gmu)?.length ?? 0
  return Math.min(24, Math.max(0, numbered - 1) * 8 + connectors * 8)
}

function acceptanceWeight(task) {
  return ACCEPTANCE_EN.some((pattern) => pattern.test(task)) || ACCEPTANCE_ZH.some((term) => task.includes(term)) ? -6 : 0
}

function classifyTask(task) {
  let best = 'general'
  let bestCount = 0
  for (const [type, terms] of Object.entries(TASK_TYPES)) {
    const count = countTerms(task.toLowerCase(), terms)
    if (count > bestCount) {
      best = type
      bestCount = count
    }
  }
  return { type: best, matches: bestCount }
}

function tierForScore(score) {
  if (score < 20) return 'trivial'
  if (score < 40) return 'simple'
  if (score < 60) return 'moderate'
  if (score < 80) return 'hard'
  return 'open-ended'
}

function classForTier(tier) {
  if (tier === 'trivial' || tier === 'simple') return 'small'
  if (tier === 'moderate') return 'mid'
  return 'top'
}

function contextSignal(summary) {
  const pressure = summary?.projections?.values?.contextPressure
  if (!pressure || !Number.isFinite(pressure.pressureTokens) || !Number.isFinite(pressure.contextWindow)) return null
  const ratio = pressure.pressureTokens / pressure.contextWindow
  const weight = ratio >= 0.85 ? 16 : ratio >= 0.7 ? 10 : ratio >= 0.5 ? 5 : 0
  return {
    ratio: round(ratio, 4),
    pressureTokens: pressure.pressureTokens,
    contextWindow: pressure.contextWindow,
    weight,
  }
}

function workspaceSignal(workspace, explicitPaths) {
  if (!workspace) return null
  let weight = 0
  if (explicitPaths.length >= 5) weight = 18
  else if (explicitPaths.length >= 2) weight = 10
  else if (workspace.sampledFiles >= 200) weight = 12
  else if (workspace.sampledFiles >= 50) weight = 8
  else if (workspace.sampledFiles >= 10) weight = 4
  return {
    sampledFiles: workspace.sampledFiles,
    capped: workspace.capped,
    hasReadme: workspace.hasReadme,
    hasDocs: workspace.hasDocs,
    hasTests: workspace.hasTests,
    weight,
  }
}

/**
 * 对工作区做一次有界的浅层采样，避免为了估算文件数而遍历大仓库。
 * @param {string|undefined} cwd - 目标工作区。
 * @param {number} limit - 最多采样的文件数。
 * @returns {Promise<{sampledFiles:number,capped:boolean,hasReadme:boolean,hasDocs:boolean,hasTests:boolean}|null>}
 */
export async function probeWorkspace(cwd, limit = 200) {
  if (!cwd) return null
  const skip = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '.turbo', 'artifacts'])
  const queue = [{ dir: cwd, depth: 0 }]
  let sampledFiles = 0
  let capped = false
  let hasReadme = false
  let hasDocs = false
  let hasTests = false
  while (queue.length > 0 && sampledFiles < limit) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/^docs?$/iu.test(entry.name)) hasDocs = true
        if (/^tests?$/iu.test(entry.name)) hasTests = true
        if (depth < 2) queue.push({ dir: fullPath, depth: depth + 1 })
        continue
      }
      sampledFiles += 1
      if (/^readme(?:\.[a-z]+)?$/iu.test(entry.name)) hasReadme = true
      if (/^(?:test|spec)/iu.test(entry.name) || /\.(?:test|spec)\./iu.test(entry.name)) hasTests = true
      if (sampledFiles >= limit) {
        capped = true
        break
      }
    }
  }
  return { sampledFiles, capped, hasReadme, hasDocs, hasTests }
}

/**
 * 生成影子复杂度判断。返回值只用于记录和对照，不参与实际模型选择。
 * @param {{task:string,summary?:object,workspace?:object,sessionsInCwd?:number}} input
 * @returns {object}
 */
export function estimateTaskComplexity({ task, summary, workspace, sessionsInCwd = 0 }) {
  const text = String(task ?? '')
  const cjkChars = countCjk(text)
  const latinWords = countLatinWords(text)
  const lengthUnits = latinWords + cjkChars / 2
  const explicitPaths = pathCounts(text)
  const signals = []

  const length = lengthWeight(lengthUnits)
  signals.push({ name: 'length', weight: length, unit: lengthUnits })

  const lowEffort = countTerms(text, [...LOW_EFFORT_EN, ...LOW_EFFORT_ZH])
  if (lowEffort > 0) signals.push({ name: 'low-effort verb', weight: Math.max(-20, -14 - (lowEffort - 1) * 3), count: lowEffort })

  const highEffort = countTerms(text, [...HIGH_EFFORT_EN, ...HIGH_EFFORT_ZH])
  if (highEffort > 0) signals.push({ name: 'high-effort verb', weight: Math.min(30, 18 + (highEffort - 1) * 6), count: highEffort })

  const scope = scopeBreadth(text, explicitPaths)
  if (scope > 0) signals.push({ name: 'scope breadth', weight: scope, explicitPaths: explicitPaths.length })

  const acceptance = acceptanceWeight(text)
  if (acceptance !== 0) signals.push({ name: 'acceptance check', weight: acceptance })

  const ambiguity = ambiguityWeight(text)
  if (ambiguity > 0) signals.push({ name: 'ambiguity', weight: ambiguity })

  const steps = stepWeight(text)
  if (steps > 0) signals.push({ name: 'step count', weight: steps })

  const context = contextSignal(summary)
  if (context && context.weight > 0) signals.push({ name: 'context pressure', weight: context.weight, ratio: context.ratio })

  const workspaceInfo = workspaceSignal(workspace, explicitPaths)
  if (workspaceInfo && workspaceInfo.weight > 0) signals.push({ name: 'workspace scope', weight: workspaceInfo.weight, sampledFiles: workspaceInfo.sampledFiles })

  const historyHits = countTerms(text.toLowerCase(), HISTORY_HINTS)
  const historyWeight = historyHits > 0 ? -8 : 0
  if (historyWeight !== 0) signals.push({ name: 'history hint', weight: historyWeight, count: historyHits })

  const riskHits = countTerms(text.toLowerCase(), RISK_HINTS)
  const riskLevel = riskHits >= 2 ? 'high' : riskHits === 1 ? 'medium' : 'low'
  if (riskHits > 0) signals.push({ name: 'risk hint', weight: 0, count: riskHits, level: riskLevel })

  const rawScore = signals.reduce((sum, signal) => sum + signal.weight, 32)
  const score = Math.round(clip(rawScore, 0, 100))
  const tier = tierForScore(score)
  const taskType = classifyTask(text)

  let confidence = 0.65
  if (explicitPaths.length > 0) confidence += 0.1
  if (acceptance !== 0) confidence += 0.05
  if (ambiguity > 0) confidence -= 0.15
  if ((scope > 0 || BROAD_ZH.some((term) => text.includes(term))) && explicitPaths.length === 0) confidence -= 0.1
  if (workspaceInfo) confidence += 0.05
  confidence = round(clip(confidence, 0.2, 0.95), 2)

  return {
    version: 'shadow-v1',
    score,
    tier,
    suggestedClass: classForTier(tier),
    confidence,
    taskType: taskType.type,
    taskTypeMatches: taskType.matches,
    riskLevel,
    signals,
    features: {
      taskChars: [...text].length,
      cjkChars,
      latinWords,
      lengthUnits: round(lengthUnits, 1),
      explicitPathCount: explicitPaths.length,
      listedSteps: (text.match(/^\s*(?:\d+[.)、]|[-*])\s+/gmu) ?? []).length,
      connectorCount: (text.match(/\b(?:and\s+then|then)\b|然后|接着|之后|再/gmu) ?? []).length,
      hasAcceptance: acceptance !== 0,
      ambiguous: ambiguity > 0,
      historyHits,
      riskHits,
      sameWorkspaceSessions: sessionsInCwd,
      workspace: workspaceInfo,
      context,
    },
    rationale: `${tier}（${score}/100）→ ${classForTier(tier)} 模型档；置信度 ${confidence}`,
  }
}
