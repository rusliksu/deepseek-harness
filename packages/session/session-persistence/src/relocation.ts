/** Durable working-directory changes; log generations and asset locations remain unchanged. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from './handle.ts'
import type { SessionPersistenceRevision } from './revision.ts'

/** A caller-generated operation identity and the exact observation it may replace. */
export interface SessionRelocationRequest {
  readonly sessionId: SessionId
  readonly operationId: string
  readonly expectedCwd: string
  readonly expectedRevision: SessionPersistenceRevision
  readonly targetCwd: string
}

/** Optional live ownership retained through agent teardown. */
export interface SessionRelocationOptions {
  /** Exact active write handle from this provider; omit for a cold session. */
  readonly writer?: SessionHandle
}

/** The authoritative working directory after one committed operation. */
export interface SessionRelocationResult {
  readonly sessionId: SessionId
  readonly operationId: string
  readonly sourceCwd: string
  readonly cwd: string
  readonly revision: SessionPersistenceRevision
}

/**
 * Exclusive ownership retained while the consumer reconciles its related data.
 * A consumer must close the transaction in a finally block. A supplied live writer
 * must close after preparation and before commit. Closing an unpublished transaction
 * leaves its original directory active; complete transfers the lease to its replacement.
 */
export interface SessionRelocationTransaction {
  /** Publish the prepared working directory; repeats return the same result. */
  commit(): Promise<SessionRelocationResult>
  /** Restore the original placement before releasing exclusive ownership. */
  rollback(): Promise<void>
  /** Open the committed or restored directory under the transaction's retained lease.
   * @returns one borrowed write handle; close it before rollback or another open.
   */
  openWriter(): Promise<SessionHandle>
  /** Transfer permanent ownership to the verified replacement handle.
   * @param writer - the exact borrowed handle returned by openWriter.
   * @param commitRelated - commit related durable records after the final flush, before lease transfer.
   */
  complete(writer: SessionHandle, commitRelated?: () => Promise<void>): Promise<void>
  /** Close borrowed writers and release retained ownership unless complete transferred it. */
  close(): Promise<void>
}
