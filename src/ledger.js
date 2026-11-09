// 派发台账：追加写入本地 JSONL，供影子阶段校准和事后审计。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

function parseLines(text) {
  const entries = []
  let invalid = 0
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      invalid += 1
    }
  }
  return { entries, invalid }
}

export function appendLedger(filePath, record) {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  return filePath
}

export function readLedger(filePath, limit = 20) {
  if (!existsSync(filePath)) return { entries: [], total: 0, invalid: 0 }
  const { entries, invalid } = parseLines(readFileSync(filePath, 'utf8'))
  const size = Math.max(1, Math.min(200, Number(limit) || 20))
  return { entries: entries.slice(-size).reverse(), total: entries.length, invalid }
}

export function summarizeLedger(filePath) {
  if (!existsSync(filePath)) {
    return {
      total: 0,
      invalid: 0,
      byTier: {},
      bySuggestedClass: {},
      byActualModel: {},
      byTaskType: {},
      blocked: 0,
      changed: 0,
      errors: 0,
      latestAt: null,
    }
  }
  const { entries, invalid } = parseLines(readFileSync(filePath, 'utf8'))
  const byTier = {}
  const bySuggestedClass = {}
  const byActualModel = {}
  const byTaskType = {}
  let blocked = 0
  let changed = 0
  let errors = 0
  let latestAt = null
  for (const entry of entries) {
    const tier = entry.shadow?.tier ?? 'unknown'
    byTier[tier] = (byTier[tier] ?? 0) + 1
    const suggested = entry.shadow?.suggestedClass ?? 'unknown'
    bySuggestedClass[suggested] = (bySuggestedClass[suggested] ?? 0) + 1
    const type = entry.shadow?.taskType ?? 'unknown'
    byTaskType[type] = (byTaskType[type] ?? 0) + 1
    const actual = entry.actualModel
      ? `${entry.actualModel.provider}/${entry.actualModel.model}`
      : 'unknown'
    byActualModel[actual] = (byActualModel[actual] ?? 0) + 1
    if (entry.modelBlocked) blocked += 1
    if (entry.modelChanged) changed += 1
    const failed = entry.ok === false && !entry.modelBlocked
    if (failed || entry.shadowError || entry.ledgerError) errors += 1
    if (entry.at && (!latestAt || entry.at > latestAt)) latestAt = entry.at
  }
  return {
    total: entries.length,
    invalid,
    byTier,
    bySuggestedClass,
    byActualModel,
    byTaskType,
    blocked,
    changed,
    errors,
    latestAt,
  }
}
