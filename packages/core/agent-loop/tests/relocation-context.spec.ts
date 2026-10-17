import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { relocationFixture } from './relocation-fixture.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

it('uses destination instructions, skills and filesystem context without rewriting the source transcript', async () => {
  const f = await relocationFixture('none', false)
  for (const { cwd, marker } of [{ cwd: f.a, marker: 'source-only' }, { cwd: f.b, marker: 'destination-only' }]) {
    await mkdir(join(cwd, '.git'))
    await writeFile(join(cwd, 'AGENTS.md'), `Instruction ${marker}\n`)
    const skill = join(cwd, '.agents', 'skills', marker)
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), `---\nname: ${marker}\ndescription: ${marker}\n---\n${marker}\n`)
    await writeFile(join(cwd, 'context.txt'), marker)
  }
  await f.ctx.plugin(LocalFileSystem)
  await f.ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  const originalPolicy = f.ctx.sandboxPolicy.resolve({ session: f.handle.agent.session })
  expect(originalPolicy.workspaceRoot).toBe(f.a)
  await f.ctx.plugin(AgentInstructions, { dshHome: join(f.root, 'home'), maxBytes: 65536 })
  await f.ctx.plugin(SkillRegistry)
  await f.ctx.plugin(SkillFileSystem, {
    dshHome: join(f.root, 'home'), agentsHome: join(f.root, 'agents'), watch: false,
  })
  const adapter = new MockAdapter([textResponse('source answer'), textResponse('destination answer')])
  f.ctx.llm.registerAdapter(['unchanged'], adapter)
  f.handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read current instructions.' }] }))
  await f.handle.agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Instruction source-only')
  await f.ctx.sessionPersistence.flush()
  const before = await f.ctx.sessionPersistence.open(f.id, 'read')
  const prefix = (await before.read()).events
  await before.close()
  const snapshot = await f.ctx.sessionPersistence.stat(f.id)
  if (snapshot === undefined) throw new Error('missing source session')
  await f.ctx.workspaceRegistry.relocateSession({ ...f.request, expectedRevision: snapshot.revision }, (request, callbacks) =>
    f.ctx.agentLoop.relocate(f.ctx, request, {}, callbacks))
  expect(adapter.requests).toHaveLength(1)
  const current = f.ctx.agents.get(f.id)
  if (current === undefined) throw new Error('missing relocated agent')
  const cwd = current.session.header.cwd
  if (cwd === undefined) throw new Error('missing destination directory')
  expect(f.ctx.sandboxPolicy.resolve({ session: current.session }).workspaceRoot).toBe(f.b)
  expect(originalPolicy.workspaceRoot).toBe(f.a)
  const skills = await f.ctx.skills.list({ cwd })
  expect(skills.map(skill => skill.name)).toEqual(['destination-only'])
  const target = await f.ctx.fs.resolve('context.txt', { cwd })
  expect(await f.ctx.fs.readText(target)).toBe('destination-only')
  current.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read current instructions again.' }] }))
  await current.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Instruction destination-only')
  const after = await f.ctx.sessionPersistence.open(f.id, 'read')
  try { expect((await after.read()).events.slice(0, prefix.length)).toEqual(prefix) }
  finally { await after.close() }
})
