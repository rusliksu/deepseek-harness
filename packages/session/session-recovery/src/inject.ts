/** The continuation message and the atomic batch that carries it. */
/** Source kind of a continuation message; a merge-extensible addition to the message source map. */
export interface RecoveryMessageSource {
  /** Discriminant of the recovery producer. */
  readonly kind: 'recovery'
}

/** Message injected into a Session whose turn was interrupted. */
export interface RecoveryMessage {
  /** Where the message came from. */
  readonly source: RecoveryMessageSource
  /** Model-facing text. */
  readonly text: string
}

/** One journal batch that announces the message and starts the turn. */
export interface RecoveryInjection {
  /** Message the model sees. */
  readonly message: RecoveryMessage
  /** The batch also opens the turn, so a message never sits without one. */
  readonly startsTurn: true
}

/** Text the model reads when a turn resumes after a restart. */
export const RECOVERY_MESSAGE_TEXT =
  'Предыдущий ход был прерван завершением работы компьютера. Проверь фактическое состояние '
  + '(файлы, git status, результат последних команд) прежде чем повторять любые действия, которые что-то меняли. '
  + 'Не повторяй побочные эффекты, которые уже произошли. Продолжай с того места, где остановился, и заверши задачу.'

/**
 * Build the continuation batch.
 * @returns Message and turn start to append in one batch.
 */
export function buildInjection(): RecoveryInjection {
  return { message: { source: { kind: 'recovery' }, text: RECOVERY_MESSAGE_TEXT }, startsTurn: true }
}
