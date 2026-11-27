import { describe, expect, it } from 'vitest'
import { classifyTurn, type ToolCallState, type ToolEffectRegistry } from '../src/policy.ts'

const registry = (declared: Record<string, boolean>): ToolEffectRegistry => ({
  declaration: tool => declared[tool] === undefined ? undefined : { mutating: declared[tool] },
})

const call = (tool: string, state: ToolCallState = 'completed') => ({ tool, state })

describe('classifyTurn', () => {
  it('allows a turn without tool calls', () => {
    expect(classifyTurn([], registry({}))).toEqual({ kind: 'auto' })
  })

  it('allows a turn of declared read-only calls, even unfinished ones', () => {
    const decision = classifyTurn([call('read'), call('grep', 'unfinished')], registry({ read: false, grep: false }))
    expect(decision).toEqual({ kind: 'auto' })
  })

  it('requires confirmation for a completed mutating call', () => {
    const decision = classifyTurn([call('write')], registry({ write: true }))
    expect(decision).toEqual({ kind: 'confirm', tools: ['write'], unfinished: false })
  })

  it('treats an undeclared tool as mutating', () => {
    const decision = classifyTurn([call('mystery')], registry({}))
    expect(decision).toEqual({ kind: 'confirm', tools: ['mystery'], unfinished: false })
  })

  it('marks an unfinished mutating call as unfinished', () => {
    const decision = classifyTurn([call('shell', 'unfinished')], registry({ shell: true }))
    expect(decision).toEqual({ kind: 'confirm', tools: ['shell'], unfinished: true })
  })

  it('collects blocking tools once, sorted', () => {
    const decision = classifyTurn(
      [call('zeta'), call('alpha', 'unfinished'), call('zeta'), call('read')],
      registry({ read: false }),
    )
    expect(decision).toEqual({ kind: 'confirm', tools: ['alpha', 'zeta'], unfinished: true })
  })

  it('ignores read-only calls next to blocking ones', () => {
    const decision = classifyTurn([call('read'), call('edit', 'unfinished')], registry({ read: false }))
    expect(decision).toEqual({ kind: 'confirm', tools: ['edit'], unfinished: true })
  })
})
