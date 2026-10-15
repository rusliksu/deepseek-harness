/** Keyless assertions run through a real dsh Desktop Host and its shared SDK. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'

export const name = 'native-session-relocation-check'
export const inject = ['sessionPersistence']

export function apply(ctx) {
  const timer = setTimeout(() => void check(ctx), 1000)
  ctx.effect(() => () => clearTimeout(timer))
}

async function check(ctx) {
  const root = process.env.DSH_RELOCATION_PROOF
  const report = { status: 'running', checks: [], modelCalls: 0 }
  const persistence = ctx.sessionPersistence
  const run = async (name, operation) => {
    report.current = name
    await operation()
    report.checks.push(name)
  }
  const code = expected => error => error?.code === expected
  let writer
  let transaction
  try {
    await run('native relocation API exists', async () => {
      assert.equal(persistence.supportsRelocation, true)
      assert.equal(typeof persistence.beginRelocation, 'function')
    })
    const a = join(root, 'fixture-a')
    const b = join(root, 'fixture-b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    const cwdA = await realpath(a)
    const cwdB = await realpath(b)
    const id = randomUUID()
    const header = { id, version: 4, createdAt: 1000, isSeeded: false, delegationDepth: 0, cwd: cwdA }
    const prefix = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    writer = await persistence.create(header)
    await writer.append(prefix)
    await writer.flush()
    const before = await persistence.stat(id)
    const request = { sessionId: id, operationId: randomUUID(), expectedCwd: cwdA,
      expectedRevision: before.revision, targetCwd: cwdB }
    await run('active writer refuses relocation', async () => {
      await assert.rejects(() => persistence.beginRelocation(request), error => error instanceof SessionAlreadyOwnedError)
    })
    await writer.close()
    writer = undefined
    let physicalDir
    for (const entry of await readdir(persistence.config.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(persistence.config.root, entry.name, id)
      try {
        if ((await readdir(candidate)).some(name => /^session\.v4\.jsonl(?:\.zstd)?$/u.test(name))) physicalDir = candidate
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    assert.ok(physicalDir)
    const logName = (await readdir(physicalDir)).find(name => /^session\.v4\.jsonl(?:\.zstd)?$/u.test(name))
    const physicalLog = join(physicalDir, logName)
    const originalBytes = await readFile(physicalLog)
    const asset = join(physicalDir, 'attachment-proof.bin')
    const assetBytes = Buffer.from([0, 1, 2, 254, 255, 10])
    await writeFile(asset, assetBytes)
    await run('foreign revision changes nothing', async () => {
      await assert.rejects(() => persistence.beginRelocation({ ...request, expectedRevision: 'foreign-revision' }),
        code('session/relocate-conflict'))
      assert.equal((await persistence.stat(id)).revision, before.revision)
      assert.deepEqual(await readFile(physicalLog), originalBytes)
    })
    let result
    await run('same identity and immutable generations after A to B', async () => {
      transaction = await persistence.beginRelocation(request)
      result = await transaction.commit()
      await transaction.close()
      transaction = undefined
      assert.equal(result.sessionId, id)
      assert.equal(result.cwd, cwdB)
      assert.notEqual(result.revision, before.revision)
      const snapshot = await persistence.stat(id)
      assert.equal(snapshot.header.cwd, cwdB)
      assert.equal(snapshot.revision, result.revision)
      writer = await persistence.open(id, 'read')
      assert.deepEqual(writer.header, { ...header, cwd: cwdB })
      assert.deepEqual((await writer.read()).events, prefix)
      await writer.close()
      writer = undefined
      assert.deepEqual(await readFile(physicalLog), originalBytes)
      assert.deepEqual(await readFile(asset), assetBytes)
      const matching = (await persistence.list()).filter(value => value.header.id === id)
      assert.equal(matching.length, 1)
      assert.equal(matching[0].header.cwd, cwdB)
    })
    await run('retry returns exactly the original committed result', async () => {
      transaction = await persistence.beginRelocation(request)
      assert.deepEqual(await transaction.commit(), result)
      await transaction.close()
      transaction = undefined
      await assert.rejects(() => persistence.beginRelocation({ ...request, targetCwd: cwdA }), code('session/relocate-conflict'))
    })
    await run('new events append to the original physical generation', async () => {
      writer = await persistence.open(id, 'write')
      assert.equal(writer.header.cwd, cwdB)
      await writer.append([
        { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
        { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
      await writer.close()
      writer = undefined
      assert.deepEqual((await readFile(physicalLog)).subarray(0, originalBytes.length), originalBytes)
      const reader = await persistence.open(id, 'read')
      try {
        assert.equal((await reader.read()).events.length, 4)
      } finally {
        await reader.close()
      }
    })
    await run('B to A retains properties and all events', async () => {
      const current = await persistence.stat(id)
      transaction = await persistence.beginRelocation({ sessionId: id, operationId: randomUUID(),
        expectedCwd: cwdB, expectedRevision: current.revision, targetCwd: cwdA })
      await transaction.commit()
      await transaction.close()
      transaction = undefined
      assert.deepEqual((await persistence.stat(id)).header, header)
      assert.deepEqual(await readFile(asset), assetBytes)
    })
    await run('same directory preserves the exact revision', async () => {
      const current = await persistence.stat(id)
      transaction = await persistence.beginRelocation({ sessionId: id, operationId: randomUUID(),
        expectedCwd: cwdA, expectedRevision: current.revision, targetCwd: cwdA })
      assert.equal((await transaction.commit()).revision, current.revision)
      await transaction.close()
      transaction = undefined
      assert.equal((await persistence.stat(id)).revision, current.revision)
    })
    await run('rollback restores the original effective directory', async () => {
      const current = await persistence.stat(id)
      transaction = await persistence.beginRelocation({ sessionId: id, operationId: randomUUID(),
        expectedCwd: cwdA, expectedRevision: current.revision, targetCwd: cwdB })
      await transaction.commit()
      await transaction.rollback()
      await transaction.close()
      transaction = undefined
      assert.equal((await persistence.stat(id)).header.cwd, cwdA)
      assert.deepEqual(await readFile(asset), assetBytes)
    })
    await run('missing required placement refuses a silent fallback', async () => {
      const path = join(physicalDir, 'cwd-placement.json')
      await rename(path, `${path}.held`)
      try {
        await assert.rejects(() => persistence.stat(id), code('session/relocate-recovery-required'))
      } finally {
        await rename(`${path}.held`, path)
      }
      assert.equal((await persistence.stat(id)).header.cwd, cwdA)
    })
    report.status = 'passed'
    report.fixture = { sessionId: id, cwdA, cwdB, physicalLog }
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error.name, message: error.message, code: error.code,
      stack: String(error.stack).split(/\r?\n/u).slice(0, 7).join('\n') }
  } finally {
    await writer?.close()
    await transaction?.close()
    await writeFile(join(root, 'native-relocation-result.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}
