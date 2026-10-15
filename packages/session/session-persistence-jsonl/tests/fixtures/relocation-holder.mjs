/** Source-mode child owns a real write lease until its parent terminates it. */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, cwd, id] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const handle = await ctx.sessionPersistence.create({
  id, cwd, version: SESSION_FORMAT_VERSION, createdAt: 1000, isSeeded: false, delegationDepth: 0,
})
await handle.append([
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
])
process.stdout.write('holding\n')
setInterval(() => {}, 1000)
