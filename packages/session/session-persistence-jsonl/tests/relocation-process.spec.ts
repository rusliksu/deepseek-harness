import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../src/format.ts'

it('refuses a foreign process writer and relocates after its crash', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relocation-process-'))
  const ctx = new Context()
  const storage = join(root, 'sessions')
  await mkdir(join(root, 'a'))
  await mkdir(join(root, 'b'))
  const cwdA = await realpath(join(root, 'a'))
  const cwdB = await realpath(join(root, 'b'))
  const id = SessionId(randomUUID())
  const holder = spawn(process.execPath, ['--import', 'tsx/esm',
    fileURLToPath(new URL('./fixtures/relocation-holder.mjs', import.meta.url)), storage, cwdA, id],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(holder, 'exit')
  let diagnostic = ''
  holder.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000) })
  try {
    await Promise.race([
      once(holder.stdout, 'data'),
      exited.then(() => { throw new Error(`lease holder exited before readiness: ${diagnostic}`) }),
    ])
    await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
    const before = await ctx.sessionPersistence.stat(id)
    expect(before).toBeDefined()
    const bytes = await readFile(logPath(storage, cwdA, id, 'none'))
    const request = { sessionId: id, operationId: randomUUID(), expectedCwd: cwdA,
      expectedRevision: before!.revision, targetCwd: cwdB }
    await expect(ctx.sessionPersistence.beginRelocation(request)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    holder.kill('SIGKILL')
    await exited
    const transaction = await ctx.sessionPersistence.beginRelocation(request)
    try { await transaction.commit() } finally { await transaction.close() }
    expect((await ctx.sessionPersistence.stat(id))?.header.cwd).toBe(cwdB)
    expect(await readFile(logPath(storage, cwdA, id, 'none'))).toEqual(bytes)
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1]) } finally { await reader.close() }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
    await exited
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains a real process lease through old writer, transaction, rollback and replacement', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relocation-handoff-'))
  const ctx = new Context()
  const storage = join(root, 'sessions')
  await mkdir(join(root, 'a'))
  await mkdir(join(root, 'b'))
  const cwdA = await realpath(join(root, 'a'))
  const cwdB = await realpath(join(root, 'b'))
  const id = SessionId(randomUUID())
  await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
  const old = await ctx.sessionPersistence.create({ id, cwd: cwdA, version: SESSION_FORMAT_VERSION,
    createdAt: 1000, isSeeded: false, delegationDepth: 0 })
  await old.flush()
  const child = spawn(process.execPath, ['--import', 'tsx/esm',
    fileURLToPath(new URL('./fixtures/relocation-contender.mjs', import.meta.url)), storage, id],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  let diagnostic = ''
  child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000) })
  const probe = async (expected: 'busy' | 'acquired'): Promise<void> => {
    const reply = once(child, 'message')
    child.send('probe')
    expect((await reply)[0]).toEqual({ status: expected })
  }
  try {
    const readyMessage: unknown[] = await Promise.race([once(child, 'message'),
      exited.then(() => { throw new Error('lease contender exited before readiness: ' + diagnostic) })])
    expect(readyMessage[0]).toEqual({ status: 'ready' })
    await probe('busy')
    const before = await ctx.sessionPersistence.stat(id)
    if (before === undefined) throw new Error('materialized session missing')
    const transaction = await ctx.sessionPersistence.beginRelocation({ sessionId: id, operationId: randomUUID(),
      expectedCwd: cwdA, expectedRevision: before.revision, targetCwd: cwdB }, { writer: old })
    try {
      await probe('busy')
      await old.close()
      await probe('busy')
      await transaction.commit()
      await probe('busy')
      const attempted = await transaction.openWriter()
      await probe('busy')
      await attempted.close()
      await probe('busy')
      await transaction.rollback()
      await probe('busy')
      const restored = await transaction.openWriter()
      await transaction.complete(restored)
      await transaction.close()
      await probe('busy')
      expect(restored.header.cwd).toBe(cwdA)
      await restored.close()
      await probe('acquired')
    } finally { await transaction.close() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await old.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
