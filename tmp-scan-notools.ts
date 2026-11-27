import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { interruptedTurns } from './packages/session/session-recovery/src/journal.ts'

const root = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const files: string[] = []
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.jsonl.zstd')) files.push(full)
  }
}
walk(root)
const found: { id: string; tools: number; at: number; turn: number }[] = []
let failed = 0
for (const file of files) {
  let text: string
  try { text = zstdDecompressSync(readFileSync(file)).toString('utf8') } catch { failed += 1; continue }
  const events = text.trim().split('\n').slice(1).map(line => JSON.parse(line) as never)
  const tail = interruptedTurns(events as never).at(-1)
  if (tail === undefined) continue
  found.push({ id: file.split(/[\\/]/).at(-2) ?? '?', tools: tail.toolCalls.length, at: tail.lastEventTime, turn: tail.turn })
}
found.sort((a, b) => b.at - a.at)
console.log('files', files.length, 'decode_failed', failed)
console.log('interrupted', found.length, 'without_tools', found.filter(entry => entry.tools === 0).length)
for (const entry of found.filter(entry => entry.tools === 0).slice(0, 6)) console.log(entry.id, new Date(entry.at).toISOString(), 'turn', entry.turn)
