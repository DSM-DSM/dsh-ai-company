# AI-Company 架构

## 1. 两层组织、一个闭环

AI-Company 同时保留两种协作方式：

1. **组织层**：`ai-company-executive → ai-company-manager → ai-company-org-worker`。总管理与部门经理通过 `company_dispatch` 创建角色明确的子 Ticket，系统保存 `parent_ticket_id` 和 `delegation_depth`，最大深度为 3。
2. **工单层**：任何获授权角色都可把跨公司、长任务或需要恢复的工作交给 `company_dispatch`，进入统一 Ticket 生命周期；普通 Worker 默认不能继续派工。

组织层的“已回复”不自动等于工单层的“已验证”。统一收口为：

```text
accepted → running → ready/completed → verified
                     ├→ blocked/failed → retry → running
                     └→ stopped
```

## 2. 原子派发

`CompanyRuntime.dispatch` 在外层 `CompanyStore.atomic` 中执行：

1. 检查并占用 `idempotency_key`；
2. `Engine.receive(Trigger)`；
3. `Engine.decide(accept)`，生成 Decision、Mandate、Ticket、订阅和首个 Assignment；
4. Executor 只写入 launch effect，不在事务内创建 Session 或发送消息；
5. 保存幂等映射和初始 `unverified` 状态；
6. 最外层提交后，Effects 才创建/恢复 Worker Session 并投递 Assignment。

因此重复键只返回原 Ticket，崩溃也不会留下“已派消息但没有工单”的窗口。

## 3. 执行与恢复

- `DshExecutor` 负责 Worker 槽位、后台任务等待、失败重试和启动恢复。
- `AgentDelivery` 以 Assignment/Input 派生的稳定 request ID 对 Session history 与 inbox 去重。
- SQLite 采用 WAL 和 `synchronous=FULL`；Effects 在 drain 后保留未完成行。
- `assignmentInterrupted` 区分忙碌 Assignment 与已经 waiting/ready/blocked/failed 的稳定状态，避免盲目重复执行。

## 4. 验收语义

Worker 的 `orchestrator_report(state=ready)` 只结束执行，不能自行宣布 `verified`。

`company_verify` 随后：

1. 要求 Ticket 以 `completed` 结束；
2. 串行执行 Mandate 中的全部 `acceptance` 命令；
3. 要求每条命令退出码为 0；
4. 将 Mandate 的每个 `evidence` 项与 Worker 报告的证据逐项匹配；
5. 全部满足后才把持久状态改为 `verified`。

`company_retry` 会保留 Mandate 与历史，但把验收状态重置为 `unverified`。

## 5. 权限与平台边界

- 不复用上游 GitHub/飞书 Setup、账号 shim、固定 MCP、管理面板或其 `danger-full-access` 策略。
- 通过 DSH Host 原生 `sessionController`、`workspaceRegistry`、`sessionPersistence`、`agents` 和 `subprocess` 工作。
- Windows 与 Unix 分别使用 `pwsh` 和 `sh` 执行验收/准备命令。
- `workspace` 共享 cwd 和 `scope` 不是隔离边界；需要隔离时使用独立目录、Git worktree 或独立 OS 账户。

## 6. 上游复用范围

固定上游 commit 和修改清单见 [../PROVENANCE.md](../PROVENANCE.md)。`company-kernel` 只导出领域核心、Effects、Executor、Delivery、模型初始化和健康登记；不激活上游 Runtime、GitHub/飞书 Source、Setup、迁移或 UI。
