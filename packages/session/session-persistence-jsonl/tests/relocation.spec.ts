import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionRelocationRequest } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Config } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../src/format.ts'

const preparationGate: { pause?: () => Promise<void> } = vi.hoisted(() => ({}))
vi.mock('../src/placement.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/placement.ts')>()
  return { ...actual, checkPlacementBudget: async (...args: Parameters<typeof actual.checkPlacementBudget>) => {
    await preparationGate.pause?.()
    return actual.checkPlacementBudget(...args)
  } }
})

const contexts: Context[] = []
const directories: string[] = []

async function requiredSnapshot(persistence: SessionPersistence, id: SessionId) {
  const snapshot = await persistence.stat(id)
  if (snapshot === undefined) throw new Error('expected persisted fixture session')
  return snapshot
}

afterEach(async () => {
  delete preparationGate.pause
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture(options: Partial<Config> = {}, seeded = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relocation-'))
  directories.push(root)
  const cwdA = await realpath(await mkdir(join(root, 'a'), { recursive: true }) ?? join(root, 'a'))
  const cwdB = await realpath(await mkdir(join(root, 'b'), { recursive: true }) ?? join(root, 'b'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', ...options })
  const id = SessionId(randomUUID())
  const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1000,
    delegationDepth: 0, cwd: cwdA, isSeeded: seeded,
    ...(seeded ? { parentSession: SessionId('parent'), origin: 'subagent' } : {}) }
  const events: SessionEvent[] = seeded
    ? [{ type: 'session/end-seed', seq: SessionSeq(0), time: 1, data: { inherited: true } }]
    : [{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }]
  const handle = await ctx.sessionPersistence.create(header, seeded ? { inheritedEventCount: SessionLogOffset(0) } : undefined)
  await handle.append(events)
  await handle.close()
  const request: SessionRelocationRequest = { sessionId: id, operationId: randomUUID(), expectedCwd: cwdA,
    expectedRevision: (await requiredSnapshot(ctx.sessionPersistence, id)).revision, targetCwd: cwdB }
  const path = logPath(join(root, 'sessions'), cwdA, id, 'none')
  return { ctx, root, cwdA, cwdB, header, events, request, path, persistence: ctx.sessionPersistence }
}

describe('session relocation refusals and lineage', () => {
  it('waits for an in-flight relocation preparation before backend unload settles', async () => {
    const f = await fixture()
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    preparationGate.pause = () => { entered.resolve(undefined); return resume.promise }
    const preparing = f.persistence.beginRelocation(f.request)
    try {
      await entered.promise
      const unloading = f.ctx.fiber.dispose()
      try {
        await expect(other.sessionPersistence.open(f.header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      } finally { resume.resolve(undefined) }
      const transaction = await preparing
      await unloading
      const successor = await other.sessionPersistence.open(f.header.id, 'write')
      await successor.close()
      await expect(transaction.commit()).rejects.toMatchObject({ code: 'session/relocate-conflict' })
    } finally {
      resume.resolve(undefined)
      await (await preparing).close()
    }
  })

  it('releases a transaction-held kernel lease when the owning backend unloads', async () => {
    const f = await fixture()
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    const old = await f.persistence.open(f.header.id, 'write')
    const transaction = await f.persistence.beginRelocation(f.request, { writer: old })
    await old.close()
    await f.ctx.fiber.dispose()
    const successor = await other.sessionPersistence.open(f.header.id, 'write')
    await successor.close()
    await expect(transaction.commit()).rejects.toMatchObject({ code: 'session/relocate-conflict' })
    await transaction.close()
  })

  it('keeps routing an existing Session when the backend missed its creation event', async () => {
    const f = await fixture()
    const session = Session.create(f.header.id, f.events, f.header)
    const first = await f.persistence.open(f.header.id, 'write')
    f.ctx.emit('session/event', session, { type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } })
    await f.ctx.parallel('session/flush', session)
    await first.close()
    const second = await f.persistence.open(f.header.id, 'write')
    f.ctx.emit('session/event', session, { type: 'turn/end', seq: SessionSeq(3), time: 4,
      data: { turn: 2, reason: { kind: 'completed' } } })
    await f.ctx.parallel('session/flush', session)
    await second.close()
    const reader = await f.persistence.open(f.header.id, 'read')
    try { expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3]) } finally { await reader.close() }
  })

  it('ignores old incarnation events and disposal after the new writer is published', async () => {
    const f = await fixture()
    const old = await f.persistence.open(f.header.id, 'write')
    const oldSession = Session.create(f.header.id, f.events, old.header)
    f.ctx.emit('session/created', oldSession)
    const transaction = await f.persistence.beginRelocation(f.request, { writer: old })
    try {
      await old.close()
      await transaction.commit()
      const next = await transaction.openWriter()
      const nextSession = Session.create(f.header.id, f.events, next.header)
      f.ctx.emit('session/created', nextSession)
      await transaction.complete(next)
      await transaction.close()
      f.ctx.emit('session/disposed', oldSession)
      f.ctx.emit('session/event', oldSession, { type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 99 } })
      f.ctx.emit('session/event', nextSession, { type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } })
      await f.ctx.parallel('session/flush', nextSession)
      const reader = await f.persistence.open(f.header.id, 'read')
      try { expect((await reader.read()).events.at(-1)?.data).toEqual({ turn: 2 }) } finally { await reader.close() }
      await next.close()
    } finally { await transaction.close(); await old.close() }
  })

  it('hands an existing writer through relocation without releasing its kernel lease', async () => {
    const f = await fixture()
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    const old = await f.persistence.open(f.header.id, 'write')
    const busy = () => expect(other.sessionPersistence.open(f.header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    const transaction = await f.persistence.beginRelocation(f.request, { writer: old })
    try {
      await busy()
      await old.close()
      await busy()
      await transaction.commit()
      await busy()
      const next = await transaction.openWriter()
      expect(next.header.cwd).toBe(f.cwdB)
      await busy()
      await transaction.complete(next)
      await transaction.close()
      await old.close()
      await busy()
      await next.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
      await next.close()
    } finally { await transaction.close(); await old.close() }
    const successor = await other.sessionPersistence.open(f.header.id, 'write')
    try { expect((await successor.read()).events).toHaveLength(3) } finally { await successor.close() }
  })

  it('returns a borrowed replacement writer to the transaction for rollback', async () => {
    const f = await fixture()
    const old = await f.persistence.open(f.header.id, 'write')
    const transaction = await f.persistence.beginRelocation(f.request, { writer: old })
    try {
      await old.close()
      await transaction.commit()
      const failed = await transaction.openWriter()
      await expect(transaction.rollback()).rejects.toMatchObject({ code: 'session/relocate-conflict' })
      await failed.close()
      await expect(f.persistence.open(f.header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      await transaction.rollback()
      const restored = await transaction.openWriter()
      expect(restored.header.cwd).toBe(f.cwdA)
      await transaction.complete(restored)
      await transaction.close()
      await failed.close()
      await restored.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
      await restored.close()
    } finally { await transaction.close(); await old.close() }
    expect((await requiredSnapshot(f.persistence, f.header.id)).header.cwd).toBe(f.cwdA)
  })

  it('preserves the existing writer when preparation is refused or abandoned', async () => {
    const f = await fixture()
    const old = await f.persistence.open(f.header.id, 'write')
    await expect(f.persistence.beginRelocation({ ...f.request, expectedCwd: f.cwdB }, { writer: old }))
      .rejects.toMatchObject({ code: 'session/relocate-conflict' })
    const transaction = await f.persistence.beginRelocation(f.request, { writer: old })
    await transaction.close()
    await old.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    await expect(f.persistence.open(f.header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await old.close()
    expect((await requiredSnapshot(f.persistence, f.header.id)).header.cwd).toBe(f.cwdA)
  })

  it('settles an already-admitted close before a concurrent commit', async () => {
    const f = await fixture()
    const transaction = await f.persistence.beginRelocation(f.request)
    const closed = transaction.close()
    const refused = expect(transaction.commit()).rejects.toMatchObject({ code: 'session/relocate-conflict' })
    await Promise.all([closed, refused])
    expect((await requiredSnapshot(f.persistence, f.header.id)).header.cwd).toBe(f.cwdA)
    const writer = await f.persistence.open(f.header.id, 'write')
    await writer.close()
  })

  it.each(['missing', 'malformed', 'foreign-origin'] as const)('refuses a committed retry with %s placement', async (corruption) => {
    const f = await fixture()
    const transaction = await f.persistence.beginRelocation(f.request)
    try { await transaction.commit() } finally { await transaction.close() }
    const path = join(dirname(f.path), 'cwd-placement.json')
    const original = await readFile(path)
    if (corruption === 'missing') await rename(path, `${path}.held`)
    else if (corruption === 'malformed') await writeFile(path, '{')
    else await writeFile(path, JSON.stringify({ ...JSON.parse(original.toString()), originCwd: f.cwdB }))
    try {
      await expect(f.persistence.beginRelocation(f.request)).rejects.toMatchObject({ code: 'session/relocate-recovery-required' })
    } finally {
      if (corruption === 'missing') await rename(`${path}.held`, path)
      else await writeFile(path, original)
    }
    expect((await requiredSnapshot(f.persistence, f.header.id)).header.cwd).toBe(f.cwdB)
  })

  it('keeps one identity and appends at the original physical location after relocation', async () => {
    const f = await fixture()
    const prefix = await readFile(f.path)
    const transaction = await f.persistence.beginRelocation(f.request)
    let result
    try { result = await transaction.commit() } finally { await transaction.close() }
    expect(result).toMatchObject({ sessionId: f.header.id, sourceCwd: f.cwdA, cwd: f.cwdB })
    const writer = await f.persistence.open(f.header.id, 'write')
    try {
      await writer.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    } finally { await writer.close() }
    const bytes = await readFile(f.path)
    expect(bytes.subarray(0, prefix.length)).toEqual(prefix)
    expect(bytes.length).toBeGreaterThan(prefix.length)
    expect((await f.persistence.list()).filter(item => item.header.id === f.header.id)).toHaveLength(1)
    expect((await requiredSnapshot(f.persistence, f.header.id)).header).toEqual({ ...f.header, cwd: f.cwdB })
  })

  it('refuses a foreign revision without changing the current observation', async () => {
    const f = await fixture()
    const request = { ...f.request, expectedRevision: 'foreign' as SessionRelocationRequest['expectedRevision'] }
    await expect(f.persistence.beginRelocation(request)).rejects.toMatchObject({ code: 'session/relocate-conflict' })
    expect((await requiredSnapshot(f.persistence, f.header.id)).revision).toBe(f.request.expectedRevision)
  })

  it('refuses a writer held by an independent backend instance', async () => {
    const f = await fixture()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    const owner = await ctx.sessionPersistence.open(f.header.id, 'write')
    try {
      await expect(f.persistence.beginRelocation(f.request)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    } finally { await owner.close() }
  })

  it('preserves seeded lineage, the inherited cut, and physical bytes', async () => {
    const f = await fixture({}, true)
    const bytes = await readFile(f.path)
    const transaction = await f.persistence.beginRelocation(f.request)
    try { await transaction.commit() } finally { await transaction.close() }
    const reader = await f.persistence.open(f.header.id, 'read')
    try {
      expect(reader.header).toEqual({ ...f.header, cwd: f.cwdB })
      expect(reader.inheritedEventCount).toBe(0)
      expect((await reader.read()).events).toEqual(f.events)
    } finally { await reader.close() }
    expect(await readFile(f.path)).toEqual(bytes)
  })

  it.each([
    { relocationLogBytes: 1 }, { relocationDataBytes: 1 }, { relocationFiles: 1 },
  ])('refuses the complete size limit before publishing metadata: %j', async (options) => {
    const f = await fixture(options)
    const bytes = await readFile(f.path)
    await expect(f.persistence.beginRelocation(f.request)).rejects.toMatchObject({ code: 'session/relocate-unsupported' })
    expect((await requiredSnapshot(f.persistence, f.header.id)).revision).toBe(f.request.expectedRevision)
    expect(await readFile(f.path)).toEqual(bytes)
  })

  it('maps a missing target to a stable refusal and releases write ownership', async () => {
    const f = await fixture()
    await rm(f.cwdB, { recursive: true })
    await expect(f.persistence.beginRelocation(f.request)).rejects.toMatchObject({ code: 'session/relocate-target-invalid' })
    const writer = await f.persistence.open(f.header.id, 'write')
    await writer.close()
    expect((await requiredSnapshot(f.persistence, f.header.id)).revision).toBe(f.request.expectedRevision)
  })

  it('refuses a target removed between prepare and commit and closes safely', async () => {
    const f = await fixture()
    const transaction = await f.persistence.beginRelocation(f.request)
    try {
      await rm(f.cwdB, { recursive: true })
      await expect(transaction.commit()).rejects.toMatchObject({ code: 'session/relocate-target-invalid' })
    } finally { await transaction.close() }
    expect((await requiredSnapshot(f.persistence, f.header.id)).header.cwd).toBe(f.cwdA)
  })

  it('refuses a torn generation without repairing or truncating it', async () => {
    const f = await fixture()
    await appendFile(f.path, '{"uncommitted":')
    const bytes = await readFile(f.path)
    const request = { ...f.request, expectedRevision: (await requiredSnapshot(f.persistence, f.header.id)).revision }
    await expect(f.persistence.beginRelocation(request)).rejects.toMatchObject({ code: 'session/relocate-recovery-required' })
    expect(await readFile(f.path)).toEqual(bytes)
  })
})
