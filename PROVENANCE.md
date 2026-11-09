# 上游来源与构建复现

## 固定来源

- 项目：`deepseek-ai/dsh-superagent-prototype`
- URL：https://github.com/deepseek-ai/dsh-superagent-prototype
- Commit：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`
- 原始提交标题：`feat: add the dsh-superagent research prototype`
- 许可证：`vendor/dsh-superagent/LICENSE`（MIT）

## 本地修改清单

| 文件 | 修改 |
|:---:|:---:|
| `src/company-kernel.ts` | 新增；只导出 AI-Company 需要的核心、Effects、Executor、Delivery 和模型初始化能力 |
| `src/company-environment.ts` | 新增；最小的 subprocess、目录校验和执行根辅助，不配置 GitHub/飞书账号；Windows 验收与准备命令支持 `pwsh` 不存在时回退 `powershell.exe` |
| `src/executor/dsh.ts` | 改用中性执行环境、跨平台目录名和公司报告消息；不加载上游 Setup/Runtime；目录准备使用上述 Shell 回退 |
| `src/core/assignments.ts` | 恢复提示改为检查当前工作目录、持久历史与既有输出 |
| `tsdown.config.ts` | 增加 `company-kernel` 构建入口 |
| `.gitignore` | 公开副本保留 `lib/` 预构建产物，避免安装包只有源码而缺运行文件 |

其他核心文件保持上游内容。AI-Company 不使用上游 `src/app/runtime.ts`、Setup、GitHub/飞书 Source、面板、迁移或其 `danger-full-access` Session 权限策略。

## 重建内核

在 `vendor/dsh-superagent` 中，使用其锁文件和 `tsdown.config.ts`：

```sh
pnpm install --frozen-lockfile
pnpm build
```

公开包已携带 `lib/company-kernel.js` 及其运行 chunk，普通使用者无需执行上述构建。源码与构建配置同时保留，便于审计和复现。

## 适配层

`src/` 下的公司 Store、Runtime、Sessions、Policy、Outbox、模型路由与独立验收为 AI-Company 自有实现。公开运行不依赖 GitHub 或飞书配置，不读取 DSH Cookie 签名秘密，也不调用 loopback 高权限 RPC。
