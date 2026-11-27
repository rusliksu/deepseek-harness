import { describe, expect, it } from 'vitest'
import { RECOVERY_MESSAGE_TEXT, buildInjection } from '../src/inject.ts'
describe('buildInjection', () => {
  it('carries the recovery source, the pinned text, and the turn start', () => {
    const batch = buildInjection()
    expect(batch.startsTurn).toBe(true)
    expect(batch.message.source).toEqual({ kind: 'recovery' })
    expect(batch.message.text).toBe(RECOVERY_MESSAGE_TEXT)
    expect(RECOVERY_MESSAGE_TEXT).toContain('Не повторяй побочные эффекты')
  })
})
