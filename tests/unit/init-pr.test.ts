import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../../src/cli.js'
import type { ExecFn, ExecResult } from '../../src/detect.js'
import { renderPrBody } from '../../src/onboarding/pr.js'

const SECRET = 'sk-or-v1-SENTINEL-do-not-leak'
const PR_URL = 'https://github.com/acme/widgets/pull/7'

interface Call {
  cmd: string
  args: string[]
  env: Record<string, string> | undefined
}

interface World {
  origin?: string
  openPr?: string
  localBranch?: boolean
  remoteBranch?: boolean
  noGh?: boolean
  defaultRef?: string
}

/** A scripted git/gh. Writes to the worktree dir are real files, so tests can read them. */
function fakeExec(world: World): { exec: ExecFn; calls: Call[]; bodies: string[] } {
  const calls: Call[] = []
  const bodies: string[] = []
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
  const fail = (code = 1, stderr = 'fail'): ExecResult => ({ code, stdout: '', stderr })
  const exec: ExecFn = async (cmd, args, _t, env) => {
    calls.push({ cmd, args, env })
    const a = args.join(' ')
    if (cmd === 'gh') {
      if (world.noGh === true)
        return { code: 127, stdout: '', stderr: 'not found', spawnError: true }
      if (a.startsWith('pr list')) {
        return ok(JSON.stringify(world.openPr !== undefined ? [{ url: world.openPr }] : []))
      }
      if (a.startsWith('pr create')) {
        const f = args[args.indexOf('--body-file') + 1] as string
        bodies.push(await readFile(f, 'utf8'))
        return ok(`${PR_URL}\n`)
      }
      return fail()
    }
    // git
    if (a.includes('remote get-url origin')) {
      return world.origin !== undefined ? ok(`${world.origin}\n`) : fail(2)
    }
    if (a.includes('symbolic-ref')) {
      return world.defaultRef !== undefined ? ok(`${world.defaultRef}\n`) : fail()
    }
    if (a.includes('rev-parse --verify')) return world.localBranch === true ? ok('abc\n') : fail(1)
    if (a.includes('ls-remote')) return world.remoteBranch === true ? ok('abc\trefs\n') : fail(2)
    if (a.includes('worktree add')) return ok()
    return ok()
  }
  return { exec, calls, bodies }
}

async function repoDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'argus-initpr-'))
}

async function run(
  argv: string[],
  world: World,
  cwd: string,
): Promise<{ code: number; out: string; err: string; calls: Call[]; bodies: string[] }> {
  const f = fakeExec(world)
  const out: string[] = []
  const err: string[] = []
  const code = await main(['init', ...argv], {
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    isTTY: false,
    env: { PATH: '/nonexistent', OPENROUTER_API_KEY: SECRET },
    exec: f.exec,
  })
  return { code, out: out.join('\n'), err: err.join('\n'), calls: f.calls, bodies: f.bodies }
}

const WORLD: World = { origin: 'git@github.com:acme/widgets.git', defaultRef: 'origin/main' }
const gitArgs = (calls: Call[], needle: string): string[][] =>
  calls
    .filter((c) => c.cmd === 'git' && c.args.slice(2).join(' ').startsWith(needle))
    .map((c) => c.args)

describe('init --pr', () => {
  it('branches, commits the scaffold in a separate worktree, pushes and opens the PR', async () => {
    const cwd = await repoDir()
    const r = await run(['--pr'], WORLD, cwd)
    expect(r.code).toBe(0)
    expect(r.out).toContain(PR_URL)
    const wt = gitArgs(r.calls, 'worktree add')[0] as string[]
    expect(wt).toContain('argus/onboarding')
    expect(wt).toContain('origin/main')
    expect(gitArgs(r.calls, 'commit')).toHaveLength(1)
    expect(gitArgs(r.calls, 'push')[0]).toEqual(
      expect.arrayContaining(['push', '-u', 'origin', 'argus/onboarding']),
    )
    const create = r.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create') as Call
    expect(create.args).toEqual(
      expect.arrayContaining([
        '--repo',
        'acme/widgets',
        '--head',
        'argus/onboarding',
        '--base',
        'main',
      ]),
    )
    // The user's checkout is never written to.
    expect(existsSync(join(cwd, '.github'))).toBe(false)
    expect(existsSync(join(cwd, 'argus-reviewer.config.ts'))).toBe(false)
  })

  it('stages exactly the scaffold paths', async () => {
    const r = await run(['--pr'], WORLD, await repoDir())
    const add = gitArgs(r.calls, 'add ')[0] as string[]
    expect(add.slice(add.indexOf('--') + 1).sort()).toEqual([
      '.github/workflows/argus-mention.yml',
      '.github/workflows/argus-reviewer.yml',
      'argus-reviewer.config.ts',
      'tests/argus/smoke.test.ts',
    ])
  })

  it('PR body carries checklist, provider statement, budget and stop path', async () => {
    const r = await run(['--pr'], WORLD, await repoDir())
    const body = r.bodies[0] as string
    expect(body).toContain('OPENROUTER_API_KEY')
    expect(body).toContain(
      'https://github.com/acme/widgets/settings/secrets/actions/new?name=OPENROUTER_API_KEY',
    )
    expect(body).toContain('sent to provider')
    expect(body).toContain('default budget')
    expect(body).toContain('$1/run cap')
    expect(body).toContain('how to stop')
    expect(body).toMatch(/uninstall|remove/i)
    expect(body).toContain('.github/workflows/argus-reviewer.yml')
  })

  it('never reads, prints or transmits OPENROUTER_API_KEY', async () => {
    const r = await run(['--pr'], WORLD, await repoDir())
    const everything = JSON.stringify(r.calls) + r.out + r.err + r.bodies.join('')
    expect(everything).not.toContain(SECRET)
    expect(r.calls.every((c) => c.env === undefined || !('OPENROUTER_API_KEY' in c.env))).toBe(true)
    expect(r.calls.some((c) => c.args.includes('secret'))).toBe(false)
  })

  it('refuses to overwrite existing files, lists them, exits non-zero, runs no write commands', async () => {
    const cwd = await repoDir()
    await mkdir(join(cwd, '.github/workflows'), { recursive: true })
    await writeFile(join(cwd, '.github/workflows/argus-reviewer.yml'), 'mine', 'utf8')
    await mkdir(join(cwd, 'tests/argus'), { recursive: true })
    await writeFile(join(cwd, 'tests/argus/smoke.test.ts'), 'mine', 'utf8')
    const r = await run(['--pr'], WORLD, cwd)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('.github/workflows/argus-reviewer.yml')
    expect(r.err).toContain('tests/argus/smoke.test.ts')
    expect(r.err).toMatch(/not overwrit|refus/i)
    expect(gitArgs(r.calls, 'worktree')).toHaveLength(0)
    expect(gitArgs(r.calls, 'push')).toHaveLength(0)
    expect(r.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false)
    expect(await readFile(join(cwd, '.github/workflows/argus-reviewer.yml'), 'utf8')).toBe('mine')
  })

  it('an existing config is not a conflict: it is left out of the PR', async () => {
    const cwd = await repoDir()
    await writeFile(join(cwd, 'argus-reviewer.config.json'), '{}', 'utf8')
    const r = await run(['--pr'], WORLD, cwd)
    expect(r.code).toBe(0)
    const add = gitArgs(r.calls, 'add ')[0] as string[]
    expect(add).not.toContain('argus-reviewer.config.ts')
  })

  it('--force is rejected with --pr', async () => {
    const r = await run(['--pr', '--force'], WORLD, await repoDir())
    expect(r.code).toBe(2)
    expect(r.calls).toHaveLength(0)
  })

  it('reports the existing open PR and does nothing else', async () => {
    const r = await run(
      ['--pr'],
      { ...WORLD, openPr: 'https://github.com/acme/widgets/pull/3' },
      await repoDir(),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('https://github.com/acme/widgets/pull/3')
    expect(r.out).toMatch(/already/i)
    expect(gitArgs(r.calls, 'worktree')).toHaveLength(0)
    expect(gitArgs(r.calls, 'push')).toHaveLength(0)
    expect(r.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false)
  })

  it('branch already on the remote without a PR: opens the PR, no new commit or push', async () => {
    const r = await run(['--pr'], { ...WORLD, remoteBranch: true }, await repoDir())
    expect(r.code).toBe(0)
    expect(r.out).toContain(PR_URL)
    expect(gitArgs(r.calls, 'commit')).toHaveLength(0)
    expect(gitArgs(r.calls, 'push')).toHaveLength(0)
    expect(gitArgs(r.calls, 'worktree add')).toHaveLength(0)
  })

  it('branch only local: pushes it, does not recreate or recommit', async () => {
    const r = await run(['--pr'], { ...WORLD, localBranch: true }, await repoDir())
    expect(r.code).toBe(0)
    expect(gitArgs(r.calls, 'push')).toHaveLength(1)
    expect(gitArgs(r.calls, 'commit')).toHaveLength(0)
    expect(gitArgs(r.calls, 'worktree add')).toHaveLength(0)
  })

  it('--repo and --branch are honoured; --repo must match origin', async () => {
    const ok = await run(
      ['--pr', '--repo', 'acme/widgets', '--branch', 'argus/setup'],
      WORLD,
      await repoDir(),
    )
    expect(ok.code).toBe(0)
    expect(gitArgs(ok.calls, 'worktree add')[0]).toContain('argus/setup')
    const bad = await run(['--pr', '--repo', 'other/thing'], WORLD, await repoDir())
    expect(bad.code).not.toBe(0)
    expect(bad.err).toContain('other/thing')
    expect(gitArgs(bad.calls, 'push')).toHaveLength(0)
  })

  it('fails clearly when the checkout has no origin remote', async () => {
    const r = await run(
      ['--pr', '--repo', 'acme/widgets'],
      { defaultRef: 'origin/main' },
      await repoDir(),
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/origin/)
  })

  it.each([
    '--repo=a b/c',
    '--repo=owner',
    '--repo=../x/y',
    '--branch=-evil',
    '--branch=a..b',
    '--branch=a b',
  ])('rejects unsafe input %s before running anything', async (flag) => {
    const r = await run(['--pr', flag], WORLD, await repoDir())
    expect(r.code).toBe(2)
    expect(r.calls).toHaveLength(0)
  })

  it('fails clearly when gh is unavailable', async () => {
    const r = await run(['--pr'], { ...WORLD, noGh: true }, await repoDir())
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/gh/)
    expect(gitArgs(r.calls, 'push')).toHaveLength(0)
  })

  it('--repo/--branch without --pr is a usage error', async () => {
    const r = await run(['--repo', 'acme/widgets'], WORLD, await repoDir())
    expect(r.code).toBe(2)
  })

  it('plain init is unchanged and runs no git', async () => {
    const cwd = await repoDir()
    const r = await run([], WORLD, cwd)
    expect(r.code).toBe(0)
    expect(r.calls.some((c) => c.cmd === 'git' && c.args.includes('commit'))).toBe(false)
  })
})

describe('renderPrBody', () => {
  it('is deterministic and names only the secret name', () => {
    const a = renderPrBody({ repo: 'acme/widgets', budgetUsd: 2, paths: ['a.yml'] })
    expect(a).toBe(renderPrBody({ repo: 'acme/widgets', budgetUsd: 2, paths: ['a.yml'] }))
    expect(a).toContain('$2/run cap')
    expect(a).not.toMatch(/sk-or-/)
  })
})
