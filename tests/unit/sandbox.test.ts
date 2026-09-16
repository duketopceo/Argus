import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExecFn } from '../../src/detect.js'
import {
  buildSandboxArgv,
  checkSandboxPaths,
  dockerAvailable,
  runProbeInSandbox,
  sandboxLimits,
  stripControlChars,
  resolveSandboxImage,
  SANDBOX_OUTPUT_CAP,
  type SandboxRunOptions,
} from '../../src/executor/sandbox.js'
import { resolveConfig } from '../../src/config.js'

function opts(over: Partial<SandboxRunOptions> = {}): SandboxRunOptions {
  return {
    workdir: '/repo',
    scratchDir: '/repo/argus-reviewer-report/probes-out',
    cmd: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'x.test.ts'],
    image: 'node:22-slim',
    name: 'abc',
    timeoutMs: 5_000,
    memory: '2g',
    cpus: '2',
    pidsLimit: 256,
    ...over,
  }
}

describe('buildSandboxArgv', () => {
  const CHECKED = {
    realWork: '/repo',
    realScratch: '/repo/argus-reviewer-report/probes-out',
    relMount: 'argus-reviewer-report/probes-out',
  }
  const argv = (gitMode: 'dir' | 'file' | 'absent' = 'dir', secretFiles: string[] = []) =>
    buildSandboxArgv(opts(), 'argus-probe-abc', CHECKED, gitMode, secretFiles)

  it('pins the full untrusted-code flag profile', () => {
    const a = argv()
    for (const flag of [
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '65534:65534',
      '--pids-limit',
      '256',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--pull',
      'always',
      '-w',
      '/work',
    ]) {
      expect(a, flag).toContain(flag)
    }
    expect(a).toContain('argus-probe-abc')
  })

  it('masks .git and mounts only the scratch dir writable', () => {
    const a = argv('dir')
    expect(a).toContain('--tmpfs')
    expect(a[a.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,nosuid,nodev,noexec')
    expect(a[a.lastIndexOf('--tmpfs') + 1]).toBe('/work/.git')
    const mounts = a.filter((v, i) => a[i - 1] === '-v')
    expect(mounts).toContain('/repo:/work:ro')
    expect(mounts).toContain(
      '/repo/argus-reviewer-report/probes-out:/work/argus-reviewer-report/probes-out:rw',
    )
    expect(mounts.filter((m) => m.endsWith(':rw'))).toHaveLength(1)
  })

  it('masks a worktree .git pointer file and secret files with /dev/null', () => {
    const a = argv('file', ['.env', '.npmrc'])
    const mounts = a.filter((v, i) => a[i - 1] === '-v')
    expect(mounts).toContain('/dev/null:/work/.git:ro')
    expect(mounts).toContain('/dev/null:/work/.env:ro')
    expect(mounts).toContain('/dev/null:/work/.npmrc:ro')
    expect(a.filter((v, i) => a[i - 1] === '--tmpfs' && v === '/work/.git')).toHaveLength(0)
    expect(mounts.filter((m) => m.endsWith(':rw'))).toHaveLength(1)
  })

  it('adds roMounts and extra tmpfs masks', () => {
    const a = buildSandboxArgv(
      opts({ roMounts: [{ host: '/repo/node_modules', container: '/work/node_modules' }], masks: ['argus-reviewer-report/probes-base'] }),
      'argus-probe-abc',
      CHECKED,
      'absent',
      [],
    )
    const mounts = a.filter((v, i) => a[i - 1] === '-v')
    expect(mounts).toContain('/repo/node_modules:/work/node_modules:ro')
    expect(a).toContain('/work/argus-reviewer-report/probes-base')
    expect(mounts.filter((m) => m.endsWith(':rw'))).toHaveLength(1)
  })

  it('carries only the declared env allowlist — no host env or secrets', () => {
    const a = argv()
    const envs = a.filter((v, i) => a[i - 1] === '--env' || a[i - 1] === '-e')
    expect(envs.sort()).toEqual(
      ['HOME=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'npm_config_cache=/tmp/.npm'].sort(),
    )
    for (const e of envs) {
      expect(e).not.toMatch(/TOKEN|SECRET|KEY/i)
      expect(e).not.toContain(process.env.HOME || '\0')
    }
  })
})

describe('stripControlChars', () => {
  it('removes ANSI escapes and C0 bytes but keeps newlines and tabs', () => {
    expect(stripControlChars('ok\x1b[31mfail\x1b[0m\x07end\n\ttab')).toBe('ok[31mfail[0mend\n\ttab')
  })
})

describe('resolveSandboxImage', () => {
  it('honors the config override', () => {
    expect(resolveSandboxImage('my-image:v1')).toBe('my-image:v1')
  })
  it('derives node:<host major>-slim when unset', () => {
    expect(resolveSandboxImage(undefined)).toBe(`node:${process.versions.node.split('.')[0]}-slim`)
  })
})

describe('checkSandboxPaths', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'argus-sandbox-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a real scratch dir inside the workdir', async () => {
    const scratch = join(root, 'argus-reviewer-report', 'probes-out')
    await mkdir(scratch, { recursive: true })
    const res = await checkSandboxPaths(root, scratch)
    expect(res).toMatchObject({ ok: true, relMount: 'argus-reviewer-report/probes-out' })
  })

  it('rejects a scratch dir symlinked outside the workdir', async () => {
    const outside = join(tmpdir(), `argus-out-${process.pid}`)
    await mkdir(outside, { recursive: true })
    const link = join(root, 'probes-out')
    await symlink(outside, link)
    const res = await checkSandboxPaths(root, link)
    expect(res.ok).toBe(false)
    await rm(outside, { recursive: true, force: true })
  })

  it('rejects a scratch dir outside the workdir', async () => {
    const res = await checkSandboxPaths(root, join(root, '..', 'elsewhere'))
    expect(res.ok).toBe(false)
  })
})

describe('dockerAvailable', () => {
  it('is false when the daemon is unreachable', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no daemon' })
    expect(await dockerAvailable(exec, 'node:22-slim', '/repo')).toBe(false)
  })

  it('is false when the daemon cannot see the workspace (mount smoke fails)', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (cmd, args) => {
      calls.push(args)
      return args[0] === 'version'
        ? { code: 0, stdout: '24.0', stderr: '' }
        : { code: 1, stdout: '', stderr: 'no such file' }
    }
    expect(await dockerAvailable(exec, 'node:22-slim', '/repo')).toBe(false)
    expect(calls[1]).toContain('test')
    expect(calls[1]).toContain('/work/package.json')
  })

  it('runs the availability smoke check under the same hardened profile', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (cmd, args) => {
      calls.push(args)
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    expect(await dockerAvailable(exec, 'node:22-slim', '/repo')).toBe(true)
    const smoke = calls[1] ?? []
    for (const flag of [
      '--pull',
      'always',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      'no-new-privileges',
      '65534:65534',
      '--entrypoint',
    ]) {
      expect(smoke, flag).toContain(flag)
    }
  })

  it('is false (not throwing) when the exec itself rejects', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn docker ENOENT')
    }
    expect(await dockerAvailable(exec, 'node:22-slim', '/repo')).toBe(false)
  })

  it('is true when both checks pass', async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: 'ok', stderr: '' })
    expect(await dockerAvailable(exec, 'node:22-slim', '/repo')).toBe(true)
  })
})

describe('runProbeInSandbox', () => {
  let workdir: string
  let realOpts: SandboxRunOptions
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'argus-run-'))
    const scratchDir = join(workdir, 'argus-reviewer-report', 'probes-out')
    await mkdir(scratchDir, { recursive: true })
    realOpts = opts({ workdir, scratchDir })
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('returns the run result with output capped and control bytes stripped', async () => {
    const big = 'x'.repeat(SANDBOX_OUTPUT_CAP + 100)
    const exec: ExecFn = async () => ({ code: 1, stdout: big, stderr: 'err\x1b[2K' })
    const res = await runProbeInSandbox({ ...realOpts, exec })
    expect(res.exitCode).toBe(1)
    expect(res.timedOut).toBe(false)
    expect(res.stdout.length).toBe(SANDBOX_OUTPUT_CAP)
    expect(res.stderr).toBe('err[2K')
  })

  it('issues docker rm -f when the run times out', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (cmd, args) => {
      calls.push(args)
      if (args[0] === 'run') return { code: 1, stdout: '', stderr: 'killed', timedOut: true, signal: 'SIGTERM' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const res = await runProbeInSandbox({ ...realOpts, exec })
    expect(res.timedOut).toBe(true)
    const rm = calls.find((a) => a[0] === 'rm')
    expect(rm).toEqual(['rm', '-f', `argus-probe-${process.pid}-abc`])
  })

  it('degrades instead of running when the scratch path check fails', async () => {
    let ran = false
    const exec: ExecFn = async () => {
      ran = true
      return { code: 0, stdout: '', stderr: '' }
    }
    const res = await runProbeInSandbox({ ...realOpts, exec, workdir: '/nonexistent-dir-x' })
    expect(ran).toBe(false)
    expect(res.exitCode).toBe(-1)
    expect(res.stderr).toContain('path check failed')
  })

  it('converts spawn rejection to a failed result and still tears down', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (cmd, args) => {
      calls.push(args)
      if (args[0] === 'run') throw new Error('spawn docker ENOENT')
      return { code: 0, stdout: '', stderr: '' }
    }
    const res = await runProbeInSandbox({ ...realOpts, exec })
    expect(res.exitCode).toBe(-1)
    expect(res.stderr).toContain('ENOENT')
    expect(calls.find((a) => a[0] === 'rm')).toBeTruthy()
  })
})

describe('sandboxLimits', () => {
  it('maps the config block through', () => {
    const s = resolveConfig({ sandbox: { timeoutMs: 42, memory: '1g', cpus: '1', pidsLimit: 64 } }).sandbox
    expect(sandboxLimits(s)).toEqual({ timeoutMs: 42, memory: '1g', cpus: '1', pidsLimit: 64 })
  })
})
