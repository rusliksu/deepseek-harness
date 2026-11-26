import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { dependency, existsSync } = vi.hoisted(() => ({
  dependency: { rgPath: '/node_modules/@vscode/ripgrep/bin/rg' },
  existsSync: vi.fn(),
}))
const originalPlatform = process.platform
const originalExecPath = process.execPath

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync }
})

vi.mock('@vscode/ripgrep', () => ({ get rgPath() { return dependency.rgPath } }))

beforeEach(() => {
  vi.resetModules()
  existsSync.mockReset()
  dependency.rgPath = '/node_modules/@vscode/ripgrep/bin/rg'
  Reflect.deleteProperty(process, 'pkg')
  Reflect.deleteProperty(process.versions, 'electron')
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
  process.execPath = originalExecPath
})

afterEach(() => {
  delete process.env.DSH_RIPGREP_PATH
  Reflect.deleteProperty(process, 'pkg')
  Reflect.deleteProperty(process.versions, 'electron')
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
  process.execPath = originalExecPath
})

describe('ripgrep resolution', () => {
  it('prefers an absolute DSH_RIPGREP_PATH override', async () => {
    process.env.DSH_RIPGREP_PATH = '/venv/lib/search/rg'
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe('/venv/lib/search/rg')
    expect(existsSync).toHaveBeenCalledWith('/venv/lib/search/rg')
  })

  it('rejects a relative or missing DSH_RIPGREP_PATH override', async () => {
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')
    process.env.DSH_RIPGREP_PATH = 'bin/rg'
    await expect(resolveRgPath()).rejects.toThrow('DSH_RIPGREP_PATH must be absolute')

    vi.resetModules()
    existsSync.mockReturnValue(false)
    process.env.DSH_RIPGREP_PATH = '/venv/lib/search/rg'
    const reloaded = await import('@deepseek-ai/dsh-util-ripgrep')
    await expect(reloaded.resolveRgPath()).rejects.toThrow('DSH_RIPGREP_PATH does not exist')
  })

  it('uses the native sidecar beside the current executable', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'linux' })
    process.execPath = '/runtime/dsh'
    existsSync.mockReturnValue(true)
    const sidecar = '/runtime/dsh-rg'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses a conventional executable name for the Windows ripgrep sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'win32' })
    process.execPath = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64.exe'
    existsSync.mockReturnValue(true)
    const sidecar = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64-rg.exe'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses the dependency binary in an ordinary Node process', async () => {
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    expect(existsSync).not.toHaveBeenCalled()
  })

  it('uses the dependency binary when a packaged runtime has no sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    existsSync.mockReturnValue(false)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    const executable = parse(process.execPath)
    const sidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses the unpacked executable path for an Electron ASAR dependency', async () => {
    Reflect.defineProperty(process.versions, 'electron', { configurable: true, value: '44.0.0' })
    dependency.rgPath = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@vscode/ripgrep/bin/rg'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(
      '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep/bin/rg',
    )
  })
})
