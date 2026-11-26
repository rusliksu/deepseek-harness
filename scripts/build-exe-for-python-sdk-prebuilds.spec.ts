import { describe, expect, it } from 'vitest'
import { foreignNodePtyPrebuilds } from './build-exe-for-python-sdk-prebuilds.ts'

describe('Python runtime executable prebuilds', () => {
  it('keeps only the prebuilds the packaged targets can load', () => {
    const present = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
    expect(foreignNodePtyPrebuilds(present, [
      { platform: 'linux', arch: 'arm64' },
      { platform: 'macos', arch: 'arm64' },
      { platform: 'macos', arch: 'x64' },
    ])).toEqual(['linux-x64', 'win32-arm64', 'win32-x64'])
  })

  it('removes every prebuild for an unknown platform directory', () => {
    expect(foreignNodePtyPrebuilds(['freebsd-x64', 'linux-x64'], [{ platform: 'linux', arch: 'x64' }]))
      .toEqual(['freebsd-x64'])
  })
})
