import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { relocationFixture as fixture } from './relocation-fixture.ts'

describe('native relocation lifecycle and workspace transaction', () => {
  it('preserves a nonempty inherited history, lineage and reasoning options through restart', async () => {
    const f = await fixture()
    const parent = await f.ctx.sessionPersistence.open(f.id, 'read')
    const inherited = (await parent.read()).events
    await parent.close()
    const id = SessionId(randomUUID())
    const options = { provider: 'unchanged', model: 'unchanged', reasoningEffort: ReasoningEffortId('high'), maxTokens: 4096 }
    const fork = await f.ctx.agents.create({
      sessionId: id, seed: inherited, inheritedEventCount: SessionLogOffset(inherited.length), agentOptions: options,
      meta: { cwd: f.a, parentSession: f.id, isSeeded: true, delegationDepth: 1 },
    })
    await f.ctx.sessionPersistence.flush()
    await f.wa.attachSession(id)
    const snapshot = await f.ctx.sessionPersistence.stat(id)
    if (snapshot === undefined) throw new Error('missing fork fixture')
    const reader = await f.ctx.sessionPersistence.open(id, 'read')
    const before = (await reader.read()).events
    await reader.close()
    const request = { ...f.request, sessionId: id, expectedRevision: snapshot.revision }
    await f.ctx.workspaceRegistry.relocateSession(request, (storageRequest, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, storageRequest, {}, callbacks))
    const current = f.ctx.agents.get(id)
    expect(current).not.toBe(fork.agent)
    expect(current?.options).toEqual(options)
    expect(current?.session.inheritedEventCount).toBe(inherited.length)
    const restarted = await f.restart()
    const after = await restarted.sessionPersistence.open(id, 'read')
    try {
      expect(after.header).toEqual({ ...snapshot.header, cwd: f.b })
      expect(after.inheritedEventCount).toBe(inherited.length)
      expect((await after.read()).events.slice(0, before.length)).toEqual(before)
    } finally { await after.close() }
  })

  it.each(['archived', 'pinned'] as const)('preserves %s status and the session title through relocation and restart', async (status) => {
    const f = await fixture()
    await f.ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 128, maxTitleBytes: 256 })
    f.ctx.sessionTitle.rename(f.handle.agent.session, 'kept title')
    await f.ctx.sessionPersistence.flush()
    if (status === 'archived') await f.ctx.workspaceRegistry.archiveSession(f.id)
    else await f.ctx.workspaceRegistry.pinSession(f.id)
    const snapshot = await f.ctx.sessionPersistence.stat(f.id)
    if (snapshot === undefined) throw new Error('missing fixture session')
    const request = { ...f.request, expectedRevision: snapshot.revision }
    await f.ctx.workspaceRegistry.relocateSession(request, (storageRequest, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, storageRequest, {}, callbacks))
    const current = f.ctx.agents.get(f.id)
    expect(current).toBeDefined()
    if (current === undefined) throw new Error('missing relocated agent')
    expect(f.ctx.sessionTitle.get(current.session)?.title).toBe('kept title')
    const restarted = await f.restart()
    expect(restarted.workspaceRegistry.archivedSessionIds).toEqual(status === 'archived' ? [f.id] : [])
    expect(restarted.workspaceRegistry.pinnedSessionIds).toEqual(status === 'pinned' ? [f.id] : [])
    expect(restarted.workspaceRegistry.get(f.wb.id)?.sessionIds).toEqual([f.id])
    const reader = await restarted.sessionPersistence.open(f.id, 'read')
    try { expect((await reader.read()).events.some(event => event.type === 'session/title' && event.data.title === 'kept title')).toBe(true) }
    finally { await reader.close() }
  })

  it('consults the exact scoped state owner before disposing or journaling the chat', async () => {
    const f = await fixture()
    const consulted = vi.fn(({ agent }) => {
      expect(agent).toBe(f.handle.agent)
      throw Object.assign(new Error('persistent terminal state'), { code: 'session/relocate-unsupported' })
    })
    f.handle.agent.ctx.on('agent/relocation-check', consulted)
    await expect(f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks)))
      .rejects.toMatchObject({ code: 'session/relocate-unsupported' })
    expect(consulted).toHaveBeenCalledOnce()
    expect(f.ctx.agents.get(f.id)).toBe(f.handle.agent)
    expect(f.ctx.workspaceRegistry.relocationPending).toBe(false)
  })

  it.each([false, true])('awaits a relocation during factory teardown and releases its final lease (recovery failure: %s)', async (recoveryFailure) => {
    const f = await fixture()
    const placed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const moving = f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, {
        ...callbacks,
        placed: async (header) => {
          await callbacks.placed(header)
          placed.resolve(undefined)
          await release.promise
          throw new Error('factory stopped while placed')
        },
        rollback: async (result) => {
          if (recoveryFailure) throw new Error('membership recovery unavailable')
          await callbacks.rollback(result)
        },
      }))
    const rejected = expect(moving).rejects.toThrow()
    await placed.promise
    const stopping = f.loopFiber.dispose()
    release.resolve(undefined)
    await Promise.all([rejected, stopping])
    expect(f.ctx.agents.get(f.id)).toBeUndefined()
    const writer = await f.foreign.sessionPersistence.open(f.id, 'write')
    expect(writer.header.cwd).toBe(f.a)
    await writer.close()
    const restarted = await f.restart()
    expect(restarted.workspaceRegistry.relocationPending).toBe(false)
    expect(restarted.workspaceRegistry.get(f.wa.id)?.sessionIds).toEqual([f.id])
    expect(restarted.workspaceRegistry.get(f.wb.id)?.sessionIds).toEqual([])
  })

  it.each(['none', 'zstd'] as const)('preserves the same history and options, then reverses the move (%s)', async (compression) => {
    const f = await fixture(compression)
    const before = await f.ctx.sessionPersistence.open(f.id, 'read')
    const prefix = (await before.read()).events
    await before.close()
    const result = await f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
    expect(result).toMatchObject({ sessionId: f.id, cwd: f.b, sourceWorkspaceId: f.wa.id, targetWorkspaceId: f.wb.id })
    expect(f.wa.sessionIds).toEqual([])
    expect(f.wb.sessionIds).toEqual([f.id])
    const current = f.ctx.agents.get(f.id)
    expect(current).toBeDefined()
    expect(current).not.toBe(f.handle.agent)
    expect(current?.options).toEqual({ provider: 'unchanged', model: 'unchanged' })
    expect(current?.session.header.cwd).toBe(f.b)
    const reader = await f.ctx.sessionPersistence.open(f.id, 'read')
    expect((await reader.read()).events.slice(0, prefix.length)).toEqual(prefix)
    await reader.close()
    await expect(f.foreign.sessionPersistence.open(f.id, 'write')).rejects.toThrow()
    const repeated = await f.ctx.workspaceRegistry.relocateSession(f.request, () => { throw new Error('retry must use durable result') })
    expect(repeated).toEqual(result)
    const back = await f.ctx.workspaceRegistry.relocateSession({ ...f.request, operationId: randomUUID(),
      expectedCwd: f.b, expectedRevision: result.revision, targetWorkspaceId: f.wa.id }, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
    expect(back.cwd).toBe(f.a)
    expect(f.wa.sessionIds).toEqual([f.id])
    expect(f.wb.sessionIds).toEqual([])
  })

  it.each(['placed', 'completed', 'completed-persisted'] as const)(
    'rolls back a failed %s callback without releasing writer ownership', async (point) => {
      const f = await fixture()
      await expect(f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
        f.ctx.agentLoop.relocate(f.ctx, request, {}, {
          ...callbacks,
          placed: async (header) => {
            await callbacks.placed(header)
            if (point === 'placed') {
              await expect(f.foreign.sessionPersistence.open(f.id, 'write')).rejects.toThrow()
              throw new Error('injected placed failure')
            }
          },
          completed: async (result) => {
            if (point === 'completed') {
              await expect(f.foreign.sessionPersistence.open(f.id, 'write')).rejects.toThrow()
              throw new Error('injected completed failure')
            }
            await callbacks.completed(result)
            if (point === 'completed-persisted') throw new Error('injected completed-persisted failure')
          },
        }))).rejects.toThrow(`injected ${point} failure`)
      expect(f.ctx.agents.get(f.id)?.session.header.cwd).toBe(f.a)
      expect(f.wa.sessionIds).toEqual([f.id])
      expect(f.wb.sessionIds).toEqual([])
      expect(f.ctx.workspaceRegistry.relocationPending).toBe(false)
      const restored = f.ctx.agents.get(f.id)!.session
      expect(await f.ctx.workspaceRegistry.sessionDirectoryContexts({ header: restored.header,
        inheritedEventCount: restored.inheritedEventCount, eventCount: restored.seq }))
        .toEqual([{ fromEvent: 0, cwd: f.a }])
      await expect(f.foreign.sessionPersistence.open(f.id, 'write')).rejects.toThrow()
    })

  it('denies queued input and in-flight API admission before preparing related data', async () => {
    const f = await fixture()
    const invoke = () => f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
    {
      using _admission = f.ctx.bail('agent/admit-operation', { sessionId: f.id })
      await expect(invoke()).rejects.toMatchObject({ code: 'session/relocate-busy' })
    }
    f.handle.agent.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'pending' }] }))
    await expect(invoke()).rejects.toMatchObject({ code: 'session/relocate-busy' })
    expect(f.ctx.workspaceRegistry.relocationPending).toBe(false)
    expect(f.handle.agent.inbox.nextStep).toHaveLength(1)
  })

  it.each(['before-rollback', 'after-rollback'] as const)('recovers an unfinished operation on restart (%s)', async (point) => {
    const f = await fixture()
    const begin = f.ctx.sessionPersistence.beginRelocation.bind(f.ctx.sessionPersistence)
    const fault = vi.spyOn(f.ctx.sessionPersistence, 'beginRelocation').mockImplementation(async (...args) => {
      const transaction = await begin(...args)
      return { ...transaction, rollback: async () => {
        if (point === 'before-rollback') throw new Error('storage rollback unavailable')
        await transaction.rollback()
      } }
    })
    await expect(f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, {
        ...callbacks,
        completed: async () => { throw new Error('completion unavailable') },
        rollback: async () => { throw new Error('membership recovery unavailable') },
      }))).rejects.toMatchObject({ code: 'session/relocate-recovery-required' })
    expect(f.ctx.workspaceRegistry.relocationPending).toBe(true)
    await expect(f.wb.setTitle('must not overwrite the recovery snapshot')).rejects.toMatchObject({
      code: 'session/relocate-recovery-required',
    })
    await expect(f.foreign.sessionPersistence.open(f.id, 'write')).rejects.toThrow()
    fault.mockRestore()
    const restarted = await f.restart()
    expect(restarted.workspaceRegistry.relocationPending).toBe(false)
    expect(restarted.workspaceRegistry.get(f.wa.id)?.sessionIds).toEqual([f.id])
    expect(restarted.workspaceRegistry.get(f.wb.id)?.sessionIds).toEqual([])
    expect((await restarted.sessionPersistence.stat(f.id))?.header.cwd).toBe(f.a)
    const writer = await restarted.sessionPersistence.open(f.id, 'write')
    await writer.close()
  })
})
