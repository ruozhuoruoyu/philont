---
name: web-research
description: 联网调研的标准流程——webSearch 评估来源 → webFetch 抓内容 → 引用回答,避免凭印象编造或单源就下结论。
when_to_use: 用户问需要联网才能答的最新信息(新闻 / 比价 / 论文 / 文档版本);用户问"X 是什么 / X 最近怎么样";agent 自己发现"我不知道 X 但应该可查";多源信息需要交叉验证防编造
version: 1.0.0
---

# Web Research

## When to Use

- 用户问需要外部信息的问题(新闻 / 文档 / 软件版本 / API 用法 / 学术)
- 你不确定某个事实(年份、库版本、API 是否存在)而准备答时
- 用户提供了一个 URL 让你"看下"
- 用户消息含 specific token(arxiv ID / CVE / RFC / `lib@version` / 引号专有名词)却你不熟

## 标准流程

### Step 1 · 先 search,再 fetch

```
webSearch("<keyword 1> <keyword 2> [年份/版本]")
```
- 关键词具体 + 加时间限定(如 "2025") → 命中更准
- 看返回 top-5 标题 + URL,**评估来源**:官方 docs > 知名媒体 > 个人博客 > 论坛回复

### Step 2 · 选 1-2 个高质量源 fetch

```
webFetch(url, "提取 X 段 / 回答 Y 问题")
```
- prompt 写**具体提取目标**——不是"总结这个页面",而是"这个 API 的参数有哪些 / 这个 bug 的修复版本号"
- **至少 2 个独立源**交叉验证,尤其是数字 / 日期 / 版本

### Step 3 · 回答带源引用

```
根据 [来源1](url1) 和 [来源2](url2):
  X 是 Y(发布于 2025-03,见来源1)
  注意 Z 在 v3.2 后改成了 W(见来源2)
```

不要用"网上说 / 据我所知"——这是编造的伪装。

## 关键反例

**❌ 凭印象答**:
> "React 19 现在默认开启 strict mode 了"
> (你不知道这是不是真的,这就是编造)

**✅ 先 search**:
> "我先查一下 React 19 的 release note 确认"
> [webSearch / webFetch...]
> "根据 [React 19 announcement](url),strict mode 默认值是 X..."

## Anti-patterns

- ❌ 跳过 search 直接 fetch 一个猜的 URL → 大概率 404 + 浪费一次工具调用
- ❌ 只 fetch 一个源 + 当成事实 → 单源不可靠
- ❌ webSearch 返回结果不看就 fetch 第一个 → 第一个不一定相关
- ❌ 用"据我所知 / 一般来说" 等模糊措辞掩盖未核实

## 结合记忆系统

- 重要事实查到后 **store_fact** 持久化(下次不用再 search)
- 用 `searchNotes` 先看本地有没有,有就不联网
