/** Reading of the ledger tables from a parsed envelope. */
import type { InterruptionRow, RecoveryTables, SessionPolicyRow } from './unit.ts'

/**
 * Read the two tables of a parsed envelope, defaulting absent ones to empty maps.
 * @param tables - Parsed tables value of an envelope.
 * @returns Tables in the current shape.
 */
export function readTables(tables: object): RecoveryTables {
  const sessions = (tables as { sessions?: unknown }).sessions
  const interruptions = (tables as { interruptions?: unknown }).interruptions
  return {
    sessions: isRecord(sessions) ? sessions as Record<string, SessionPolicyRow> : {},
    interruptions: isRecord(interruptions) ? interruptions as Record<string, InterruptionRow> : {},
  }
}

/**
 * Whether a value is a non-array object.
 * @param value - Value to test.
 * @returns True for a plain record.
 */
function isRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
