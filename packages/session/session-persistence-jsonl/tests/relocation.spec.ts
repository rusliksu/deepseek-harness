import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionRelocationRequest } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Config } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../src/format.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
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
    expectedRevision: (await ctx.sessionPersistence.stat(id)).revision, targetCwd: cwdB }
  const path = logPath(join(root, 'sessions'), cwdA, id, 'none')
  return { root, cwdA, cwdB, header, events, request, path, persistence: ctx.sessionPersistence }
}

describe('session relocation refusals and lineage', () => {
  it('settles an already-admitted close before a concurrent commit', async () => {
    const f = await fixture()
    const transaction = await f.persistence.beginRelocation(f.request)
    const closed = transaction.close()
    const refused = expect(transaction.commit()).rejects.toMatchObject({ code: 'session/relocate-conflict' })
    await Promise.all([closed, refused])
    expect((await f.persistence.stat(f.header.id)).header.cwd).toBe(f.cwdA)
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
    expect((await f.persistence.stat(f.header.id)).header.cwd).toBe(f.cwdB)
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
    expect((await f.persistence.stat(f.header.id)).header).toEqual({ ...f.header, cwd: f.cwdB })
  })

  it('refuses a foreign revision without changing the current observation', async () => {
    const f = await fixture()
    const request = { ...f.request, expectedRevision: 'foreign' as SessionRelocationRequest['expectedRevision'] }
    await expect(f.persistence.beginRelocation(request)).rejects.toMatchObject({ code: 'session/relocate-conflict' })
    expect((await f.persistence.stat(f.header.id)).revision).toBe(f.request.expectedRevision)
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
    expect((await f.persistence.stat(f.header.id)).revision).toBe(f.request.expectedRevision)
    expect(await readFile(f.path)).toEqual(bytes)
  })

  it('maps a missing target to a stable refusal and releases write ownership', async () => {
    const f = await fixture()
    await rm(f.cwdB, { recursive: true })
    await expect(f.persistence.beginRelocation(f.request)).rejects.toMatchObject({ code: 'session/relocate-target-invalid' })
    const writer = await f.persistence.open(f.header.id, 'write')
    await writer.close()
    expect((await f.persistence.stat(f.header.id)).revision).toBe(f.request.expectedRevision)
  })

  it('refuses a target removed between prepare and commit and closes safely', async () => {
    const f = await fixture()
    const transaction = await f.persistence.beginRelocation(f.request)
    try {
      await rm(f.cwdB, { recursive: true })
      await expect(transaction.commit()).rejects.toMatchObject({ code: 'session/relocate-target-invalid' })
    } finally { await transaction.close() }
    expect((await f.persistence.stat(f.header.id)).header.cwd).toBe(f.cwdA)
  })

  it('refuses a torn generation without repairing or truncating it', async () => {
    const f = await fixture()
    await appendFile(f.path, '{"uncommitted":')
    const bytes = await readFile(f.path)
    const request = { ...f.request, expectedRevision: (await f.persistence.stat(f.header.id)).revision }
    await expect(f.persistence.beginRelocation(request)).rejects.toMatchObject({ code: 'session/relocate-recovery-required' })
    expect(await readFile(f.path)).toEqual(bytes)
  })
})
