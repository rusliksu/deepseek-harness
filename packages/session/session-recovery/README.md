---
description: "The durable per-interruption recovery ledger and the boot pass that continues a Session turn interrupted by a restart, for maintainers of the desktop composition and of the recovery policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recovery

English | [中文](README.zh.md)

## Summary

`dsh-session-recovery` turns an open turn left in a stored Session log into at most one continuation after a restart. A session-scoped ledger records one outcome per interruption, a pass classifies the interrupted turn before it resumes anything, and only a consenting Session or a turn that called no tool continues unattended. A continuation is one user message with source `recovery`; the interrupted turn's events stay unchanged behind it. The host composition supplies the ports that read logs, resume the Session, inject the message, and wait for the model provider.

## Table of Contents

- [What it owns](#what-it-owns)
- [Order of operations](#order-of-operations)
- [Safety policy](#safety-policy)
- [Status machine](#status-machine)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## What it owns

- `RecoveryLedger` — the only writer of the recovery unit. It creates one record per (`sessionId`, `turnStartSeq`), enforces the status machine, and counts repeat attempts.
- `FileRecoveryStore` — a JSON-file implementation of the `LedgerStore` port. Writes replace the file through a sibling temporary file and a rename, so a crash leaves the previous or the new document.
- `selectCandidates` — joins candidates from Session logs with records the ledger still keeps non-terminal, applies archive, subagent, opt-in, and age rules, and orders the result newest first.
- `RecoveryRuntime` — one pass over the selected candidates: mark `resuming`, wait for the model provider, resume the Session (which appends the closing events of the interrupted turn), append the continuation batch, then mark `resumed`.
- `buildInjection` — the message text, the `recovery` source kind, and the marker that the batch also starts the turn.
- `classifyTurn` — decides whether the interrupted turn may continue unattended: any mutating call blocks it, a completed mutating call because a recorded result is not a confirmed-safe effect and an unfinished one because its outcome is unknown. Undeclared tools count as mutating.
- The unit envelope (`{ unit: { name: 'recovery', version: 1 }, tables: { sessions, interruptions } }`) matches the versioned storage units other host services use, so the file store can be replaced by the host storage service without a format change.

## Order of operations

A pass is only correct in one order. The record is marked `resuming` before the Session is resumed, because resuming appends the closing events and erases the open-turn signal in the log. The message and the turn start are appended as one batch, so no message ever sits without a turn. The record becomes `resumed` only after that batch lands. A record left in `resuming` by a dead process is counted as an attempt on the next pass instead of being overwritten.

## Safety policy

A pass classifies the interrupted turn before it resumes anything. Only calls declared read-only, and a turn without calls, allow automatic continuation. A mutating or undeclared call parks the record in `awaiting-confirmation`: the Session gets a notice, and `continueConfirmed` is the single human-triggered path that resumes the turn. `requireConfirmationForWriteTools: false` removes the gate for a deployment that accepts the risk.

Automatic continuation also needs consent. A Session opts in through its policy record, except for a turn that called no tool: that case continues on its own unless `continueWithoutTools: false` is set. An interrupted turn whose tool calls cannot be read keeps needing the per-Session opt-in.

## Status machine

`resuming` starts every record. It moves to `resumed`, `failed`, `awaiting-confirmation`, or `skipped`. `failed` returns to `resuming` (attempt counted) or ends as `skipped`. `awaiting-confirmation` returns to `resuming` only through a human action. `resumed` and `skipped` are final.

## Model Experience

### Request context and condition

The package contributes nothing a model saw before recovery. When a pass injects a continuation, the model reads exactly one user message with source `recovery` and the pinned text in `RECOVERY_MESSAGE_TEXT`; the interrupted turn's own events stay unchanged behind it.

### Tools

None. The package exports no tool.

### Token and KV-cache effects

A continuation adds one user message to the conversation, so its tokens are billed once per recovered interruption, within the configured per-pass limit. The message sits after the interrupted turn, so the cached prefix of the previous turn is unchanged.

## Dev Note

The ledger is a single JSON document under `ledgerPath`; the unit envelope carries its version, and a reader rejects a unit whose name or version it does not know instead of reinterpreting it. One host mounts one recovery owner. Every setting is validated `Config` except the pinned message text and the unit name, which are protocol constants.

## Known Limitations and Deferred Work

- The Cordis plugin that reads these settings and supplies the ports (Session log scan, resume, injection, provider readiness) ships with the desktop composition; the base bundle row stays disabled until a deployment opts in.
- `FileRecoveryStore` serializes writes through the caller: the ledger reads, mutates, and writes back, so two concurrent writers on one file can lose an update. The host mounts exactly one recovery owner, which is the current contract; a shared store must serialize writes itself.
- The `mutating` declaration itself lives in each tool package; this release ships the registry port and the fail-safe default (undeclared tools are mutating).
- No pass produces `awaiting-confirmation` from a real tool log yet in the general case: the composition supplies `classify` and `notifyAwaiting`, and the UI action calls `continueConfirmed`.
