import { describe, expect, it } from 'vitest'
import { selectCandidates, type JournalCandidate } from '../src/candidates.ts'
import type { InterruptionRow } from '../src/unit.ts'

const NOW = Date.parse('2026-11-24T09:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const journal = (sessionId: string, turnStartSeq: number, lastEventAt: string, extra: Partial<JournalCandidate> = {}): JournalCandidate =>
  ({ sessionId, turnStartSeq, lastEventAt, ...extra })

const record = (sessionId: string, turnStartSeq: number, updatedAt: string, status: InterruptionRow['status'] = 'failed'): InterruptionRow =>
  ({ sessionId, turnStartSeq, bootId: 'boot-0', status, attempts: 1, updatedAt })

describe('selectCandidates', () => {
  it('keeps opted-in journal candidates and orders the newest first', () => {
    const selected = selectCandidates({
      journal: [journal('old', 1, minutesAgo(120)), journal('new', 2, minutesAgo(5))],
      ledger: [],
      continueWithoutTools: false,
      autoContinue: new Set(['old', 'new']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected.map(candidate => candidate.sessionId)).toEqual(['new', 'old'])
  })

  it('continues a turn that called no tool without an opt-in', () => {
    const selected = selectCandidates({
      journal: [journal('quiet', 1, minutesAgo(5), { toolCalls: [] })],
      ledger: [],
      continueWithoutTools: true,
      autoContinue: new Set(),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected.map(candidate => candidate.sessionId)).toEqual(['quiet'])
  })

  it('keeps a turn with tools or unknown tools behind the opt-in', () => {
    const selected = selectCandidates({
      journal: [
        journal('worked', 1, minutesAgo(5), { toolCalls: ['run_code'] }),
        journal('unknown', 2, minutesAgo(4)),
      ],
      ledger: [],
      continueWithoutTools: true,
      autoContinue: new Set(),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toEqual([])
  })

  it('honours a deployment that disables continuation without tools', () => {
    const selected = selectCandidates({
      journal: [journal('quiet', 1, minutesAgo(5), { toolCalls: [] })],
      ledger: [],
      continueWithoutTools: false,
      autoContinue: new Set(),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toEqual([])
  })

  it('drops archived, subagent, unopted, and too old candidates', () => {
    const selected = selectCandidates({
      journal: [
        journal('archived', 1, minutesAgo(5), { archived: true }),
        journal('child', 1, minutesAgo(5), { origin: 'subagent' }),
        journal('unopted', 1, minutesAgo(5)),
        journal('stale', 1, minutesAgo(60 * 13)),
      ],
      ledger: [],
      continueWithoutTools: false,
      autoContinue: new Set(['archived', 'child', 'stale', 'unopted-x']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toEqual([])
  })

  it('drops a candidate whose timestamp cannot be parsed', () => {
    const selected = selectCandidates({
      journal: [journal('broken', 1, 'not-a-date')],
      ledger: [],
      continueWithoutTools: false,
      autoContinue: new Set(['broken']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toEqual([])
  })

  it('keeps a record the ledger still holds when the journal no longer reports it', () => {
    const selected = selectCandidates({
      journal: [],
      ledger: [record('ledger-only', 3, minutesAgo(30))],
      continueWithoutTools: false,
      autoContinue: new Set(['ledger-only']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toEqual([{ key: 'ledger-only#3', sessionId: 'ledger-only', turnStartSeq: 3, ageMs: 30 * 60_000 }])
  })

  it('prefers the journal record when both sources report one interruption', () => {
    const selected = selectCandidates({
      journal: [journal('both', 4, minutesAgo(10))],
      ledger: [record('both', 4, minutesAgo(600))],
      continueWithoutTools: false,
      autoContinue: new Set(['both']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toHaveLength(1)
    expect(selected[0]?.ageMs).toBe(10 * 60_000)
  })

  it('drops a ledger record that is too old, unopted, or unparsable', () => {
    const selected = selectCandidates({
      journal: [],
      ledger: [record('old', 1, minutesAgo(60 * 13)), record('quiet', 1, minutesAgo(5)), record('broken', 1, 'nope')],
      continueWithoutTools: false,
      autoContinue: new Set(['old', 'broken']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected).toEqual([])
  })

  it('sorts equal ages by key so the pass is deterministic', () => {
    const selected = selectCandidates({
      journal: [journal('b', 1, minutesAgo(1)), journal('a', 1, minutesAgo(1))],
      ledger: [],
      continueWithoutTools: false,
      autoContinue: new Set(['a', 'b']),
      now: NOW,
      maxAgeHours: 12,
    })
    expect(selected.map(candidate => candidate.key)).toEqual(['a#1', 'b#1'])
  })
})
