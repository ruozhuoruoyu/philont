---
name: git-workflow
description: 标准 git 工作流——branch / commit message / push / pr 的多步骤 routine,避免遗漏关键步骤(如 status 核对、commit message 写规范)。
when_to_use: 用户说"提交一下 / 推送 / 建 PR / 切分支";完成代码改动需要进入 git workflow;commit 前需要正确写 message + 检查 status;创建 PR 需要规范流程
version: 1.0.0
---

# Git Workflow

## When to Use

- 用户说"帮我提交 / 推送 / 发 PR"
- 工作完成后准备 commit 时
- 涉及 git push / git commit / git rebase / pr 等动作

## Pre-flight checklist

每次开始 git 操作前先并行跑这三条 — 不要假设当前状态:

1. `git status`(看未追踪/未暂存的变化)
2. `git diff` (看实际改动)
3. `git log -5 --oneline`(看最近提交风格,统一 message 风格)

## Commit 规范

- **Subject**:< 70 字符,类型前缀(feat/fix/refactor/docs/chore/test) + 范围 + 一句话动机
- **Body**:多段说明"为什么"而非"做了什么"——diff 已经显示做了什么
- **不要**用 `git add -A` 或 `git add .`——那会把 .env / 大二进制 / IDE 配置一并塞进去。**指名添加** `git add path1 path2`
- **不要** `--no-verify` 跳过 hook,除非用户明确要求

## Push / PR 流程

```
git status                         # 确认要提交的文件清单
git add <specific paths>           # 不用 -A
git commit -m "$(cat <<'EOF'
<subject>

<body>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git status                         # 确认 commit 干净
# 推送前问用户(push 是 hard-to-reverse 行为):
git push origin <branch>
gh pr create --title "<title>" --body "<body>"
```

## Anti-patterns

- ❌ 不看 git status 直接 `add -A` → 容易污染历史
- ❌ commit subject "update / fix / wip" 等无信息词
- ❌ 没问用户就 push / 强推 / amend 已发布的 commit
- ❌ commit body 复述 diff 内容 ("modified file X to do Y")——应写 **why**

## 修复 hook 失败

pre-commit hook 失败 = commit 没成功。**不要** `--amend`(那会改之前的 commit)。修问题 → 重新 stage → 创建**新** commit。
