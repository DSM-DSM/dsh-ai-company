// 可选资产治理子插件入口：默认不自动建档，不注册任何固定 MCP。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply as applyRepoManage } from './repo-manage.js'
import { createNativeHost } from './native-host.js'

export const inject = ['tools', 'subprocess', 'sessionController', 'workspaceRegistry', 'sessionPersistence']

export function apply(ctx, config = {}) {
  const base = process.env.DSH_HOME?.trim()
    ? resolve(process.env.DSH_HOME, 'ai-company')
    : join(homedir(), '.dsh', 'ai-company')
  return applyRepoManage(ctx, {
    autoProvision: config.autoProvision === true,
    statePath: config.statePath ?? join(base, 'repo-manage-provisioned.json'),
    ...config,
    nativeHost: createNativeHost(ctx),
  })
}
