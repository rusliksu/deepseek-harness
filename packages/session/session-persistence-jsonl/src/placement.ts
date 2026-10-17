/** Versioned working-directory metadata beside immutable session generations. */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, opendir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionRelocationRequest, SessionRelocationResult } from '@deepseek-ai/dsh-session-persistence'

const PLACEMENT_FILE = 'cwd-placement.json'
const REQUIRED_FILE = 'cwd-placement.required.json'
const OPERATIONS_DIR = 'cwd-relocations'
const PENDING_FILE = 'cwd-relocation.pending.json'
const MAX_METADATA_BYTES = 262144
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** A stable physical origin and the currently selected logical directory. */
export interface SessionPlacement {
  readonly schemaVersion: 1
  readonly sessionId: SessionId
  readonly originCwd: string
  readonly cwd: string
  readonly revision: string
}

/** One bounded, durable recovery record; the request is immutable across retries. */
export interface PlacementOperation {
  readonly schemaVersion: 1
  readonly request: SessionRelocationRequest
  readonly before: SessionPlacement
  readonly after: SessionPlacement
  readonly hadPlacement: boolean
  readonly status: 'prepared' | 'committed' | 'rolling-back' | 'rolled-back'
  readonly rollbackPlacement?: SessionPlacement
  readonly result?: SessionRelocationResult
}

/** Deployment limits checked before any placement publication. */
export interface RelocationLimits {
  readonly logBytes: number
  readonly dataBytes: number
  readonly files: number
}

/**
 * Return a stable public refusal code without exposing stored data or paths.
 * @param code - relocation refusal category.
 * @returns an Error carrying the public code.
 */
export function relocationFailure(code: 'conflict' | 'unsupported' | 'recovery-required'): Error & { code: string } {
  return Object.assign(new Error(`session relocation ${code}`), { code: `session/relocate-${code}` })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function placement(value: unknown, id: SessionId): SessionPlacement {
  if (!record(value) || value.schemaVersion !== 1 || value.sessionId !== id
    || typeof value.originCwd !== 'string' || !isAbsolute(value.originCwd)
    || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)
    || typeof value.revision !== 'string' || !UUID.test(value.revision)) {
    throw relocationFailure('recovery-required')
  }
  return { schemaVersion: 1, sessionId: id, originCwd: value.originCwd, cwd: value.cwd, revision: value.revision }
}

async function json(path: string): Promise<unknown> {
  let identity
  try {
    identity = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!identity.isFile() || identity.size > MAX_METADATA_BYTES) throw relocationFailure('recovery-required')
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value
  } catch (error) {
    if (error instanceof SyntaxError) throw relocationFailure('recovery-required')
    throw error
  }
}

/**
 * Validate a wire/durable relocation request before deriving an operation path.
 * @param request - the caller's expected observation and operation identity.
 */
export function assertRelocationRequest(request: SessionRelocationRequest): void {
  if (typeof request.operationId !== 'string' || !UUID.test(request.operationId)
    || typeof request.expectedCwd !== 'string' || !isAbsolute(request.expectedCwd)
    || typeof request.targetCwd !== 'string' || !isAbsolute(request.targetCwd)
    || typeof request.expectedRevision !== 'string' || request.expectedRevision.length > 4096) {
    throw relocationFailure('conflict')
  }
}

/**
 * Read the required metadata pair; a lost or malformed member never falls back.
 * @param dir - physical session directory.
 * @param id - exact stored identity.
 * @returns the placement, or undefined for a session never relocated.
 */
export async function readPlacement(dir: string, id: SessionId): Promise<SessionPlacement | undefined> {
  const [value, required, pending] = await Promise.all([
    json(join(dir, PLACEMENT_FILE)), json(join(dir, REQUIRED_FILE)), json(join(dir, PENDING_FILE)),
  ])
  if (pending !== undefined && (!record(pending) || pending.schemaVersion !== 1 || pending.sessionId !== id
    || typeof pending.requiresPlacement !== 'boolean' || pending.operationId !== null)) throw relocationFailure('recovery-required')
  if (value === undefined && required === undefined) {
    if (record(pending) && pending.requiresPlacement) throw relocationFailure('recovery-required')
    return undefined
  }
  if (!record(pending) || pending.requiresPlacement !== true) throw relocationFailure('recovery-required')
  if (!record(required) || required.schemaVersion !== 1 || required.sessionId !== id || value === undefined) {
    throw relocationFailure('recovery-required')
  }
  return placement(value, id)
}

/**
 * Apply a validated placement to a detached header, retaining all other fields.
 * @param header - unchanged logical header decoded from its generation.
 * @param value - metadata for that physical session.
 * @returns effective metadata used by live and cold consumers.
 */
export function effectivePlacementHeader(header: SessionHeader, value: SessionPlacement | undefined): SessionHeader {
  if (value === undefined) return header
  if (value.originCwd !== header.cwd || value.sessionId !== header.id) throw relocationFailure('recovery-required')
  return Object.freeze({ ...header, cwd: value.cwd })
}

/**
 * Include placement changes in every cache observation token.
 * @param revision - physical generation observation.
 * @param value - validated placement metadata.
 * @returns composite opaque revision.
 */
export function placementRevision(revision: string, value: SessionPlacement | undefined): ReturnType<typeof SessionPersistenceRevision> {
  return SessionPersistenceRevision(value === undefined ? revision : `${revision}:cwd:${value.revision}`)
}

/**
 * Persist owner-only metadata through the existing atomic-write implementation.
 * @param dir - physical session directory.
 * @param value - validated current placement.
 */
export async function writePlacement(dir: string, value: SessionPlacement): Promise<void> {
  const required = await json(join(dir, REQUIRED_FILE))
  if (required !== undefined && (!record(required) || required.schemaVersion !== 1 || required.sessionId !== value.sessionId)) {
    throw relocationFailure('recovery-required')
  }
  await writeFileAtomic(join(dir, PLACEMENT_FILE), `${JSON.stringify(value)}\n`, { mode: 0o600 })
  if (required === undefined) {
    await writeFileAtomic(join(dir, REQUIRED_FILE), `${JSON.stringify({ schemaVersion: 1, sessionId: value.sessionId })}\n`, { mode: 0o600 })
  }
}

/**
 * Construct the initial placement from its original generation header.
 * @param header - stored header in the current format.
 * @returns a fresh metadata revision anchored to the unchanged origin.
 */
export function initialPlacement(header: SessionHeader): SessionPlacement {
  if (header.cwd === undefined) throw relocationFailure('unsupported')
  return { schemaVersion: 1, sessionId: header.id, originCwd: header.cwd, cwd: header.cwd, revision: randomUUID() }
}

/**
 * Publish one operation record before or after its placement commit point.
 * @param dir - physical session directory.
 * @param operation - bounded recovery record.
 */
export async function writePlacementOperation(dir: string, operation: PlacementOperation): Promise<void> {
  assertRelocationRequest(operation.request)
  const content = `${JSON.stringify(operation)}\n`
  if (Buffer.byteLength(content) > MAX_METADATA_BYTES) throw relocationFailure('unsupported')
  const operations = join(dir, OPERATIONS_DIR)
  await mkdir(operations, { recursive: true, mode: 0o700 })
  const requiresPlacement = operation.hadPlacement || await json(join(dir, PLACEMENT_FILE)) !== undefined
  const pending = `${JSON.stringify({ schemaVersion: 1, sessionId: operation.request.sessionId,
    operationId: operation.status === 'prepared' || operation.status === 'rolling-back' ? operation.request.operationId : null, requiresPlacement })}\n`
  // Make rollback discoverable before replacing a previously committed record.
  if (operation.status === 'rolling-back') await writeFileAtomic(join(dir, PENDING_FILE), pending, { mode: 0o600 })
  await writeFileAtomic(join(operations, `${operation.request.operationId}.json`), content, { mode: 0o600 })
  if (operation.status !== 'rolling-back') await writeFileAtomic(join(dir, PENDING_FILE), pending, { mode: 0o600 })
}

/**
 * Read an existing operation and reject a reused UUID with different arguments.
 * @param dir - physical session directory.
 * @param request - exact original request, including expected revision.
 * @returns the recovery record, if that operation has started.
 */
export async function readPlacementOperation(dir: string, request: SessionRelocationRequest): Promise<PlacementOperation | undefined> {
  assertRelocationRequest(request)
  const value = await json(join(dir, OPERATIONS_DIR, `${request.operationId}.json`))
  if (value === undefined) return undefined
  if (!record(value) || value.schemaVersion !== 1 || !record(value.request) || typeof value.hadPlacement !== 'boolean'
    || !['prepared', 'committed', 'rolling-back', 'rolled-back'].includes(String(value.status))) {
    throw relocationFailure('recovery-required')
  }
  for (const key of ['sessionId', 'operationId', 'expectedCwd', 'expectedRevision', 'targetCwd'] as const) {
    if (value.request[key] !== request[key]) throw relocationFailure('conflict')
  }
  const before = placement(value.before, request.sessionId)
  const after = placement(value.after, request.sessionId)
  if (before.originCwd !== after.originCwd || before.cwd !== request.expectedCwd || after.cwd !== request.targetCwd) {
    throw relocationFailure('recovery-required')
  }
  let result: SessionRelocationResult | undefined
  if (value.result !== undefined) {
    if (!record(value.result) || value.result.sessionId !== request.sessionId
      || value.result.operationId !== request.operationId || value.result.cwd !== after.cwd
      || value.result.sourceCwd !== before.cwd || typeof value.result.revision !== 'string') {
      throw relocationFailure('recovery-required')
    }
    result = { sessionId: request.sessionId, operationId: request.operationId,
      cwd: after.cwd, sourceCwd: before.cwd, revision: SessionPersistenceRevision(value.result.revision) }
  }
  const rollbackPlacement = value.rollbackPlacement === undefined ? undefined : placement(value.rollbackPlacement, request.sessionId)
  if (rollbackPlacement !== undefined && (rollbackPlacement.originCwd !== before.originCwd || rollbackPlacement.cwd !== before.cwd)) {
    throw relocationFailure('recovery-required')
  }
  return { schemaVersion: 1, request, before, after, hadPlacement: value.hadPlacement,
    ...(rollbackPlacement === undefined ? {} : { rollbackPlacement }),
    status: value.status as PlacementOperation['status'], ...(result === undefined ? {} : { result }) }
}

/**
 * Settle interrupted publications while the caller holds the physical write lease.
 * Only a prepared record can repair an incomplete initial metadata pair. Missing
 * metadata after a completed operation remains an explicit recovery refusal.
 * @param dir - exclusively owned physical session directory.
 * @param header - unchanged generation header.
 * @param physicalRevision - current generation observation.
 */
export async function recoverPlacement(dir: string, header: SessionHeader, physicalRevision: string): Promise<void> {
  const pending = await json(join(dir, PENDING_FILE))
  if (pending === undefined) return
  if (!record(pending) || pending.schemaVersion !== 1 || pending.sessionId !== header.id
    || typeof pending.requiresPlacement !== 'boolean') throw relocationFailure('recovery-required')
  if (pending.operationId === null) return
  if (typeof pending.operationId !== 'string' || !UUID.test(pending.operationId)) throw relocationFailure('recovery-required')
  const rawOperation = await json(join(dir, OPERATIONS_DIR, pending.operationId + '.json'))
  if (!record(rawOperation) || !record(rawOperation.request) || rawOperation.request.sessionId !== header.id
    || rawOperation.request.operationId !== pending.operationId || typeof rawOperation.request.expectedCwd !== 'string'
    || typeof rawOperation.request.targetCwd !== 'string' || typeof rawOperation.request.expectedRevision !== 'string') throw relocationFailure('recovery-required')
  const request: SessionRelocationRequest = { sessionId: header.id, operationId: pending.operationId,
    expectedCwd: rawOperation.request.expectedCwd, targetCwd: rawOperation.request.targetCwd,
    expectedRevision: SessionPersistenceRevision(rawOperation.request.expectedRevision) }
  const operation = await readPlacementOperation(dir, request)
  if (operation === undefined) throw relocationFailure('recovery-required')
  if (operation.status === 'rolling-back') {
    if (operation.rollbackPlacement !== undefined) await writePlacement(dir, operation.rollbackPlacement)
    await writePlacementOperation(dir, { ...operation, status: 'rolled-back' })
    return
  }
  if (operation.status !== 'prepared') {
    await writePlacementOperation(dir, operation)
    return
  }
  const [raw, required] = await Promise.all([json(join(dir, PLACEMENT_FILE)), json(join(dir, REQUIRED_FILE))])
  if (raw === undefined) {
    if (required !== undefined || operation.hadPlacement) throw relocationFailure('recovery-required')
    await writePlacementOperation(dir, { ...operation, status: 'rolled-back' })
    return
  }
  const current = placement(raw, header.id)
  if (current.originCwd !== header.cwd) throw relocationFailure('recovery-required')
  if (current.revision !== operation.before.revision && current.revision !== operation.after.revision) {
    throw relocationFailure('recovery-required')
  }
  if (required === undefined) {
    if (operation.hadPlacement) throw relocationFailure('recovery-required')
    await writePlacement(dir, current)
  } else if (!record(required) || required.schemaVersion !== 1 || required.sessionId !== header.id) {
    throw relocationFailure('recovery-required')
  }
  const committed = current.revision === operation.after.revision
  if (current.cwd !== (committed ? operation.after.cwd : operation.before.cwd)) throw relocationFailure('recovery-required')
  const result: SessionRelocationResult = {
    sessionId: header.id, operationId: operation.request.operationId, sourceCwd: operation.before.cwd,
    cwd: current.cwd, revision: placementRevision(physicalRevision, current),
  }
  await writePlacementOperation(dir, { ...operation, status: committed ? 'committed' : 'rolled-back',
    ...(committed ? { result } : {}) })
}

/**
 * Refuse oversized or link-shaped session data without traversing outside its owner.
 * @param dir - physical session directory protected by the write lease.
 * @param logPath - selected current generation file.
 * @param limits - validated deployment limits.
 * @returns the measured physical bytes and files before relocation metadata.
 */
export async function checkRelocationSize(
  dir: string, logPath: string, limits: RelocationLimits,
): Promise<{ bytes: number; files: number }> {
  if ((await lstat(logPath)).size > limits.logBytes) throw relocationFailure('unsupported')
  let bytes = 0
  let files = 0
  let entries = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    const identity = await lstat(current)
    if (identity.isSymbolicLink()) throw relocationFailure('unsupported')
    if (identity.isDirectory()) {
      for await (const entry of await opendir(current)) {
        entries += 1
        if (entries > limits.files * 2 || pending.length >= limits.files) throw relocationFailure('unsupported')
        pending.push(join(current, entry.name))
      }
    } else if (identity.isFile()) {
      files += 1
      bytes += identity.size
      if (files > limits.files || bytes > limits.dataBytes) throw relocationFailure('unsupported')
    } else {
      throw relocationFailure('unsupported')
    }
  }
  if (logPath.endsWith('.zstd')) {
    let logicalBytes = 0
    await pipeline(createReadStream(logPath), createZstdDecompress(), new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logicalBytes += chunk.length
        callback(logicalBytes > limits.logBytes ? relocationFailure('unsupported') : undefined)
      },
    }))
  }
  return { bytes, files }
}

/**
 * Include the complete committed metadata in the size limit before creating it.
 * @param dir - physical session directory protected by the write lease.
 * @param operation - proposed durable operation.
 * @param physicalRevision - immutable generation observation under that lease.
 * @param usage - already measured session data.
 * @param limits - deployment byte and file limits.
 */
export async function checkPlacementBudget(
  dir: string, operation: PlacementOperation, physicalRevision: string,
  usage: { bytes: number; files: number }, limits: RelocationLimits,
): Promise<void> {
  const changed = operation.before.cwd !== operation.after.cwd
  const result = { sessionId: operation.request.sessionId, operationId: operation.request.operationId,
    sourceCwd: operation.before.cwd, cwd: operation.after.cwd,
    revision: changed ? placementRevision(physicalRevision, operation.after) : operation.request.expectedRevision }
  const largestPlacement = Buffer.byteLength(JSON.stringify(operation.before)) > Buffer.byteLength(JSON.stringify(operation.after))
    ? operation.before : operation.after
  const proposed: Array<readonly [string, unknown]> = [
    [join(OPERATIONS_DIR, `${operation.request.operationId}.json`), { ...operation, status: changed ? 'rolling-back' : 'committed', result,
      ...(changed ? { rollbackPlacement: operation.before } : {}) }],
    [PENDING_FILE, { schemaVersion: 1, sessionId: operation.request.sessionId,
      operationId: operation.request.operationId, requiresPlacement: operation.hadPlacement || changed }],
    ...(changed ? [
      [PLACEMENT_FILE, largestPlacement] as const,
      [REQUIRED_FILE, { schemaVersion: 1, sessionId: operation.request.sessionId }] as const,
    ] : []),
  ]
  let bytes = usage.bytes
  let files = usage.files
  for (const [name, value] of proposed) {
    const size = Buffer.byteLength(`${JSON.stringify(value)}\n`)
    if (size > MAX_METADATA_BYTES) throw relocationFailure('unsupported')
    let oldSize = 0
    try {
      const identity = await lstat(join(dir, name))
      if (!identity.isFile()) throw relocationFailure('recovery-required')
      oldSize = identity.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      files += 1
    }
    bytes += Math.max(0, size - oldSize)
  }
  if (files > limits.files || bytes > limits.dataBytes) throw relocationFailure('unsupported')
}
