import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { interruptedTurns } from '../src/journal.ts'

const event = (type: string, seq: number, time: number, data: object): SessionEvent =>
  ({ type, seq, time, data }) as SessionEvent

describe('interruptedTurns', () => {
  it('reports nothing for an empty log', () => {
    expect(interruptedTurns([])).toEqual([])
  })

  it('reports nothing when every turn ended', () => {
    const log = [event('turn/start', 1, 10, { turn: 1 }), event('turn/end', 2, 20, { turn: 1, reason: 'completed' })]
    expect(interruptedTurns(log)).toEqual([])
  })

  it('reports the open turn with its tool calls and last event time', () => {
    const log = [
      event('turn/start', 1, 10, { turn: 1 }),
      event('turn/end', 2, 20, { turn: 1, reason: 'completed' }),
      event('turn/start', 3, 30, { turn: 2 }),
      event('tool/call', 4, 40, { turn: 2, step: 1, callId: 'c1', name: 'write', arguments: '{}' }),
      event('tool/call', 5, 50, { turn: 2, step: 1, callId: 'c2', name: 'run_code', arguments: '{}' }),
    ]
    expect(interruptedTurns(log)).toEqual([
      { turn: 2, turnStartSeq: 3, lastEventTime: 50, toolCalls: ['write', 'run_code'] },
    ])
  })

  it('ignores tool calls from an earlier, finished turn', () => {
    const log = [
      event('turn/start', 1, 10, { turn: 1 }),
      event('tool/call', 2, 15, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
      event('turn/end', 3, 20, { turn: 1, reason: 'completed' }),
      event('turn/start', 4, 30, { turn: 2 }),
      event('assistant/message', 5, 40, { turn: 2 }),
    ]
    expect(interruptedTurns(log)).toEqual([{ turn: 2, turnStartSeq: 4, lastEventTime: 40, toolCalls: [] }])
  })

  it('reports more than one open turn, oldest first', () => {
    const log = [event('turn/start', 1, 10, { turn: 1 }), event('turn/start', 2, 20, { turn: 2 })]
    expect(interruptedTurns(log).map(entry => entry.turn)).toEqual([1, 2])
  })
})
