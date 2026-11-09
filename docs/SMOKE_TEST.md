# 真实 DSH 冒烟验收

本文用于安装/升级后验证真实 Host，而不是只运行 Node 单元测试。请在一个空白测试目录中操作，不要在真实项目里执行。

## 1. 激活检查

安装 Bundle 并重启 DSH 后：

1. 打开插件管理，确认 `AI Company` 与资产子插件处于 active；
2. 确认预设中存在 `ai-company-executive / manager / org-worker / worker`；
3. 在新会话调用 `company_health`，确认 `ok=true`、`maxWorkers` 和私有 stateDir；
4. 调用 `company_policy`，确认默认 profile 为 `core-values-v1`、shadow 模式。

## 2. 两个并行工单

在空白目录 `company-smoke` 中，分别创建以下两个任务（idempotency key 不同）：

| 工单 | task | acceptance | evidence |
|:---:|:---:|:---:|:---:|
| A | 写入 `a.txt`，内容 `A-OK`，然后 `orchestrator_report(state=ready)` | `node -e "require('node:fs').accessSync('a.txt')"` | `a.txt` |
| B | 写入 `b.txt`，内容 `B-OK`，然后 `orchestrator_report(state=ready)` | `node -e "require('node:fs').accessSync('b.txt')"` | `b.txt` |

两单的公共参数：

```json
{
  "goal": "真实并行闭环冒烟",
  "scope": { "allow": ["a.txt 或 b.txt"] },
  "execution_mode": "workspace",
  "model_policy": "keep"
}
```

使用同一个根 Session 在同一条消息中并行调用两次 `company_dispatch`，随后：

- 返回各有一个不同的 `ticketId` 和 `sessionId`；
- `company_tickets` 可以看到两条独立 Ticket；
- `company_collect` 最终均有 `orchestrator_report` 证据，而不是只有 accepted；
- 分别调用 `company_verify`，两条均为 `verified=true`；
- 文件内容分别为 `A-OK` 与 `B-OK`。

## 3. 幂等与恢复

1. 用第一次的 `idempotency_key` 再次派发，应返回 `duplicate=true` 和原 `ticketId`，不得新建 Worker。
2. 在没有新 Assignment 的情况下重启 DSH，已完成/已验证工单必须保持原状态，不得自动重跑。
3. 对 failed/blocked 工单使用 `company_retry`，应新增 Assignment 且验收重置为 `unverified`。
4. 对仍在运行的工单使用 `company_stop`，再开启新任务，Worker 槽位应可释放。

## 4. 公开默认安全

- 未配置 GitHub/飞书/AOCI/CodeGraph 时，核心流程仍可完成；
- 插件不读取 `~/.dsh/.credentials.yaml`，不要求粘贴启动 token；
- `autoProvision=false`，新工作区不会自动创建管家会话；
- `shadow.enabled=false`，默认没有派发 JSONL 台账；
- 新 Worker 的权限仍由使用者的 DSH permission preset 决定，没有被插件强制改为 `danger-full-access`。

只有以上真实检查全部通过，才能把对应版本标为“已在本机 DSH 验证”。
