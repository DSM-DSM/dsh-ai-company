/** AI-Company 专用的最小执行环境辅助；从上游 infra/environment.ts 抽离，避免绑定 GitHub/飞书部署。 */
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface Variable { key: string; value: string; description: string | { zh: string; en: string }; owner: string }
export const executionRoot = (settings: { executor: { directory: string } }, stateDir: string): string =>
  settings.executor.directory || `${stateDir}/work`

/** Windows 同时兼容 PowerShell 7 的 pwsh 与系统自带 Windows PowerShell。 */
export async function shellArgv(subprocess: SubprocessRuntime, command: string): Promise<string[]> {
  if (process.platform !== 'win32') return ['sh', '-c', command]
  const resolve = subprocess.resolveExecutable?.bind(subprocess) ?? (async () => 'powershell.exe')
  const executable = await resolve('pwsh').catch(() => 'powershell.exe')
  return [executable, '-NoProfile', '-Command', command]
}

class CommandError extends Error {
  constructor(message: string, readonly exitCode?: number) { super(message) }
}

/** 通过 DSH subprocess 运行准备命令，不读取或转发任何凭据。 */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CommandError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, exitCode ?? undefined)
}

/** 拒绝仓库本地配置中的凭据助手和 HTTP extraheader，非 Git 目录按普通工作目录处理。 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CommandError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
