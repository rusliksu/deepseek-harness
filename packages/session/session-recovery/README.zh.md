---
description: "每次中断的持久恢复记录，以及重启后继续被中断 Session 轮次的启动过程，供桌面组合与恢复策略的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recovery

[English](README.md) | 中文

## 概述

`dsh-session-recovery` 把已存储 Session 日志中残留的未关闭轮次，在重启后变成最多一次续跑。按 Session 记录的账本为每次中断记录一个结果；一轮流程在继续任何内容之前先判定被中断的轮次，只有明确同意的 Session 或没有调用工具的轮次才会自动继续。续跑是一条来源为 `recovery` 的用户消息，被中断轮次自身的事件保持不变。读取日志、恢复 Session、注入消息与等待模型提供方注册都由宿主组合提供。

## 目录

- [职责](#职责)
- [执行顺序](#执行顺序)
- [安全策略](#安全策略)
- [状态机](#状态机)
- [开发备注](#开发备注)
- [已知限制与后续工作](#已知限制与后续工作)

## 职责

- `RecoveryLedger` — 恢复单元唯一的写入者。它按 (`sessionId`, `turnStartSeq`) 创建记录，执行状态机并统计重试次数。
- `FileRecoveryStore` — `LedgerStore` 端口的 JSON 文件实现。写入先写同目录临时文件再改名，崩溃后留下的总是旧文档或新文档。
- `selectCandidates` — 把 Session 日志中的候选与账本仍未终结的记录合并，应用归档、子智能体、同意与时效规则，并按最新优先排序。
- `RecoveryRuntime` — 对候选执行一轮：标记 `resuming`、等待模型提供方、恢复 Session（补写被中断轮次的收尾事件）、追加续跑批次，最后标记 `resumed`。
- `buildInjection` — 消息文本、`recovery` 来源类型，以及该批次同时开启轮次的标记。
- `classifyTurn` — 判定被中断轮次能否无人值守继续：任何修改型调用都会阻止继续；已完成的修改型调用因为没有可确认安全的实际效果，未完成的则因为结果未知。未声明的工具按修改型处理。

## 执行顺序

一轮流程只有一种正确顺序。必须在恢复 Session 之前标记 `resuming`，因为恢复会补写收尾事件并抹掉日志中的未关闭标记。消息与轮次开始作为一个批次追加，因此不会出现没有轮次的消息。只有批次写入后才变为 `resumed`。被杀进程留在 `resuming` 的记录，在下一轮按一次尝试计数，而不是被覆盖。

## 安全策略

流程在继续之前判定被中断轮次。只有声明为只读的调用，以及没有调用工具的轮次，允许自动继续。修改型或未声明的调用会让记录停在 `awaiting-confirmation`：Session 收到通知，`continueConfirmed` 是唯一由人触发的继续路径。`requireConfirmationForWriteTools: false` 为接受该风险的部署移除这道门。

自动继续还需要同意。Session 通过自己的策略记录选择加入；没有调用工具的轮次是例外，除非设置 `continueWithoutTools: false`，否则自动继续。无法读取工具调用的中断仍然需要按 Session 选择加入。

## 状态机

每条记录从 `resuming` 开始，可转为 `resumed`、`failed`、`awaiting-confirmation` 或 `skipped`。`failed` 回到 `resuming`（计一次尝试）或以 `skipped` 结束。`awaiting-confirmation` 只能由人的操作回到 `resuming`。`resumed` 与 `skipped` 是终态。

## 开发备注

账本是 `ledgerPath` 下的单个 JSON 文档；单元信封携带版本，读取方遇到未知名称或版本会拒绝，而不是重新解释。一个宿主只挂载一个恢复所有者。除固定消息文本与单元名称这两个协议常量外，所有设置都是经过校验的 `Config`。

## 已知限制与后续工作

- 读取设置并提供端口（日志扫描、恢复、注入、提供方就绪）的 Cordis 插件随桌面组合发布；基础 bundle 行保持关闭，直到部署显式启用。
- `FileRecoveryStore` 由调用方串行写入：账本读、改、写回，因此同一文件上的两个并发写入可能丢更新。宿主只挂载一个恢复所有者，这是当前约定；共享存储必须自行串行化。
- `mutating` 声明本身位于各工具包；本版本提供注册端口与失败即保守的默认值（未声明工具视为修改型）。
