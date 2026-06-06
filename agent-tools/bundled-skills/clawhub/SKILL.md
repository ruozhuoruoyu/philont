---
name: clawhub
description: 从 ClawHub 公共技能库(clawhub.ai)发现、装入、卸载技能,把社区经验内化为我自己的能力。
when_to_use: 用户提到 ClawHub / 公共技能库 / 社区 skill;agent 自己发现"本地无现成 skill 但社区可能有"想去找;用户说"看看 clawhub 上有没有 X" / "装一个处理 X 的 skill"
version: 1.0.0
---

# ClawHub Skill Registry

## When to Use

- 用户的请求我没有现成 skill 可用,但属于公共可复用模式("k8s manifest 校验" / "Postgres 备份" / "GitHub PR 审查" 等)
- 用户明确说:"找/装/卸 ClawHub 技能" / "看看 ClawHub 上有没有 X"
- 我刚反复踩同一类坑,意识到需要更系统的领域指引

## ClawHub 是什么

ClawHub 是 OpenClaw 的公共技能 registry(clawhub.ai),所有 skill 都是公开的、版本化的 SKILL.md bundle。靠本地 `clawhub` CLI 操作,通过 npm 安装:

```
npm i -g clawhub
```

如果 `which clawhub` 失败,告诉用户先装上,然后我们再继续。

## 核心流程

### 1. 搜索

```
shell({ command: "clawhub search '<query>' --limit 5" })
```

例:`clawhub search "k8s yaml validate"`。返回若干 slug + 一句话描述。读懂候选,挑最贴合用户需求的那个。

### 2. 安装

```
shell({ command: "clawhub install <slug> --dir .philont/skills" })
```

`--dir .philont/skills` 让 ClawHub 把 SKILL.md 装到 philont 主 skill 目录(默认它装到 `./skills/`,虽然 philont loader 也读那里,但 `.philont/skills/` 优先级更高,避免冲突)。

写盘后**立即 patch 一下 source 标签**,让 philont 知道这个 skill 来自 ClawHub:

```
installSkill({ name: "<slug>", source: "clawhub:<slug>@<version>" })
```

`<version>` 从 `clawhub install` 的输出里读。如果输出格式变化,可以再跑 `clawhub list` 看 lockfile。

`installSkill` 调用返回时,SkillStore 已经同步刷新——下一个 tool call(包括 `use_skill`)立即就能看到新 skill,不用等 fs watcher。

#### 幂等:`Already installed`

如果 `clawhub install` 退出非 0 且 stderr 含 `Already installed`(可能伴随 libuv assertion 噪声),**不要当失败**:
- 文件已经在磁盘上了,不用重装
- 直接走 `installSkill({ name: "<slug>", source: "clawhub:<slug>@<version>" })` patch source,**不必加 `--force`**(`--force` 会丢失用户/反思器对该目录的本地改动)
- 只有"我有充分理由要拉新版"才传 `--force`(并且事先 `uninstallSkill` 清旧)

### 3. 列出已装

两条路:

- 读 philont 自己的 SkillStore(系统提示词索引里 `[clawhub]` 标签的就是这些)
- 跑 `shell({ command: "clawhub list" })` 读 `.clawhub/lock.json`(以 ClawHub 视角看)

两者应该一致。不一致时(例如用户手工 rm 了目录),philont reload-prune 会自动同步。

### 4. 卸载

```
uninstallSkill({ name: "<slug>" })
```

这会删 `.philont/skills/<slug>/` 目录;watcher 触发 reload 后,prune 路径自动从 SkillStore 删除对应行。

不要直接调 `clawhub uninstall`(它操作的是 `.clawhub/lock.json`,philont 不读那个)。

### 5. 更新

```
shell({ command: "clawhub update <slug>" })   # 单个
shell({ command: "clawhub update --all" })    # 所有
```

更新后**重新 patch source 标签**(版本变了):

```
installSkill({ name: "<slug>", source: "clawhub:<slug>@<new-version>" })
```

## 决策树:用户提到一个我不会的领域,该不该装?

- 一次性问题(用户只问一次,且通用 LLM 能力够用) → 不装,直接答
- 反复出现的多步骤模式(N ≥ 3 步,且 LLM 自己每次走得不稳) → 装
- 用户明确说"装这个" → 装
- ClawHub 上找不到合适的 → 告诉用户搜不到,问要不要让用户给 GitHub URL 直接装(走 `github-skills` skill)

## Anti-patterns

- ❌ 不要装 `clawhub install` 后忘了 patch source。没 source 标签,reload-prune 会把它当本地手写 skill,卸载时不会自动清孤儿行。
- ❌ 不要用 `shell` 直接执行 `rm -rf .philont/skills/<slug>` 替代 `uninstallSkill`。前者绕过了 prune 路径,SkillStore 行会残留(虽然下次 reload 时也会被清,但语义不清晰)。
- ❌ 不要 `clawhub install --force` 覆盖用户本地手写的同名 skill——会丢失反思器自生的成果。先 `uninstallSkill` 显式卸再装。
- ❌ 不要把 ClawHub search 结果原样转给用户后等指令。挑最匹配的一个直接装,失败再反馈。"自主"的体现就是不必每步征求同意。

## 失败处理

| 现象 | 应对 |
|---|---|
| `clawhub: command not found` | 告诉用户 `npm i -g clawhub`,装好后再试 |
| 网络超时 | 重试一次;再失败告诉用户网络问题 |
| 找不到匹配 slug | 切到 `github-skills` 找,或回报用户"ClawHub 暂无相关技能" |
| `clawhub install` 报权限/空间错 | 直接转述给用户,不要假装成功 |
| `Error: Already installed` (含或不含 libuv assertion) | 不重装、不传 `--force`;直接 `installSkill {name, source}` patch source 即可。技能已经在磁盘上,exit≠0 是 CLI 拒绝重装的"善意失败"。 |
| `clawhub install` 长时间无响应(>2 分钟) | 显式传更大 `timeout`(如 300000)重试一次,仍超时则告诉用户网络问题 |
