/**
 * Boot report: what the host recovered after a restart, and the downtime signal
 * catch-up rules need to tell "missed while the machine was off" from "overdue
 * by design".
 * @module @deepseek-ai/dsh-app-boot/boot-report
 */

/** One recorded application start. */
export interface BootRecord {
  /** Operating-system boot time, ISO timestamp. */
  readonly bootTime: string
  /** Process start time, ISO timestamp. */
  readonly processStartedAt: string
  /** Stable identity of this start. */
  readonly bootId: string
  /** Application process id. */
  readonly appPid: number
  /** When the host finished mounting, or null when it never did. */
  readonly hostReadyAt: string | null
  /** Result code of the autostart task, or null when it did not run. */
  readonly autostartTaskResult: number | null
  /** Sessions continued after the restart. */
  readonly recovered: number
  /** Scheduled tasks delivered late. */
  readonly catchedUp: number
  /** Candidates left for a later pass or a human. */
  readonly skippedSessions: number
  /** Missed occurrences that produced no delivery. */
  readonly skippedTasks: number
}

/** Typed refusal when a stored report cannot be interpreted. */
export class BootReportError extends Error {
  /** @param detail - What is wrong with the stored report. */
  constructor(readonly detail: string) {
    super(`boot report: ${detail}`)
    this.name = 'BootReportError'
  }
}

/**
 * Identity of one application start.
 *
 * Both inputs are wall-clock milliseconds, so the id is stable for the same
 * start and different across restarts.
 * @param bootTimeMs - Operating-system boot time in milliseconds.
 * @param processStartedAtMs - Application process start in milliseconds.
 * @returns Compact identity.
 */
export function bootId(bootTimeMs: number, processStartedAtMs: number): string {
  return `${bootTimeMs.toString(36)}-${processStartedAtMs.toString(36)}`
}

/**
 * Append a record to the retained history.
 * @param history - Previous records, oldest first.
 * @param record - Record of this start.
 * @param limit - Number of starts to retain, at least 1.
 * @returns History with the new record last and at most `limit` entries.
 * @throws RangeError when the limit is not a positive integer.
 */
export function appendBootRecord(
  history: readonly BootRecord[],
  record: BootRecord,
  limit: number,
): readonly BootRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('boot report: limit must be a positive integer')
  return [...history, record].slice(-limit)
}

/**
 * Whether a scheduled occurrence predates this boot, which is the only evidence
 * that it was missed while the host was not running.
 * @param scheduledAtMs - Planned occurrence in milliseconds.
 * @param bootTimeMs - Operating-system boot time in milliseconds.
 * @returns True when the occurrence was already due before the machine started.
 */
export function missedWhileHostDown(scheduledAtMs: number, bootTimeMs: number): boolean {
  return scheduledAtMs <= bootTimeMs
}

/**
 * Render the single log line of one start.
 * @param record - Record of this start.
 * @returns One line naming the boot, host readiness, and the counters.
 */
export function renderBootSummary(record: BootRecord): string {
  const ready = record.hostReadyAt === null ? 'host not ready' : `host ready ${record.hostReadyAt}`
  return `boot ${record.bootId}: ${ready}, recovered ${record.recovered}, catched up ${record.catchedUp}, `
    + `skipped sessions ${record.skippedSessions}, skipped tasks ${record.skippedTasks}`
}

/**
 * Read the retained history from its stored JSON.
 * @param raw - File content, or undefined when no file exists yet.
 * @returns Retained records, oldest first.
 * @throws BootReportError when the content is not a record array.
 */
export function parseBootHistory(raw: string | undefined): readonly BootRecord[] {
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BootReportError('stored history is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new BootReportError('stored history is not an array')
  const records: BootRecord[] = []
  for (const entry of parsed) {
    if (!isBootRecord(entry)) throw new BootReportError('stored history holds an entry without the required fields')
    records.push(entry)
  }
  return records
}

/**
 * Whether a value carries every field of {@link BootRecord}.
 * @param value - Value read from storage.
 * @returns True for a complete record.
 */
function isBootRecord(value: unknown): value is BootRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof BootRecord, unknown>>
  return typeof record.bootTime === 'string'
    && typeof record.processStartedAt === 'string'
    && typeof record.bootId === 'string'
    && typeof record.appPid === 'number'
    && (record.hostReadyAt === null || typeof record.hostReadyAt === 'string')
    && (record.autostartTaskResult === null || typeof record.autostartTaskResult === 'number')
    && typeof record.recovered === 'number'
    && typeof record.catchedUp === 'number'
    && typeof record.skippedSessions === 'number'
    && typeof record.skippedTasks === 'number'
}
