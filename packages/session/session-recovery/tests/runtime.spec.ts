import { describe, expect, it } from 'vitest'
import { RecoveryLedger, type LedgerStore } from '../src/ledger.ts'
import { emptyUnit, type RecoveryUnitFile } from '../src/unit.ts'
import { RecoveryConfirmationError, RecoveryRuntime, type RecoveryPorts, type RecoveryReport, type RecoverySettings } from '../src/runtime.ts'
import type { RecoveryDecision } from '../src/policy.ts'
import type { JournalCandidate } from '../src/candidates.ts'

/** Ports with writable members, so a test can replace one capability. */
type MutablePorts = { -readonly [K in keyof RecoveryPorts]: RecoveryPorts[K] }

const NOW = Date.parse('2026-11-24T09:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const settings = (overrides: Partial<RecoverySettings> = {}): RecoverySettings => ({
  enabled: true,
  maxSessions: 3,
  maxAgeHours: 12,
  staggerMs: 15_000,
  providerWaitMs: 60_000,
  providerPollMs: 1_000,
  attempts: 2,
  requireConfirmationForWriteTools: true,
  continueWithoutTools: true,
  ...overrides,
})

function memoryStore(): LedgerStore {
  let current: RecoveryUnitFile = emptyUnit()
  return { async read() { return current }, async write(file) { current = file } }
}

interface Harness {
  readonly ports: MutablePorts
  readonly events: string[]
  readonly sleeps: number[]
  readonly logs: string[]
  readonly ledger: RecoveryLedger
  setProviderReady(value: (sessionId: string) => boolean): void
  setDecision(value: RecoveryDecision): void
  seedPolicy(sessionId: string): Promise<void>
  seedJournal(rows: readonly JournalCandidate[]): void
}

function harness(now: () => number = () => NOW): Harness {
  const events: string[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  let journal: readonly JournalCandidate[] = []
  let ready: (sessionId: string) => boolean = () => true
  let decision: RecoveryDecision = { kind: 'auto' }
  const ledger = new RecoveryLedger(memoryStore(), () => new Date(NOW).toISOString())
  const ports: MutablePorts = {
    ledger,
    bootId: 'boot-1',
    now,
    sleep: (ms) => { sleeps.push(ms); events.push(`sleep:${ms}`); return Promise.resolve() },
    journal: async () => journal,
    providerReady: async sessionId => ready(sessionId),
    classify: async () => decision,
    notifyAwaiting: async (sessionId, value) => { events.push(`notify:${sessionId}:${value.tools.join('+')}`) },
    resume: async (sessionId) => { events.push(`resume:${sessionId}`) },
    inject: async (sessionId, batch) => { events.push(`inject:${sessionId}:${batch.message.source.kind}`) },
    log: { info: message => logs.push(`info:${message}`), warn: message => logs.push(`warn:${message}`) },
  }
  return {
    ports,
    events,
    sleeps,
    logs,
    ledger,
    setProviderReady: (value) => { ready = value },
    setDecision: (value) => { decision = value },
    seedPolicy: async (sessionId) => { await ledger.setPolicy(sessionId, true) },
    seedJournal: (rows) => { journal = rows },
  }
}

describe('RecoveryRuntime pass', () => {
  it('does nothing when disabled', async () => {
    const h = harness()
    const report = await new RecoveryRuntime(h.ports, settings({ enabled: false })).run()
    expect(report).toEqual({ ran: false, skipped: 'disabled', injected: 0, failed: 0, skippedCount: 0, outcomes: [] })
    expect(h.events).toEqual([])
  })

  it('ignores a session that never opted into continuation', async () => {
    const h = harness()
    h.seedJournal([{ sessionId: 'quiet', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    const report = await new RecoveryRuntime(h.ports, settings()).run()
    expect(report).toMatchObject({ ran: true, injected: 0, outcomes: [] })
    expect(h.events).toEqual([])
  })

  it('marks resuming, resumes, injects, and marks resumed in that order', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 3, lastEventAt: minutesAgo(2) }])
    const report = await new RecoveryRuntime(h.ports, settings()).run()
    expect(h.events).toEqual(['resume:session-a', 'inject:session-a:recovery'])
    expect(report).toMatchObject({ ran: true, injected: 1, failed: 0, skippedCount: 0 })
    expect(await h.ledger.get('session-a', 3)).toMatchObject({ status: 'resumed', attempts: 0 })
    expect(h.logs[0]).toContain('continued "session-a"')
  })

  it('covers a ledger-only candidate and pauses between injections', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    await h.seedPolicy('session-b')
    await h.ledger.begin({ sessionId: 'session-b', turnStartSeq: 1, bootId: 'boot-0' })
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    const report = await new RecoveryRuntime(h.ports, settings({ maxSessions: 2 })).run()
    expect(report.injected).toBe(2)
    expect(h.sleeps).toEqual([15_000])
    expect([...report.outcomes.map(outcome => outcome.sessionId)].sort()).toEqual(['session-a', 'session-b'])
  })

  it('stops at the injection limit and keeps the rest for a later pass', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    await h.seedPolicy('session-b')
    h.seedJournal([
      { sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) },
      { sessionId: 'session-b', turnStartSeq: 1, lastEventAt: minutesAgo(2) },
    ])
    const report = await new RecoveryRuntime(h.ports, settings({ maxSessions: 1 })).run()
    expect(report.injected).toBe(1)
    expect(report.outcomes[1]).toEqual({ sessionId: 'session-b', status: 'skipped', reason: 'limit' })
    expect(h.sleeps).toEqual([])
  })

  it('waits for a human when the turn touched a mutating tool', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    h.setDecision({ kind: 'confirm', tools: ['shell', 'write'], unfinished: true })
    const report = await new RecoveryRuntime(h.ports, settings()).run()
    expect(h.events).toEqual(['notify:session-a:shell+write'])
    expect(report).toMatchObject({ injected: 0, failed: 0, skippedCount: 1 })
    expect(report.outcomes[0]).toEqual({ sessionId: 'session-a', status: 'awaiting-confirmation' })
    expect(await h.ledger.get('session-a', 1)).toMatchObject({ status: 'awaiting-confirmation', detail: 'tools: shell, write' })
    expect(h.logs[0]).toContain('waits for a human')
  })

  it('continues a mutating turn when the deployment disables the rule', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    h.setDecision({ kind: 'confirm', tools: ['shell'], unfinished: false })
    const report = await new RecoveryRuntime(h.ports, settings({ requireConfirmationForWriteTools: false })).run()
    expect(report.injected).toBe(1)
    expect(h.events).toEqual(['resume:session-a', 'inject:session-a:recovery'])
  })

  it('continues after a human confirms and refuses a record that is not waiting', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    h.setDecision({ kind: 'confirm', tools: ['shell'], unfinished: false })
    const runtime = new RecoveryRuntime(h.ports, settings())
    await runtime.run()
    h.events.length = 0
    await expect(runtime.continueConfirmed('session-a', 1)).resolves.toEqual({ sessionId: 'session-a', status: 'resumed' })
    expect(h.events).toEqual(['resume:session-a', 'inject:session-a:recovery'])
    expect(await h.ledger.get('session-a', 1)).toMatchObject({ status: 'resumed', attempts: 0 })
    await expect(runtime.continueConfirmed('session-a', 1)).rejects.toBeInstanceOf(RecoveryConfirmationError)
    await expect(runtime.continueConfirmed('missing', 1)).rejects.toThrow('is not awaiting confirmation')
  })

  it('fails the candidate when the provider never registers', async () => {
    let clock: number = NOW
    const h = harness(() => clock)
    await h.seedPolicy('session-a')
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    h.setProviderReady(() => false)
    h.ports.sleep = async (ms: number) => { clock += ms }
    const report = await new RecoveryRuntime(h.ports, settings({ providerWaitMs: 3_000, providerPollMs: 1_000 })).run()
    expect(report).toMatchObject({ injected: 0, failed: 1 })
    expect(report.outcomes[0]).toMatchObject({ status: 'failed', reason: 'provider-unavailable' })
    expect(await h.ledger.get('session-a', 1)).toMatchObject({ status: 'failed', reason: 'provider-unavailable' })
    expect(h.logs[0]).toContain('provider unavailable')
    expect(h.events).toEqual([])
  })

  it('waits for a provider that registers late', async () => {
    let clock: number = NOW
    let probes = 0
    const h = harness(() => clock)
    await h.seedPolicy('session-a')
    h.seedJournal([{ sessionId: 'session-a', turnStartSeq: 1, lastEventAt: minutesAgo(1) }])
    h.setProviderReady(() => ++probes > 2)
    h.ports.sleep = async (ms: number) => { clock += ms }
    const report = await new RecoveryRuntime(h.ports, settings()).run()
    expect(report.injected).toBe(1)
    expect(probes).toBe(3)
  })

  it('retries a failed record until attempts run out, then parks it', async () => {
    const h = harness()
    await h.seedPolicy('session-a')
    await h.ledger.begin({ sessionId: 'session-a', turnStartSeq: 1, bootId: 'boot-0' })
    await h.ledger.mark('session-a', 1, 'failed', { reason: 'provider-unavailable' })
    h.setProviderReady(() => false)
    let clock: number = NOW
    h.ports.now = () => clock
    h.ports.sleep = async (ms: number) => { clock += ms }
    let last: RecoveryReport = { ran: false, injected: 0, failed: 0, skippedCount: 0, outcomes: [] }
    for (let pass = 0; pass < 5; pass += 1) {
      last = await new RecoveryRuntime(h.ports, settings({ providerWaitMs: 0 })).run()
      if (last.outcomes[0]?.status === 'skipped') break
    }
    expect(last.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'stale' })
    expect(await h.ledger.get('session-a', 1)).toMatchObject({ status: 'skipped', attempts: 2 })
  })
})

describe('continuation without tools', () => {
  it('continues a quiet turn without a per-Session policy', async () => {
    const test = harness()
    test.seedJournal([{ sessionId: 'quiet', turnStartSeq: 1, lastEventAt: minutesAgo(5), toolCalls: [] }])
    const report = await new RecoveryRuntime(test.ports, settings()).run()
    expect(report.outcomes).toEqual([{ sessionId: 'quiet', status: 'resumed' }])
    expect(test.events).toEqual(['resume:quiet', 'inject:quiet:recovery'])
  })

  it('keeps a quiet turn behind the opt-in when the deployment disables the rule', async () => {
    const test = harness()
    test.seedJournal([{ sessionId: 'quiet', turnStartSeq: 1, lastEventAt: minutesAgo(5), toolCalls: [] }])
    const report = await new RecoveryRuntime(test.ports, settings({ continueWithoutTools: false })).run()
    expect(report.outcomes).toEqual([])
    expect(test.events).toEqual([])
  })

  it('still requires the opt-in for a turn that called a tool', async () => {
    const test = harness()
    test.seedJournal([{ sessionId: 'worked', turnStartSeq: 1, lastEventAt: minutesAgo(5), toolCalls: ['run_code'] }])
    const report = await new RecoveryRuntime(test.ports, settings()).run()
    expect(report.outcomes).toEqual([])
    expect(test.events).toEqual([])
  })
})
