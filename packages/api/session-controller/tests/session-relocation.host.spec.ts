import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { relocationFixture } from '../../../core/agent-loop/tests/relocation-fixture.ts'
import { createSessionTestController } from './test-remote.ts'

describe('Session Controller native relocation', () => {
  it('refuses a source workspace denied by the caller policy before changing placement', async () => {
    const f = await relocationFixture()
    const controller = createSessionTestController(f.ctx, {
      cwd: f.a, defaultModelSelection: () => ({ provider: 'unchanged', model: 'unchanged' }),
    })
    const allows = vi.spyOn(f.ctx.remoteAccess, 'allows').mockImplementation(resource => resource.kind !== 'workspace' || resource.id !== f.wa.id)
    await expect(controller.relocate(f.request, new AbortController().signal)).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(allows).toHaveBeenCalledWith({ kind: 'workspace', id: f.wa.id })
    expect(f.wa.sessionIds).toEqual([f.id])
    expect(f.wb.sessionIds).toEqual([])
    expect((await f.ctx.sessionPersistence.stat(f.id))?.header.cwd).toBe(f.a)
  })

  it.each([false, true])('refuses subagent identities before changing either workspace (cold: %s)', async (cold) => {
    const f = await relocationFixture()
    const id = SessionId(randomUUID())
    const child = await f.ctx.agents.create({ sessionId: id, meta: { cwd: f.a, origin: 'subagent' } })
    child.agent.session.append('turn/start', { turn: 1 })
    child.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.ctx.sessionPersistence.flush()
    await f.wa.attachSession(id)
    if (cold) await child.dispose()
    const snapshot = await f.ctx.sessionPersistence.stat(id)
    if (snapshot === undefined) throw new Error('missing child fixture')
    const controller = createSessionTestController(f.ctx, {
      cwd: f.a, defaultModelSelection: () => ({ provider: 'unchanged', model: 'unchanged' }),
    })
    expect(await controller.relocationInfo({ sessionId: id }, new AbortController().signal)).toEqual({ supported: false })
    await expect(controller.relocate({ ...f.request, sessionId: id, expectedRevision: snapshot.revision }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/relocate-unsupported' })
    expect(f.wa.sessionIds).toContain(id)
    expect(f.wb.sessionIds).toEqual([])
    expect(f.ctx.workspaceRegistry.relocationPending).toBe(false)
  })

  it('rejects malformed wire payloads before consulting or mutating native owners', async () => {
    const f = await relocationFixture()
    const controller = createSessionTestController(f.ctx, { cwd: f.a, defaultModelSelection: () => ({ provider: 'unchanged', model: 'unchanged' }) })
    const signal = new AbortController().signal
    for (const request of [null, {}, { ...f.request, expectedRevision: 1 },
      { ...f.request, expectedCwd: '' }, { ...f.request, targetWorkspaceId: null },
      { ...f.request, sessionId: [] }, { ...f.request, operationId: 'not-a-uuid' },
      { ...f.request, unexpected: true }]) {
      await expect(Reflect.apply(controller.relocate.bind(controller), undefined, [request, signal]))
        .rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    await expect(Reflect.apply(controller.relocationInfo.bind(controller), undefined, [null, signal]))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(f.ctx.agents.get(f.id)).toBe(f.handle.agent)
    expect(f.wa.sessionIds).toEqual([f.id])
    expect(f.wb.sessionIds).toEqual([])
    expect(f.ctx.workspaceRegistry.relocationPending).toBe(false)
  })

  it('exposes an exact observation and relocates through the native owners with the same ID', async () => {
    const f = await relocationFixture()
    const controller = createSessionTestController(f.ctx, {
      cwd: f.a, defaultModelSelection: () => ({ provider: 'unchanged', model: 'unchanged' }),
    })
    const signal = new AbortController().signal
    const info = await controller.relocationInfo({ sessionId: f.id }, signal)
    expect(info).toEqual({ supported: true, cwd: f.a, revision: f.request.expectedRevision,
      directoryContexts: [{ fromEvent: 0, cwd: f.a }] })
    const result = await controller.relocate(f.request, signal)
    expect(result).toMatchObject({ sessionId: f.id, cwd: f.b, targetWorkspaceId: f.wb.id })
    expect(f.ctx.sessions.list().filter(session => session.id === f.id)).toHaveLength(1)
    expect(f.ctx.agents.get(f.id)?.session.header.cwd).toBe(f.b)
    expect((await controller.relocationInfo({ sessionId: f.id }, signal)).directoryContexts).toEqual([
      { fromEvent: 0, cwd: f.a }, { fromEvent: 2, cwd: f.b },
    ])
    const composition = vi.spyOn(ApiSessionAgentController.prototype, 'composeAgent').mockRejectedValue(new Error('preset unavailable'))
    try {
      expect(await controller.relocate(f.request, signal)).toEqual(result)
      expect(composition).not.toHaveBeenCalled()
    } finally { composition.mockRestore() }
    await expect(controller.relocate({ ...f.request, expectedCwd: f.b }, signal)).rejects.toMatchObject({
      code: 'session/relocate-conflict',
    })
  })

  it('keeps a current-directory no-op from replacing its live incarnation or revision', async () => {
    const f = await relocationFixture()
    const controller = createSessionTestController(f.ctx, {
      cwd: f.a, defaultModelSelection: () => ({ provider: 'unchanged', model: 'unchanged' }),
    })
    const result = await controller.relocate({ ...f.request, targetWorkspaceId: f.wa.id }, new AbortController().signal)
    expect(result.revision).toBe(f.request.expectedRevision)
    expect(f.ctx.agents.get(f.id)).toBe(f.handle.agent)
    expect(f.wa.sessionIds).toEqual([f.id])
  })

  it('maps a concurrent operation to busy and a stale revision to conflict without changing membership', async () => {
    const f = await relocationFixture()
    const controller = createSessionTestController(f.ctx, {
      cwd: f.a, defaultModelSelection: () => ({ provider: 'unchanged', model: 'unchanged' }),
    })
    const signal = new AbortController().signal
    {
      using _admission = f.ctx.bail('agent/admit-operation', { sessionId: f.id })
      await expect(controller.relocate(f.request, signal)).rejects.toMatchObject({ code: 'session/relocate-busy' })
    }
    await expect(controller.relocate({ ...f.request, operationId: randomUUID(), expectedRevision: 'stale' }, signal))
      .rejects.toMatchObject({ code: 'session/relocate-conflict' })
    expect(f.wa.sessionIds).toEqual([f.id])
    expect(f.wb.sessionIds).toEqual([])
  })
})
