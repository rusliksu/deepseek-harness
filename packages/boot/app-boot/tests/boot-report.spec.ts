import { describe, expect, it } from 'vitest'
import {
  BootReportError, appendBootRecord, bootId, missedWhileHostDown, parseBootHistory, renderBootSummary,
  type BootRecord,
} from '../src/boot-report.ts'

const BOOT = Date.parse('2026-11-24T06:00:00.000Z')
const START = Date.parse('2026-11-24T06:00:05.000Z')

const record = (overrides: Partial<BootRecord> = {}): BootRecord => ({
  bootTime: new Date(BOOT).toISOString(),
  processStartedAt: new Date(START).toISOString(),
  bootId: bootId(BOOT, START),
  appPid: 4242,
  hostReadyAt: '2026-11-24T06:00:09.000Z',
  autostartTaskResult: 0,
  recovered: 2,
  catchedUp: 1,
  skippedSessions: 0,
  skippedTasks: 1,
  ...overrides,
})

describe('bootId', () => {
  it('is stable for one start and differs across restarts', () => {
    expect(bootId(BOOT, START)).toBe(bootId(BOOT, START))
    expect(bootId(BOOT, START)).not.toBe(bootId(BOOT + 1, START))
    expect(bootId(BOOT, START)).not.toBe(bootId(BOOT, START + 1))
  })
})

describe('appendBootRecord', () => {
  it('appends the record last and keeps the configured window', () => {
    const first = record({ bootId: 'first' })
    const second = record({ bootId: 'second' })
    expect(appendBootRecord([first], second, 5)).toEqual([first, second])
    expect(appendBootRecord([first], second, 1)).toEqual([second])
  })

  it('refuses a limit that is not a positive integer', () => {
    expect(() => appendBootRecord([], record(), 0)).toThrow(RangeError)
    expect(() => appendBootRecord([], record(), 1.5)).toThrow('limit must be a positive integer')
  })
})

describe('missedWhileHostDown', () => {
  it('marks only occurrences that predate the boot', () => {
    expect(missedWhileHostDown(BOOT - 3_600_000, BOOT)).toBe(true)
    expect(missedWhileHostDown(BOOT, BOOT)).toBe(true)
    expect(missedWhileHostDown(BOOT + 1, BOOT)).toBe(false)
  })
})

describe('renderBootSummary', () => {
  it('renders one line with the counters', () => {
    const line = renderBootSummary(record())
    expect(line).toContain('boot ready'.slice(0, 4))
    expect(line).toContain('recovered 2')
    expect(line).toContain('catched up 1')
    expect(line).toContain('skipped sessions 0')
    expect(line).toContain('skipped tasks 1')
    expect(line).toContain('host ready 2026-11-24T06:00:09.000Z')
  })

  it('names a start whose host never mounted', () => {
    expect(renderBootSummary(record({ hostReadyAt: null }))).toContain('host not ready')
  })
})

describe('parseBootHistory', () => {
  it('reads an absent file as an empty history', () => {
    expect(parseBootHistory(undefined)).toEqual([])
  })

  it('round-trips stored records', () => {
    const stored = [record()]
    expect(parseBootHistory(JSON.stringify(stored))).toEqual(stored)
  })

  it('rejects invalid JSON', () => {
    expect(() => parseBootHistory('{nope')).toThrow(BootReportError)
    expect(() => parseBootHistory('{nope')).toThrow('not valid JSON')
  })

  it('rejects a document that is not an array', () => {
    expect(() => parseBootHistory('{}')).toThrow('not an array')
  })

  it('rejects an entry without the required fields', () => {
    expect(() => parseBootHistory('[null]')).toThrow('entry without the required fields')
    expect(() => parseBootHistory('[{"bootTime":"x"}]')).toThrow('entry without the required fields')
    expect(() => parseBootHistory(JSON.stringify([record({ hostReadyAt: 'ready' }), { bootTime: 1 }]))).toThrow(BootReportError)
  })
})
