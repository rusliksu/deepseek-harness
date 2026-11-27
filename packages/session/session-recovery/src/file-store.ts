/** JSON-file store for the recovery unit, with atomic replace and typed failures. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RecoveryUnitFile, RECOVERY_UNIT_NAME, RECOVERY_UNIT_VERSION, emptyUnit } from './unit.ts'
import type { LedgerStore } from './ledger.ts'
import { readTables } from './tables.ts'

/** Typed refusal when the persisted unit cannot be interpreted. */
export class RecoveryStorageError extends Error {
  /**
   * @param detail - What is wrong with the persisted document.
   * @param options - Optional underlying cause.
   */
  constructor(readonly detail: string, options?: { cause?: unknown }) {
    super(`recovery: ${detail}`, options)
    this.name = 'RecoveryStorageError'
  }
}

/**
 * Store one recovery unit in a plain JSON file.
 *
 * The write replaces the file through a sibling temporary file and a rename, so
 * a crash leaves either the previous document or the new one, never a torn one.
 * A missing file reads as an empty document.
 */
export class FileRecoveryStore implements LedgerStore {
  /**
   * @param path - Absolute path of the unit file.
   */
  constructor(readonly path: string) {}

  /** @returns Persisted document, or an empty document when the file does not exist. */
  async read(): Promise<RecoveryUnitFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyUnit()
      throw new RecoveryStorageError(`cannot read "${this.path}"`, { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new RecoveryStorageError(`"${this.path}" is not valid JSON`, { cause: error })
    }
    return this.decode(parsed)
  }

  /**
   * Persist the document.
   * @param file - Document to store.
   */
  async write(file: RecoveryUnitFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await rename(temporary, this.path)
  }

  /**
   * Validate a parsed document.
   * @param parsed - Value read from disk.
   * @returns Validated document.
   */
  private decode(parsed: unknown): RecoveryUnitFile {
    const bad = (detail: string) => new RecoveryStorageError(`"${this.path}" ${detail}`)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw bad('does not hold an object')
    const unit = (parsed as { unit?: unknown }).unit
    const tables = (parsed as { tables?: unknown }).tables
    if (typeof unit !== 'object' || unit === null) throw bad('has no unit envelope')
    const name = (unit as { name?: unknown }).name
    const version = (unit as { version?: unknown }).version
    if (name !== RECOVERY_UNIT_NAME) throw bad(`belongs to unit "${String(name)}", not "${RECOVERY_UNIT_NAME}"`)
    if (typeof version !== 'number' || !Number.isInteger(version)) throw bad('has no integer unit version')
    if (version > RECOVERY_UNIT_VERSION) throw bad(`uses unit version ${version}; this build reads up to ${RECOVERY_UNIT_VERSION}`)
    if (typeof tables !== 'object' || tables === null) throw bad('has no tables')
    return { unit: { name: RECOVERY_UNIT_NAME, version }, tables: readTables(tables) }
  }
}
