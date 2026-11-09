# 验证记录

## 1. 自动化检查

| 检查 | 结果 | 原始输出 |
|:---:|:---:|:---:|
| 上游 TypeScript 类型检查 | 通过 | `tsc --noEmit`，退出码 0 |
| 上游内核构建 | 通过 | `tsdown` 生成 `company-kernel.js` 与运行 chunk |
| Node 单元与模拟集成测试 | 24/24 通过 | `npm test`，pass=24、fail=0 |
| 公开静态检查 | 通过 | 入口、语法、README 锚点、本机绑定扫描 |
| npm 打包审计 | 通过 | `company-kernel.js` 及其实际 import chunk 均在包内 |

测试覆盖：原子建单、完整信封幂等、独立 Thread、报告与 relay 同事务、独立验收、空证据拒绝、Ticket 树深度、资产批量门禁、普通祖先报告接收方、dead-letter、Bundle 启停和 SQLite 重开恢复。

## 2. 真实 DSH 并行闭环

环境：DeepSeek Harness `0.2.1-alpha.2`，Windows，Node.js 24.21.0。测试目录为本机隔离的空白目录，不包含项目数据。

| 原始项 | 工单 A | 工单 B |
|:---:|:---:|:---:|
| Ticket | `bf8587b066bbe817fd560573611990ee` | `f5f33c2fe1c4d3bafc533513c3b77286` |
| Worker Session | `worker-bf8587b066bbe817fd560573611990ee` | `worker-f5f33c2fe1c4d3bafc533513c3b77286` |
| 创建时间（UTC） | 2026-11-09T13:15:48.651Z | 2026-11-09T13:15:49.281Z |
| Worker ready（UTC） | 2026-11-09T13:16:04.016Z | 2026-11-09T13:16:07.296Z |
| 执行结果 | `completed` | `completed` |
| 文件证据 | `a.txt`，内容 `A-OK` | `b.txt`，内容 `B-OK` |
| Worker 检查退出码 | 0 | 0 |
| 独立验收退出码 | 0 | 0 |
| 独立验收时间（UTC） | 2026-11-09T13:22:31.463Z | 2026-11-09T13:22:32.048Z |
| 最终状态 | `verified` | `verified` |

两单在同一条消息中并行创建，均产生独立 Ticket、Worker Session 和 Assignment。`company_collect` 返回完整 Mandate、报告和证据；`company_verify` 在工单目录中独立重跑命令，确认文件存在且证据精确覆盖。

## 3. 兼容性实证

首次独立验收时，本机没有 `pwsh`，返回 `spawn pwsh ENOENT`，两单均为 failed。加入 `pwsh → powershell.exe` 的 DSH 原生解析回退并构建新内核后，同样两单独立验收均为 0 并转为 `verified`。该失败与修复过程未隐藏。

## 4. 幂等实证

对工单 A 使用完全相同的 `idempotency_key=smoke-20261109-parallel-a-v1` 再次派发，返回 `duplicate=true`，Ticket 与 Worker Session 保持原值，`acceptedAt=2026-11-09T13:15:48.652Z`，没有创建第二个 Worker。

## 5. 重启验证

待 DSH 重启后复核：已完成工单不得自动重跑，重复幂等派发仍返回原 Ticket。

## 6. 证据边界

上述结果只证明本机、当前版本和这组小型任务的真实闭环，不构成大规模性能、成本或生产可靠性结论。论文所需的对照实验、吞吐、失败率和恢复统计见 [RESEARCH_QUESTION_CARD.md](RESEARCH_QUESTION_CARD.md)。
