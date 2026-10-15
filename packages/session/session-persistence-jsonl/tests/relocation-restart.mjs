/** Process-level recovery checks through the real Desktop Host; no model calls. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'native-session-relocation-restart'
export const inject = ['sessionPersistence']

export function apply(ctx) {
  const timer = setTimeout(() => void check(ctx), 500)
  ctx.effect(() => () => clearTimeout(timer))
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

async function check(ctx) {
  const root = process.env.DSH_RELOCATION_PROOF
  const phase = process.env.DSH_RELOCATION_PHASE
  const point = process.env.DSH_RELOCATION_CRASH
  const persistence = ctx.sessionPersistence
  let handle
  let transaction
  const report = { status: 'running', phase, point, modelCalls: 0 }
  try {
    if (phase === 'prepare') {
      const a = join(root, 'fixture-a')
      const b = join(root, 'fixture-b')
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      const cwdA = await realpath(a)
      const cwdB = await realpath(b)
      const id = randomUUID()
      const header = { id, version: 4, createdAt: 1000, isSeeded: false, delegationDepth: 0, cwd: cwdA }
      handle = await persistence.create(header)
      await handle.append(events)
      await handle.close()
      handle = undefined
      let dir
      for (const entry of await readdir(persistence.config.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(persistence.config.root, entry.name, id)
        try {
          if ((await readdir(candidate)).some(name => /^session\.v4\.jsonl(?:\.zstd)?$/u.test(name))) dir = candidate
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      assert.ok(dir)
      const log = join(dir, (await readdir(dir)).find(name => /^session\.v4\.jsonl(?:\.zstd)?$/u.test(name)))
      const asset = join(dir, 'restart-attachment.bin')
      await writeFile(asset, Buffer.from([0, 19, 255, 2]))
      const before = await persistence.stat(id)
      const request = { sessionId: id, operationId: randomUUID(), expectedCwd: cwdA,
        expectedRevision: before.revision, targetCwd: cwdB }
      await writeFile(join(root, 'restart-fixture.json'), JSON.stringify({ header, cwdA, cwdB, request, log, asset,
        logHash: digest(await readFile(log)), assetHash: digest(await readFile(asset)) }))
      if (point === 'held') {
        handle = await persistence.open(id, 'write')
        await writeFile(join(root, 'prepared.json'), JSON.stringify({ sessionId: id, point }))
        for (;;) {
          try { await readFile(join(root, 'release-holder.json')); break } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          await delay(100)
        }
        process.exit(77)
      }
      transaction = await persistence.beginRelocation(request)
      await writeFile(join(root, 'prepared.json'), JSON.stringify({ sessionId: id, point }))
      // A real process exit releases the native kernel lease without close/rollback.
      if (point === 'before') process.exit(77)
      await transaction.commit()
      if (point.startsWith('rollback')) await transaction.rollback()
      throw new Error('fault build did not terminate at the publication point')
    }
    const fixture = JSON.parse(await readFile(join(root, 'restart-fixture.json'), 'utf8'))
    if (phase === 'contend') {
      await assert.rejects(() => persistence.beginRelocation(fixture.request), error => error instanceof SessionAlreadyOwnedError)
      assert.equal((await persistence.stat(fixture.header.id)).header.cwd, fixture.cwdA)
      assert.equal(digest(await readFile(fixture.log)), fixture.logHash)
      report.status = 'passed'
      report.checks = ['foreign process writer refuses relocation through the native kernel lease', 'refusal preserves cwd and bytes']
      return
    }
    if (phase === 'takeover') {
      transaction = await persistence.beginRelocation(fixture.request)
      assert.equal((await transaction.commit()).cwd, fixture.cwdB)
      await transaction.close()
      transaction = undefined
      assert.equal((await persistence.stat(fixture.header.id)).header.cwd, fixture.cwdB)
      assert.equal(digest(await readFile(fixture.log)), fixture.logHash)
      report.status = 'passed'
      report.checks = ['relocation acquires the same native lease after the foreign process exits', 'original ID and bytes preserved']
      return
    }
    const expectedCwd = point === 'after' ? fixture.cwdB : fixture.cwdA
    const snapshot = await persistence.stat(fixture.header.id)
    assert.deepEqual(snapshot.header, { ...fixture.header, cwd: expectedCwd })
    assert.equal(digest(await readFile(fixture.log)), fixture.logHash)
    assert.equal(digest(await readFile(fixture.asset)), fixture.assetHash)
    handle = await persistence.open(fixture.header.id, 'read')
    assert.deepEqual((await handle.read()).events, events)
    await handle.close()
    handle = undefined
    assert.equal((await persistence.list()).filter(value => value.header.id === fixture.header.id).length, 1)
    if (point === 'after') {
      transaction = await persistence.beginRelocation(fixture.request)
      const result = await transaction.commit()
      assert.equal(result.cwd, fixture.cwdB)
      assert.equal(result.revision, snapshot.revision)
      await transaction.close()
      transaction = undefined
    } else {
      await assert.rejects(() => persistence.beginRelocation(fixture.request), error => error.code === 'session/relocate-conflict')
    }
    // The restarted provider must acquire the same physical writer lease again.
    handle = await persistence.open(fixture.header.id, 'write')
    assert.equal(handle.header.cwd, expectedCwd)
    await handle.close()
    handle = undefined
    report.status = 'passed'
    report.checks = ['cold recovery selects the durable publication', 'history and attachment hashes unchanged',
      'one original session ID', 'retry respects recovered decision', 'native write lease reacquired after process exit']
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error.name, message: error.message, code: error.code, stack: error.stack }
  } finally {
    await handle?.close()
    await transaction?.close()
    await writeFile(join(root, `restart-${phase}.json`), JSON.stringify(report, null, 2))
  }
}
