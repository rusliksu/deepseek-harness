/** Message source declared by the recovery producer. */

/**
 * A continuation message carries its own source kind, so the client can label
 * it as recovery instead of a human message. The map is merge-extensible;
 * consumers that do not know the kind fall through to the generic trigger.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    recovery: { readonly kind: 'recovery' }
  }
}

export {}
