import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { onTestFinished } from 'vitest'
import AgentLoop from '../src/index.ts'

export async function relocationFixture(compression: 'none' | 'zstd' = 'none', materializeHistory = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relocation-lifecycle-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'a'))
  await mkdir(join(root, 'b'))
  const a = await realpath(join(root, 'a'))
  const b = await realpath(join(root, 'b'))
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(WorkspaceRegistry)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const wa = await ctx.workspaceRegistry.create(a)
  const wb = await ctx.workspaceRegistry.create(b)
  const id = SessionId(randomUUID())
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: a }, agentOptions: { provider: 'unchanged', model: 'unchanged' } })
  if (materializeHistory) {
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  await ctx.sessionPersistence.flush()
  await wa.attachSession(id)
  const foreign = new Context()
  contexts.push(foreign)
  await foreign.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression })
  const snapshot = await ctx.sessionPersistence.stat(id)
  if (snapshot === undefined) throw new Error('fixture was not persisted')
  const request = { sessionId: id, operationId: randomUUID(), expectedCwd: a,
    expectedRevision: snapshot.revision, targetWorkspaceId: wb.id }
  const restart = async () => {
    await ctx.fiber.dispose()
    const restarted = new Context()
    contexts.push(restarted)
    await restarted.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression })
    await restarted.plugin(Storage)
    restarted.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const domain = new DomainFacility(restarted, { backend: 'memory', routes: {} })
    restarted.storage.mount('domain', domain)
    restarted.provide('storageDomain', domain)
    await restarted.plugin(WorkspaceRegistry)
    return restarted
  }
  return { ctx, foreign, root, pool, id, a, b, wa, wb, handle, request, restart, loopFiber }
}
