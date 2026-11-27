import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyUnit } from '../src/unit.ts'
import { RecoveryLedger } from '../src/ledger.ts'
import { createRecoveryPorts } from '../src/composition.ts'

const NOW = Date.parse('2026-11-25T09:00:00.000Z')

const event = (type: string, seq: number, data: object, time = NOW): SessionEvent =>
  ({ type, seq, time, data }) as SessionEvent

const openTurn = (): SessionEvent[] => [
  event('turn/start', 1, { turn: 1 }),
  event('tool/call', 2, { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' }),
]

const closedTurn = (): SessionEvent[] => [
  event('turn/start', 1, { turn: 1 }),
  event('turn/end', 2, { turn: 1, reason: 'completed' }),
]

const ctxWith = (services: Record<string, unknown>, options: { sessions?: false } = {}) => {
  const sessions = {
    get: vi.fn(() => ({ id: 's1' })),
    list: vi.fn(() => [] as { id: string }[]),
    flush: vi.fn(async () => {}),
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  const ctx = {
    get: (name: string) => name === 'sessions' ? (options.sessions === false ? undefined : sessions) : services[name],
    logger,
  }
  return { ctx: ctx as never, sessions, logger }
}

const ledger = () => new RecoveryLedger(new (class {
  read = async () => emptyUnit()
  write = async () => {}
})())

const persistence = (logs: Record<string, readonly SessionEvent[]>, listed = Object.keys(logs)) => ({
  list: vi.fn(async () => listed.map(id => ({ header: { id } }))),
  open: vi.fn(async (id: string) => ({
    read: vi.fn(async () => ({ events: logs[id] ?? [] })),
    close: vi.fn(async () => {}),
  })),
})

const input = () => ({ ledger: ledger(), bootId: 'boot-1', now: () => NOW, sleep: async () => {}, log: { info: vi.fn(), warn: vi.fn() } })

describe('createRecoveryPorts', () => {
  it('refuses a Host without session persistence', () => {
    const { ctx } = ctxWith({})
    expect(() => createRecoveryPorts(ctx, input())).toThrow('sessionPersistence')
  })

  it('refuses a journal scan without the Session store', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({ s1: openTurn() }) }, { sessions: false })
    await expect(createRecoveryPorts(ctx, input()).journal()).rejects.toThrow('does not provide sessions')
  })

  it('skips a Session whose stored log cannot be read', async () => {
    const persistence = { list: async () => [{ header: { id: 'broken' } }, { header: { id: 's1' } }], open: async (id: string) => {
      if (id === 'broken') throw new Error('corrupt log')
      return { read: async () => ({ events: openTurn() }), close: async () => {} }
    } }
    const { ctx } = ctxWith({ sessionPersistence: persistence })
    const ports = createRecoveryPorts(ctx, input())
    await expect(ports.journal()).resolves.toEqual([{ sessionId: 's1', turnStartSeq: 1, lastEventAt: new Date(NOW).toISOString(), toolCalls: ['write'] }])
    expect(ports.log.warn).toHaveBeenCalledWith(expect.stringContaining('skipped broken'))
  })

  it('reports an open turn as a candidate and skips a closed one', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({ s1: openTurn(), s2: closedTurn() }) })
    const ports = createRecoveryPorts(ctx, input())
    await expect(ports.journal()).resolves.toEqual([
      { sessionId: 's1', turnStartSeq: 1, lastEventAt: new Date(NOW).toISOString(), toolCalls: ['write'] },
    ])
  })

  it('skips a Session that is live in this Host', async () => {
    const { ctx, sessions } = ctxWith({ sessionPersistence: persistence({ s1: openTurn() }) })
    sessions.list.mockReturnValue([{ id: 's1' }] as never)
    await expect(createRecoveryPorts(ctx, input()).journal()).resolves.toEqual([])
  })

  it('reports no candidate when no stored session is interrupted', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({ s2: closedTurn() }) })
    await expect(createRecoveryPorts(ctx, input()).journal()).resolves.toEqual([])
  })

  it('reads model provider readiness from the llm service', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({}), llm: { listProviders: () => [{ id: 'p', name: 'P' }] } })
    await expect(createRecoveryPorts(ctx, input()).providerReady('s1')).resolves.toBe(true)
  })

  it('treats a missing llm service and an empty registry as not ready', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({}), llm: { listProviders: () => [] } })
    await expect(createRecoveryPorts(ctx, input()).providerReady('s1')).resolves.toBe(false)
    const bare = ctxWith({ sessionPersistence: persistence({}) })
    await expect(createRecoveryPorts(bare.ctx, input()).providerReady('s1')).resolves.toBe(false)
  })

  it('continues an interrupted turn that called no tool', async () => {
    const log = [event('turn/start', 1, { turn: 1 })]
    const { ctx } = ctxWith({ sessionPersistence: persistence({ s1: log }) })
    await expect(createRecoveryPorts(ctx, input()).classify('s1')).resolves.toMatchObject({ kind: 'auto' })
  })

  it('treats a log with no open turn as safe to continue', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({ s1: closedTurn() }) })
    await expect(createRecoveryPorts(ctx, input()).classify('s1')).resolves.toMatchObject({ kind: 'auto' })
  })

  it('asks for a human when the interrupted turn called a tool', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({ s1: openTurn() }) })
    await expect(createRecoveryPorts(ctx, input()).classify('s1')).resolves.toMatchObject({ kind: 'confirm' })
  })

  it('publishes the awaiting notice through the log sink', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({}) })
    const ports = createRecoveryPorts(ctx, input())
    await ports.notifyAwaiting('s1', { kind: 'confirm', tools: ['write'], unfinished: true })
    expect(ports.log.warn).toHaveBeenCalledWith(expect.stringContaining('waits for a human'))
  })

  it('resumes through the agent loop', async () => {
    const resume = vi.fn(async () => undefined)
    const { ctx } = ctxWith({ sessionPersistence: persistence({}), agentLoop: { resume } })
    await createRecoveryPorts(ctx, input()).resume('s1')
    expect(resume).toHaveBeenCalledWith(expect.anything(), { resumeSessionId: 's1' })
  })

  it('refuses to resume without an agent loop', async () => {
    const { ctx } = ctxWith({ sessionPersistence: persistence({}) })
    await expect(createRecoveryPorts(ctx, input()).resume('s1')).rejects.toThrow('agentLoop')
  })

  it('injects the continuation batch with the recovery source and flushes it', async () => {
    const followup = vi.fn()
    const { ctx, sessions } = ctxWith({
      sessionPersistence: persistence({}),
      sessionController: { resolveAgent: async () => ({ agent: { followup, session: 's1' } }) },
    })
    await createRecoveryPorts(ctx, input()).inject('s1', { message: { text: 'hello' } } as never)
    expect(sessions.flush).toHaveBeenCalledWith({ id: 's1' })
    expect(followup.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'recovery' } })
  })

  it('refuses to inject without the Session store', async () => {
    const { ctx } = ctxWith({
      sessionPersistence: persistence({}),
      sessionController: { resolveAgent: async () => ({ agent: { followup: vi.fn(), session: 's1' } }) },
    }, { sessions: false })
    await expect(createRecoveryPorts(ctx, input()).inject('s1', { message: { text: 'x' } } as never)).rejects.toThrow('does not provide sessions')
  })

  it('refuses to inject without activation, without an Agent, and without a loaded Session', async () => {
    const missingController = ctxWith({ sessionPersistence: persistence({}) })
    await expect(createRecoveryPorts(missingController.ctx, input()).inject('s1', { message: { text: 'x' } } as never)).rejects.toThrow('sessionController')
    const noAgent = ctxWith({ sessionPersistence: persistence({}), sessionController: { resolveAgent: async () => ({}) } })
    await expect(createRecoveryPorts(noAgent.ctx, input()).inject('s1', { message: { text: 'x' } } as never)).rejects.toThrow('no live Agent')
    const noSession = ctxWith({ sessionPersistence: persistence({}), sessionController: { resolveAgent: async () => ({ agent: { followup: vi.fn(), session: 'gone' } }) } })
    noSession.sessions.get.mockReturnValue(undefined as never)
    await expect(createRecoveryPorts(noSession.ctx, input()).inject('s1', { message: { text: 'x' } } as never)).rejects.toThrow('not loaded')
  })

  it('defaults the clock, the delay and the log sinks', async () => {
    const { ctx, logger } = ctxWith({ sessionPersistence: persistence({}) })
    const ports = createRecoveryPorts(ctx, { ledger: ledger(), bootId: 'boot-1' })
    expect(typeof ports.now()).toBe('number')
    await expect(ports.sleep(0)).resolves.toBeUndefined()
    ports.log.info('note')
    ports.log.warn('problem')
    expect(logger.info).toHaveBeenCalledWith('note')
    expect(logger.warn).toHaveBeenCalledWith('problem')
  })
})
