/** Event-directory reconstruction from persisted ranges and copied fork prefixes. */
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { WorkspaceDomainState } from './spec.ts'
import type { SessionDirectoryContext, SessionDirectoryObservation } from './types.ts'

/**
 * Reconstruct initial directory ranges without changing Session history.
 * @param observation - owner-validated header, inherited cut and event count.
 * @param state - serialized registry snapshot containing committed ranges and relocation outcomes.
 * @param persistence - reader used only for a missing fork-parent range.
 * @param visited - ancestors already traversed, to refuse corrupt cyclic lineage.
 * @returns detached ranges, or undefined when historical metadata is insufficient.
 */
export async function deriveSessionDirectoryContexts(
  observation: SessionDirectoryObservation,
  state: Pick<WorkspaceDomainState, 'directoryContexts' | 'relocations'>,
  persistence: SessionPersistence,
  visited = new Set<SessionId>(),
): Promise<SessionDirectoryContext[] | undefined> {
  const { header, inheritedEventCount, eventCount } = observation
  const existing = state.directoryContexts[header.id]
  if (existing !== undefined) return existing.map(context => ({ ...context }))
  if (header.cwd === undefined || inheritedEventCount > eventCount || visited.has(header.id)) return undefined
  // Journals from an earlier runtime lack the event frontier; never guess it from time or text.
  if (Object.values(state.relocations).some(operation => operation.request.sessionId === header.id
    && operation.status === 'completed' && operation.source.path !== operation.target.path)) return undefined
  if (inheritedEventCount === 0) return [{ fromEvent: SessionLogOffset(0), cwd: header.cwd }]
  if (header.parentSession === undefined) return undefined
  visited.add(header.id)
  let parent
  try { parent = await persistence.open(header.parentSession, 'read') }
  catch (error: unknown) {
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  }
  let parentContexts: SessionDirectoryContext[] | undefined
  try {
    const events = (await parent.read()).events
    if (inheritedEventCount > events.length) return undefined
    parentContexts = await deriveSessionDirectoryContexts({ header: parent.header,
      inheritedEventCount: parent.inheritedEventCount, eventCount: SessionLogOffset(events.length) }, state, persistence, visited)
  } finally { await parent.close() }
  if (parentContexts === undefined) return undefined
  return [...parentContexts.filter(context => context.fromEvent < inheritedEventCount),
    { fromEvent: inheritedEventCount, cwd: header.cwd }]
}
