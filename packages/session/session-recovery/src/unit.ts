/**
 * Storage shape and status rules of the recovery ledger — the durable record
 * that keeps an interrupted turn from being resumed twice or lost silently.
 * The published unit envelope matches the versioned storage units other host
 * services use, so the file store in this package is replaceable by the
 * storage service without a format change.
 * @module @deepseek-ai/dsh-session-recovery/unit
 */

/** Unit name written into the persisted envelope. */
export const RECOVERY_UNIT_NAME = 'recovery'

/** Unit version this build writes and reads. */
export const RECOVERY_UNIT_VERSION = 1

/** Lifecycle of one interruption record. */
export type InterruptionStatus = 'resuming' | 'resumed' | 'skipped' | 'failed' | 'awaiting-confirmation'

/** Why an interruption produced no automatic continuation. */
export type InterruptionReason = 'limit' | 'stale' | 'owned-elsewhere' | 'archived' | 'subagent' | 'provider-unavailable'

/** Per-Session continuation policy. */
export interface SessionPolicyRow {
  /** Whether the Session continues after a restart. */
  readonly autoContinue: boolean
  /** ISO timestamp of the last policy change. */
  readonly updatedAt: string
}

/** One durable outcome record for one interrupted turn. */
export interface InterruptionRow {
  /** Session whose turn was interrupted. */
  readonly sessionId: string
  /** Sequence number of the open `turn/start` event. */
  readonly turnStartSeq: number
  /** Boot that created the record. */
  readonly bootId: string
  /** Current status. */
  readonly status: InterruptionStatus
  /** Reason recorded with a non-continuing outcome. */
  readonly reason?: InterruptionReason
  /** Number of repeat injections. */
  readonly attempts: number
  /** Free-form diagnostic detail. */
  readonly detail?: string
  /** ISO timestamp of the last outcome change. */
  readonly updatedAt: string
}

/** Tables of the recovery unit. */
export interface RecoveryTables {
  /** Policy keyed by Session id. */
  readonly sessions: Record<string, SessionPolicyRow>
  /** Outcomes keyed by {@link interruptionKey}. */
  readonly interruptions: Record<string, InterruptionRow>
}

/** Persisted envelope. */
export interface RecoveryUnitFile {
  /** Unit identity and format version. */
  readonly unit: { readonly name: string; readonly version: number }
  /** Ledger tables. */
  readonly tables: RecoveryTables
}

/** Statuses that never change again until a human acts. */
const TERMINAL: ReadonlySet<InterruptionStatus> = new Set(['resumed', 'awaiting-confirmation', 'skipped'])

/**
 * Key of one interruption record.
 * @param sessionId - Session whose turn was interrupted.
 * @param turnStartSeq - Sequence number of the open turn.
 * @returns Stable record key.
 */
export function interruptionKey(sessionId: string, turnStartSeq: number): string {
  return `${sessionId}#${turnStartSeq}`
}

/**
 * Whether a status is final.
 * @param status - Status to test.
 * @returns True when the record accepts no further automatic transition.
 */
export function isTerminal(status: InterruptionStatus): boolean {
  return TERMINAL.has(status)
}

/** Allowed automatic transitions; human actions are the only way out of `awaiting-confirmation`. */
const TRANSITIONS: Readonly<Record<InterruptionStatus, readonly InterruptionStatus[]>> = {
  resuming: ['resumed', 'failed', 'awaiting-confirmation', 'skipped'],
  failed: ['resuming', 'skipped'],
  resumed: [],
  'awaiting-confirmation': ['resuming'],
  skipped: [],
}

/**
 * Whether one automatic transition is allowed.
 * @param from - Current status.
 * @param to - Requested status.
 * @returns True when the transition is allowed.
 */
export function allowsTransition(from: InterruptionStatus, to: InterruptionStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Create an empty unit in the current version.
 * @returns Empty ledger envelope.
 */
export function emptyUnit(): RecoveryUnitFile {
  return { unit: { name: RECOVERY_UNIT_NAME, version: RECOVERY_UNIT_VERSION }, tables: { sessions: {}, interruptions: {} } }
}
