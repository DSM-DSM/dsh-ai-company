# 安全说明

## 执行边界

AI-Company 的 `scope.allow/deny`、Mandate 和价值规范是**任务授权与审计语义**，不是操作系统或文件系统安全沙箱。Worker 的实际权限由使用者的 DSH permission preset、Shell/FS 沙箱和操作系统账户共同决定。

本插件不会给 Worker 强制设置 `danger-full-access`，也不会读取 DSH Cookie 签名秘密。请按任务风险选择适当的 DSH 权限；不要让不可信输入构造验收命令或授权不可逆操作。

## 数据位置

默认运行状态位于 `${DSH_HOME}/ai-company`（未设置时为 `~/.dsh/ai-company`），包括 SQLite 工单、Effects、Outbox 和验收记录。复杂度/派发台账默认关闭，开启后可能包含任务目标、路径和证据位置，应仅放在私有目录并定期审查。

## 报告漏洞

请通过发布仓库的 Security Advisory 或安全联系渠道报告，不要在公开 Issue 中粘贴 API Key、Cookie、私有会话、真实任务正文或凭据文件。修复前可使用新 stateDir、关闭相关 Source/工具或卸载 Bundle 作为临时缓解措施。
