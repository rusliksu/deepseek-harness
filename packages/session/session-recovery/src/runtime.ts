/** Orchestration of one recovery pass: eligibility, safety policy, provider wait, injection. */
import { RecoveryLedger } from './ledger.ts'
import type { InterruptionReason, InterruptionStatus } from './unit.ts'
import { selectCandidates, type JournalCandidate } from './candidates.ts'
import { buildInjection, type RecoveryInjection } from './inject.ts'
import type { RecoveryDecision } from './policy.ts'

/** Settings that bound one pass. */
export interface RecoverySettings {
  /** Whether automatic continuation runs at all. */
  readonly enabled: boolean
  /** Maximum number of injections per pass. */
  readonly maxSessions: number
  /** Maximum age of an interruption in hours. */
  readonly maxAgeHours: number
  /** Pause between two injections in milliseconds. */
  readonly staggerMs: number
  /** Longest wait for a model provider before the candidate fails. */
  readonly providerWaitMs: number
  /** Delay between two provider probes in milliseconds. */
  readonly providerPollMs: number
  /** Maximum repeat injections per interruption. */
  readonly attempts: number
  /**
   * Whether a turn that touched a mutating tool waits for a human. Turning this
   * off lets the pass continue such a turn on its own.
   */
  readonly requireConfirmationForWriteTools: boolean
  /**
   * Whether an interrupted turn that called no tool continues without a per-Session
   * opt-in. A turn whose tool calls are unknown still needs the opt-in.
   */
  readonly continueWithoutTools: boolean
}

/** Host capabilities the runtime calls; the composition supplies them. */
export interface RecoveryPorts {
  /** Durable outcomes. */
  readonly ledger: RecoveryLedger
  /** Boot that runs this pass. */
  readonly bootId: string
  /** Current wall time in milliseconds. */
  readonly now: () => number
  /** Delay primitive. */
  readonly sleep: (ms: number) => Promise<void>
  /** Candidates read from Session logs. */
  readonly journal: () => Promise<readonly JournalCandidate[]>
  /** Whether the target Session's model provider is registered. */
  readonly providerReady: (sessionId: string) => Promise<boolean>
  /** Decide whether the interrupted turn may continue without a human. */
  readonly classify: (sessionId: string) => Promise<RecoveryDecision>
  /** Publish the request for a human decision in the Session. */
  readonly notifyAwaiting: (sessionId: string, decision: Extract<RecoveryDecision, { kind: 'confirm' }>) => Promise<void>
  /** Close the open turn of one Session through the normal resume path. */
  readonly resume: (sessionId: string) => Promise<void>
  /** Append the continuation batch to one Session. */
  readonly inject: (sessionId: string, batch: RecoveryInjection) => Promise<void>
  /** Diagnostic log sink. */
  readonly log: { info: (message: string) => void; warn: (message: string) => void }
}

/** Outcome of one candidate. */
export interface RecoveryOutcome {
  /** Session id. */
  readonly sessionId: string
  /** Final status of the record. */
  readonly status: InterruptionStatus
  /** Reason when the candidate did not continue. */
  readonly reason?: InterruptionReason
}

/** Outcome of one pass. */
export interface RecoveryReport {
  /** Whether the pass ran. */
  readonly ran: boolean
  /** Why the pass did not run. */
  readonly skipped?: 'disabled'
  /** Injected continuations. */
  readonly injected: number
  /** Candidates left for a later pass or a human. */
  readonly failed: number
  /** Candidates that produced no work. */
  readonly skippedCount: number
  /** Per-candidate outcomes. */
  readonly outcomes: readonly RecoveryOutcome[]
}

/** Typed refusal when a human continuation is requested for a record that does not wait for one. */
export class RecoveryConfirmationError extends Error {
  /** @param sessionId - Session whose record is not awaiting confirmation. */
  constructor(readonly sessionId: string) {
    super(`recovery: "${sessionId}" is not awaiting confirmation`)
    this.name = 'RecoveryConfirmationError'
  }
}

/**
 * Run the recovery pass for one boot.
 *
 * The order is the contract: a record is marked `resuming` before the Session is
 * resumed, because resuming closes the open turn and erases the journal signal;
 * a turn that touched a mutating tool waits for a human instead of continuing;
 * the message and the turn start are appended in one batch; the record becomes
 * `resumed` only after that batch lands.
 */
export class RecoveryRuntime {
  /**
   * @param ports - Host capabilities this pass uses.
   * @param settings - Bounds of the pass.
   */
  constructor(private readonly ports: RecoveryPorts, private readonly settings: RecoverySettings) {}

  /**
   * Execute one automatic pass.
   * @returns Report of every candidate this pass touched.
   */
  async run(): Promise<RecoveryReport> {
    if (!this.settings.enabled) return { ran: false, skipped: 'disabled', injected: 0, failed: 0, skippedCount: 0, outcomes: [] }
    const [journal, ledgerRows] = await Promise.all([this.ports.journal(), this.ports.ledger.list()])
    const policies = new Set<string>()
    for (const sessionId of new Set([...journal.map(row => row.sessionId), ...ledgerRows.map(row => row.sessionId)])) {
      if (await this.ports.ledger.getPolicy(sessionId) !== undefined) policies.add(sessionId)
    }
    const candidates = selectCandidates({
      journal,
      ledger: ledgerRows.filter(row => row.status === 'resuming' || row.status === 'failed'),
      autoContinue: policies,
      continueWithoutTools: this.settings.continueWithoutTools,
      now: this.ports.now(),
      maxAgeHours: this.settings.maxAgeHours,
    })
    const outcomes: RecoveryOutcome[] = []
    let injected = 0
    for (const candidate of candidates) {
      if (injected >= this.settings.maxSessions) {
        outcomes.push({ sessionId: candidate.sessionId, status: 'skipped', reason: 'limit' })
        continue
      }
      if (injected > 0) await this.ports.sleep(this.settings.staggerMs)
      const outcome = await this.continueOne(candidate.sessionId, candidate.turnStartSeq, false)
      outcomes.push(outcome)
      if (outcome.status === 'resumed') injected += 1
    }
    return {
      ran: true,
      injected,
      failed: outcomes.filter(outcome => outcome.status === 'failed').length,
      skippedCount: outcomes.filter(outcome => outcome.status === 'skipped' || outcome.status === 'awaiting-confirmation').length,
      outcomes,
    }
  }

  /**
   * Continue one interruption after a human confirmed it.
   * @param sessionId - Session id.
   * @param turnStartSeq - Sequence number of the open turn.
   * @returns Outcome of this candidate.
   */
  async continueConfirmed(sessionId: string, turnStartSeq: number): Promise<RecoveryOutcome> {
    const row = await this.ports.ledger.get(sessionId, turnStartSeq)
    if (row === undefined || row.status !== 'awaiting-confirmation') throw new RecoveryConfirmationError(sessionId)
    return this.continueOne(sessionId, turnStartSeq, true)
  }

  /**
   * Continue one interruption through the whole ordered protocol.
   * @param sessionId - Session id.
   * @param turnStartSeq - Sequence number of the open turn.
   * @param confirmed - Whether a human already accepted the turn's tool effects.
   * @returns Outcome of this candidate.
   */
  private async continueOne(sessionId: string, turnStartSeq: number, confirmed: boolean): Promise<RecoveryOutcome> {
    const existing = await this.ports.ledger.get(sessionId, turnStartSeq)
    if (existing !== undefined && existing.attempts >= this.settings.attempts) {
      await this.ports.ledger.mark(sessionId, turnStartSeq, 'skipped', { reason: 'stale', detail: 'attempts exhausted' })
      return { sessionId, status: 'skipped', reason: 'stale' }
    }
    if (existing === undefined) await this.ports.ledger.begin({ sessionId, turnStartSeq, bootId: this.ports.bootId })
    else if (existing.status === 'resuming') await this.ports.ledger.noteAttempt(sessionId, turnStartSeq)
    else await this.ports.ledger.mark(sessionId, turnStartSeq, 'resuming')
    if (!confirmed) {
      const decision = await this.ports.classify(sessionId)
      if (decision.kind === 'confirm' && this.settings.requireConfirmationForWriteTools) {
        await this.ports.ledger.mark(sessionId, turnStartSeq, 'awaiting-confirmation', { detail: `tools: ${decision.tools.join(', ')}` })
        await this.ports.notifyAwaiting(sessionId, decision)
        this.ports.log.info(`recovery: "${sessionId}" waits for a human because of ${decision.tools.join(', ')}`)
        return { sessionId, status: 'awaiting-confirmation' }
      }
    }
    const ready = await this.waitForProvider(sessionId)
    if (!ready) {
      await this.ports.ledger.mark(sessionId, turnStartSeq, 'failed', { reason: 'provider-unavailable' })
      this.ports.log.warn(`recovery: provider unavailable for "${sessionId}"; leaving the turn for a later pass`)
      return { sessionId, status: 'failed', reason: 'provider-unavailable' }
    }
    await this.ports.resume(sessionId)
    await this.ports.inject(sessionId, buildInjection())
    await this.ports.ledger.mark(sessionId, turnStartSeq, 'resumed')
    this.ports.log.info(`recovery: continued "${sessionId}" after restart`)
    return { sessionId, status: 'resumed' }
  }

  /**
   * Wait for the target's model provider within the configured bound.
   * @param sessionId - Session id.
   * @returns Whether the provider became available.
   */
  private async waitForProvider(sessionId: string): Promise<boolean> {
    const deadline = this.ports.now() + this.settings.providerWaitMs
    for (;;) {
      if (await this.ports.providerReady(sessionId)) return true
      if (this.ports.now() >= deadline) return false
      await this.ports.sleep(this.settings.providerPollMs)
    }
  }
}
