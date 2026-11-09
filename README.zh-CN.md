# AI-Company for DeepSeek Harness

![MIT License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)
![Node](https://img.shields.io/badge/Node-%5E22.19%20%7C%20%3E%3D24-blue?style=for-the-badge)
![DSH](https://img.shields.io/badge/DSH-%5E0.2.1--alpha.2-purple?style=for-the-badge)

[English](README.md) | 中文

> **多公司管理 + 持久化工单 + 并行 Worker + 独立验收。** AI-Company 把 DSH 工作区视为公司，将 Super-agent 的 Trigger、Mandate、Ticket、Assignment、Report 和恢复机制接入跨公司组织编排。`accepted` 只代表工单已持久化并排入队列，绝不等于任务完成。

<a id="sec-toc"></a>

## 目录

- [1. 核心能力](#sec-1)
- [2. 工作原理](#sec-2)
- [3. 环境与安装](#sec-3)
- [4. 第一个闭环任务](#sec-4)
- [5. 工具一览](#sec-5)
- [6. 组织角色](#sec-6)
- [7. 配置与数据](#sec-7)
- [8. 安全边界](#sec-8)
- [9. 开发与验证](#sec-9)
- [10. 当前限制与许可证](#sec-10)

<a id="sec-1"></a>

## 1. 核心能力

| 能力 | 实现方式 |
|:---:|:---:|
| 多公司管理 | 每个 DSH 工作区 cwd 视为一家公司；统一列出会话与工单 |
| 持久化工单 | Trigger、Decision、Mandate、Ticket、Assignment 存入 SQLite |
| 原子派发 | 工单、幂等键和 launch effect 在同一事务提交后才执行 |
| 并行执行 | 每个 Ticket 一个独立 Worker Session；`maxWorkers` 控制槽位 |
| 结构化报告 | Worker 通过 `orchestrator_report` 提交状态、证据和检查结果 |
| 独立验收 | `company_verify` 串行重跑验收命令，并逐项核对必需证据 |
| 故障恢复 | 持久 Effects、Outbox、retry、stop、启动时 Assignment 恢复 |
| 组织协作 | 总管理、部门经理、组织执行 Agent，最大委派深度 3 |
| 模型解耦 | 使用 DSH 当前模型目录；可指定单次 Worker 模型或上下文候选 |
| 资产治理 | 可选 AOCI/CodeGraph 工具与公司资产管家；默认不自动建档 |

<a id="sec-2"></a>

## 2. 工作原理

```text
用户 / 总管理 Agent
        │ company_dispatch
        ▼
Trigger → Decision → Ticket → Assignment → launch effect
        │            同一个 SQLite 事务
        ▼
Worker Session（每工单一Session）
        │ 执行、检查、orchestrator_report
        ▼
company_collect → company_verify → verified
```

状态必须分开理解：

| 状态 | 含义 |
|:---:|:---:|
| `accepted` | 工单和 launch effect 已持久化；尚未证明执行完成 |
| `ready / completed` | Worker 已报告结果，Ticket 已结束执行 |
| `unverified` | 尚未独立验收，或证据/命令未通过 |
| `verified` | 所有独立验收命令退出码为 0，且所有必需证据被报告覆盖 |
| `blocked / failed` | 需要人工回答、修复或显式 `company_retry` |
| `stopped` | Mandate 已撤销；历史、目录和审计记录保留 |

<a id="sec-3"></a>

## 3. 环境与安装

### 环境要求

- DeepSeek Harness `^0.2.1-alpha.2`；
- Node.js `^22.19.0 || >=24.0.0`；
- 一个已在 DSH 中配置好的模型供应商；
- 可选：Git、AOCI、CodeGraph（只在使用资产治理时需要）。

Bundle 已包含 Worker 与组织预设，**不需要单独安装 lean-worker**，也不要求 GitHub、飞书、AOCI 或 CodeGraph 才能使用工单闭环。

### 从源码安装

```powershell
git clone <your-git-url>/dsh-ai-company.git D:\source\dsh-ai-company
dsh plugin --profile web add D:\source\dsh-ai-company
```

Linux/macOS 示例：

```bash
git clone <your-git-url>/dsh-ai-company.git "$HOME/src/dsh-ai-company"
dsh plugin --profile web add "$HOME/src/dsh-ai-company"
```

也可以通过 DSH 插件管理界面安装该目录。安装后**重启 DSH**，在新会话中使用。升级 JavaScript 模块同样需要重启；仅修改配置时按 DSH 的热加载结果为准。

<a id="sec-4"></a>

## 4. 第一个闭环任务

在一个空白测试目录中，让 DSH Agent 调用 `company_dispatch`：

```json
{
  "cwd": "D:\\demo\\company-smoke",
  "task": "在当前目录写入 hello.txt，内容为 exactly: AI-Company OK。随后调用 orchestrator_report，state=ready，并附 evidence 与 checks。",
  "goal": "验证一个工单从执行到独立验收",
  "scope": { "allow": ["hello.txt"] },
  "acceptance": [
    "node -e \"require('node:fs').accessSync('hello.txt')\""
  ],
  "evidence": ["hello.txt"],
  "execution_mode": "workspace",
  "idempotency_key": "hello-v1"
}
```

返回后：

1. 用 `company_collect` 读取 `ticketId`、Assignment、Worker 报告与原始证据；
2. 用 `company_verify` 独立重跑 `acceptance`；
3. 只有 `verified=true` 才把该任务称为完成。

重复调用相同 `idempotency_key` 会返回原 Ticket，不会重复创建 Worker。

> ⚠️ 默认 `workspace` 模式让 Worker 在公司的实际 cwd 中工作。`directory` 模式则为每工单创建一个独立空目录，适合自包含任务；它不会自动复制原项目。Git worktree 的准备命令可在本地配置中提供。

<a id="sec-5"></a>

## 5. 工具一览

| 工具 | 用途 |
|:---:|:---:|
| `company_list` | 列出公司、会话与工单概况 |
| `company_dispatch` | 原子创建工单并排队执行 |
| `company_tickets` | 查询工单执行和验收状态 |
| `company_collect` | 读取 Mandate、Assignment、报告、证据与审计 |
| `company_verify` | 独立重跑验收命令并核对证据覆盖 |
| `company_retry` | 为可恢复工单创建新 Assignment |
| `company_stop` | 停止工单并撤销 Mandate |
| `company_policy` | 查看当前价值规范与执行模式 |
| `company_ledger` | 查看可选复杂度/派发台账；默认关闭 |
| `company_health` | 查看 Runtime、Worker 与 Effects 健康状态 |
| `company_repo_*` | 可选的资产体检、索引、查询、盘点、建档和准则工具 |

Worker 内部使用 `orchestrator_read` 和 `orchestrator_report`，它们只暴露给对应 Ticket 的 Worker Session。

<a id="sec-6"></a>

## 6. 组织角色

| Preset | 角色 | 适用场景 |
|:---:|:---:|:---:|
| `ai-company-executive` | 总管理 | 跨公司目标拆解、最多三个部门、最终验收 |
| `ai-company-manager` | 部门经理 | 最多四个执行任务、证据复核与汇总 |
| `ai-company-org-worker` | 组织执行 Agent | 部门经理下属的具体子 Ticket，不继续派工 |
| `ai-company-worker` | Ticket Worker | 持久化工单执行与结构化报告，不主动继续派工 |

推荐规则：总管理通过 Ticket 创建部门经理，部门经理在授权下继续创建子 Ticket；系统持久化 `parent_ticket_id` 与 `delegation_depth`，最大深度为 3。普通 Worker 默认不能继续派工。

<a id="sec-7"></a>

## 7. 配置与数据

完整示例见 [examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml)。公开默认值：

| 配置 | 默认值 |
|:---:|:---:|
| `maxWorkers` | `3` |
| `executionMode` | `workspace` |
| `workerPreset` | `ai-company-worker` |
| `modelPolicy.candidates` | `[]` |
| `shadow.enabled` | `false` |
| `policy.enforcement` | `shadow` |
| `autoProvision` | `false` |
| `companies` / `allowedRoots` | `{}` / `[]` |

运行数据默认位于 `${DSH_HOME}/ai-company`；未设置 `DSH_HOME` 时为 `~/.dsh/ai-company`。包括：

- `company.sqlite`：工单、Effects、Outbox 与验收状态；
- `dispatch-ledger.jsonl`：只有显式开启 shadow 后才产生；
- `repo-manage-provisioned.json`：资产管家建档状态；
- `work/`：`directory` 模式的工单目录。

这些目录不应被提交到公开仓库。`scope.allow/deny` 是授权与审计信息，不是自动生效的路径沙箱。

<a id="sec-8"></a>

## 8. 安全边界

- 不读取 DSH Cookie 签名秘密，不调用 loopback 高权限 RPC；
- 不给 Worker 强制设置 `danger-full-access`，权限由使用者的 DSH 配置决定；
- `acceptance` 会在工单目录中被再次执行，必须视为代码命令，不接受不可信文本；
- `policy.enforcement=shadow` 只记录风险；需要阻断时改为 `enforce`；
- 共享 cwd 的多个 Worker 可能写冲突，应拆分写入范围，或使用独立目录/worktree；
- 资产工具会执行外部 AOCI/CodeGraph/Git 命令，索引写入仍要求显式 `dryRun=false`；
- `directory` 与命令包装不是 OS 安全边界，高权限任务仍需独立 OS 账户或真正的沙箱。

详见 [SECURITY.md](SECURITY.md)。

<a id="sec-9"></a>

## 9. 开发与验证

```powershell
pnpm install --ignore-scripts
pnpm test
node --check entry.js
npm pack --dry-run --json
```

测试覆盖 SQLite 事务与恢复、幂等建单、独立验收、公开默认策略和 Worker 并发槽。`devDependencies` 仅用于本地测试；运行时所需的 DSH 包由宿主提供。真实 DSH 安装后的并行验收步骤见 [SMOKE_TEST.md](docs/SMOKE_TEST.md)。

上游内核的固定 commit、修改清单与重建方法见 [PROVENANCE.md](PROVENANCE.md)。若要将本系统写成研究论文，请先阅读 [RESEARCH_QUESTION_CARD.md](docs/RESEARCH_QUESTION_CARD.md)：其中明确区分现有实现证据、尚缺的真实 DSH 证据和可证伪假设。

<a id="sec-10"></a>

## 10. 当前限制与许可证

当前版本聚焦 DSH 内部任务闭环，以下内容不作已完成承诺：

- 尚无原生图形化 Ticket 面板，管理入口是 Agent 工具；
- 默认不启用 GitHub/飞书 Source，也不替代官方 Super-agent 的 PR 工作流；
- 尚未实现供应商配额插件的统一适配层；模型选择使用 DSH 目录、显式选择与上下文压力；
- 共享 cwd 与 `scope` 不提供真正的写入隔离。

本项目按 [MIT LICENSE](LICENSE) 发布。DeepSeek Super-agent 上游源码及其 MIT 许可证保留在 `vendor/dsh-superagent`，适配与归因见 [NOTICE](NOTICE) 和 [PROVENANCE.md](PROVENANCE.md)。上游研究原型声明不表示 DeepSeek 对本适配提供背书。
