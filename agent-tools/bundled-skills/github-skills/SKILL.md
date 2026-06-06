---
name: github-skills
description: 从 GitHub 任意仓库的 SKILL.md 文件直接装入技能,补 ClawHub 之外的长尾。
when_to_use: 用户给出 GitHub repo URL 让"装一个 X skill";用户说"看 github 上有没有 X 的 skill";本地 + clawhub 都没找到合适 skill,需要去 github 长尾搜
version: 1.0.0
---

# GitHub as Skill Source

## When to Use

- ClawHub `clawhub search` 找不到合适的,但我相信 GitHub 上有
- 用户给了一个 GitHub URL 让装("装这个仓库的 skill:https://github.com/foo/bar")
- 想找"非主流但优秀"的领域 skill(很多个人项目只发 GitHub 不发 ClawHub)

## 前置依赖

- `gh` CLI(GitHub CLI),`brew install gh` 或 `apt install gh`,装好后 `gh auth login` 一次
- 本 skill 的 search 用到 `gh search code`,需要登录态。如果 `gh auth status` 失败,告诉用户先登录。

## 核心流程

### 1. 搜索 GitHub 上的 SKILL.md

```
shell({ command: "gh search code 'philont skill SKILL.md path:**/SKILL.md' --limit 10 --json repository,path" })
```

按主题缩小:

```
shell({ command: "gh search code '<topic> SKILL.md path:**/SKILL.md' --limit 10 --json repository,path" })
```

JSON 输出里挑 repository.nameWithOwner + path,组合成 raw URL:
```
https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>
```

### 2. 拉取并校验

```
http({
  method: "GET",
  url: "https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>",
})
```

拿到文本后**校验**:
- 必须以 `---\n` 开头(YAML frontmatter)
- frontmatter 必须含 `name:` 字段
- body 必须含 `## When to Use` 段(否则 trigger keyword 提取不出来)
- 整篇 < 8KB(philont loader 的 cap,超过会被拒)

任一不通过,告诉用户原因,不装。

### 3. 装入

从 frontmatter 读出 `name`(若没有,fallback 用 owner-repo 形式或问用户)。然后:

```
installSkill({
  name: "<from-frontmatter-or-derived>",
  content: "<整篇 SKILL.md 文本>",
  source: "github:<owner>/<repo>@<commit-sha>"
})
```

`<commit-sha>` 可以从另一次 http GET 拿:
```
http({
  method: "GET",
  url: "https://api.github.com/repos/<owner>/<repo>/commits/HEAD",
  headers: { "Accept": "application/vnd.github.v3+json" }
})
```
读响应 body 的 `.sha`,截取前 7 位。如果懒省事,直接写 `github:<owner>/<repo>@HEAD`,但版本不可重现。

### 4. 卸载

```
uninstallSkill({ name: "<name>" })
```

和 ClawHub 装入的 skill 卸载同路径。

## 决策树:GitHub URL 用户给我了,直接装?

- URL 形如 `https://github.com/<owner>/<repo>/blob/.../SKILL.md` → 转成 raw URL,直接走流程
- URL 是仓库根 → 试 `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/SKILL.md`,失败再问用户具体路径
- URL 不是 GitHub → 用 `installSkill` content 模式直接装(任意 HTTP 源都行,见 `Anti-patterns` 注意事项)

## Anti-patterns

- ❌ 不要不校验就 `installSkill`。GitHub 上的 SKILL.md 没有 ClawHub 那种发布前审核,可能是别人测试时写歪了的。最少校验三件:有 frontmatter、有 name、有 When to Use。
- ❌ 不要忘了 source 标签。GitHub URL 用户回头问"从哪装的",我必须能答上。
- ❌ 不要用 `gh repo clone` 拉整个仓库。我们只要 SKILL.md 一个文件,clone 浪费磁盘和时间。`http` GET raw 即可。
- ❌ 不要装私有仓里的 SKILL.md 而不告诉用户。私有仓 `gh api` 能看到但 raw URL 默认 401。如果用户没明说要装私有仓,跳过。
- ❌ 不要在 `name` 字段里塞 `owner/repo` 这种带斜杠的字符。philont 的 installSkill 只允许 `[a-z0-9_-]`,会被拒。derive name 时把斜杠换成 `-`。

## 失败处理

| 现象 | 应对 |
|---|---|
| `gh: command not found` | 告诉用户 `brew install gh` / `apt install gh` |
| `gh auth status` 报未登录 | 告诉用户跑 `gh auth login` |
| raw URL 返回 404 | 试 `master` 分支(老仓库默认分支不是 main),再失败告诉用户该路径没文件 |
| frontmatter 解析失败 | 把原文头 200 字给用户看,问要不要"原样装"(用 `installSkill content` 强制覆盖) |
| 内容 > 8KB | 不装。告诉用户该 SKILL.md 太长,建议作者拆分 |
