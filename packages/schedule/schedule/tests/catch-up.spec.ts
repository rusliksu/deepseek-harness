import { describe, expect, it } from 'vitest'
import { catchUpReceipt, isDuplicateDelivery, occurrenceKey, providerWaitStep, resolveCatchUp, waitForModelProvider, type CatchUpTaskId } from '../src/catch-up.ts'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-24T09:00:00.000Z')
const taskId = 'schedule-1' as CatchUpTaskId

describe('resolveCatchUp', () => {
  it('delivers a recent missed occurrence', () => {
    expect(resolveCatchUp({ scheduledAt: NOW - 3 * HOUR, now: NOW, enabled: true, maxStaleHours: 24 })).toEqual({ kind: 'deliver' })
  })

  it('delivers without an age rule when the policy is disabled', () => {
    expect(resolveCatchUp({ scheduledAt: NOW - 30 * HOUR, now: NOW, enabled: false, maxStaleHours: 24, bootTimeMs: NOW - 1_000 })).toEqual({ kind: 'deliver' })
  })

  it('delivers an old occurrence when the boot time is unknown', () => {
    expect(resolveCatchUp({ scheduledAt: NOW - 30 * HOUR, now: NOW, enabled: true, maxStaleHours: 24 })).toEqual({ kind: 'deliver' })
  })

  it('applies the bound only to occurrences that predate a known boot', () => {
    const bootTimeMs = NOW - 2 * HOUR
    expect(resolveCatchUp({ scheduledAt: NOW - 30 * HOUR, now: NOW, enabled: true, maxStaleHours: 24, bootTimeMs }))
      .toEqual({ kind: 'skip', reason: 'stale' })
    expect(resolveCatchUp({ scheduledAt: NOW - 20 * HOUR, now: NOW, enabled: true, maxStaleHours: 24, bootTimeMs }))
      .toEqual({ kind: 'deliver' })
    expect(resolveCatchUp({ scheduledAt: NOW - 30 * HOUR, now: NOW, enabled: true, maxStaleHours: 24, bootTimeMs: NOW - 72 * HOUR }))
      .toEqual({ kind: 'deliver' })
  })

  it('delivers exactly at the bound and rejects one millisecond later', () => {
    const bootTimeMs = NOW - 1_000
    expect(resolveCatchUp({ scheduledAt: NOW - 24 * HOUR, now: NOW, enabled: true, maxStaleHours: 24, bootTimeMs })).toEqual({ kind: 'deliver' })
    expect(resolveCatchUp({ scheduledAt: NOW - 24 * HOUR - 1, now: NOW, enabled: true, maxStaleHours: 24, bootTimeMs })).toEqual({ kind: 'skip', reason: 'stale' })
  })
})

describe('occurrenceKey', () => {
  it('names the task and the occurrence', () => {
    expect(occurrenceKey(taskId, Date.parse('2026-11-24T07:00:00.000Z'))).toBe('schedule-1@2026-11-24T07:00:00.000Z')
  })

  it('keeps distinct occurrences distinct', () => {
    expect(occurrenceKey(taskId, NOW)).not.toBe(occurrenceKey(taskId, NOW + HOUR))
  })
})

describe('catchUpReceipt', () => {
  it('records both instants and the delay', () => {
    expect(catchUpReceipt(Date.parse('2026-11-24T07:00:00.000Z'), Date.parse('2026-11-24T09:00:00.000Z'))).toEqual({
      scheduledAt: '2026-11-24T07:00:00.000Z',
      deliveredAt: '2026-11-24T09:00:00.000Z',
      lagMs: 2 * HOUR,
    })
  })
})

describe('isDuplicateDelivery', () => {
  it('finds a key already recorded and misses an unknown one', () => {
    expect(isDuplicateDelivery('k1', ['k1', 'k2'])).toBe(true)
    expect(isDuplicateDelivery('k3', ['k1'])).toBe(false)
    expect(isDuplicateDelivery('k1', [])).toBe(false)
  })
})

describe('providerWaitStep', () => {
  it('delivers as soon as the provider is registered', () => {
    expect(providerWaitStep(true, NOW, NOW + 5_000, 60_000)).toBe('deliver')
  })

  it('waits inside the bound and gives up at it', () => {
    expect(providerWaitStep(false, NOW, NOW + 59_999, 60_000)).toBe('wait')
    expect(providerWaitStep(false, NOW, NOW + 60_000, 60_000)).toBe('give-up')
  })
})

describe('waitForModelProvider', () => {
  const clock = (start: number) => {
    let now = start
    return { now: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve() }, current: () => now }
  }

  it('returns as soon as the provider is registered', async () => {
    const c = clock(NOW)
    await expect(waitForModelProvider({ provider: 'p', registered: () => true, now: c.now, sleep: c.sleep, limitMs: 1_000, pollMs: 100 })).resolves.toBe(true)
    expect(c.current()).toBe(NOW)
  })

  it('waits for a provider that registers late', async () => {
    const c = clock(NOW)
    let probes = 0
    await expect(waitForModelProvider({ provider: 'p', registered: () => ++probes > 2, now: c.now, sleep: c.sleep, limitMs: 1_000, pollMs: 100 })).resolves.toBe(true)
    expect(c.current()).toBe(NOW + 200)
  })

  it('gives up when the wait expires', async () => {
    const c = clock(NOW)
    await expect(waitForModelProvider({ provider: 'p', registered: () => false, now: c.now, sleep: c.sleep, limitMs: 300, pollMs: 100 })).resolves.toBe(false)
    expect(c.current()).toBe(NOW + 300)
  })
})
