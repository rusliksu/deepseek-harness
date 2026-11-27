import { describe, expect, it } from 'vitest'
import { RecoveryDuplicateError, RecoveryLedger, RecoveryTransitionError, type LedgerStore } from '../src/ledger.ts'
import * as barrel from '../src/index.ts'
import { RECOVERY_UNIT_NAME, RECOVERY_UNIT_VERSION, emptyUnit, type RecoveryUnitFile } from '../src/unit.ts'

/** In-memory store that records every written document. */
function memoryStore(): LedgerStore & { writes: RecoveryUnitFile[] } {
  let current = emptyUnit()
  const writes: RecoveryUnitFile[] = []
  return {
    writes,
    async read() { return current },
    async write(file) { current = file; writes.push(file) },
  }
}

const clock = () => '2026-11-24T00:00:00.000Z'

describe('package entry', () => {
  it('exposes the plugin class and nothing else as a value', () => {
    expect(Object.keys(barrel).sort()).toEqual(['default'])
  })
})

describe('RecoveryLedger defaults', () => {
  it('uses the wall clock when no clock is supplied', async () => {
    const ledger = new RecoveryLedger(memoryStore())
    const row = await ledger.setPolicy('session-a', false)
    expect(row.autoContinue).toBe(false)
    expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('RecoveryLedger policy', () => {
  it('defaults to no policy and stores one change', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await expect(ledger.getPolicy('session-a')).resolves.toBeUndefined()
    await expect(ledger.setPolicy('session-a', true)).resolves.toEqual({ autoContinue: true, updatedAt: clock() })
    await expect(ledger.getPolicy('session-a')).resolves.toEqual({ autoContinue: true, updatedAt: clock() })
  })
})

describe('RecoveryLedger interruptions', () => {
  it('creates a resuming record once and returns it on a repeated begin', async () => {
    const store = memoryStore()
    const ledger = new RecoveryLedger(store, clock)
    const first = await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    expect(first).toEqual({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1', status: 'resuming', attempts: 0, updatedAt: clock() })
    const second = await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-2' })
    expect(second).toEqual(first)
    expect(store.writes).toHaveLength(1)
  })

  it('moves resuming to a terminal outcome', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    await expect(ledger.mark('session-a', 7, 'resumed')).resolves.toMatchObject({ status: 'resumed' })
    const stored = await ledger.get('session-a', 7)
    expect(stored).toMatchObject({ status: 'resumed' })
    expect(stored).not.toHaveProperty('reason')
    expect(stored).not.toHaveProperty('detail')
  })

  it('keeps the reason and detail of a skip', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    const row = await ledger.mark('session-a', 7, 'skipped', { reason: 'stale', detail: 'older than 12h' })
    expect(row).toMatchObject({ status: 'skipped', reason: 'stale', detail: 'older than 12h' })
  })

  it('counts an attempt when a failed record re-enters resuming', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    await ledger.mark('session-a', 7, 'failed', { reason: 'provider-unavailable' })
    await ledger.mark('session-a', 7, 'resuming')
    await ledger.mark('session-a', 7, 'failed', { reason: 'provider-unavailable' })
    await expect(ledger.get('session-a', 7)).resolves.toMatchObject({ attempts: 1, status: 'failed' })
  })

  it('counts an attempt on a record the previous process left in resuming', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    await expect(ledger.noteAttempt('session-a', 7)).resolves.toMatchObject({ status: 'resuming', attempts: 1 })
  })

  it('refuses to count an attempt for an unknown or finished record', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await expect(ledger.noteAttempt('missing', 1)).rejects.toThrow('cannot move from "absent"')
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    await ledger.mark('session-a', 7, 'resumed')
    await expect(ledger.noteAttempt('session-a', 7)).rejects.toThrow('cannot move from "resumed"')
  })

  it('lets a human action re-enter resuming from awaiting-confirmation', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    await ledger.mark('session-a', 7, 'awaiting-confirmation')
    await expect(ledger.mark('session-a', 7, 'resuming')).resolves.toMatchObject({ status: 'resuming', attempts: 0 })
  })

  it('refuses transitions the ledger does not allow', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await ledger.begin({ sessionId: 'session-a', turnStartSeq: 7, bootId: 'boot-1' })
    await ledger.mark('session-a', 7, 'resumed')
    await expect(ledger.mark('session-a', 7, 'resuming')).rejects.toBeInstanceOf(RecoveryTransitionError)
    await expect(ledger.mark('session-a', 7, 'resuming')).rejects.toThrow('cannot move from "resumed" to "resuming"')
  })

  it('refuses a transition for an unknown record and names the absent state', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    await expect(ledger.mark('missing', 1, 'resumed')).rejects.toThrow('cannot move from "absent" to "resumed"')
  })

  it('lists newest first and keeps only non-terminal records open', async () => {
    let tick = 0
    const ledger = new RecoveryLedger(memoryStore(), () => `2026-11-24T00:00:0${tick++}.000Z`)
    await ledger.begin({ sessionId: 'b', turnStartSeq: 1, bootId: 'boot-1' })
    await ledger.begin({ sessionId: 'a', turnStartSeq: 1, bootId: 'boot-1' })
    await ledger.mark('b', 1, 'resumed')
    const listed = await ledger.list()
    expect(listed.map(row => row.sessionId)).toEqual(['b', 'a'])
    await expect(ledger.open()).resolves.toMatchObject([{ sessionId: 'a', status: 'resuming' }])
  })

  it('imports a record once and refuses a duplicate', async () => {
    const ledger = new RecoveryLedger(memoryStore(), clock)
    const row = { sessionId: 'legacy', turnStartSeq: 3, bootId: 'boot-0', status: 'skipped' as const, reason: 'archived' as const, attempts: 0, updatedAt: clock() }
    await expect(ledger.import(row)).resolves.toEqual(row)
    await expect(ledger.import(row)).rejects.toBeInstanceOf(RecoveryDuplicateError)
    await expect(ledger.import(row)).rejects.toThrow('record "legacy#3" already exists')
  })

  it('replaces the whole document and reports an empty one', async () => {
    const store = memoryStore()
    const ledger = new RecoveryLedger(store, clock)
    const file = {
      unit: { name: RECOVERY_UNIT_NAME, version: RECOVERY_UNIT_VERSION },
      tables: { sessions: { s: { autoContinue: true, updatedAt: clock() } }, interruptions: {} },
    }
    await ledger.replace(file)
    expect(store.writes).toEqual([file])
    expect(ledger.empty()).toEqual(emptyUnit())
  })
})
