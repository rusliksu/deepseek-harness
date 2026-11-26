/** Select the node-pty prebuild directories a packaged target set cannot load. */

/** node-pty prebuild directory prefix for one pkg platform tag. */
const NODE_PTY_PLATFORM = { linux: 'linux', macos: 'darwin', win32: 'win32' } as const

/** One packaged platform and architecture pair. */
export interface PackagedTarget {
  /** pkg platform tag. */
  readonly platform: keyof typeof NODE_PTY_PLATFORM
  /** pkg CPU tag. */
  readonly arch: 'x64' | 'arm64'
}

/**
 * Select the prebuild directories no packaged target can load.
 * @param present - directory names found under `node-pty/prebuilds`.
 * @param targets - packaged platform and architecture pairs.
 * @returns directory names to remove, in the order they were found.
 */
export function foreignNodePtyPrebuilds(
  present: readonly string[],
  targets: readonly PackagedTarget[],
): string[] {
  const wanted = new Set(targets.map(target => `${NODE_PTY_PLATFORM[target.platform]}-${target.arch}`))
  return present.filter(name => !wanted.has(name))
}
