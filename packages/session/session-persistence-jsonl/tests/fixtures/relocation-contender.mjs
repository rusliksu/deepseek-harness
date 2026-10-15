/** Source-mode child probes the real kernel lease during each writer handoff. */
import { Context } from '@deepseek-ai/cordis'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, id] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
process.on('message', async () => {
  try {
    const writer = await ctx.sessionPersistence.open(id, 'write')
    await writer.close()
    process.send?.({ status: 'acquired' })
  } catch (error) {
    process.send?.({ status: error instanceof SessionAlreadyOwnedError ? 'busy' : 'error',
      ...(error instanceof SessionAlreadyOwnedError ? {} : { message: String(error) }) })
  }
})
process.send?.({ status: 'ready' })
