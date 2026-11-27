/** Ledger operations over a durable store, with status rules enforced here. */
import {
  RecoveryUnitFile,
  InterruptionRow,
  InterruptionStatus,
  InterruptionReason,
  SessionPolicyRow,
  allowsTransition,
  emptyUnit,
  interruptionKey,
  isTerminal,
} from './unit.ts'

/** Typed refusal when a caller asks for a transition the ledger does not allow. */
export class RecoveryTransitionError extends Error {
  /**
   * @param key - Record key.
   * @param from - Current status.
   * @param to - Requested status.
   */
  constructor(readonly key: string, readonly from: InterruptionStatus | 'absent', readonly to: InterruptionStatus) {
    super(`recovery: record "${key}" cannot move from "${from}" to "${to}"`)
    this.name = 'RecoveryTransitionError'
  }
}

/** Typed refusal when a duplicate interruption record would change an existing outcome. */
export class RecoveryDuplicateError extends Error {
  /**
   * @param key - Record key that already exists.
   */
  constructor(readonly key: string) {
    super(`recovery: record "${key}" already exists`)
    this.name = 'RecoveryDuplicateError'
  }
}

/** Durable document access the ledger needs; implemented by the file store and by the host storage. */
export interface LedgerStore {
  /** @returns Current durable document, or an empty document when nothing was written yet. */
  read(): Promise<RecoveryUnitFile>
  /** @param file - Complete document to persist. */
  write(file: RecoveryUnitFile): Promise<void>
}

/** Input of {@link RecoveryLedger.begin}. */
export interface BeginInterruptionInput {
  /** Session whose turn was interrupted. */
  readonly sessionId: string
  /** Sequence number of the open turn. */
  readonly turnStartSeq: number
  /** Boot that detected the interruption. */
  readonly bootId: string
}

/** Clock used for record timestamps. */
export type Clock = () => string

/**
 * Durable outcomes of interrupted turns and the per-Session continuation policy.
 *
 * One record exists per interruption; the first writer owns it. Every mutation
 * reads the current document, applies its rule, and writes the whole document
 * back, so a store must serialize concurrent writes.
 */
export class RecoveryLedger {
  /**
   * @param store - Durable document access.
   * @param clock - Timestamp source; defaults to the wall clock in ISO form.
   */
  constructor(private readonly store: LedgerStore, private readonly clock: Clock = () => new Date().toISOString()) {}

  /**
   * Read the continuation policy of one Session.
   * @param sessionId - Session id.
   * @returns Policy row, or undefined when the Session was never configured.
   */
  async getPolicy(sessionId: string): Promise<SessionPolicyRow | undefined> {
    const file = await this.store.read()
    return file.tables.sessions[sessionId]
  }

  /**
   * Store the continuation policy of one Session.
   * @param sessionId - Session id.
   * @param autoContinue - Whether the Session continues after a restart.
   * @returns Stored policy row.
   */
  async setPolicy(sessionId: string, autoContinue: boolean): Promise<SessionPolicyRow> {
    const file = await this.store.read()
    const row: SessionPolicyRow = { autoContinue, updatedAt: this.clock() }
    await this.store.write({ ...file, tables: { ...file.tables, sessions: { ...file.tables.sessions, [sessionId]: row } } })
    return row
  }

  /**
   * Create the record of one interruption. A repeated call for the same
   * interruption returns the existing record instead of overwriting its outcome.
   * @param input - Interruption identity.
   * @returns Existing or newly created record.
   */
  async begin(input: BeginInterruptionInput): Promise<InterruptionRow> {
    const key = interruptionKey(input.sessionId, input.turnStartSeq)
    const file = await this.store.read()
    const existing = file.tables.interruptions[key]
    if (existing !== undefined) return existing
    const row: InterruptionRow = {
      sessionId: input.sessionId,
      turnStartSeq: input.turnStartSeq,
      bootId: input.bootId,
      status: 'resuming',
      attempts: 0,
      updatedAt: this.clock(),
    }
    await this.store.write({ ...file, tables: { ...file.tables, interruptions: { ...file.tables.interruptions, [key]: row } } })
    return row
  }

  /**
   * Read one record.
   * @param sessionId - Session id.
   * @param turnStartSeq - Sequence number of the open turn.
   * @returns Record, or undefined when the interruption was never recorded.
   */
  async get(sessionId: string, turnStartSeq: number): Promise<InterruptionRow | undefined> {
    const file = await this.store.read()
    return file.tables.interruptions[interruptionKey(sessionId, turnStartSeq)]
  }

  /** @returns Every recorded interruption, newest update first. */
  async list(): Promise<readonly InterruptionRow[]> {
    const file = await this.store.read()
    return Object.values(file.tables.interruptions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** @returns Records an automatic pass may still act on. */
  async open(): Promise<readonly InterruptionRow[]> {
    return (await this.list()).filter(row => !isTerminal(row.status))
  }

  /**
   * Record the next outcome of one interruption and count the attempt when the
   * record re-enters `resuming` after a failure.
   * @param sessionId - Session id.
   * @param turnStartSeq - Sequence number of the open turn.
   * @param status - Requested status.
   * @param options - Optional reason and diagnostic detail.
   * @returns Updated record.
   */
  async mark(
    sessionId: string,
    turnStartSeq: number,
    status: InterruptionStatus,
    options: { reason?: InterruptionReason; detail?: string } = {},
  ): Promise<InterruptionRow> {
    const key = interruptionKey(sessionId, turnStartSeq)
    const file = await this.store.read()
    const current = file.tables.interruptions[key]
    if (current === undefined) throw new RecoveryTransitionError(key, 'absent', status)
    if (!allowsTransition(current.status, status)) throw new RecoveryTransitionError(key, current.status, status)
    const retry = current.status === 'failed' && status === 'resuming'
    const row: InterruptionRow = {
      ...current,
      status,
      ...options.reason === undefined ? {} : { reason: options.reason },
      ...options.detail === undefined ? {} : { detail: options.detail },
      attempts: retry ? current.attempts + 1 : current.attempts,
      updatedAt: this.clock(),
    }
    await this.store.write({ ...file, tables: { ...file.tables, interruptions: { ...file.tables.interruptions, [key]: row } } })
    return row
  }

  /**
   * Count one more attempt without changing the status, for a record the previous
   * process left in `resuming` when it died between the mark and the injection.
   * @param sessionId - Session id.
   * @param turnStartSeq - Sequence number of the open turn.
   * @returns Updated record.
   */
  async noteAttempt(sessionId: string, turnStartSeq: number): Promise<InterruptionRow> {
    const key = interruptionKey(sessionId, turnStartSeq)
    const file = await this.store.read()
    const current = file.tables.interruptions[key]
    if (current === undefined) throw new RecoveryTransitionError(key, 'absent', 'resuming')
    if (current.status !== 'resuming' && current.status !== 'failed') throw new RecoveryTransitionError(key, current.status, 'resuming')
    const row: InterruptionRow = { ...current, attempts: current.attempts + 1, updatedAt: this.clock() }
    await this.store.write({ ...file, tables: { ...file.tables, interruptions: { ...file.tables.interruptions, [key]: row } } })
    return row
  }

  /**
   * Insert a record supplied by an upstream migration.
   * @param row - Complete record to store.
   * @returns Stored record.
   */
  async import(row: InterruptionRow): Promise<InterruptionRow> {
    const key = interruptionKey(row.sessionId, row.turnStartSeq)
    const file = await this.store.read()
    if (file.tables.interruptions[key] !== undefined) throw new RecoveryDuplicateError(key)
    await this.store.write({ ...file, tables: { ...file.tables, interruptions: { ...file.tables.interruptions, [key]: row } } })
    return row
  }

  /**
   * Replace the whole document; used by transports that manage the envelope.
   * @param file - Document to persist.
   */
  async replace(file: RecoveryUnitFile): Promise<void> {
    await this.store.write(file)
  }

  /** @returns An empty document in the current version. */
  empty(): RecoveryUnitFile {
    return emptyUnit()
  }
}
