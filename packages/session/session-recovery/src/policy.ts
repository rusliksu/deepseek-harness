/** Classification of the interrupted turn's tool calls, so a pass never repeats a world-changing effect blindly. */

/** How far a tool call got before the process died. */
export type ToolCallState = 'completed' | 'unfinished'

/** One tool call recorded in the interrupted turn. */
export interface TurnToolCall {
  /** Tool name as the log recorded it. */
  readonly tool: string
  /** Whether the call has a recorded result. */
  readonly state: ToolCallState
}

/** Declared effect of one tool. */
export interface ToolEffectDeclaration {
  /**
   * Whether the tool changes state outside the conversation. A missing
   * declaration is treated as mutating.
   */
  readonly mutating?: boolean
}

/** Registry of declared tool effects, supplied by the composition. */
export interface ToolEffectRegistry {
  /**
   * Read the declaration of one tool.
   * @param tool - Tool name.
   * @returns Declaration, or undefined when the tool declares nothing.
   */
  declaration(tool: string): ToolEffectDeclaration | undefined
}

/** What a pass may do with the interrupted turn. */
export type RecoveryDecision =
  | { readonly kind: 'auto' }
  | {
    /** A human must confirm before the turn continues. */
    readonly kind: 'confirm'
    /** Tools whose effect may already exist, sorted and unique. */
    readonly tools: readonly string[]
    /** Whether at least one of them has no recorded result. */
    readonly unfinished: boolean
  }

/**
 * Decide whether a turn may continue without a human.
 *
 * A completed mutating call does not prove its effect is safe to repeat: the
 * record only says it ran. An unfinished call has an unknown outcome. Both
 * block an automatic continuation. Only calls declared read-only, and the
 * absence of calls, allow it.
 * @param calls - Tool calls of the interrupted turn, in log order.
 * @param registry - Declared tool effects.
 * @returns Automatic or confirmation decision.
 */
export function classifyTurn(calls: readonly TurnToolCall[], registry: ToolEffectRegistry): RecoveryDecision {
  const blocking = new Set<string>()
  let unfinished = false
  for (const call of calls) {
    if (registry.declaration(call.tool)?.mutating === false) continue
    blocking.add(call.tool)
    if (call.state === 'unfinished') unfinished = true
  }
  if (blocking.size === 0) return { kind: 'auto' }
  return { kind: 'confirm', tools: [...blocking].sort(), unfinished }
}
