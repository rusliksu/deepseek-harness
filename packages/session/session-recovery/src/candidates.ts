/** Candidate discovery and ordering for the recovery pass. */
import type { InterruptionRow } from './unit.ts'
import { interruptionKey } from './unit.ts'

/** One interruption detected from a Session log. */
export interface JournalCandidate {
  /** Session whose log ends with an open turn. */
  readonly sessionId: string
  /** Sequence number of the open `turn/start`. */
  readonly turnStartSeq: number
  /** ISO timestamp of the last event in the log. */
  readonly lastEventAt: string
  /** Tool names the interrupted turn called; empty when it called none. */
  readonly toolCalls?: readonly string[]
  /** Whether the Session is archived. */
  readonly archived?: boolean
  /** Session origin when it was created as a subagent child. */
  readonly origin?: 'subagent'
}

/** Candidate that survived filtering, with the record it maps to. */
export interface RecoveryCandidate {
  /** Stable interruption key. */
  readonly key: string
  /** Session id. */
  readonly sessionId: string
  /** Sequence number of the open turn. */
  readonly turnStartSeq: number
  /** Age of the last event in milliseconds. */
  readonly ageMs: number
}

/** Input of {@link selectCandidates}. */
export interface SelectCandidatesInput {
  /** Candidates detected in Session logs. */
  readonly journal: readonly JournalCandidate[]
  /** Records the ledger still keeps non-terminal or failed. */
  readonly ledger: readonly InterruptionRow[]
  /** Sessions that opted into continuation. */
  readonly autoContinue: ReadonlySet<string>
  /** Whether a turn that called no tool continues without an opt-in. */
  readonly continueWithoutTools: boolean
  /** Current time in milliseconds. */
  readonly now: number
  /** Maximum age of an interruption in hours. */
  readonly maxAgeHours: number
}

/**
 * Join journal and ledger candidates, drop the ineligible ones, and order the rest newest first.
 *
 * A record that only the ledger knows about stays a candidate: repairing the
 * Session log closes its open turn, so the journal alone would lose it.
 * @param input - Candidate sources and eligibility rules.
 * @returns Eligible candidates, newest last event first.
 */
export function selectCandidates(input: SelectCandidatesInput): readonly RecoveryCandidate[] {
  const byKey = new Map<string, RecoveryCandidate>()
  for (const row of input.journal) {
    const key = interruptionKey(row.sessionId, row.turnStartSeq)
    const ageMs = input.now - Date.parse(row.lastEventAt)
    if (row.archived === true || row.origin === 'subagent') continue
    if (!input.autoContinue.has(row.sessionId) && !(input.continueWithoutTools && row.toolCalls?.length === 0)) continue
    if (!Number.isFinite(ageMs) || ageMs > input.maxAgeHours * 3_600_000) continue
    byKey.set(key, { key, sessionId: row.sessionId, turnStartSeq: row.turnStartSeq, ageMs })
  }
  for (const row of input.ledger) {
    const key = interruptionKey(row.sessionId, row.turnStartSeq)
    if (byKey.has(key)) continue
    if (!input.autoContinue.has(row.sessionId)) continue
    const ageMs = input.now - Date.parse(row.updatedAt)
    if (!Number.isFinite(ageMs) || ageMs > input.maxAgeHours * 3_600_000) continue
    byKey.set(key, { key, sessionId: row.sessionId, turnStartSeq: row.turnStartSeq, ageMs })
  }
  return [...byKey.values()].sort((a, b) => a.ageMs - b.ageMs || a.key.localeCompare(b.key))
}
