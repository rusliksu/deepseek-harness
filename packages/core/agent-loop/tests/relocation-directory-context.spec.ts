import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionDirectoryContext } from '@deepseek-ai/dsh-workspace/types'
import { describe, expect, it } from 'vitest'
import { relocationFixture } from './relocation-fixture.ts'

function observation(session: Session) {
  return { header: session.header, inheritedEventCount: session.inheritedEventCount, eventCount: session.seq }
}

async function referencedFile(contexts: readonly SessionDirectoryContext[], seq: SessionSeq) {
  const context = contexts.findLast(context => context.fromEvent <= seq)
  if (context === undefined) throw new Error('missing historical directory')
  return await readFile(join(context.cwd, 'same.txt'), 'utf8')
}

describe('historical directories across chat relocation', () => {
  it('resolves old and new references independently across repeated moves and restart', async () => {
    const f = await relocationFixture()
    await writeFile(join(f.a, 'same.txt'), 'file from A')
    await writeFile(join(f.b, 'same.txt'), 'file from B')
    const first = f.handle.agent.session.append('turn/start', { turn: 2 })
    f.handle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const frontier = f.handle.agent.session.seq
    const move = async (targetWorkspaceId: typeof f.wa.id) => {
      const snapshot = await f.ctx.sessionPersistence.stat(f.id)
      if (snapshot?.header.cwd === undefined) throw new Error('missing fixture')
      return await f.ctx.workspaceRegistry.relocateSession({ ...f.request, operationId: randomUUID(),
        expectedCwd: snapshot.header.cwd, expectedRevision: snapshot.revision, targetWorkspaceId },
      (request, callbacks) => f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
    }
    await f.ctx.sessionPersistence.flush()
    await move(f.wb.id)
    let current = f.ctx.agents.get(f.id)!.session
    const second = current.append('turn/start', { turn: 3 })
    current.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await f.ctx.sessionPersistence.flush()
    const secondFrontier = current.seq
    await move(f.wa.id)
    // Each resume appends its own marker, even without a model turn.
    await move(f.wb.id)
    current = f.ctx.agents.get(f.id)!.session
    const contexts = await f.ctx.workspaceRegistry.sessionDirectoryContexts(observation(current))
    expect(contexts).toEqual([
      { fromEvent: 0, cwd: f.a }, { fromEvent: frontier, cwd: f.b },
      { fromEvent: secondFrontier, cwd: f.a }, { fromEvent: 8, cwd: f.b },
    ])
    if (contexts === undefined) throw new Error('missing contexts')
    expect(await referencedFile(contexts, first.seq)).toBe('file from A')
    expect(await referencedFile(contexts, second.seq)).toBe('file from B')
    const restarted = await f.restart()
    const reader = await restarted.sessionPersistence.open(f.id, 'read')
    try {
      const events = (await reader.read()).events
      const recovered = await restarted.workspaceRegistry.sessionDirectoryContexts({ header: reader.header,
        inheritedEventCount: reader.inheritedEventCount, eventCount: SessionLogOffset(events.length) })
      expect(recovered).toEqual(contexts)
    } finally { await reader.close() }
  })

  it('copies a fork prefix before its parent moves again and rolls back failed placement', async () => {
    const f = await relocationFixture()
    await f.ctx.workspaceRegistry.relocateSession(f.request, (request, callbacks) =>
      f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
    const parent = f.ctx.agents.get(f.id)!.session
    parent.append('turn/start', { turn: 2 })
    parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await f.ctx.sessionPersistence.flush()
    const parentReader = await f.ctx.sessionPersistence.open(f.id, 'read')
    const seed = (await parentReader.read()).events
    await parentReader.close()
    const id = SessionId(randomUUID())
    const child = await f.ctx.agents.create({ sessionId: id, seed,
      inheritedEventCount: parent.seq, meta: { cwd: f.b, parentSession: f.id, isSeeded: true } })
    await f.ctx.sessionPersistence.flush()
    await f.wb.attachSession(id)
    const before = await f.ctx.workspaceRegistry.sessionDirectoryContexts(observation(child.agent.session))
    expect(before).toEqual([{ fromEvent: 0, cwd: f.a }, { fromEvent: 2, cwd: f.b },
      { fromEvent: 5, cwd: f.b }])
    const snapshot = await f.ctx.sessionPersistence.stat(id)
    if (snapshot === undefined) throw new Error('missing child')
    await expect(f.ctx.workspaceRegistry.relocateSession({ ...f.request, sessionId: id, operationId: randomUUID(),
      expectedCwd: f.b, expectedRevision: snapshot.revision, targetWorkspaceId: f.wa.id },
    (request, callbacks) => f.ctx.agentLoop.relocate(f.ctx, request, {}, { ...callbacks,
      placed: async (header) => { await callbacks.placed(header); throw new Error('placed failure') },
    }))).rejects.toThrow('placed failure')
    const restored = f.ctx.agents.get(id)!.session
    expect(await f.ctx.workspaceRegistry.sessionDirectoryContexts(observation(restored))).toEqual(before)
    const parentSnapshot = await f.ctx.sessionPersistence.stat(f.id)
    if (parentSnapshot === undefined) throw new Error('missing parent')
    await f.ctx.workspaceRegistry.relocateSession({ ...f.request, operationId: randomUUID(), expectedCwd: f.b,
      expectedRevision: parentSnapshot.revision, targetWorkspaceId: f.wa.id },
    (request, callbacks) => f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
    expect(await f.ctx.workspaceRegistry.sessionDirectoryContexts(observation(restored))).toEqual(before)
  })
})
