import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionRecovery, { Config, DEFAULTS } from '../src/service.ts'
import { emptyUnit } from '../src/unit.ts'

const ports = (overrides: Record<string, unknown> = {}) => ({
  bootId: 'boot-1',
  now: () => Date.parse('2026-11-24T09:00:00.000Z'),
  sleep: async () => {},
  journal: async () => [],
  providerReady: async () => true,
  classify: async () => ({ kind: 'auto' as const }),
  notifyAwaiting: async () => {},
  resume: async () => {},
  inject: async () => {},
  log: { info: () => {}, warn: () => {} },
  ...overrides,
})

const service = (config: Record<string, unknown> = {}) => {
  const ctx = new Context()
  return new SessionRecovery(ctx, Config({ ledgerPath: 'C:/tmp/recovery-test.json', ...config }))
}

/** A deployment that states only the unit path, so every default is resolved here. */
const bare = () => new SessionRecovery(new Context(), { ledgerPath: 'C:/tmp/bare.json' })

describe('SessionRecovery service', () => {
  it('falls back to the default unit name when no path is configured', () => {
    expect(new SessionRecovery(new Context(), {}).unitPath).toBe('recovery.json')
  })

  it('falls back to the documented defaults when the deployment states nothing', () => {
    expect(bare().settingsView).toEqual({ ...DEFAULTS })
  })

  it('resolves the defaults and exposes the ledger path', () => {
    const svc = service()
    expect(svc.unitPath).toBe('C:/tmp/recovery-test.json')
    expect(svc.settingsView).toMatchObject({ enabled: DEFAULTS.enabled, maxSessions: DEFAULTS.maxSessions, attempts: DEFAULTS.attempts })
    expect(svc.ledger.empty()).toEqual(emptyUnit())
  })

  it('honours configured bounds', () => {
    const svc = service({
      enabled: true, maxSessions: 1, maxAgeHours: 2, staggerMs: 5,
      providerWaitMs: 7, providerPollMs: 3, attempts: 4, requireConfirmationForWriteTools: false, continueWithoutTools: true,
    })
    expect(svc.settingsView).toEqual({
      enabled: true, maxSessions: 1, maxAgeHours: 2, staggerMs: 5,
      providerWaitMs: 7, providerPollMs: 3, attempts: 4, requireConfirmationForWriteTools: false, continueWithoutTools: true,
    })
  })

  it('runs a disabled pass without touching the ports', async () => {
    const svc = service()
    await expect(svc.run(ports())).resolves.toMatchObject({ ran: false, skipped: 'disabled' })
  })

  it('runs an enabled pass with the supplied ports', async () => {
    const svc = service({ enabled: true })
    await expect(svc.run(ports())).resolves.toMatchObject({ ran: true, injected: 0 })
  })
})
