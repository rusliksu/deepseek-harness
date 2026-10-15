import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
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
