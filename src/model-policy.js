// 原生模型选择：只读 DSH 模型目录与目标会话投影，不读取 Cookie 或本机凭据。
const DEFAULTS = {
  maxContextPressure: 0.9,
  candidates: [],
}

const sameModel = (a, b) => a?.provider === b?.provider && a?.model === b?.model

function currentSelection(summary, catalog) {
  const values = summary?.projections?.values
  return values?.modelSelection?.next ?? values?.modelSelection?.lastUsed ?? catalog.default
}

function contextPressure(summary) {
  const raw = summary?.projections?.values?.contextPressure
  if (!raw || !Number.isFinite(raw.pressureTokens) || !Number.isFinite(raw.contextWindow)) return null
  return {
    pressureTokens: raw.pressureTokens,
    projectedTokens: raw.projectedTokens,
    contextWindow: raw.contextWindow,
    ratio: raw.pressureTokens / raw.contextWindow,
  }
}

export function createModelPolicy(ctx, supplied = {}) {
  const config = { ...DEFAULTS, ...supplied }

  async function resolveCandidate(catalog, selection) {
    const group = catalog.groups?.find((entry) => entry.id === selection.provider)
    const advertised = group?.models?.some((model) => model.id === selection.model)
    if (!advertised) throw new Error('不在当前可路由模型目录中')
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
    return { ...selection, contextWindow: info.context?.contextWindow ?? null }
  }

  async function evaluate({ summary, explicit, thresholds = {} }) {
    const maxContextPressure = thresholds.maxContextPressure ?? config.maxContextPressure
    const catalog = await ctx.sessionController.modelCatalog()
    const original = currentSelection(summary, catalog)
    if (explicit) {
      const selected = await resolveCandidate(catalog, explicit)
      return {
        ok: true,
        original,
        selection: { provider: explicit.provider, model: explicit.model },
        changed: !sameModel(original, explicit),
        reason: '按调用方明确指定的模型派发',
        contextWindow: selected.contextWindow,
        rejected: [],
      }
    }
    if (!original) return { ok: true, changed: false, selection: null, reason: '无法确定当前模型，使用 DSH 默认选择', rejected: [] }
    const pressure = contextPressure(summary)
    const contextBad = pressure !== null && pressure.ratio >= maxContextPressure
    if (!contextBad) {
      return {
        ok: true,
        original,
        selection: { provider: original.provider, model: original.model },
        changed: false,
        reason: '当前上下文未超阈值，保持原模型；公开版不读取第三方配额插件',
        context: pressure,
        rejected: [],
      }
    }
    const rejected = [{
      provider: original.provider,
      model: original.model,
      reason: `上下文 ${pressure.pressureTokens}/${pressure.contextWindow} tokens（阈值 ${(maxContextPressure * 100).toFixed(0)}%）`,
    }]
    for (const candidate of config.candidates) {
      if (sameModel(candidate, original)) continue
      let resolved
      try {
        resolved = await resolveCandidate(catalog, candidate)
      } catch (error) {
        rejected.push({ ...candidate, reason: String(error?.message ?? error) })
        continue
      }
      if (!resolved.contextWindow || resolved.contextWindow <= pressure.pressureTokens || resolved.contextWindow <= pressure.contextWindow) {
        rejected.push({ ...candidate, reason: `候选窗口 ${resolved.contextWindow ?? '未知'} 不能安全容纳当前上下文` })
        continue
      }
      return {
        ok: true,
        original,
        selection: { provider: candidate.provider, model: candidate.model },
        changed: true,
        reason: rejected[0].reason,
        context: pressure,
        candidateContextWindow: resolved.contextWindow,
        rejected,
      }
    }
    return { ok: false, original, selection: null, reason: '没有能容纳当前上下文的候选模型', context: pressure, rejected }
  }

  return { evaluate }
}
