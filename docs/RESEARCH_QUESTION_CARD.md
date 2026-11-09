# 研究问题卡：AI-Company 多 Agent 持久化组织与验收

## 研究问题

在多个长期、并行、跨工作区的 Agent 任务中，**“组织编排 + 持久化授权工单 + 独立验收”**能否比单会话或普通一次性委派更可靠地完成任务，并减少重复副作用与人工协调成本？

## 候选贡献

1. 将公司/部门组织映射为可持久化的 Ticket 树，而非仅存在于提示词中的角色关系。
2. 将 Trigger、Decision、Mandate、Ticket、Assignment、launch effect 和幂等键置于同一事务，避免派发窗口产生无工单或重复执行。
3. 区分 `accepted`、`completed` 与 `verified`，以独立验收命令和逐项证据覆盖作为完成门禁。
4. 通过持久化 Effects、Outbox、稳定 requestId 和启动恢复，降低进程重启后的重复副作用。

## 可证伪假设

- H1：在相同模型、任务集和工具权限下，AI-Company 的端到端 `verified` 比例不低于普通一次性 subagent。
- H2：在注入进程退出、网络失败和重复派发后，AI-Company 的重复外部副作用次数低于非持久化调度。
- H3：在相同并行度下，AI-Company 提高有效吞吐，而不增加最终验收失败率。
- H4：完成同等任务集时，AI-Company 减少人工追踪、查重和恢复所需的干预次数。

若 H1 不成立、持久化反而增加重复副作用，或额外协调成本超过收益，则核心设计假设被削弱或否定，不能只展示成功案例。

## 当前证据

- 公开 Bundle、上游固定 commit 与本地适配已实现。
- Node 单元与模拟集成测试覆盖原子建单、幂等、完整信封区分、独立 Thread、报告事务、独立验收、空证据拒绝、Ticket 树深度、资产门禁和重开恢复。
- 上游 TypeScript 类型检查与构建通过；npm 打包包含实际 company-kernel 与运行 chunk。
- 真实 DSH 中两个不同并行 Worker 均完成 ready 回达，并分别通过独立验收；完整原始记录见 [VERIFICATION.md](VERIFICATION.md)。
- DSH 重启后，已完成工单保持 completed + verified，重复幂等派发只返回原 Ticket，未出现自动重跑。

## 尚缺证据

- Windows `directory + prepareCommand` 的真实执行。
- 多模型、多任务类型、多并发度的对照实验及原始运行日志。
- 与单 Session、普通 subagent、官方 Super-agent 或简单任务队列的可比测量。

## 最小下一步

下一阶段执行多模型、多任务类型、多并发度的对照实验，保留每个任务的原始 Ticket、Assignment、Session、验收退出码、证据文件、时间戳和资源消耗；在这些更大规模证据存在前，不在论文中声称生产可靠性或性能优势。Windows `directory + prepareCommand` 另作独立兼容性验证，不与主闭环结果混合。

## 文章定位

优先考虑系统工程、Agent 基础设施、可靠执行与人机协作治理方向。文章应以研究问题、可复现设计、对照测量和失败边界为主，而不是功能清单或“集成 Super-agent”的宣传。arXiv 预印本可在上述最小实证完成后形成，后续再按目标会议/期刊扩充任务规模与统计分析。
