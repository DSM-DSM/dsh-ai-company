// 小型原生 Session 适配器：供非工单型资产管理员工具使用。
import { randomUUID } from 'node:crypto'

export function createNativeHost(ctx) {
  return {
    async createSession(cwd, agentPreset) {
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
        ?? await ctx.workspaceRegistry.create(cwd)
      return ctx.sessionController.create({ workspaceId: workspace.id, agentPreset })
    },
    async promptSession(sessionId, text, mode = 'queue') {
      return ctx.sessionController.prompt({
        requestId: `ai-company-${randomUUID()}`,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(60_000))
    },
  }
}
