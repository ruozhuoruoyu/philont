---
name: code-search-strategy
description: 在代码库中找东西的高效三步法——glob 定位 → grep 关键词 → readFile 精读,而不是一上来就跑全仓 grep 或 readFile 整文件。
when_to_use: 用户问"X 在代码哪里 / 谁实现了 X / 怎么找 Y";要修改某模块前定位文件;debug 想找 stack trace 来源;读不熟悉的代码库前定位入口;面对大仓库不知从哪开始
version: 1.0.0
---

# Code Search Strategy

## When to Use

- 需要在代码库中找函数 / 类 / 配置 / 字符串
- 用户说"X 在哪里 / 谁调用了 Y / 哪里定义了 Z"
- 准备改某个跨多文件的概念

## 三步法(从粗到细)

### Step 1 · glob 定位文件集

先用 `glob` 圈定可能的文件,**不要**对整仓裸跑 grep。
```
glob("**/*.ts")              # 整个 ts 文件集
glob("src/**/*.{ts,tsx}")    # 只 src 下
glob("**/auth*.ts")          # 名字含 auth
```

glob 输出是文件名清单,**人/LLM 都能扫**——比 grep 整仓输出几百匹配行更省 token。

### Step 2 · grep 缩到匹配行

只对 Step 1 圈出的子集 grep:
```
grep -n "<symbol>" <files-from-glob>
```

加 `-n`(行号)+ `-A 2 -B 2`(上下文 2 行)后续直接跳读。

**不要** `grep -r "X" /` 全盘扫——返回几百行,LLM 失焦,用户也读不进去。

### Step 3 · readFile 精读

只读 grep 命中文件的关键段(传 `offset` + `limit`):
```
readFile(path, offset=120, limit=40)   # 看第 120 行附近 40 行
```

整文件 read 超 500 行就考虑分段。

## 例子对比

**❌ 慢且占 token**:
```
grep -r "useState" .         # 数千行命中,看不过来
```

**✅ 高效**:
```
glob("src/components/**/*.tsx")        # 圈出 ~50 个组件文件
grep -ln "useState" <those files>      # 哪些组件用了 useState
readFile(<top-3>, ranges...)           # 精读最相关的几个
```

## Anti-patterns

- ❌ 一上来 `grep -r` 全仓 → token 爆炸 + 信号被噪音淹没
- ❌ readFile 一个 5000 行的文件不传 offset/limit → 浪费上下文窗口
- ❌ 只看第一个 grep 命中就下结论 → 同名符号经常多处定义
- ❌ glob 用过宽的模式 `**/*` 而不限定扩展名 → 扫到二进制 / 锁文件
