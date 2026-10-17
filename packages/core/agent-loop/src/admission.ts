/** Process-local admission owned by the concrete agent factory. */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One synchronous owner excludes relocation from accepted ordinary work. */
export class RelocationAdmission {
  private readonly operations = new Map<SessionId, number>()
  private readonly relocating = new Set<SessionId>()

  /** Hold ordinary work until its side effects are registered or settled.
   * @param id - exact identity accepting ordinary work.
   * @returns the idempotent admission release.
   */
  enter(id: SessionId): Disposable {
    if (this.relocating.has(id)) throw Object.assign(new Error('session relocation is in progress'), { code: 'session/relocate-busy' })
    this.operations.set(id, (this.operations.get(id) ?? 0) + 1)
    let released = false
    return { [Symbol.dispose]: () => {
      if (released) return
      released = true
      const count = (this.operations.get(id) ?? 1) - 1
      if (count === 0) this.operations.delete(id)
      else this.operations.set(id, count)
    } }
  }

  /** Exclude every new operation before the caller performs any await.
   * @param id - exact identity to replace.
   * @returns the exclusive reservation release.
   */
  reserve(id: SessionId): Disposable {
    if (this.relocating.has(id) || this.operations.has(id)) {
      throw Object.assign(new Error('session has admitted work'), { code: 'session/relocate-busy' })
    }
    this.relocating.add(id)
    return { [Symbol.dispose]: () => { this.relocating.delete(id) } }
  }
}
