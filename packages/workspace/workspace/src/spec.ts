/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

const sessionId = z.string().transform(value => brandString<SessionId>(value))

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; `sessionIds` is the ordered ownership account (array
 * order is display order); timestamps are ISO-8601 strings.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Recoverable two-write mutation marker. The marker is persisted before the
 * record/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

const relocationRequest = z.object({
  sessionId, operationId: z.uuid(), expectedCwd: z.string(),
  expectedRevision: z.string().transform(SessionPersistenceRevision), targetWorkspaceId: workspaceId,
})

const relocationResult = z.object({
  sessionId, operationId: z.uuid(), sourceCwd: z.string(), cwd: z.string(),
  revision: z.string().transform(SessionPersistenceRevision),
})

const directoryContexts = z.array(z.object({
  fromEvent: z.number().int().nonnegative().transform(SessionLogOffset), cwd: z.string().min(1),
})).min(1).refine(contexts => contexts[0]?.fromEvent === 0
  && contexts.every((context, index) => index === 0 || context.fromEvent > (contexts[index - 1]?.fromEvent ?? -1)),
{ message: 'directory contexts must start at zero and have strictly increasing event offsets' })

const workspaceRelocation = z.object({
  request: relocationRequest,
  sourceWorkspaceId: workspaceId,
  source: workspaceRecord,
  target: workspaceRecord,
  status: z.enum(['prepared', 'completed', 'recovered']),
  result: relocationResult.optional(),
  directoryContexts: directoryContexts.optional(),
})

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order. `archivedSessionIds` is
 * the registry-global archive set layered over workspace accounting: an
 * archived session keeps its `sessionIds` slot (unarchiving must restore the
 * position), so the set never participates in the one-owner accounting
 * invariant. `pinnedSessionIds` is the registry-global pin set in pin order
 * (most recently pinned first); pinning and archival are mutually
 * exclusive, so archiving drops the session's pin. Both session sets are
 * defaulted so records written before the fields parse unchanged.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  /** First-use Workspace identity, retained after its registration is deleted. */
  defaultWorkspaceId: workspaceId.optional(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  pendingMutation: workspacePendingMutation.optional(),
  /** Exact retry outcomes and unfinished cross-owner recovery intents. */
  relocations: z.record(z.string(), workspaceRelocation).default({}),
  /** Independent event-directory history, including copied fork prefixes. */
  directoryContexts: z.record(z.string(), directoryContexts).default({}),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: one `workspaces` table keyed by
 * {@link WorkspaceId} plus the bootstrap/order singleton. The registry opens
 * this through `ctx.storage.domain`; the spec object is the single source of
 * the domain's identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], relocations: {}, directoryContexts: {} },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
