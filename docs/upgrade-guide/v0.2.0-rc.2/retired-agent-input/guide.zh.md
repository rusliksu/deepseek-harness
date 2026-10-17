---
kind: upgrade-guide
description: "退役 Agent 实例拒绝新输入，而不再在拆卸期间接收消息。"
---

# 停止使用退役 Agent 实例

[English](guide.md) | 中文

## 变更

生命周期释放开始后，保留的 Agent 引用会拒绝新输入、收件箱修改与维护。此前，延迟调用方可能在实例拆卸期间追加输入。原生 Session 迁移也会先退役旧实例，再以相同 Session id 发布替代实例。

## 迁移

1. 释放 Agent 句柄之前完成或取消已接受工作。释放开始后，不要再通过该引用提交输入。
2. 迁移之后，通过 Session 控制器或 `ctx.agents.get(sessionId)` 重新解析 Agent；在同一 id 上重新打开已结束的 Session 历史订阅。
3. 确认延迟输入被拒绝，并且新解析的实例在保留原始历史的同时使用目标 cwd。
