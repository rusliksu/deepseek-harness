import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileRecoveryStore, RecoveryStorageError } from '../src/file-store.ts'
import { RECOVERY_UNIT_NAME, emptyUnit } from '../src/unit.ts'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-recovery-'))
})

describe('FileRecoveryStore', () => {
  it('reads a missing file as an empty document', async () => {
    const store = new FileRecoveryStore(join(dir, 'nested', 'recovery.json'))
    await expect(store.read()).resolves.toEqual(emptyUnit())
  })

  it('round-trips a written document without a temporary file left behind', async () => {
    const path = join(dir, 'recovery.json')
    const store = new FileRecoveryStore(path)
    const file = {
      unit: { name: RECOVERY_UNIT_NAME, version: 1 },
      tables: {
        sessions: { s: { autoContinue: true, updatedAt: '2026-11-24T00:00:00.000Z' } },
        interruptions: { 's#2': { sessionId: 's', turnStartSeq: 2, bootId: 'b', status: 'resuming' as const, attempts: 0, updatedAt: '2026-11-24T00:00:00.000Z' } },
      },
    }
    await store.write(file)
    await expect(store.read()).resolves.toEqual(file)
    await expect(readdir(dir)).resolves.toEqual(['recovery.json'])
    const raw = await readFile(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('accepts an older unit version and defaults tables that are absent from the envelope', async () => {
    const path = join(dir, 'recovery.json')
    await writeFile(path, JSON.stringify({ unit: { name: RECOVERY_UNIT_NAME, version: 0 }, tables: {} }), 'utf8')
    await expect(new FileRecoveryStore(path).read()).resolves.toEqual({
      unit: { name: RECOVERY_UNIT_NAME, version: 0 },
      tables: { sessions: {}, interruptions: {} },
    })
  })

  it('rejects invalid JSON', async () => {
    const path = join(dir, 'broken.json')
    await writeFile(path, '{nope', 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toBeInstanceOf(RecoveryStorageError)
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('is not valid JSON')
  })

  it('rejects a non-object document', async () => {
    const path = join(dir, 'array.json')
    await writeFile(path, '[]', 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('does not hold an object')
  })

  it('rejects a document without a unit envelope', async () => {
    const path = join(dir, 'bare.json')
    await writeFile(path, '{"tables":{}}', 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('has no unit envelope')
  })

  it('rejects a foreign unit name', async () => {
    const path = join(dir, 'foreign.json')
    await writeFile(path, JSON.stringify({ unit: { name: 'other', version: 1 }, tables: {} }), 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('belongs to unit "other"')
  })

  it('rejects a non-integer unit version', async () => {
    const path = join(dir, 'float.json')
    await writeFile(path, JSON.stringify({ unit: { name: RECOVERY_UNIT_NAME, version: 1.5 }, tables: {} }), 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('has no integer unit version')
  })

  it('rejects a newer unit version', async () => {
    const path = join(dir, 'future.json')
    await writeFile(path, JSON.stringify({ unit: { name: RECOVERY_UNIT_NAME, version: 99 }, tables: {} }), 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('this build reads up to 1')
  })

  it('rejects a document without tables', async () => {
    const path = join(dir, 'notables.json')
    await writeFile(path, JSON.stringify({ unit: { name: RECOVERY_UNIT_NAME, version: 1 } }), 'utf8')
    await expect(new FileRecoveryStore(path).read()).rejects.toThrow('has no tables')
  })

  it('reports an unreadable path', async () => {
    const store = new FileRecoveryStore(dir)
    await expect(store.read()).rejects.toBeInstanceOf(RecoveryStorageError)
    await expect(store.read()).rejects.toThrow('cannot read')
  })
})
