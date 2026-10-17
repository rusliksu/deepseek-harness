import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import AgentLoop from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('relocation admission', () => {
  it('retired incarnations cannot accept direct input, inbox mutations, or maintenance', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({ sessionId: SessionId('retired') })
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'late' }] })
    await handle.dispose()
    expect(() =>{  handle.agent.inject(message) }).toThrow(/retired/)
    expect(() =>{  handle.agent.inbox.append('next-turn', message) }).toThrow(/retired/)
    expect(() => handle.agent.runMaintenance(async () => {})).toThrow(/retired/)
    const replacement = await ctx.agents.create({ sessionId: handle.agent.id })
    replacement.agent.inject(message)
    expect(replacement.agent.inbox.nextStep).toHaveLength(1)
    expect(() =>{  handle.agent.inbox.clear() }).toThrow(/retired/)
    expect(replacement.agent.inbox.nextStep).toHaveLength(1)
  })

  it('ordinary operations retain admission across asynchronous side effects', async () => {
    const ctx = await harness()
    const id = SessionId('admitted')
    const admission = ctx.bail('agent/admit-operation', { sessionId: id })
    expect(admission).toBeDefined()
    admission?.[Symbol.dispose]()
  })
})
