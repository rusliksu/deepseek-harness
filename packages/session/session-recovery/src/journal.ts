/** Session-log reading that names the turns a crash left open. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One turn that started and never ended in the stored log. */
export interface InterruptedTurn {
  /** Turn number the log opened. */
  readonly turn: number
  /** Sequence number of the opening `turn/start` event. */
  readonly turnStartSeq: number
  /** Time of the newest event in the log, in epoch milliseconds. */
  readonly lastEventTime: number
  /** Tool names the open turn called, in call order. */
  readonly toolCalls: readonly string[]
}

/**
 * Read the turns a log left open.
 *
 * A turn counts as interrupted when its `turn/start` has no `turn/end` with the
 * same turn number. A durable log carries at most one such turn, but the scan
 * reports every one it finds so a repaired log cannot hide a second tail.
 * @param events - Complete stored event log of one Session.
 * @returns Interrupted turns in log order, newest last.
 */
export function interruptedTurns(events: readonly SessionEvent[]): InterruptedTurn[] {
  const starts = new Map<number, number>()
  let lastEventTime = 0
  for (const event of events) {
    lastEventTime = event.time
    if (event.type === 'turn/start') starts.set(event.data.turn, event.seq)
    if (event.type === 'turn/end') starts.delete(event.data.turn)
  }
  return [...starts].map(([turn, turnStartSeq]) => ({
    turn,
    turnStartSeq,
    lastEventTime,
    toolCalls: events.flatMap(event =>
      event.type === 'tool/call' && event.data.turn === turn ? [event.data.name] : [],
    ),
  }))
}
