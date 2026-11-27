/**
 * Catch-up policy for deliveries missed while the host was not running.
 *
 * The runtime already coalesces a missed series into one delivery. This module
 * decides whether that delivery is still wanted, how it is recorded, and when a
 * delivery waits for a model provider instead of failing in the target Session.
 * @module @deepseek-ai/dsh-schedule/catch-up
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Task identity. */
export type CatchUpTaskId = Branded<'ScheduleTaskId'>

/** Why a missed occurrence produces no delivery. */
export type CatchUpSkipReason = 'stale'

/** Whether a missed occurrence is still worth delivering. */
export type CatchUpDecision =
  | { readonly kind: 'deliver' }
  | { readonly kind: 'skip'; readonly reason: CatchUpSkipReason }

/** Input of {@link resolveCatchUp}. */
export interface CatchUpInput {
  /** Planned occurrence that was missed, in milliseconds. */
  readonly scheduledAt: number
  /** Current time in milliseconds. */
  readonly now: number
  /** Whether catch-up delivery is enabled at all. */
  readonly enabled: boolean
  /** Maximum age of a missed occurrence in hours. */
  readonly maxStaleHours: number
  /**
   * Operating-system boot time in milliseconds. When known, the age bound applies
   * only to occurrences that predate it; an occurrence after the boot was late
   * while the host was already running and keeps its place in the series.
   */
  readonly bootTimeMs?: number
}

/**
 * Decide whether a missed occurrence is delivered.
 *
 * A disabled policy delivers without an age rule. With a known boot time, an
 * occurrence after the boot was late while the host was already running, so it
 * keeps its place; only occurrences that predate the boot are compared with the
 * configured age bound, so a host that was off for a week does not replay a
 * Monday digest on Friday.
 * @param input - Occurrence time and the configured bounds.
 * @returns Deliver or skip decision.
 */
export function resolveCatchUp(input: CatchUpInput): CatchUpDecision {
  if (!input.enabled) return { kind: 'deliver' }
  if (input.bootTimeMs === undefined || input.scheduledAt > input.bootTimeMs) return { kind: 'deliver' }
  const lagMs = input.now - input.scheduledAt
  if (lagMs > input.maxStaleHours * 3_600_000) return { kind: 'skip', reason: 'stale' }
  return { kind: 'deliver' }
}

/**
 * Deduplication key of one occurrence.
 *
 * The key is fixed from the occurrence the host selected at first detection, so
 * a later pass over a shifted "latest missed" occurrence cannot deliver the same
 * work twice.
 * @param taskId - Task identity.
 * @param scheduledAt - Planned occurrence in milliseconds.
 * @returns Stable key for this occurrence.
 */
export function occurrenceKey(taskId: CatchUpTaskId, scheduledAt: number): string {
  return `${taskId}@${new Date(scheduledAt).toISOString()}`
}

/** How a late delivery is recorded. */
export interface CatchUpReceipt {
  /** Planned occurrence, ISO timestamp. */
  readonly scheduledAt: string
  /** Actual delivery time, ISO timestamp. */
  readonly deliveredAt: string
  /** Delay between the planned occurrence and the delivery. */
  readonly lagMs: number
}

/**
 * Build the late-delivery record for one delivery.
 * @param scheduledAt - Planned occurrence in milliseconds.
 * @param deliveredAt - Actual delivery time in milliseconds.
 * @returns Record with the delay.
 */
export function catchUpReceipt(scheduledAt: number, deliveredAt: number): CatchUpReceipt {
  return {
    scheduledAt: new Date(scheduledAt).toISOString(),
    deliveredAt: new Date(deliveredAt).toISOString(),
    lagMs: deliveredAt - scheduledAt,
  }
}

/** Input of {@link waitForModelProvider}. */
export interface ProviderWaitInput {
  /** Provider route key the target Session needs. */
  readonly provider: string
  /** Whether that route is registered in this Host. */
  readonly registered: () => boolean
  /** Current time in milliseconds. */
  readonly now: () => number
  /** Delay primitive. */
  readonly sleep: (ms: number) => Promise<void>
  /** Longest wait before the delivery is refused. */
  readonly limitMs: number
  /** Delay between two probes. */
  readonly pollMs: number
}

/**
 * Wait until the target's model provider is registered.
 * @param input - Provider key, registration probe, clock, and bounds.
 * @returns True when the provider registered inside the bound, false when the wait expired.
 */
export async function waitForModelProvider(input: ProviderWaitInput): Promise<boolean> {
  const deadline = input.now() + input.limitMs
  for (;;) {
    if (input.registered()) return true
    if (input.now() >= deadline) return false
    await input.sleep(input.pollMs)
  }
}

/**
 * Whether a key was already delivered.
 * @param key - Occurrence key.
 * @param delivered - Keys the task already records.
 * @returns True when the occurrence must not be injected again.
 */
export function isDuplicateDelivery(key: string, delivered: readonly string[]): boolean {
  return delivered.includes(key)
}

/** Whether a delivery may proceed, wait, or give up on its model provider. */
export type ProviderWaitDecision = 'deliver' | 'wait' | 'give-up'

/**
 * Decide one step of the provider wait.
 * @param ready - Whether the target provider is registered.
 * @param startedAt - When the wait started, in milliseconds.
 * @param now - Current time in milliseconds.
 * @param limitMs - Longest wait the deployment accepts.
 * @returns Deliver when ready, wait inside the bound, give up past it.
 */
export function providerWaitStep(ready: boolean, startedAt: number, now: number, limitMs: number): ProviderWaitDecision {
  if (ready) return 'deliver'
  return now - startedAt >= limitMs ? 'give-up' : 'wait'
}
