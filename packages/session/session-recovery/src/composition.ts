/** Adapters that connect one recovery pass to the Host services. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { JournalCandidate } from './candidates.ts'
import { interruptedTurns } from './journal.ts'
import { classifyTurn } from './policy.ts'
import type { RecoveryPorts } from './runtime.ts'

/** Backend implementations this module reads; the file store provides them at runtime. */
interface PersistenceLike {
  list: () => Promise<readonly { header: { readonly id: SessionId } }[]>
  open: (id: SessionId, access: 'read') => Promise<{
    read: () => Promise<{ events: readonly SessionEvent[] }>
    close: () => Promise<void>
  }>
}

/** Loop capability used to close an interrupted turn through the normal path. */
interface AgentLoopLike {
  resume: (owner: Context, options: { resumeSessionId: SessionId }) => Promise<unknown>
}

/** Activation capability used to reach the live Agent of a stored Session. */
interface ControllerLike {
  resolveAgent: (id: SessionId) => Promise<{
    agent?: { followup: (message: unknown) => void; session: SessionId }
    error?: unknown
  }>
}

/** Services one pass needs; each is read with `ctx.get` and refused when absent. */
export interface RecoveryCompositionInput {
  /** Durable ledger owned by the service. */
  readonly ledger: RecoveryPorts['ledger']
  /** Boot running this pass. */
  readonly bootId: string
  /** Current wall time; defaults to the system clock. */
  readonly now?: () => number
  /** Delay primitive; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Diagnostic sinks; default to the context logger. */
  readonly log?: RecoveryPorts['log']
}

/**
 * Build the recovery ports over the Host services.
 *
 * The classification registry is empty here: a turn that called no tool
 * continues on its own, and a turn that called one waits for a human until the
 * tool-effect declarations arrive with their owning packages.
 * @param ctx - Context of the Host that mounts the service.
 * @param input - Ledger, boot identity, clock, and log sinks.
 * @returns Ports for one pass.
 */
export function createRecoveryPorts(ctx: Context, input: RecoveryCompositionInput): RecoveryPorts {
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence === undefined) throw new Error('session-recovery: Host does not provide sessionPersistence')
  const readEvents = async (sessionId: string): Promise<readonly SessionEvent[]> => {
    const handle = await persistence.open(SessionId(sessionId), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }
  const log = input.log ?? {
    info: (message: string): void => { ctx.logger.info(message) },
    warn: (message: string): void => { ctx.logger.warn(message) },
  }
  return {
    ledger: input.ledger,
    bootId: input.bootId,
    now: input.now ?? (() => Date.now()),
    sleep: input.sleep ?? (async (ms) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref()
      })
    }),
    journal: async (): Promise<readonly JournalCandidate[]> => {
      const sessions = await persistence.list()
      const store = ctx.get('sessions')
      if (store === undefined) throw new Error('session-recovery: Host does not provide sessions')
      const live = new Set(store.list().map(session => session.id))
      const candidates: JournalCandidate[] = []
      for (const { header } of sessions) {
        if (live.has(header.id)) continue
        let events: readonly SessionEvent[]
        try {
          events = await readEvents(header.id)
        } catch (error: unknown) {
          log.warn(`session-recovery: skipped ${header.id}: ${String(error)}`)
          continue
        }
        const tail = interruptedTurns(events).at(-1)
        if (tail === undefined) continue
        candidates.push({
          sessionId: header.id,
          turnStartSeq: tail.turnStartSeq,
          lastEventAt: new Date(tail.lastEventTime).toISOString(),
          toolCalls: tail.toolCalls,
        })
      }
      return candidates
    },
    providerReady: (): Promise<boolean> => {
      const llm = ctx.get('llm')
      return Promise.resolve(llm !== undefined && llm.listProviders().length > 0)
    },
    classify: async (sessionId) => {
      const tail = interruptedTurns(await readEvents(sessionId)).at(-1)
      return classifyTurn(
        (tail?.toolCalls ?? []).map(tool => ({ tool, state: 'completed' as const })),
        { declaration: () => undefined },
      )
    },
    notifyAwaiting: (sessionId, decision) => {
      log.warn(`session-recovery: Session ${sessionId} waits for a human before continuing (${decision.tools.join(', ')})`)
      return Promise.resolve()
    },
    resume: async (sessionId) => {
      const loops = ctx.get('agentLoop') as AgentLoopLike | undefined
      if (loops === undefined) throw new Error('session-recovery: Host does not provide agentLoop')
      await loops.resume(ctx, { resumeSessionId: SessionId(sessionId) })
    },
    inject: async (sessionId, batch) => {
      const controller = ctx.get('sessionController') as ControllerLike | undefined
      if (controller === undefined) throw new Error('session-recovery: Host does not provide sessionController')
      const resolved = await controller.resolveAgent(SessionId(sessionId))
      if (resolved.agent === undefined) throw new Error(`session-recovery: Session ${sessionId} has no live Agent`)
      resolved.agent.followup(createUserMessage({
        content: [{ type: 'text', text: batch.message.text }],
        source: { kind: 'recovery' },
      }))
      const sessions = ctx.get('sessions')
      if (sessions === undefined) throw new Error('session-recovery: Host does not provide sessions')
      const session = sessions.get(resolved.agent.session)
      if (session === undefined) throw new Error(`session-recovery: Session ${sessionId} is not loaded`)
      await sessions.flush(session)
    },
    log,
  }
}
