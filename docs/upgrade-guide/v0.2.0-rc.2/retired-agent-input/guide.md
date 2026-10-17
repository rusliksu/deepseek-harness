---
kind: upgrade-guide
description: "Retired Agent incarnations reject new input instead of accepting messages during teardown."
---

# Stop using retired Agent incarnations

English | [中文](guide.zh.md)

## Change

After lifecycle disposal starts, a retained Agent reference rejects new input, inbox mutations, and maintenance. Previously a late caller could append input while that incarnation was being torn down. Native Session relocation also retires the old incarnation before publishing the replacement with the same Session id.

## Migration

1. Finish or cancel accepted work before disposing its Agent handle. Do not submit input through that reference after disposal starts.
2. After relocation, resolve the Agent again through the Session controller or `ctx.agents.get(sessionId)`; reopen a completed Session history subscription on the same id.
3. Confirm that late input is refused and that the newly resolved incarnation uses the destination cwd with the original history.
