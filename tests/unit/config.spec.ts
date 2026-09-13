import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// config.ts's default-identity fallback reads `homedir()/.ssh/...`; mocked
// here so the test is deterministic regardless of what the machine actually
// running these tests happens to have under its own ~/.ssh.
let fakeHome: string | undefined
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome ?? actual.homedir() }
})

const { resolveConfig, resolveSshTarget } = await import('../../src/config.ts')

/** Run `fn` with `homedir()` pointed at a fresh, empty directory (no `.ssh` at all) — isolates a test from whatever real default identity files happen to exist on the machine actually running the suite. */
function withEmptyHome<T>(fn: () => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-test-empty-home-'))
  fakeHome = dir
  try {
    return fn()
  } finally {
    fakeHome = undefined
    rmSync(dir, { recursive: true, force: true })
  }
}

const ENV_KEYS = ['SSH_HOST', 'SSH_PORT', 'SSH_USER', 'SSH_PASSWORD', 'SSH_KEY_PATH', 'SSH_KEY_PASSPHRASE'] as const

function clearSshEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

describe('resolveConfig', () => {
  afterEach(() => {
    clearSshEnv()
  })

  it('has no default SSH target when nothing at all is configured (per-call ssh becomes mandatory)', () => {
    clearSshEnv()
    const resolved = resolveConfig(undefined)
    expect(resolved.ssh).toBeUndefined()
  })

  it('still fails loud when a partial ssh config is given (a likely mistake, not "unset")', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { user: 'u', password: 'p' } })).toThrow(/ssh\.host/u)
  })

  it('accepts SSH connection details from environment variables', () => {
    clearSshEnv()
    process.env['SSH_HOST'] = '10.0.0.5'
    process.env['SSH_USER'] = 'alice'
    process.env['SSH_PASSWORD'] = 'secret'
    const resolved = resolveConfig(undefined)
    expect(resolved.ssh?.host).toBe('10.0.0.5')
    expect(resolved.ssh?.user).toBe('alice')
    expect(resolved.ssh?.port).toBe(22)
  })

  it('prefers explicit config over environment variables', () => {
    clearSshEnv()
    process.env['SSH_HOST'] = 'env-host'
    const resolved = resolveConfig({ ssh: { host: 'config-host', user: 'u', password: 'p' } })
    expect(resolved.ssh?.host).toBe('config-host')
  })

  it('requires a password or a private key (with no default identity file available)', () => {
    clearSshEnv()
    withEmptyHome(() => {
      expect(() => resolveConfig({ ssh: { host: 'h', user: 'u' } })).toThrow(/password.*private key|private key.*password/iu)
    })
  })

  it('rejects an out-of-range port', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p', port: 70_000 } })).toThrow(/ssh\.port/u)
  })

  it('rejects an invalid autoApproveWindows regex', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, autoApproveWindows: ['[unclosed'] })).toThrow(/autoApproveWindows/u)
  })

  it('treats an explicit null the same as an omitted optional ssh field (the loader/YAML shape, not just TS-typed undefined)', () => {
    clearSshEnv()
    // Mirrors what the harness's own YAML template (and this plugin's
    // cordis.patch.yml) actually hands resolveConfig for an unset optional
    // field: a literal `null`, not an absent key. Regression test for a bug
    // where `stringField` only special-cased `undefined`, so a `null`
    // privateKeyPath was passed straight to `readFileSync` and crashed with
    // "path argument must be of type string ... Received null".
    const raw = {
      ssh: {
        host: 'h', user: 'u', password: 'p',
        privateKeyPath: null, passphrase: null, remoteWorkdir: null, port: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const resolved = resolveConfig(raw)
    expect(resolved.ssh?.host).toBe('h')
    expect(resolved.ssh?.password).toBe('p')
    expect(resolved.ssh?.privateKey).toBeUndefined()
    expect(resolved.ssh?.remoteWorkdir).toBe('dsh-rssh')
    expect(resolved.ssh?.port).toBe(22)
  })

  it('has no default target for the shipped cordis.patch.yml template shape (credentials null, but port/strictHostKeyChecking/remoteWorkdir left at their concrete defaults)', () => {
    clearSshEnv()
    // Regression test: hasAnySshField must only look at identity fields
    // (host/user/password/privateKeyPath/passphrase). The bundled
    // cordis.patch.yml sets port/strictHostKeyChecking/remoteWorkdir to
    // concrete values even when no target is configured yet — counting
    // those would make `ssh` look "configured" and throw "ssh.host is
    // required" for every fresh install, before anyone has had a chance to
    // fill in a real host.
    const resolved = resolveConfig({
      ssh: {
        host: null, user: null, password: null, privateKeyPath: null, passphrase: null,
        port: 22, strictHostKeyChecking: true, remoteWorkdir: 'dsh-rssh',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(resolved.ssh).toBeUndefined()
  })

  it('applies defaults for every optional field', () => {
    clearSshEnv()
    const resolved = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' } })
    expect(resolved.requireApproval).toBe(true)
    expect(resolved.focusFallback).toBe('never')
    expect(resolved.imageMode).toBe('auto')
    expect(resolved.rollbackEnabled).toBe(true)
    expect(resolved.ssh?.remoteWorkdir).toBe('dsh-rssh')
    // The powershell tool is categorically more powerful than everything
    // else this plugin registers, so it must default OFF, never silently on.
    expect(resolved.enablePowerShellTool).toBe(false)
    expect(resolved.powerShellTimeoutMs).toBe(30_000)
    expect(resolved.maxPowerShellOutputLength).toBe(20_000)
  })

  it('accepts an explicit enablePowerShellTool: true', () => {
    clearSshEnv()
    const resolved = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, enablePowerShellTool: true })
    expect(resolved.enablePowerShellTool).toBe(true)
  })

  it('rejects an out-of-range powerShellTimeoutMs', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, powerShellTimeoutMs: -1 })).toThrow(/powerShellTimeoutMs/u)
  })

  it('rejects an out-of-range maxPowerShellOutputLength', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, maxPowerShellOutputLength: 0 })).toThrow(/maxPowerShellOutputLength/u)
  })

  it('applies defaults for the filesystem_pull/filesystem_push transfer caps', () => {
    clearSshEnv()
    const resolved = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' } })
    expect(resolved.maxFilesystemTransferBytes).toBe(10_000_000)
    expect(resolved.maxInlineFilesystemBytes).toBe(100_000)
  })

  it('rejects an out-of-range maxFilesystemTransferBytes', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, maxFilesystemTransferBytes: 0 })).toThrow(/maxFilesystemTransferBytes/u)
  })

  it('rejects an out-of-range maxInlineFilesystemBytes', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, maxInlineFilesystemBytes: 0 })).toThrow(/maxInlineFilesystemBytes/u)
  })

  it('applies defaults for waitForTimeoutMs, notifyAppId, and maxMultiActionSteps', () => {
    clearSshEnv()
    const resolved = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' } })
    expect(resolved.waitForTimeoutMs).toBe(10_000)
    expect(resolved.notifyAppId).toBe('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(resolved.maxMultiActionSteps).toBe(20)
  })

  it('rejects an out-of-range waitForTimeoutMs', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, waitForTimeoutMs: 100 })).toThrow(/waitForTimeoutMs/u)
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, waitForTimeoutMs: 999_999 })).toThrow(/waitForTimeoutMs/u)
  })

  it('accepts a custom notifyAppId', () => {
    clearSshEnv()
    const resolved = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, notifyAppId: 'MyApp' })
    expect(resolved.notifyAppId).toBe('MyApp')
  })

  it('rejects an empty notifyAppId', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, notifyAppId: '' })).toThrow(/notifyAppId/u)
  })

  it('rejects an out-of-range maxMultiActionSteps', () => {
    clearSshEnv()
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, maxMultiActionSteps: 0 })).toThrow(/maxMultiActionSteps/u)
    expect(() => resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, maxMultiActionSteps: 101 })).toThrow(/maxMultiActionSteps/u)
  })
})

describe('resolveSshTarget', () => {
  afterEach(() => {
    clearSshEnv()
  })

  it('throws a clear, tool-facing error when neither a call override nor a configured default exists', () => {
    expect(() => resolveSshTarget(undefined, undefined)).toThrow(/no SSH target available/iu)
  })

  it('falls back to the configured default when the call supplies no override', () => {
    clearSshEnv()
    const fallback = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' } }).ssh
    const resolved = resolveSshTarget(undefined, fallback)
    expect(resolved.host).toBe('h')
  })

  it('lets a per-call override replace the configured default entirely', () => {
    clearSshEnv()
    const fallback = resolveConfig({ ssh: { host: 'default-host', user: 'default-user', password: 'p' } }).ssh
    const resolved = resolveSshTarget({ host: 'call-host', user: 'call-user', password: 'call-pw' }, fallback)
    expect(resolved.host).toBe('call-host')
    expect(resolved.user).toBe('call-user')
  })

  it('does NOT consult SSH_* env vars for a per-call override (must be self-contained)', () => {
    clearSshEnv()
    process.env['SSH_PASSWORD'] = 'env-password'
    withEmptyHome(() => {
      expect(() => resolveSshTarget({ host: 'h', user: 'u' }, undefined)).toThrow(/password/iu)
    })
  })

  it('rejects a partial per-call override the same way a partial static config is rejected', () => {
    clearSshEnv()
    expect(() => resolveSshTarget({ host: 'h' }, undefined)).toThrow(/user/iu)
  })

  it('falls back to a default SSH identity file on this machine when neither password nor privateKeyPath is given', () => {
    clearSshEnv()
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-test-ssh-'))
    mkdirSync(path.join(dir, '.ssh'))
    writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'FAKE PRIVATE KEY BYTES')
    fakeHome = dir
    try {
      const resolved = resolveSshTarget({ host: 'h', user: 'u' }, undefined)
      expect(resolved.privateKey?.toString()).toBe('FAKE PRIVATE KEY BYTES')
      expect(resolved.password).toBeUndefined()
    } finally {
      fakeHome = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers an explicit password/privateKeyPath over the default identity file', () => {
    clearSshEnv()
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-test-ssh-'))
    mkdirSync(path.join(dir, '.ssh'))
    writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'FAKE DEFAULT KEY')
    fakeHome = dir
    try {
      const resolved = resolveSshTarget({ host: 'h', user: 'u', password: 'explicit-password' }, undefined)
      expect(resolved.password).toBe('explicit-password')
      expect(resolved.privateKey).toBeUndefined()
    } finally {
      fakeHome = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still fails, mentioning the default-identity search, when neither a credential nor a default identity file exists', () => {
    clearSshEnv()
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-test-ssh-empty-'))
    fakeHome = dir
    try {
      expect(() => resolveSshTarget({ host: 'h', user: 'u' }, undefined)).toThrow(/no default identity found/iu)
    } finally {
      fakeHome = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
