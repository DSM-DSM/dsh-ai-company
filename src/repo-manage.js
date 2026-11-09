// ai-company-repo-manage —— ai-company 的子插件：为每家公司配一个「代码与数据资产管家 Agent」。
//
// 这个插件做两件事：
//   ① **公司建档时自动拉起管家**：轮询 DSH 的工作区注册表，发现新公司（新工作区目录）就
//      创建一个专属 Agent 会话（可配 preset），把本插件定义的《资产管理准则 + 任务清单》
//      作为首条指令投进去，并在状态文件里记账（幂等，不重复建）。
//   ② **给管家一套手脚**：四个公司粒度工具（体检 / 建索引 / 查代码 / 盘点），
//      背后是两套引擎：
//        · AOCI-CODE —— 模型撰写的认知索引（aoci.txt / .aoci/），回答"这系统由什么组成、什么不能改坏"；
//        · CodeGraph  —— 本地符号图（.codegraph/），回答"符号在哪、谁调用谁、影响面多大"。
//
// 准则与任务的权威来源就是本文件的 DEFAULT_PLAYBOOK（可用 config.playbook 覆盖）：
//   · company_repo_provision 用它在建档时投喂管家；
//   · company_repo_playbook 可随时把全文再取出来（上下文压缩后重新注入）。
//
// 设计纪律：
//   1) 默认只读。任何会改盘的操作（codegraph index、aoci scan）都必须 dryRun=false 才执行；
//   2) 不猜路径。公司要么由调用方给出绝对路径，要么在 config.companies 里登记，要么来自工作区注册表；
//   3) 不 kill、不删除、不改业务文件。索引工具只写自己的 .aoci/ 与 .codegraph/（须由目标仓库确认忽略）。

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['tools', 'subprocess', 'sessionController', 'workspaceRegistry', 'sessionPersistence']

// ── 管家 Agent 的准则与任务清单（权威定义；config.playbook 可整体覆盖）──────────
const DEFAULT_PLAYBOOK = `# 你是本公司的「代码与数据资产管理员」

你被 ai-company-repo-manage 子插件在**公司建档时自动创建**，负责让这家公司的代码与数据资产始终「可被 AI 一眼看懂」。

## 身份与边界
- 你只管理下面这一家公司；不跨公司操作，不改别家公司的工作区。
- **默认只读**：任何会改盘的动作（codegraph index / aoci scan / git 操作）先说明再执行；不删除、不 kill 进程、不改业务代码，除非用户明确要求。
- **凭据红线**：带密码的文件（*.pass.txt、内嵌口令的脚本）永不读取、不回显、不写进任何产物。
- **NAS 纪律**：若公司目录在网络盘上，禁止全树递归 grep/find（会打满链路并留孤儿进程）；查代码走 CodeGraph。
- 不臆测：索引条目证据不足就留空或登记待办，不编造关系与约束。

## 你负责的三类资产
1. **代码认知**（AOCI）：aoci.txt / aoci.meta.txt / aoci.code.txt / .aoci/ —— 每个受管文件一条 F/R/A/S 条目，随 Git 版本化。
2. **代码结构**（CodeGraph）：.codegraph/ —— 符号、调用链、影响面；自忽略，不入库。
3. **数据资产**：数据目录、实验结果、模型检查点的位置与体量，以及哪些该入库、哪些走归档。

## 入职首日（一次性建档）
1. \`company_repo_status\`（verify=false 先看快照，需要对齐证据时再 verify=true）摸清 git / AOCI / CodeGraph 现状。
2. 没有 .codegraph：\`company_repo_index target=codegraph dryRun=false\` 建图（秒级到分钟级）。
3. 没有 aoci.txt：先报告，拿到用户同意后再执行 \`aoci init\`（这一步会往仓库里写 aoci*.txt / AGENTS.md / .gitattributes）。
4. 已有索引但漂移：走 MCP 的 aoci_maintain → 读源码 → aoci_update_entry 整批提交，不要用 CLI 兼容路径（Volumes v1 只认 MCP）。
5. 建档结论写成一段：仓库规模、索引覆盖、数据资产分布、下一步建议。

## 日常（每次被唤醒）
1. \`company_repo_status\` 看变化：git 脏文件、AOCI 漂移（missing/stale）、CodeGraph 规模。
2. 代码有改动 → 维护受影响的 AOCI 条目（索引批次按下面「交付纪律」整批提交）。
3. 数据资产有变化 → 更新资产台账（位置、体量、是否已归档）。
4. 汇报：**只报变化与异常**，带关键数字（条目数/漂移数/目录体量），不复述没变的东西。

## Git 提交纪律（定期、分批 —— 不是改完就提交）
- **定期提交**：不在每次改动后立刻 commit。攒到一个工作阶段收口、或用户明确要求时，再统一提交。
- **提交前先看清**：\`git status --porcelain\`，再对每个要交的文件看 diff；分清哪些是本轮成果、哪些是并发会话或别的方向正在写的。
- **按内容分批**（一个语义主题一个 commit）：
  - 同一方向的文档 / 同一组实验脚本 / 测试与验证脚本 / 配置与依赖 / 索引资产（aoci*.txt、AGENTS.md、.gitattributes）/ 清理与删除，各算一批；
  - **不** \`git add -A\`，不把无关改动塞进同一个提交；
  - 新增文件（新模块、新方向文档、AOCI 资产）单独成批，避免和修改混在一起看不出改动面。
  - 提交信息写清「改了什么 + 为什么」，语言与格式遵循目标仓库约定。
- **逐批提交并复核**：每批 \`git add <具体路径>\` → \`git commit\` → 再 \`git status\` 确认剩下的是不是下一批；发现混入了并发会话正在写的文件，停下汇报，不要替对方提交。
- **不提交**：\`.aoci/\` 里的运行时事务、\`.codegraph/\`、\`.mcp.json\`、\`.codex/config.toml\`；先确认目标仓库确已忽略，凭据文件永不提交。
- **仓库没有 remote 时**：提交即终态，更不能一把梭——历史脏了没法回滚靠推送纠正。

## 交付纪律
- 一次维护一批 AOCI 条目，整批提交、不自行截断（这条指的是**索引写入事务**，与上面的 git 提交是两件事）。
- 不把「accepted / APPROVED」当作执行授权。
- 不确定就先问，问要问得具体（给选项，不给空泛问题）。`

// 输出统一成 lossless-JSON 友好的结构（undefined 字段在返回前清掉）
const json = (value) => JSON.parse(JSON.stringify(value))

// npm 全局安装的 codegraph 在 Windows 上是 .cmd shim，subprocess.spawn 无法直接解析
// PATH 里的 .cmd，所以默认改走「node + npm-shim.js」。这里按 APPDATA 探测一次。
function defaultCodegraphShim() {
  const appData = process.env.APPDATA || ''
  if (!appData) return ''
  const p = join(appData, 'npm', 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js')
  return existsSync(p) ? p.replace(/\\/g, '/') : ''
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    company: { type: 'object', additionalProperties: true },
    companies: { type: 'array', items: { type: 'object', additionalProperties: true } },
    action: { type: 'string' },
    executed: { type: 'boolean' },
    result: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
}

const render = (_args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
const errorText = (error) => String((error && error.message) || error)

export function apply(ctx, config = {}) {
  const shim = defaultCodegraphShim()
  const cfg = {
    // 外部工具默认从 PATH 解析；也可由使用者提供绝对路径。
    aociCommand: 'aoci',
    codegraphCommand: shim ? process.execPath : 'codegraph',
    codegraphShim: shim,
    defaultCompany: '',
    companies: {},
    statusTimeoutMs: 180000,
    indexTimeoutMs: 3600000,
    queryTimeoutMs: 300000,
    assetMaxFiles: 20000,
    // 公开默认不自动创建会话；只有显式开启后才监听新工作区。
    autoProvision: false,
    managerPreset: 'ai-company-org-worker',
    provisionPollMs: 15000,
    statePath: join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'ai-company', 'repo-manage-provisioned.json'),
    playbook: '',
    provisionRoots: [],
    // 非空时，所有手动公司解析与自动建档都必须落在这些根目录内。
    allowedRoots: [],
    ...(config || {}),
  }
  if (!cfg.nativeHost) throw new Error('repo-manage 需要 nativeHost；请通过 repo-manage-entry.js 激活')
  const { createSession, promptSession } = cfg.nativeHost

  // codegraph 的 argv 组装：配了 shim 时是 [node, shim, ...args]
  const cgArgv = (...args) => (cfg.codegraphShim
    ? [cfg.codegraphCommand, cfg.codegraphShim, ...args]
    : [cfg.codegraphCommand, ...args])

  // ── 子进程：收 stdout/stderr，带超时与取消 ──────────────────────────────
  async function run(argv, { cwd, timeoutMs, signal, env } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? cfg.statusTimeoutMs)
    const onAbort = () => ctrl.abort()
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: cwd || process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 262144, spill: { maxBytes: 4194304 } },
          stderr: { maxBytes: 65536 },
        },
        graceMs: 5000,
        // 无显式覆盖时省略 env，由 DSH subprocess 提供经过凭据清洗的基础环境。
        ...(env ? { env } : {}),
        signal: ctrl.signal,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout?.readFrom(0)
      const err = handle.collected.stderr?.readFrom(0)
      return {
        exitCode: outcome.exitCode,
        stdout: out?.text ?? '',
        stderr: err?.text ?? '',
        lossy: out?.lossy ?? false,
      }
    } catch (error) {
      const msg = errorText(error)
      if (/ENOENT/i.test(msg)) {
        throw new Error(
          `找不到可执行文件「${argv[0]}」。请检查插件 config：aociCommand 指向 aoci 可执行文件，`
          + `codegraphShim 指向 codegraph 的 npm-shim.js（Windows 上 codegraph 是 .cmd，spawn 解析不了）。原始错误：${msg}`,
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  // ── 公司解析：名字 → 绝对路径 ─────────────────────────────────────────
  const isPath = (s) => typeof s === 'string' && /[\\/]/.test(s) && !cfg.companies?.[s]

  function resolveCompany(name) {
    const wanted = (name || '').trim()
    let company
    if (wanted && isPath(wanted)) company = { name: wanted, root: wanted.replace(/[\\/]+$/, '') }
    else if (wanted && cfg.companies && Object.prototype.hasOwnProperty.call(cfg.companies, wanted)) {
      company = { name: wanted, root: String(cfg.companies[wanted]).replace(/[\\/]+$/, '') }
    } else if (cfg.defaultCompany) {
      company = { name: cfg.defaultCompany, root: String(cfg.defaultCompany).replace(/[\\/]+$/, '') }
    }
    if (!company) {
      throw new Error('未指定公司：请传 company（绝对路径或 config.companies 里登记的名字），或在插件 config 里设置 defaultCompany')
    }
    assertCompanyAllowed(company)
    return company
  }

  function assertCompanyAllowed(company) {
    if (cfg.allowedRoots.length > 0 && !cfg.allowedRoots.some((root) => withinRoot(root, company.root))) {
      throw new Error(`公司路径不在 allowedRoots 内：${company.root}`)
    }
  }

  function listCompanies() {
    const out = []
    const seen = new Set()
    for (const [name, root] of Object.entries(cfg.companies || {})) {
      const key = String(root).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const company = { name, root: String(root).replace(/[\\/]+$/, '') }
      assertCompanyAllowed(company)
      out.push(company)
    }
    if (cfg.defaultCompany) {
      const key = String(cfg.defaultCompany).toLowerCase()
      if (!seen.has(key)) {
        const company = { name: cfg.defaultCompany, root: String(cfg.defaultCompany).replace(/[\\/]+$/, '') }
        assertCompanyAllowed(company)
        out.push(company)
      }
    }
    return out
  }

  // ── 公司建档：自动拉起「代码与数据资产管家」Agent 会话 ────────────────
  //
  // 触发链路：
  //   ① DSH 的持久工作区注册表（<DSH_HOME>/storages/workspace.json）里出现新的公司目录；
  //   ② 本插件每 provisionPollMs 轮询一次，把首次快照之后新出现的公司记为"待建档"；
  //   ③ 每个新公司建一个专属会话（可配 preset），首条指令就是《准则 + 任务清单》；
  //   ④ 过程写进 statePath 记账，保证幂等（同一家公司只建一次）。

  const playbookText = () => (typeof cfg.playbook === 'string' && cfg.playbook.trim() ? cfg.playbook : DEFAULT_PLAYBOOK)

  const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  function withinRoot(root, candidate) {
    const canonical = (value) => {
      try { return realpathSync.native(resolve(value)) } catch { return resolve(value) }
    }
    const rel = relative(canonical(root), canonical(candidate))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  function dshHome() {
    const raw = process.env.DSH_HOME
    if (raw === undefined || raw.trim() === '') return join(homedir(), '.dsh')
    const trimmed = raw.trim()
    if (trimmed.startsWith('~')) return join(homedir(), trimmed.slice(1).replace(/^[\\/]+/u, ''))
    return trimmed
  }

  /** 读工作区注册表：返回 [{id, path, title}]，读不到返回 []。 */
  function readWorkspaceStore() {
    const file = join(dshHome(), 'storages', 'workspace.json')
    try {
      const store = JSON.parse(readFileSync(file, 'utf8'))
      const records = store?.tables?.workspaces
      if (!records || typeof records !== 'object') return []
      return Object.entries(records)
        .map(([id, rec]) => ({ id, path: typeof rec?.path === 'string' ? rec.path : '', title: rec?.title || '' }))
        .filter((w) => w.path)
    } catch {
      return []
    }
  }

  function loadState() {
    try {
      const doc = JSON.parse(readFileSync(cfg.statePath, 'utf8'))
      if (doc && typeof doc === 'object' && doc.companies && typeof doc.companies === 'object') return doc
    } catch {
      /* 没状态文件就是首次运行 */
    }
    return { version: 1, companies: {} }
  }

  function saveState(state) {
    try {
      mkdirSync(dirname(cfg.statePath), { recursive: true })
      writeFileSync(cfg.statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`repo-manage: 写状态文件失败 ${cfg.statePath}: ${errorText(error)}`)
    }
  }

  /** 组装给管家的首条指令：公司档案 + 准则与任务清单 + 开工要求。 */
  function buildProvisionPrompt(company, playbook) {
    const head = [
      `【公司建档】${company.name}`,
      `- 工作区/仓库根：${company.root}`,
      `- 建档时间：${new Date().toISOString()}`,
      '',
      '你是这家公司的**代码与数据资产管理员**。下面是本插件为你定义的准则与任务清单，长期有效；',
      '上下文被压缩后，重新调用 `company_repo_playbook` 取回全文，不要凭记忆复述。',
      '',
    ].join('\n')
    const tail = [
      '',
      '---',
      '## 现在开始入职',
      '按上面「入职首日」的顺序做一遍，然后给我一段建档结论（仓库规模 / 索引覆盖 / 数据资产分布 / 下一步建议）。',
      '只读优先：除 `company_repo_*` 工具外不要改任何文件；需要 `aoci init` 这类会写仓库的动作，先问我。',
    ].join('\n')
    return head + playbook + tail
  }

  /**
   * 为一家公司建档：创建管家会话并投递 playbook。
   * @param company - { name, root }
   * @param opts - { reason, preset, force }
   * @returns { created, sessionId, skipped?, error? }
   */
  async function provisionCompany(company, opts = {}) {
    assertCompanyAllowed(company)
    const state = loadState()
    const key = normPath(company.root)
    const done = state.companies[key]
    if (done && !opts.force) {
      return { created: false, skipped: 'already-provisioned', sessionId: done.sessionId, at: done.at }
    }
    const preset = opts.preset || cfg.managerPreset
    try {
      const session = await createSession(company.root, preset)
      const sessionId = session?.sessionId
      if (!sessionId) throw new Error('session/create 没有返回 sessionId')
      const prompt = buildProvisionPrompt(company, playbookText())
      // mode 用 queue：目标会话可能刚建好还在初始化，排队更稳
      await promptSession(sessionId, prompt, 'queue')
      const record = {
        name: company.name,
        root: company.root,
        sessionId,
        preset,
        at: new Date().toISOString(),
        reason: opts.reason || 'manual',
      }
      state.companies[key] = record
      state.updatedAt = record.at
      saveState(state)
      return { created: true, sessionId, at: record.at, preset, reason: record.reason }
    } catch (error) {
      return { created: false, error: errorText(error) }
    }
  }

  /** 认领一个已经存在的会话当管家（用户在 UI 里自建的，插件不自作主张重建）。 */
  async function adoptCompany(company, sessionId, opts = {}) {
    assertCompanyAllowed(company)
    const state = loadState()
    const key = normPath(company.root)
    const record = {
      name: company.name,
      root: company.root,
      sessionId,
      preset: null,
      at: new Date().toISOString(),
      reason: opts.reason || 'adopted',
      note: '已有会话被认领为管家，插件只登记不重建',
    }
    state.companies[key] = record
    state.updatedAt = record.at
    saveState(state)
    if (!opts.sendPlaybook) return { created: false, adopted: true, sessionId, at: record.at }
    try {
      const prompt = buildProvisionPrompt(company, playbookText())
      await promptSession(sessionId, prompt, 'queue')
      return { created: false, adopted: true, sessionId, at: record.at, playbookSent: true }
    } catch (error) {
      return { created: false, adopted: true, sessionId, at: record.at, playbookSent: false, error: errorText(error) }
    }
  }

  // 首次快照：插件启动时已存在的公司不算"新建"，除非 backfill 明确要求
  let knownCompanies = new Set(readWorkspaceStore().map((w) => normPath(w.path)))

  function startProvisionWatcher() {
    if (!cfg.autoProvision) return () => {}
    const timer = setInterval(async () => {
      try {
        const current = readWorkspaceStore()
        const fresh = current.filter((w) => w.path && !knownCompanies.has(normPath(w.path)))
        for (const w of fresh) {
          knownCompanies.add(normPath(w.path))
          if (cfg.provisionRoots.length > 0 && !cfg.provisionRoots.some((root) => withinRoot(root, w.path))) continue
          if (cfg.allowedRoots.length > 0 && !cfg.allowedRoots.some((root) => withinRoot(root, w.path))) continue
          const name = w.title || w.path.split(/[\\/]/).filter(Boolean).pop() || w.path
          const result = await provisionCompany({ name, root: w.path }, { reason: 'workspace-created' })
          if (result.created) {
            ctx.logger?.info?.(`repo-manage: 已为新公司 ${name} 建档，管家会话 ${result.sessionId}`)
          } else if (result.error) {
            ctx.logger?.warn?.(`repo-manage: 公司 ${name} 建档失败：${result.error}`)
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`repo-manage: 建档轮询异常：${errorText(error)}`)
      }
    }, Math.max(5000, cfg.provisionPollMs))
    return () => clearInterval(timer)
  }

  // ── 解析工具输出 ─────────────────────────────────────────────────────
  const firstInt = (text, re) => {
    const m = re.exec(text || '')
    if (!m) return null
    return Number(String(m[1]).replace(/[,，]/g, ''))
  }

  function parseAociStatus(text) {
    const entries = firstInt(text, /索引条目\s*([\d,，]+)/)
    const baseline = firstInt(text, /基线\s*([\d,，]+)\s*文件/)
    const snapshot = /最近\s*verify\s*快照[:：]\s*(\S+)/.exec(text || '')
    const report = firstInt(text, /report\s*待办[:：]\s*([\d,，]+)/)
    return {
      present: entries !== null,
      entries,
      baselineFiles: baseline,
      reportTodo: report,
      lastVerifySnapshot: snapshot ? snapshot[1] : null,
    }
  }

  function parseCodegraphStatus(text) {
    const files = firstInt(text, /Files:\s*([\d,，]+)/)
    const nodes = firstInt(text, /Nodes:\s*([\d,，]+)/)
    const edges = firstInt(text, /Edges:\s*([\d,，]+)/)
    const db = /DB Size:\s*([^\n]+)/.exec(text || '')
    return {
      present: files !== null,
      files,
      nodes,
      edges,
      dbSize: db ? db[1].trim() : null,
    }
  }

  function parseVerify(text) {
    try {
      const start = text.indexOf('{')
      const doc = JSON.parse(text.slice(start))
      const gov = doc.governance || {}
      const drift = gov.code_drift || {}
      const count = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : null)
      return {
        aligned: doc.governance_aligned === true,
        structureValid: doc.structure_valid === true,
        entryCount: gov.code_entry_count ?? null,
        sourceCount: gov.code_source_count ?? null,
        drift: {
          missing: count(drift.missing),
          stale: count(drift.stale),
          orphan: count(drift.orphan),
          unbaselined: count(drift.unbaselined),
        },
        budget: gov.budget ? { status: gov.budget.status, wholeIndexTokens: gov.budget.whole_index_tokens } : null,
      }
    } catch {
      return null
    }
  }

  // ── 单家公司体检 ─────────────────────────────────────────────────────
  async function inspectCompany(company, opts = {}) {
    const root = company.root
    const info = { name: company.name, root }

    // git：分支 + 跟踪文件数 + 脏文件数（不改盘）
    const gitBranch = await run(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 20000 })
    if (gitBranch.exitCode !== 0) {
      info.git = { isRepo: false, error: (gitBranch.stderr || '').trim().split('\n')[0] || 'not a git repository' }
    } else {
      const branch = gitBranch.stdout.trim()
      const tracked = await run(['git', '-C', root, 'ls-files'], { timeoutMs: 120000 })
      const dirty = await run(['git', '-C', root, 'status', '--porcelain'], { timeoutMs: 120000 })
      const remotes = await run(['git', '-C', root, 'remote'], { timeoutMs: 20000 })
      info.git = {
        isRepo: true,
        branch,
        trackedFiles: tracked.exitCode === 0 ? tracked.stdout.split('\n').filter(Boolean).length : null,
        dirtyEntries: dirty.exitCode === 0 ? dirty.stdout.split('\n').filter(Boolean).length : null,
        remotes: remotes.exitCode === 0 ? remotes.stdout.split('\n').filter(Boolean) : [],
      }
    }

    // AOCI：status 便宜；verify 可选（会重新哈希受管文件，NAS 上要几十秒）
    const aociStatus = await run([cfg.aociCommand, 'status', '--repo', root], { timeoutMs: cfg.statusTimeoutMs })
    const parsedAoci = aociStatus.exitCode === 0
      ? parseAociStatus(aociStatus.stdout + aociStatus.stderr)
      : { present: false, error: (aociStatus.stderr || aociStatus.stdout || '').trim().split('\n')[0] }
    if (opts.verify && parsedAoci.present) {
      const v = await run([cfg.aociCommand, 'verify', '--repo', root, '--json'], { timeoutMs: cfg.statusTimeoutMs, signal: opts.signal })
      parsedAoci.verify = v.exitCode === 0 || v.stdout.includes('{') ? parseVerify(v.stdout + v.stderr) : null
    }
    info.aoci = parsedAoci

    // CodeGraph：status 需要 cwd 在该仓库
    const cg = await run(cgArgv('status'), { cwd: root, timeoutMs: cfg.statusTimeoutMs })
    info.codegraph = cg.exitCode === 0
      ? parseCodegraphStatus(cg.stdout + cg.stderr)
      : { present: false, error: (cg.stderr || cg.stdout || '').trim().split('\n')[0] || 'codegraph status failed' }

    return info
  }

  // ── 顶层目录占用（只 stat，不递归读内容；有文件数上限）────────────────
  async function topLevelUsage(root, maxEntries = 12) {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    let entries = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch (error) {
      return { error: errorText(error) }
    }
    const rows = []
    let budgetFiles = cfg.assetMaxFiles
    const walk = async (dir, depth) => {
      let total = 0
      let files = 0
      let list = []
      try {
        list = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return { total, files }
      }
      for (const ent of list) {
        if (budgetFiles <= 0) break
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (depth >= 2) continue
          const sub = await walk(p, depth + 1)
          total += sub.total
          files += sub.files
          budgetFiles = sub.budgetFiles ?? budgetFiles
        } else if (ent.isFile()) {
          try {
            const st = await fs.stat(p)
            total += st.size
            files += 1
            budgetFiles -= 1
          } catch {
            /* 忽略不可读项 */
          }
        }
      }
      return { total, files }
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const p = path.join(root, ent.name)
      if (ent.isDirectory()) {
        const sub = await walk(p, 0)
        rows.push({ name: ent.name, kind: 'dir', bytes: sub.total, files: sub.files })
      } else if (ent.isFile()) {
        try {
          const st = await fs.stat(p)
          rows.push({ name: ent.name, kind: 'file', bytes: st.size, files: 1 })
        } catch {
          /* 忽略 */
        }
      }
    }
    rows.sort((a, b) => b.bytes - a.bytes)
    return { entries: rows.slice(0, maxEntries), truncated: budgetFiles <= 0 }
  }

  const fmtMB = (bytes) => {
    if (typeof bytes !== 'number' || !isFinite(bytes)) return '-'
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
    return bytes + ' B'
  }

  // ── 工具 1：资产总览 ─────────────────────────────────────────────────
  const statusTool = {
    name: 'company_repo_status',
    description:
      '一家或多家公司的代码与数据资产体检：git 分支/跟踪文件数/脏文件数，AOCI 认知索引（条目数、基线文件数、最近 verify 快照），'
      + 'CodeGraph 符号图规模（文件/节点/边/DB 大小），以及顶层目录占用（识别数据资产）。'
      + '不传 company 时检查 config.companies 里登记的全部公司；verify=true 时额外跑 aoci verify 拿对齐与漂移（较慢）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        company: { type: 'string', description: '公司名或仓库绝对路径；省略则检查登记的全部公司' },
        verify: { type: 'boolean', description: '是否跑 aoci verify 检查对齐与漂移（会重新哈希受管文件，默认 false）' },
        usage: { type: 'boolean', description: '是否统计顶层目录占用（数据资产盘点，默认 true）' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const targets = args.company ? [resolveCompany(args.company)] : listCompanies()
      if (targets.length === 0) {
        throw new Error('没有可检查的公司：请传 company，或在插件 config.companies 里登记仓库')
      }
      const companies = []
      for (const c of targets) {
        const info = await inspectCompany(c, { verify: args.verify === true, signal: exec?.signal })
        if (args.usage !== false) info.usage = await topLevelUsage(c.root)
        companies.push(info)
      }
      const lines = companies.map((c) => {
        const g = c.git || {}
        const a = c.aoci || {}
        const cg = c.codegraph || {}
        const drift = a.verify?.drift
          ? ` drift(m=${a.verify.drift.missing},s=${a.verify.drift.stale},o=${a.verify.drift.orphan})`
          : ''
        return [
          `■ ${c.name}  (${c.root})`,
          `  git      : ${g.isRepo ? `${g.branch} · ${g.trackedFiles} 跟踪文件 · ${g.dirtyEntries} 项未提交 · remote: ${g.remotes?.length ? g.remotes.join(',') : '无'}` : `非仓库 (${g.error})`}`,
          `  AOCI     : ${a.present ? `${a.entries} 条目 · 基线 ${a.baselineFiles} 文件${a.verify ? ` · ${a.verify.aligned ? '已对齐' : '未对齐'}${drift}` : ''}` : '未初始化'}`,
          `  CodeGraph: ${cg.present ? `${cg.files} 文件 · ${cg.nodes} 节点 · ${cg.edges} 边 · DB ${cg.dbSize}` : '未建索引'}`,
          c.usage?.entries?.length
            ? `  资产     : ${c.usage.entries.slice(0, 6).map((e) => `${e.name} ${fmtMB(e.bytes)}`).join(' · ')}`
            : '',
        ].filter(Boolean).join('\n')
      })
      return json({ ok: true, companies, text: lines.join('\n\n') })
    },
  }

  // ── 工具 2：建/刷新索引 ──────────────────────────────────────────────
  const indexTool = {
    name: 'company_repo_index',
    description:
      '为一家公司建或刷新代码资产索引。target=codegraph：全量重建符号图（快，秒级到分钟级）；'
      + 'target=aoci-scan：重建 AOCI 的 Baseline 指纹（不写条目，条目由宿主模型创作）；'
      + 'target=aoci-maintain：只返回该走的流程说明（维护必须由宿主模型按 AOCI Guide 完成，插件不能代写语义）。'
      + '安全默认：dryRun=true 只报告将要执行什么，必须显式 dryRun=false 才真的执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        company: { type: 'string', description: '公司名或仓库绝对路径' },
        target: { type: 'string', enum: ['codegraph', 'aoci-scan', 'aoci-maintain'], description: '要刷新的索引类型' },
        dryRun: { type: 'boolean', description: '默认 true 只报告；false 才执行' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const company = resolveCompany(args.company)
      const dryRun = args.dryRun !== false
      const plan = []
      let argv = null
      if (args.target === 'codegraph') {
        argv = cgArgv('index')
        plan.push('codegraph index —— 全量重建 .codegraph/（自忽略，不进 git）')
      } else if (args.target === 'aoci-scan') {
        argv = [cfg.aociCommand, 'scan', '--repo', company.root]
        plan.push('aoci scan —— 按受管范围重建 Baseline 指纹（不改条目内容）')
      } else {
        return json({
          ok: true,
          company,
          action: 'aoci-maintain',
          executed: false,
          text: [
            `■ ${company.name} (${company.root})`,
            'aoci-maintain 不能由插件代做：AOCI 的条目是「模型撰写」的语义产物，必须由宿主 Agent 按当前 Guide 完成。',
            '正确做法：在目标公司的会话里让 Agent 调 aoci_maintain（MCP），按返回批次读完源码后 aoci_update_entry 整批提交。',
            '本插件只负责体检、建 Baseline（aoci-scan）和查询。',
          ].join('\n'),
        })
      }
      if (dryRun) {
        return json({
          ok: true,
          company,
          action: args.target,
          executed: false,
          text: `■ ${company.name} (${company.root})\n  计划：${plan.join('；')}\n  命令：${argv.map((s) => (/\s/.test(s) ? JSON.stringify(s) : s)).join(' ')}\n  cwd ：${company.root}\n  当前为 dryRun=true，未执行。确认无误后传 dryRun=false 执行。`,
        })
      }
      const started = Date.now()
      const r = await run(argv, { cwd: company.root, timeoutMs: cfg.indexTimeoutMs, signal: exec?.signal })
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      const tail = (r.stdout || r.stderr || '').trim().split('\n').slice(-12).join('\n')
      return json({
        ok: r.exitCode === 0,
        company,
        action: args.target,
        executed: true,
        result: { exitCode: r.exitCode, elapsedSec: Number(elapsed), tail },
        text: `■ ${company.name} (${company.root})\n  ${plan.join('；')}\n  退出码 ${r.exitCode}，耗时 ${elapsed}s${r.lossy ? '（输出被截断）' : ''}\n${tail ? '\n' + tail : ''}`,
      })
    },
  }

  // ── 工具 3：查代码 ───────────────────────────────────────────────────
  const queryTool = {
    name: 'company_repo_query',
    description:
      '在一家公司的代码库里提问。backend=codegraph：用 codegraph explore 一次返回相关符号的逐行源码与调用链（推荐，最省 round-trip）；'
      + 'backend=aoci：返回认知索引的检索入口说明（AOCI 的检索在 MCP 工具 aoci_search 上，CLI 不提供）。'
      + '查询词可以是符号名、文件名，也可以是一句自然语言问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        company: { type: 'string', description: '公司名或仓库绝对路径' },
        query: { type: 'string', description: '符号名 / 文件名 / 自然语言问题' },
        backend: { type: 'string', enum: ['codegraph', 'aoci'], description: '默认 codegraph' },
        maxFiles: { type: 'integer', description: 'codegraph explore 最多返回多少个文件的源码（默认 6）' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const company = resolveCompany(args.company)
      const backend = args.backend || 'codegraph'
      if (backend === 'aoci') {
        return json({
          ok: true,
          company,
          action: 'aoci-query',
          executed: false,
          text: [
            `■ ${company.name} (${company.root})`,
            'AOCI 的语义检索走 MCP 工具 aoci_search（keyword / tag_filter / scope），CLI 不提供等价子命令。',
            '认知层的建立与维护同样走 MCP：aoci_rules → aoci_overview → aoci_maintain → aoci_update_entry。',
            '本插件的 company_repo_status 会报告条目数与对齐状态，company_repo_index target=aoci-scan 可重建 Baseline。',
          ].join('\n'),
        })
      }
      const maxFiles = Number.isFinite(args.maxFiles) ? Math.max(1, Math.min(24, args.maxFiles)) : 6
      const argv = cgArgv('explore', '--max-files', String(maxFiles), String(args.query))
      const r = await run(argv, { cwd: company.root, timeoutMs: cfg.queryTimeoutMs, signal: exec?.signal })
      const out = (r.stdout || '').trim()
      const err = (r.stderr || '').trim()
      const text = out || err || '（codegraph explore 没有返回内容）'
      return json({
        ok: r.exitCode === 0,
        company,
        action: 'codegraph-explore',
        executed: true,
        result: { exitCode: r.exitCode, maxFiles, chars: text.length },
        text: `■ ${company.name} · codegraph explore "${args.query}"\n\n${text}`,
      })
    },
  }

  // ── 工具 4：代码 vs 数据资产盘点 ─────────────────────────────────────
  const assetTool = {
    name: 'company_repo_assets',
    description:
      '盘点一家公司的代码资产与数据资产：代码侧按 git 跟踪的扩展名统计文件数（区分源码/文档/配置/二进制），'
      + '数据侧列出顶层目录与文件的占用（MB/GB），并标出未被 git 跟踪但存在的顶层目录。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        company: { type: 'string', description: '公司名或仓库绝对路径' },
        top: { type: 'integer', description: '列出前多少个顶层占用项（默认 12）' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const company = resolveCompany(args.company)
      const top = Number.isFinite(args.top) ? Math.max(3, Math.min(40, args.top)) : 12
      const tracked = await run(['git', '-C', company.root, 'ls-files'], { timeoutMs: 180000, signal: exec?.signal })
      const files = tracked.exitCode === 0 ? tracked.stdout.split('\n').filter(Boolean) : []
      const EXT = {
        源码: ['.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.cpp', '.cc', '.c', '.h', '.cu', '.java', '.sh', '.ps1', '.sbatch', '.mjs', '.m'],
        文档: ['.md', '.tex', '.bib', '.txt', '.rst'],
        配置: ['.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.condarc'],
        数据: ['.npz', '.npy', '.pkl', '.csv', '.parquet', '.h5', '.hdf5', '.pt', '.ckpt', '.bin', '.memmap'],
        素材: ['.png', '.jpg', '.jpeg', '.svg', '.pdf', '.tiff', '.webp', '.gif', '.drawio', '.mp4'],
      }
      const bucket = {}
      const detail = {}
      for (const f of files) {
        const dot = f.lastIndexOf('.')
        const ext = dot >= 0 ? f.slice(dot).toLowerCase() : '(无扩展名)'
        detail[ext] = (detail[ext] || 0) + 1
        let cls = '其他'
        for (const [k, list] of Object.entries(EXT)) {
          if (list.includes(ext)) { cls = k; break }
        }
        bucket[cls] = (bucket[cls] || 0) + 1
      }
      const topExt = Object.entries(detail).sort((a, b) => b[1] - a[1]).slice(0, 10)
      const usage = await topLevelUsage(company.root, top)
      const lines = [
        `■ ${company.name} (${company.root})`,
        `  git 跟踪：${files.length} 个文件`,
        '  ' + Object.entries(bucket).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '),
        '  主要扩展名：' + topExt.map(([k, v]) => `${k} ${v}`).join(' · '),
        usage?.entries?.length
          ? '  顶层占用：\n' + usage.entries.map((e) => `    ${e.kind === 'dir' ? '📁' : '📄'} ${e.name}  ${fmtMB(e.bytes)}${e.kind === 'dir' ? `（${e.files} 文件）` : ''}`).join('\n')
          : '  顶层占用：不可读',
        usage?.truncated ? '  ⚠ 枚举达到 assetMaxFiles 上限，占用为下界' : '',
      ].filter(Boolean)
      return json({
        ok: true,
        company,
        action: 'assets',
        executed: true,
        result: { trackedFiles: files.length, byClass: bucket, topExt, usage },
        text: lines.join('\n'),
      })
    },
  }

  // ── 工具 5：公司建档（自动拉起管家 Agent）─────────────────────────────
  const provisionTool = {
    name: 'company_repo_provision',
    description:
      '为一家公司建档：创建一个专属 Agent 会话（默认 preset=ai-company-org-worker），把本插件定义的《代码与数据资产管理员准则 + 任务清单》作为首条指令投给它，'
      + '并记进状态文件（幂等，重复调用不会重复建）。插件开启 autoProvision 时，新工作区出现会自动走同一流程，本工具用于手动补建/重建。'
      + '不传 company 时对 config.companies 里登记的全部公司建档；force=true 才为已建档的公司重建会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        company: { type: 'string', description: '公司名或仓库绝对路径；省略则处理登记的全部公司' },
        preset: { type: 'string', description: '管家会话的 agent preset，默认取 config.managerPreset' },
        force: { type: 'boolean', description: '已建档也重建（默认 false）' },
        all: { type: 'boolean', description: '连同工作区注册表里发现、但未登记在 config.companies 的公司一起建档' },
        sessionId: {
          type: 'string',
          description: '认领一个已存在的会话当管家（如用户自己在 UI 里建的「项目仓库管理员」）：只登记不重建',
        },
        sendPlaybook: {
          type: 'boolean',
          description: '认领时是否把准则与任务清单投给该会话（默认 false，避免突然让对方开始干活）',
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      // 认领模式：已有会话，只登记 +（可选）投准则
      if (args.sessionId) {
        const company = resolveCompany(args.company)
        const r = await adoptCompany(company, args.sessionId, {
          reason: 'adopted-manual',
          sendPlaybook: args.sendPlaybook === true,
        })
        const line = r.error
          ? `⚠ ${company.name} 已认领会话 ${r.sessionId}，但投递准则失败：${r.error}`
          : `✅ ${company.name} (${company.root}) 认领会话 ${r.sessionId}${r.playbookSent ? '，并已投递准则与任务清单' : '（未投递准则，需要时传 sendPlaybook=true）'}`
        return json({ ok: !r.error, action: 'adopt', executed: true, company, result: r, text: line })
      }
      const targets = []
      if (args.company) targets.push(resolveCompany(args.company))
      else {
        targets.push(...listCompanies())
        if (args.all) {
          for (const w of readWorkspaceStore()) {
            if (!targets.some((t) => normPath(t.root) === normPath(w.path))) {
              targets.push({ name: w.title || w.path.split(/[\\/]/).filter(Boolean).pop() || w.path, root: w.path })
            }
          }
        }
      }
      const results = []
      for (const c of targets) {
        const r = await provisionCompany(c, { reason: 'manual', preset: args.preset, force: args.force === true })
        results.push({ company: c, ...r })
      }
      const lines = results.map((r) => {
        if (r.created) return `✅ ${r.company.name} (${r.company.root})\n   管家会话 ${r.sessionId} · preset ${r.preset} · ${r.at}`
        if (r.error) return `❌ ${r.company.name} (${r.company.root}) 建档失败：${r.error}`
        return `• ${r.company.name} (${r.company.root}) 已建档，跳过（会话 ${r.sessionId}，${r.at}）；要重建加 force=true`
      })
      return json({
        ok: results.every((r) => r.created || r.skipped),
        action: 'provision',
        executed: true,
        companies: results.map((r) => ({ ...r.company, ...r })),
        text: lines.join('\n'),
      })
    },
  }

  // ── 工具 6：取回准则全文 ─────────────────────────────────────────────
  const playbookTool = {
    name: 'company_repo_playbook',
    description:
      '取回本插件为「代码与数据资产管理员」定义的准则与任务清单全文（config.playbook 有覆盖时返回覆盖后的版本）。'
      + '用途：① 人工审阅这份准则；② 管家会话在上下文被压缩后重新注入，不要凭记忆复述。只读。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute() {
      const text = playbookText()
      return json({
        ok: true,
        action: 'playbook',
        executed: false,
        result: { source: cfg.playbook?.trim() ? 'config' : 'builtin', chars: text.length },
        text,
      })
    },
  }

  ctx.effect(() => ctx.tools.register(statusTool))
  ctx.effect(() => ctx.tools.register(indexTool))
  ctx.effect(() => ctx.tools.register(queryTool))
  ctx.effect(() => ctx.tools.register(assetTool))
  ctx.effect(() => ctx.tools.register(provisionTool))
  ctx.effect(() => ctx.tools.register(playbookTool))
  // 公司建档监听：新工作区出现即拉起管家（ctx.effect 负责在插件卸载时清掉定时器）
  ctx.effect(() => startProvisionWatcher())
}
