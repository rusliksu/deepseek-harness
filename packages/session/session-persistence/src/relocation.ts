/** Durable working-directory changes; log generations and asset locations remain unchanged. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from './revision.ts'

/** A caller-generated operation identity and the exact observation it may replace. */
export interface SessionRelocationRequest {
  readonly sessionId: SessionId
  readonly operationId: string
  readonly expectedCwd: string
  readonly expectedRevision: SessionPersistenceRevision
  readonly targetCwd: string
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
 * A consumer must close the transaction in a finally block. Closing an unpublished
 * transaction leaves its original directory active; closing a committed one retains it.
 */
export interface SessionRelocationTransaction {
  /** Publish the prepared working directory; repeats return the same result. */
  commit(): Promise<SessionRelocationResult>
  /** Restore the original placement before releasing exclusive ownership. */
  rollback(): Promise<void>
  /** Finish recovery bookkeeping and release both process and kernel ownership. */
  close(): Promise<void>
}
