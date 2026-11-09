# AI-Company for DeepSeek Harness

[中文完整文档](README.zh-CN.md) | English | [GitHub](https://github.com/DSM-DSM/dsh-ai-company) | [Gitee](https://gitee.com/AiALi7-9-22/dsh-ai-company)

AI-Company turns DSH workspaces into a federation of agent companies and adds persistent, parallel, verifiable execution inspired by DeepSeek's Super-agent.

## What it provides

- Workspaces as companies with multi-level organization presets.
- Atomic `Trigger → Decision → Ticket → Assignment → launch effect` creation in SQLite.
- One DSH Worker Session per Ticket with configurable `maxWorkers` concurrency.
- Structured `orchestrator_report` evidence and checks.
- Independent `company_verify` acceptance commands and evidence coverage.
- Durable Effects/Outbox, retry, stop, and restart recovery.
- Optional AOCI/CodeGraph asset governance with automatic provisioning disabled by default.

**`accepted` means durably queued, never completed. A task is called verified only after every independent acceptance command exits 0 and every required evidence item is covered.**

## Requirements

- DeepSeek Harness `^0.2.1-alpha.2`
- Node.js `^22.19.0 || >=24.0.0`
- At least one model provider configured in DSH

## Install

```sh
# Gitee
git clone https://gitee.com/AiALi7-9-22/dsh-ai-company.git /absolute/path/dsh-ai-company
# Or GitHub
git clone https://github.com/DSM-DSM/dsh-ai-company.git /absolute/path/dsh-ai-company
dsh plugin --profile web add /absolute/path/dsh-ai-company
```

Restart DSH after installing or upgrading the JavaScript modules. The Bundle includes all worker and organization presets; no separate lean-worker, GitHub, Feishu, AOCI, or CodeGraph installation is required for the core ticket workflow.

## First ticket

Ask a DSH Agent to call `company_dispatch` with an absolute `cwd`, `task`, `goal`, `scope.allow`, `acceptance`, and `evidence`. Then call `company_collect` and `company_verify` with the returned `ticket_id`.

Use `execution_mode=workspace` to work in the company directory, or `directory` for an empty per-ticket directory. Shared directories do not provide write isolation.

## Main tools

| Tool | Purpose |
|:---:|:---:|
| `company_dispatch` | Atomically create and queue a persistent Ticket |
| `company_tickets` / `company_collect` | Inspect execution, reports, evidence and audit |
| `company_verify` | Re-run acceptance commands and verify evidence |
| `company_retry` / `company_stop` | Recover or withdraw a Ticket |
| `company_list` / `company_health` | Inspect companies and runtime health |
| `company_policy` / `company_ledger` | Inspect value policies and the optional ledger |
| `company_repo_*` | Optional code/data asset governance |

## Safety and current limits

The plugin reads no DSH cookie-signing secret, calls no privileged loopback RPC, and does not force `danger-full-access`. Scope and policy are authorization/audit semantics, not an OS sandbox. Acceptance entries are executable commands and must be trusted.

This release focuses on DSH-native ticket execution. It has no graphical Ticket panel, does not enable GitHub/Feishu Sources by default, and does not yet provide a unified third-party quota adapter.

See [SECURITY.md](SECURITY.md), [NOTICE](NOTICE), and [PROVENANCE.md](PROVENANCE.md) for safety, upstream provenance and adaptation details. Licensed under [MIT](LICENSE).
