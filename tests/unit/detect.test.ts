import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectEnvironment,
  resolveA0Host,
  type ExecFn,
} from '../../src/detect.js'

const missing: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'ENOENT: no such file' })

describe('resolveA0Host', () => {
  it('prefers AGENT_ZERO_HOST env over everything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    const probe = async () => {
      throw new Error('probe should not run')
    }
    const res = await resolveA0Host({ AGENT_ZERO_HOST: 'https://a0.example.com' }, { home, probe })
    expect(res).toEqual({ host: 'https://a0.example.com', source: 'env' })
  })

  it('falls back to ~/.agent-zero/.env', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    await mkdir(join(home, '.agent-zero'), { recursive: true })
    await writeFile(
      join(home, '.agent-zero', '.env'),
      'AGENT_ZERO_COMPUTER_USE_ENABLED=1\nAGENT_ZERO_HOST=https://a0.internal\n',
    )
    const res = await resolveA0Host({}, { home, probe: async () => false })
    expect(res).toEqual({ host: 'https://a0.internal', source: 'dotfile' })
  })

  it('probes localhost:5080 as a last resort', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    const res = await resolveA0Host({}, { home, probe: async () => true })
    expect(res).toEqual({ host: 'http://localhost:5080', source: 'probe' })
  })

  it('returns undefined when nothing resolves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    const res = await resolveA0Host({}, { home, probe: async () => false })
    expect(res.host).toBeUndefined()
    expect(res.source).toBeUndefined()
  })
})

describe('detectEnvironment', () => {
  it('reports a fully-equipped environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    await mkdir(join(home, '.cache', 'ms-playwright', 'chromium-1148'), { recursive: true })
    await mkdir(join(home, '.cache', 'ms-playwright', 'webkit-2100'), { recursive: true })

    const exec: ExecFn = async (cmd) =>
      cmd === 'a0'
        ? { code: 0, stdout: '2.12\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' } // gh auth status

    const report = await detectEnvironment(
      { OPENROUTER_API_KEY: 'sk-test', AGENT_ZERO_HOST: 'https://a0.example.com' },
      { exec, home, probe: async () => false },
    )
    expect(report.openrouterKey).toBe(true)
    expect(report.ghAuth).toBe(true)
    expect(report.playwrightBrowsers.sort()).toEqual(['chromium', 'webkit'])
    expect(report.a0.version).toBe('2.12')
    expect(report.a0.host).toBe('https://a0.example.com')
    expect(report.a0.hostSource).toBe('env')
  })

  it('reports a bare environment without throwing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    const report = await detectEnvironment({}, { exec: missing, home, probe: async () => false })
    expect(report.openrouterKey).toBe(false)
    expect(report.ghAuth).toBeUndefined()
    expect(report.playwrightBrowsers).toEqual([])
    expect(report.a0.version).toBeUndefined()
    expect(report.a0.host).toBeUndefined()
  })

  it('distinguishes gh-installed-but-unauthenticated from gh-missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-detect-'))
    const unauthenticated: ExecFn = async (cmd) =>
      cmd === 'gh'
        ? { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts' }
        : { code: 1, stdout: '', stderr: 'ENOENT' }
    const report = await detectEnvironment({}, { exec: unauthenticated, home, probe: async () => false })
    expect(report.ghAuth).toBe(false)
  })
})
