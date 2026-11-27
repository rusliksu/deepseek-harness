/** Host service that owns the recovery ledger and runs one pass per start. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RecoveryLedger } from './ledger.ts'
import { FileRecoveryStore } from './file-store.ts'
import type { RecoveryPorts, RecoveryReport, RecoverySettings } from './runtime.ts'
import { RecoveryRuntime } from './runtime.ts'

/** Deployment configuration of the recovery service. */
export interface Config {
  /** Whether an automatic pass runs at all; omission defaults to false. */
  enabled?: boolean
  /** Absolute path of the recovery unit file; omission defaults to the home storage directory. */
  ledgerPath?: string
  /** Maximum injections per pass; omission defaults to 3. */
  maxSessions?: number
  /** Maximum age of an interruption in hours; omission defaults to 12. */
  maxAgeHours?: number
  /** Pause between two injections in milliseconds; omission defaults to 15000. */
  staggerMs?: number
  /** Longest wait for a model provider in milliseconds; omission defaults to 60000. */
  providerWaitMs?: number
  /** Delay between provider probes in milliseconds; omission defaults to 1000. */
  providerPollMs?: number
  /** Maximum repeat injections per interruption; omission defaults to 2. */
  attempts?: number
  /** Whether a turn that touched a mutating tool waits for a human; omission defaults to true. */
  requireConfirmationForWriteTools?: boolean
  /** Whether a turn that called no tool continues without a per-Session opt-in; omission defaults to true. */
  continueWithoutTools?: boolean
}

/** Defaults applied when the deployment states nothing. */
export const DEFAULTS = {
  enabled: false,
  maxSessions: 3,
  maxAgeHours: 12,
  staggerMs: 15_000,
  providerWaitMs: 60_000,
  providerPollMs: 1_000,
  attempts: 2,
  requireConfirmationForWriteTools: true,
  continueWithoutTools: true,
} as const

/** Validated deployment configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  ledgerPath: z.string(),
  maxSessions: z.number().default(DEFAULTS.maxSessions),
  maxAgeHours: z.number().default(DEFAULTS.maxAgeHours),
  staggerMs: z.number().default(DEFAULTS.staggerMs),
  providerWaitMs: z.number().default(DEFAULTS.providerWaitMs),
  providerPollMs: z.number().default(DEFAULTS.providerPollMs),
  attempts: z.number().default(DEFAULTS.attempts),
  requireConfirmationForWriteTools: z.boolean().default(DEFAULTS.requireConfirmationForWriteTools),
  continueWithoutTools: z.boolean().default(DEFAULTS.continueWithoutTools),
})

/**
 * Recovery service: one ledger per host and one pass per call.
 *
 * The host composition supplies the ports (Session log scan, resume, injection,
 * provider readiness, notifications) because those capabilities belong to the
 * packages that own them, not to this one.
 */
export default class SessionRecovery extends Service {
  static Config: z<Config> = Config

  /** Ledger this service owns. */
  readonly ledger: RecoveryLedger
  private readonly settings: RecoverySettings
  private readonly ledgerPath: string

  /**
   * @param ctx - Owner context.
   * @param config - Validated deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionRecovery')
    this.ledgerPath = config.ledgerPath ?? 'recovery.json'
    this.ledger = new RecoveryLedger(new FileRecoveryStore(this.ledgerPath))
    this.settings = {
      enabled: config.enabled ?? DEFAULTS.enabled,
      maxSessions: config.maxSessions ?? DEFAULTS.maxSessions,
      maxAgeHours: config.maxAgeHours ?? DEFAULTS.maxAgeHours,
      staggerMs: config.staggerMs ?? DEFAULTS.staggerMs,
      providerWaitMs: config.providerWaitMs ?? DEFAULTS.providerWaitMs,
      providerPollMs: config.providerPollMs ?? DEFAULTS.providerPollMs,
      attempts: config.attempts ?? DEFAULTS.attempts,
      requireConfirmationForWriteTools: config.requireConfirmationForWriteTools ?? DEFAULTS.requireConfirmationForWriteTools,
      continueWithoutTools: config.continueWithoutTools ?? DEFAULTS.continueWithoutTools,
    }
  }

  /** @returns Absolute path of the recovery unit this service owns. */
  get unitPath(): string {
    return this.ledgerPath
  }

  /**
   * Run one recovery pass with the ports the composition supplies.
   * @param ports - Host capabilities for this pass.
   * @returns Report of the pass.
   */
  async run(ports: Omit<RecoveryPorts, 'ledger' | 'bootId'> & { bootId: string }): Promise<RecoveryReport> {
    return new RecoveryRuntime({ ...ports, ledger: this.ledger }, this.settings).run()
  }

  /** @returns Settings this service resolved from its configuration. */
  get settingsView(): RecoverySettings {
    return this.settings
  }
}
