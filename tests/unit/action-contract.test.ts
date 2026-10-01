import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// @ts-expect-error plain-node action helper — no type declarations
import {
  assertRegularFile,
  assertRegularFileInside,
  parseCommand,
  resolveWorkingDirectory,
  validateBrowser,
  validateBudget,
  validateCodeModel,
  validateMaxComments,
  validateReviewProfiles,
  validateVersion,
} from '../../action/runtime.mjs'

// @ts-expect-error plain-node action helper — no type declarations
import {
  renderBody as renderStickyBody,
  renderManifestBody,
  renderManifestLanes,
  renderReviewOnlyBody,
  run,
  shortHash,
} from '../../action/sticky-comment.cjs'

import { renderManifestComment } from '../../src/report/comment.js'
import { fixtureLane, fixtureManifest } from '../fixtures/manifest.js'

const execFileAsync = promisify(execFile)
const ACTION = join(process.cwd(), 'action')

describe('action input contract', () => {
  it('renders fingerprint cache economics in the sticky summary', () => {
    const body = renderStickyBody(
      {
        totals: {
          passed: 1,
          tests: 1,
          visionCalls: 0,
          visionCostUsd: 0,
          sandboxSeconds: 1,
          cacheHits: 3,
          cacheMisses: 2,
          cacheHeals: 1,
          callsByModel: {},
          costByModel: {},
          budgetExceeded: false,
        },
        tests: [],
      },
      undefined,
      'https://github.com/run/1',
      true,
      { comments: [], dropped: 0, cap: 20, overflow: 0, offDiff: 0 },
    )

    expect(body).toContain('**Fingerprint cache:** 3 hit(s) · 2 miss(es) · 1 heal(s)')
  })

  it('renders the Exploratory section only when the lane was enabled', () => {
    const base = {
      totals: {
        passed: 1,
        tests: 1,
        visionCalls: 0,
        visionCostUsd: 0,
        sandboxSeconds: 1,
        callsByModel: {},
        costByModel: {},
        budgetExceeded: false,
      },
      ok: true,
      tests: [
        {
          name: 'landing',
          file: 'tests/landing.test.ts',
          ok: true,
          visionCalls: 0,
          visionCostUsd: 0,
          healEvents: [],
          asserts: [],
          captures: [
            { kind: 'console-error', text: 'seeded console boom', count: 3 },
            {
              kind: 'request-failed',
              text: 'net::ERR_ABORTED',
              url: 'http://127.0.0.1:4000/api/missing',
              count: 1,
            },
          ],
        },
      ],
      artifacts: { videos: [] },
    }
    const inline = { comments: [], dropped: 0, cap: 20, overflow: 0, offDiff: 0 }

    // Lane off → captures present but no section rendered.
    expect(
      renderStickyBody({ ...base }, undefined, undefined, true, inline),
    ).not.toContain('Exploratory')

    // Lane on → observed findings with collapsed counts.
    const on = renderStickyBody(
      { ...base, explore: { enabled: true } },
      undefined,
      undefined,
      true,
      inline,
    )
    expect(on).toContain('🔭 Exploratory')
    expect(on).toContain('🟡 observed · console error ×3: `seeded console boom`')
    expect(on).toContain('do not change the verdict')

    // Skip line — unreachable target is explicit, not silent.
    const skipped = renderStickyBody(
      { ...base, explore: { enabled: true, skipped: 'no page loaded — nothing captured' } },
      undefined,
      undefined,
      true,
      inline,
    )
    expect(skipped).toContain('explore skipped — no page loaded')

    // U4b act pass — step/visited/stopReason summary plus its own captures
    // merged with the per-file ones.
    const acted = renderStickyBody(
      {
        ...base,
        explore: {
          enabled: true,
          steps: 7,
          visited: 2,
          stopReason: 'max-steps',
          visionCalls: 7,
          visionCostUsd: 0.0012,
          captures: [{ kind: 'pageerror', text: 'TypeError: boom', count: 1 }],
        },
      },
      undefined,
      undefined,
      true,
      inline,
    )
    expect(acted).toContain('explored **7** step(s) across **2** page(s)')
    expect(acted).toContain('stopped: max-steps')
    expect(acted).toContain('🟡 observed · page error: `TypeError: boom`')
    expect(acted).toContain('🟡 observed · console error ×3: `seeded console boom`')
  })

  it('parses trusted CLI argv without a shell and rejects shell operators', () => {
    expect(parseCommand('node dist/cli.js')).toEqual(['node', 'dist/cli.js'])
    expect(parseCommand('npx --no-install argus-reviewer')).toEqual([
      'npx',
      '--no-install',
      'argus-reviewer',
    ])
    expect(parseCommand('"node" \'dist/cli.js\'')).toEqual(['node', 'dist/cli.js'])
    expect(() => parseCommand('node dist/cli.js; touch /tmp/pwn')).toThrow(/shell operators/)
    expect(() => parseCommand('node "dist/cli.js')).toThrow(/unterminated quote/)
  })

  it('validates browser, budget, comment, and pinned-version inputs', () => {
    expect(validateBrowser('firefox')).toBe('firefox')
    expect(() => validateBrowser('safari')).toThrow(/browser/)
    expect(validateBudget('1.25')).toBe(1.25)
    expect(() => validateBudget('-1')).toThrow(/positive/)
    expect(validateMaxComments('0')).toBe(0)
    expect(() => validateMaxComments('1e2')).toThrow(/integer/)
    expect(validateCodeModel('deepseek/deepseek-r1:free')).toBe('deepseek/deepseek-r1:free')
    expect(() => validateCodeModel('model; rm -rf /')).toThrow(/slug/)
    expect(validateReviewProfiles('security, perf')).toBe('security,perf')
    expect(validateReviewProfiles('')).toBeUndefined()
    expect(() => validateReviewProfiles('security,style')).toThrow(/review-profiles/)
    expect(validateVersion('0.2.0')).toBe('0.2.0')
    expect(() => validateVersion('latest')).toThrow(/pinned semver/)
  })

  it('keeps working-directory and config paths inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-action-root-'))
    await mkdir(join(root, 'apps', 'web'), { recursive: true })
    expect(resolveWorkingDirectory(root, 'apps/web')).toBe(join(root, 'apps/web'))
    expect(() => resolveWorkingDirectory(root, '../outside')).toThrow(/inside/)

    const outside = await mkdtemp(join(tmpdir(), 'argus-action-outside-'))
    await symlink(outside, join(root, 'escape'))
    expect(() => resolveWorkingDirectory(root, 'escape')).toThrow(/inside/)
    await writeFile(join(outside, 'review.json'), '{}\n')
    await symlink(outside, join(root, 'config'))
    expect(() => assertRegularFileInside(root, 'config/review.json', 'config')).toThrow(/inside/)

    await symlink(join(outside, 'review.json'), join(root, 'leaf.json'))
    await expect(assertRegularFile(join(root, 'leaf.json'), 'config')).rejects.toThrow(
      /non-symlink/,
    )
  })

  it('uses safe action wiring: pinned bootstrap, no dynamic source evaluation, opt-in runtime install', async () => {
    const action = await readFile(join(ACTION, 'action.yml'), 'utf8')
    expect(action).toContain('argus-version:')
    expect(action).toContain("default: ''")
    expect(action).toContain("default: 'false'")
    expect(action).toContain('install-consumer-dependencies:')
    expect(action).toContain("if: inputs.install-consumer-dependencies == 'true'")
    expect(action).toContain('node "$ARGUS_ACTION_PATH/cli.mjs" verify')
    expect(action).toContain('ARGUS_VERIFY_FLOW:')
    // U5/U6 — app + a0 lanes surface as opt-in action inputs bridged to
    // the verify env contract; expect markers ride along.
    expect(action).toContain('app-task:')
    expect(action).toContain('app-url:')
    expect(action).toContain('app-expect-text:')
    expect(action).toContain('ARGUS_VERIFY_APP:')
    expect(action).toContain('ARGUS_VERIFY_A0:')
    expect(action).toContain('ARGUS_VERIFY_TASK:')
    expect(action).toContain('ARGUS_VERIFY_EXPECT_TEXT:')
    // Both lanes are executable — they must ride the fork gate.
    expect(action).toContain("inputs.app == 'true'")
    expect(action).toContain("inputs.a0 == 'true'")
    expect(action).not.toContain('code-review --report-dir')
    expect(action).not.toContain('run --report-dir')
    expect(action).not.toContain('new Function')
    expect(action).not.toContain('run: ${{ inputs.cli }}')
    expect(action).not.toContain('sticky-comment.mjs')
    expect(action).not.toMatch(/uses:\s+[^\s]+@v\d+/)
    expect(action).toMatch(/actions\/setup-node@[0-9a-f]{40} # v4/)
    expect(action).toMatch(/actions\/github-script@[0-9a-f]{40} # v7/)
  })

  it('keeps the repository workflow on a pinned action and runs local action checks without secrets', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/argus-reviewer.yml'),
      'utf8',
    )
    expect(workflow).toContain(
      'uses: duketopceo/Argus/action@75492b8a6b10338d1f141ac9f8544135edc34409 # v0.2.0',
    )
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}')
    expect(workflow).toContain('repository: duketopceo/Argus')
    expect(workflow).toContain('run: rm -rf -- trusted-argus')
    expect(workflow).toContain('path: trusted-argus')
    expect(workflow).toMatch(/name: Install trusted CLI dependencies\n\s+id: trusted-cli/)
    expect(workflow).toContain('npm --prefix "$TRUSTED_ARGUS_DIR" ci --ignore-scripts')
    expect(workflow).not.toContain('cli: node dist/cli.js')
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/)
    expect(workflow).toContain('action-contract:')
    expect(workflow).toContain('permissions:\n      contents: read')
    expect(workflow).not.toContain('uses: ./action')
  })

  it('bootstraps a custom CLI and stages a custom config without invoking npm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-action-bootstrap-'))
    const configDir = join(root, 'config')
    const output = join(root, 'github-output')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'review.json'), '{"model":"test/model"}\n')
    await writeFile(output, '')

    await execFileAsync(process.execPath, [join(ACTION, 'bootstrap.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: output,
        ARGUS_CLI: 'node dist/cli.js',
        ARGUS_ARGUS_VERSION: '',
        ARGUS_CONFIG_PATH: 'config/review.json',
        ARGUS_WORKING_DIRECTORY: '',
        ARGUS_REPORT_DIR: 'reports',
        ARGUS_BROWSER: 'chromium',
        ARGUS_BUDGET_USD: '',
        ARGUS_MAX_COMMENTS: '',
      },
    })

    expect(await readFile(join(root, 'argus-reviewer.config.json'), 'utf8')).toContain('test/model')
    const outputs = await readFile(output, 'utf8')
    expect(outputs).toContain('cli-json=["node","dist/cli.js"]')
    expect(outputs).toContain(`working-directory=${root}`)
    expect(outputs).toContain('report-dir=reports')
  })

  it('defaults to the CLI package installed from the pinned action ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-action-bundled-'))
    const output = join(root, 'github-output')
    await writeFile(output, '')

    await execFileAsync(process.execPath, [join(ACTION, 'bootstrap.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: output,
        ARGUS_CLI: '',
        ARGUS_ARGUS_VERSION: '',
        ARGUS_CONFIG_PATH: '',
        ARGUS_WORKING_DIRECTORY: '',
        ARGUS_REPORT_DIR: 'reports',
        ARGUS_BROWSER: 'chromium',
        ARGUS_BUDGET_USD: '',
        ARGUS_MAX_COMMENTS: '',
      },
    })

    const cliLine = (await readFile(output, 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('cli-json='))
    const cli = JSON.parse(cliLine!.slice('cli-json='.length)) as string[]
    expect(cli[0]).toBe(process.execPath)
    expect(cli[1]).toMatch(
      /argus-reviewer-action-pinned-[^/]+\/node_modules\/argus-reviewer-e2e\/dist\/cli\.js$/,
    )
  })

  it('rejects a config path that escapes the working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-action-escape-'))
    const output = join(root, 'github-output')
    await writeFile(output, '')
    await expect(
      execFileAsync(process.execPath, [join(ACTION, 'bootstrap.mjs')], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          GITHUB_OUTPUT: output,
          ARGUS_CLI: 'node dist/cli.js',
          ARGUS_CONFIG_PATH: '../outside.json',
          ARGUS_WORKING_DIRECTORY: '',
          ARGUS_REPORT_DIR: 'reports',
          ARGUS_BROWSER: 'chromium',
        },
      }),
    ).rejects.toThrow(/config must stay inside/)
  })
})

// U4/R6 — the sticky's scannable top block: verdict + one-line summary +
// honest counts under the sentinel, ahead of every <details> fold.
describe('sticky review top block (U4)', () => {
  const runReport = {
    ok: true,
    totals: {
      passed: 1,
      tests: 1,
      visionCalls: 0,
      visionCostUsd: 0,
      sandboxSeconds: 1,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHeals: 0,
      callsByModel: {},
      costByModel: {},
      budgetExceeded: false,
    },
    tests: [],
    artifacts: { videos: [] },
  }

  function review(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      skipped: false,
      summary: 'found real problems',
      verdict: 'needs_changes',
      findings: [],
      model: 'test/model',
      tokens: 0,
      visionCostUsd: 0,
      reviewEvent: 'comment',
      provenBlockers: 0,
      highConfidenceBlockers: 0,
      reviewComments: [],
      commentsOverflow: 0,
      maxComments: 20,
      ...overrides,
    }
  }

  it('renders verdict + counts under the sentinel, before the first details section', () => {
    const cr = review({
      verdict: 'needs_changes',
      findings: [
        {
          file: 'a.ts',
          line: 3,
          severity: 'bug',
          message: 'boom',
          evidence: { status: 'reproduced', detail: 'fails on head' },
        },
        { file: 'b.ts', line: 8, severity: 'risk', message: 'hmm' },
        { file: 'c.ts', line: 1, severity: 'nit', message: 'meh' },
      ],
      provenBlockers: 1,
      reviewEvent: 'request_changes',
    })

    const body = renderStickyBody(runReport, cr, 'https://github.com/run/1', false, undefined)

    expect(body.indexOf('<!-- argus-reviewer -->')).toBeLessThan(body.indexOf('**Code review:**'))
    expect(body.indexOf('**Code review:**')).toBeLessThan(body.indexOf('<details>'))
    expect(body).toContain('**Code review:** 🔴 **needs_changes** — found real problems')
    expect(body).toContain('🐛 1 · ⚠️ 1 · 💡 1 · ❓ 0')
    expect(body).toContain('⛔ 1 reproduced')
    expect(body).not.toContain('◎')
  })

  it('renders a clean zero-finding block with no proof counts', () => {
    const cr = review({ verdict: 'pass', summary: 'clean diff' })
    const body = renderStickyBody(runReport, cr, 'https://github.com/run/1', true, undefined)

    expect(body).toContain('**Code review:** ✅ **pass** — clean diff')
    expect(body).toContain('no findings')
    expect(body).not.toContain('⛔')
    expect(body).not.toContain('◎')
    expect(body).not.toMatch(/🔧 \d+ suggestion/)
  })

  it('counts reproduced and p-only findings separately — p alone is never proven', () => {
    // No serialized counts — exercises the finding-level recount fallback:
    // the p-only blocker must land under ◎ and never leak into ⛔.
    const cr = review({
      findings: [
        {
          file: 'a.ts',
          line: 3,
          severity: 'bug',
          message: 'boom',
          evidence: { status: 'reproduced', detail: 'fails on head' },
        },
        { file: 'b.ts', line: 8, severity: 'bug', message: 'confident', p: 0.95 },
        { file: 'c.ts', line: 9, severity: 'bug', message: 'plain' },
      ],
    })
    delete (cr as Record<string, unknown>).provenBlockers
    delete (cr as Record<string, unknown>).highConfidenceBlockers

    const body = renderStickyBody(runReport, cr, 'https://github.com/run/1', false, undefined)

    expect(body).toContain('⛔ 1 reproduced')
    expect(body).toContain('◎ 1 high-confidence')
    expect(body).not.toContain('⛔ 2')
    expect(body).not.toContain('◎ 2')
  })

  it('counts only serialized comments that carry a committable suggestion', () => {
    const cr = review({
      findings: [
        { file: 'a.ts', line: 3, severity: 'bug', message: 'boom', suggestion: 'const x = 1' },
        // A second patched finding that never made reviewComments (cap/
        // ineligible) — its suggestion is not committable on the PR.
        { file: 'b.ts', line: 8, severity: 'nit', message: 'meh', suggestion: 'const y = 2' },
      ],
      reviewComments: [
        {
          path: 'a.ts',
          line: 3,
          side: 'RIGHT',
          body:
            '**argus-reviewer bug:** boom\n\n' +
            '````suggestion\nconst x = 1\n````\n\n' +
            '*Suggested change — review before committing.*',
          dedupKey: 'k1',
        },
        {
          path: 'b.ts',
          line: 8,
          side: 'RIGHT',
          body: '**argus-reviewer nit:** meh',
          dedupKey: 'k2',
        },
      ],
    })

    const body = renderStickyBody(runReport, cr, 'https://github.com/run/1', false, undefined)

    expect(body).toContain('🔧 1 suggestion\n')
    expect(body).not.toContain('🔧 2')
  })

  it('renders the same top block in the review-only body', () => {
    const cr = review({
      findings: [
        {
          file: 'a.ts',
          line: 3,
          severity: 'bug',
          message: 'boom',
          evidence: { status: 'reproduced', detail: 'fails on head' },
        },
      ],
      provenBlockers: 1,
      reviewEvent: 'request_changes',
    })

    const body = renderReviewOnlyBody(cr, 'https://github.com/run/1', false, undefined)

    expect(body.indexOf('**Code review:**')).toBeLessThan(body.indexOf('<details>'))
    expect(body).toContain('⛔ 1 reproduced')
  })
})

// U3 — the poster consumes the serialized `reviewComments[]`/`reviewEvent`
// surface end-to-end through the `run(runtime)` seam with a mocked octokit.
describe('action review poster (U3)', () => {
  const HEAD = 'headsha0000000000000000000000000000000000'
  const POSTER_ENV_KEYS = [
    'OPENROUTER_API_KEY',
    'GITHUB_WORKSPACE',
    'GITHUB_SERVER_URL',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'VISION_E2E_WORKING_DIR',
    'ARGUS_REPORT_DIR',
    'ARGUS_RUN_DISABLED',
  ]

  let workspace: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'argus-poster-'))
    savedEnv = Object.fromEntries(POSTER_ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env.OPENROUTER_API_KEY = 'test-key'
    process.env.GITHUB_WORKSPACE = workspace
    process.env.GITHUB_SERVER_URL = 'https://github.com'
    process.env.GITHUB_RUN_ID = '1'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.ARGUS_RUN_DISABLED = '1'
    delete process.env.VISION_E2E_WORKING_DIR
    delete process.env.ARGUS_REPORT_DIR
  })

  afterEach(() => {
    for (const k of POSTER_ENV_KEYS) {
      if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = savedEnv[k]
    }
  })

  function comment(path: string, line: number, body: string, suggestion = '') {
    return {
      path,
      line,
      side: 'RIGHT',
      body,
      dedupKey: `${path}:${line}:${body.split('\n')[0]}:${shortHash(suggestion)}`,
    }
  }

  function codeReview(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      skipped: false,
      summary: 'summary',
      verdict: 'needs_changes',
      findings: [],
      model: 'test/model',
      tokens: 0,
      visionCostUsd: 0,
      reviewEvent: 'comment',
      provenBlockers: 0,
      highConfidenceBlockers: 0,
      reviewComments: [],
      commentsOverflow: 0,
      maxComments: 20,
      headBinding: {
        intendedSha: HEAD,
        checkoutSha: HEAD,
        status: 'match',
        source: 'github',
        detail: 'checkout matches the intended PR head',
      },
      ...overrides,
    }
  }

  async function writeReport(report: Record<string, unknown>) {
    await mkdir(join(workspace, 'argus-reviewer-report'), { recursive: true })
    await writeFile(
      join(workspace, 'argus-reviewer-report', 'code-review.json'),
      JSON.stringify(report),
    )
  }

  function makeRuntime(overrides: Record<string, unknown> = {}) {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const warnings: string[] = []
    const record =
      (method: string, impl?: (params: Record<string, unknown>) => Promise<unknown>) =>
      async (params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (impl !== undefined) return impl(params)
        return { data: {} }
      }
    const github = {
      rest: {
        pulls: {
          listReviewComments: async () => ({ data: [] }),
          listFiles: async () => ({ data: [] }),
          listReviews: async () => ({ data: [] }),
          createReview: record('createReview'),
          dismissReview: record('dismissReview'),
          ...(overrides.pulls as Record<string, unknown> | undefined),
        },
        issues: {
          listComments: record('listComments', async () => ({ data: [] })),
          createComment: record('createComment'),
          updateComment: record('updateComment'),
        },
        repos: { createCommitStatus: record('createCommitStatus') },
      },
    }
    const context = {
      actor: 'github-actions[bot]',
      repo: { owner: 'o', repo: 'r' },
      sha: HEAD,
      payload: { pull_request: { number: 7, head: { sha: HEAD } } },
    }
    const core = { warning: (m: string) => warnings.push(m), setOutput: () => {} }
    return { runtime: { github, context, core }, calls, warnings }
  }

  const A_TS_PATCH = '@@ -1,2 +1,4 @@\n ctx\n+added1\n+added2\n+added3'

  it('posts one batched review with the serialized comments and event', async () => {
    const c = comment('a.ts', 3, '**argus-reviewer bug:** broken `correctness`')
    await writeReport(codeReview({ reviewComments: [c] }))
    const { runtime, calls } = makeRuntime({
      pulls: { listFiles: async () => ({ data: [{ filename: 'a.ts', patch: A_TS_PATCH }] }) },
    })

    await run(runtime)

    const reviews = calls.filter((x) => x.method === 'createReview')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].params.event).toBe('COMMENT')
    expect(reviews[0].params.commit_id).toBe(HEAD)
    const posted = reviews[0].params.comments as Record<string, unknown>[]
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual({ path: 'a.ts', line: 3, side: 'RIGHT', body: c.body })
    expect(posted[0].dedupKey).toBeUndefined()
  })

  it('posts REQUEST_CHANGES when the report gates it', async () => {
    await writeReport(codeReview({ reviewEvent: 'request_changes' }))
    const { runtime, calls } = makeRuntime()

    await run(runtime)

    const reviews = calls.filter((x) => x.method === 'createReview')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].params.event).toBe('REQUEST_CHANGES')
    expect(reviews[0].params.body).toContain('<!-- argus-reviewer -->')
  })

  it('skips the review on a head-binding mismatch and still posts the sticky', async () => {
    const c = comment('a.ts', 3, '**argus-reviewer bug:** stale')
    await writeReport(
      codeReview({
        reviewComments: [c],
        headBinding: {
          intendedSha: 'othersha',
          checkoutSha: 'othersha',
          status: 'match',
          source: 'github',
          detail: 'stale report',
        },
      }),
    )
    const { runtime, calls, warnings } = makeRuntime()

    await run(runtime)

    expect(calls.filter((x) => x.method === 'createReview')).toHaveLength(0)
    expect(warnings.some((w) => w.includes('head binding'))).toBe(true)
    expect(calls.filter((x) => x.method === 'createComment')).toHaveLength(1)
  })

  it('retries a failed REQUEST_CHANGES as COMMENT with a downgrade note', async () => {
    const c = comment('a.ts', 3, '**argus-reviewer bug:** broken')
    await writeReport(codeReview({ reviewEvent: 'request_changes', reviewComments: [c] }))
    let attempts = 0
    const { runtime, calls } = makeRuntime({
      pulls: {
        listFiles: async () => ({ data: [{ filename: 'a.ts', patch: A_TS_PATCH }] }),
        createReview: async (params: Record<string, unknown>) => {
          calls.push({ method: 'createReview', params })
          attempts += 1
          if (attempts === 1) {
            throw Object.assign(new Error('Resource not accessible by integration'), {
              status: 403,
            })
          }
          return { data: {} }
        },
      },
    })

    await run(runtime)

    const reviews = calls.filter((x) => x.method === 'createReview')
    expect(reviews).toHaveLength(2)
    expect(reviews[0].params.event).toBe('REQUEST_CHANGES')
    expect(reviews[1].params.event).toBe('COMMENT')
    expect(reviews[1].params.body).toContain('REQUEST_CHANGES downgraded to COMMENT')
    expect(reviews[1].params.body).toContain('Resource not accessible')
  })

  it('dismisses a prior self CHANGES_REQUESTED before posting', async () => {
    const c = comment('a.ts', 3, '**argus-reviewer bug:** broken')
    await writeReport(codeReview({ reviewComments: [c] }))
    const { runtime, calls } = makeRuntime({
      pulls: {
        listFiles: async () => ({ data: [{ filename: 'a.ts', patch: A_TS_PATCH }] }),
        listReviews: async () => ({
          data: [
            {
              id: 9,
              state: 'CHANGES_REQUESTED',
              user: { login: 'github-actions[bot]' },
              body: '<!-- argus-reviewer -->\nold run',
            },
            {
              id: 10,
              state: 'CHANGES_REQUESTED',
              user: { login: 'alice' },
              body: 'please fix this',
            },
          ],
        }),
      },
    })

    await run(runtime)

    const dismissed = calls.filter((x) => x.method === 'dismissReview')
    expect(dismissed).toHaveLength(1)
    expect(dismissed[0].params.review_id).toBe(9)
    const order = calls.map((x) => x.method)
    expect(order.indexOf('dismissReview')).toBeLessThan(order.indexOf('createReview'))
  })

  it('drops comments whose anchor is not a RIGHT-side diff line', async () => {
    const on = comment('a.ts', 3, '**argus-reviewer bug:** on diff')
    const off = comment('a.ts', 99, '**argus-reviewer risk:** off diff')
    const absent = comment('b.ts', 3, '**argus-reviewer bug:** not in files')
    await writeReport(
      codeReview({
        reviewComments: [on, off, absent],
        findings: [
          { file: 'a.ts', line: 3, severity: 'bug', category: 'correctness', message: 'x' },
        ],
      }),
    )
    const { runtime, calls } = makeRuntime({
      pulls: { listFiles: async () => ({ data: [{ filename: 'a.ts', patch: A_TS_PATCH }] }) },
    })

    await run(runtime)

    const reviews = calls.filter((x) => x.method === 'createReview')
    expect(reviews).toHaveLength(1)
    const posted = reviews[0].params.comments as Record<string, unknown>[]
    expect(posted).toHaveLength(1)
    expect(posted[0].line).toBe(3)
    const sticky = calls.find((x) => x.method === 'createComment')
    expect(sticky?.params.body).toContain('outside the PR diff')
  })

  it('posts nothing for an old-format report without reviewComments', async () => {
    const legacy = codeReview()
    delete (legacy as Record<string, unknown>).reviewComments
    delete (legacy as Record<string, unknown>).reviewEvent
    legacy.findings = [
      { file: 'a.ts', line: 3, severity: 'bug', category: 'correctness', message: 'x' },
    ] as never
    await writeReport(legacy)
    const { runtime, calls } = makeRuntime()

    await run(runtime)

    expect(calls.filter((x) => x.method === 'createReview')).toHaveLength(0)
    expect(calls.filter((x) => x.method === 'createComment')).toHaveLength(1)
    expect(calls.filter((x) => x.method === 'createCommitStatus')).toHaveLength(1)
  })

  it('posts a suggestion-bearing comment body verbatim', async () => {
    const body =
      '**argus-reviewer bug:** fix this\n\n' +
      '````suggestion\nconst x = 1\n````\n\n' +
      '*Suggested change — review before committing.*'
    const c = comment('a.ts', 3, body, 'const x = 1')
    await writeReport(codeReview({ reviewComments: [c] }))
    const { runtime, calls } = makeRuntime({
      pulls: { listFiles: async () => ({ data: [{ filename: 'a.ts', patch: A_TS_PATCH }] }) },
    })

    await run(runtime)

    const reviews = calls.filter((x) => x.method === 'createReview')
    expect(reviews).toHaveLength(1)
    const posted = reviews[0].params.comments as Record<string, unknown>[]
    expect(posted[0].body).toBe(body)
  })

  it('dedups on the serialized dedupKey reconstructed from a posted body', async () => {
    const body =
      '**argus-reviewer bug:** fix this\n\n' +
      '````suggestion\nconst x = 1\n````\n\n' +
      '*Suggested change — review before committing.*'
    const c = comment('a.ts', 3, body, 'const x = 1')
    await writeReport(codeReview({ reviewComments: [c] }))
    const { runtime, calls } = makeRuntime({
      pulls: {
        listReviewComments: async () => ({
          data: [
            { path: 'a.ts', line: 3, commit_id: HEAD, body },
            // Same text on an older commit must NOT suppress the finding.
            { path: 'other.ts', line: 5, commit_id: 'oldsha', body: '**argus-reviewer bug:** x' },
          ],
        }),
        listFiles: async () => ({ data: [{ filename: 'a.ts', patch: A_TS_PATCH }] }),
      },
    })

    await run(runtime)

    expect(calls.filter((x) => x.method === 'createReview')).toHaveLength(0)
  })
})

// U5/AE-C — the PR comment, the TUI, and the dashboard all render the same
// manifest contract. The TS renderer (comment.ts → viewmodel.ts) and the
// action's plain-node block (sticky-comment.cjs) must produce identical lane
// rows from identical input; this test is the agreement enforcement.
describe('manifest comment parity (U5)', () => {
  const manifest = fixtureManifest()

  function laneRows(body: string): string[] {
    return body
      .split('\n')
      .filter((l) => /^\| (review|flow|app|a0) \|/.test(l))
  }

  it('the action lane block and the shared view-model render identical rows', () => {
    const cjsBody = renderManifestLanes(manifest).join('\n')
    const tsBody = renderManifestComment(manifest)
    const cjsRows = laneRows(cjsBody)
    const tsRows = laneRows(tsBody)
    expect(cjsRows).toHaveLength(4)
    expect(cjsRows).toEqual(tsRows)
    // Status is always a word, never color-only.
    expect(tsRows.join('\n')).toContain('inconclusive')
    expect(tsRows.join('\n')).toContain('unmetered')
  })

  it('the header and cache line agree across renderers', () => {
    const cjsBody = renderManifestLanes(manifest).join('\n')
    const tsBody = renderManifestComment(manifest)
    for (const text of [
      '| Lane | Status | Calls | Cost | Detail |',
      '**Fingerprint cache:** 2 hit(s) · 1 miss(es) · 1 heal(s)',
    ]) {
      expect(cjsBody).toContain(text)
      expect(tsBody).toContain(text)
    }
  })

  it('hostile detail strings — pipes, newlines, and 200+ chars — render identically', () => {
    const hostile = fixtureManifest()
    hostile.lanes.app.reason =
      'line one\nline two | pipe-break ' + 'x'.repeat(250)
    hostile.lanes.flow.reason = 'secret sk-or-v1-leak-here inside'
    const cjsRows = laneRows(renderManifestLanes(hostile).join('\n'))
    const tsRows = laneRows(renderManifestComment(hostile))
    expect(cjsRows).toEqual(tsRows)
    // The token is masked and the pipe is escaped — the raw two-line
    // reason must not break the table row.
    for (const row of tsRows) {
      expect(row).not.toContain('sk-or-v1-leak-here')
    }
    const appRow = tsRows.find((r) => r.startsWith('| app |')) ?? ''
    expect(appRow).toContain('line one line two \\| pipe-break')
    // Five column delimiters; every other pipe must be backslash-escaped.
    expect(appRow.match(/(?<!\\)\|/g)).toHaveLength(6)
  })

  it('a verify run with only a manifest renders the lane block in the sticky', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'argus-manifest-sticky-'))
    const saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      ARGUS_RUN_DISABLED: process.env.ARGUS_RUN_DISABLED,
      ARGUS_REPORT_DIR: process.env.ARGUS_REPORT_DIR,
    }
    try {
      process.env.OPENROUTER_API_KEY = 'test-key'
      process.env.GITHUB_WORKSPACE = workspace
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      process.env.GITHUB_RUN_ID = '1'
      process.env.GITHUB_RUN_ATTEMPT = '1'
      delete process.env.ARGUS_RUN_DISABLED
      delete process.env.ARGUS_REPORT_DIR
      await mkdir(join(workspace, 'argus-reviewer-report'), { recursive: true })
      const boundManifest = fixtureManifest()
      boundManifest.identity.intendedHeadSha = 'h'.repeat(40)
      boundManifest.identity.runNonce = '1:1'
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'run-manifest.json'),
        JSON.stringify(boundManifest),
      )
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'code-review.json'),
        JSON.stringify({ ok: true, skipped: false, findings: [], reviewComments: [] }),
      )
      const calls: { method: string; params: Record<string, unknown> }[] = []
      const record =
        (method: string, impl?: (params: Record<string, unknown>) => Promise<unknown>) =>
        async (params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (impl !== undefined) return impl(params)
          return { data: {} }
        }
      const runtime = {
        github: {
          rest: {
            pulls: {
              listReviewComments: async () => ({ data: [] }),
              listFiles: async () => ({ data: [] }),
              listReviews: async () => ({ data: [] }),
              createReview: record('createReview'),
              dismissReview: record('dismissReview'),
            },
            issues: {
              listComments: record('listComments', async () => ({ data: [] })),
              createComment: record('createComment'),
              updateComment: record('updateComment'),
            },
            repos: { createCommitStatus: record('createCommitStatus') },
          },
        },
        context: {
          actor: 'github-actions[bot]',
          repo: { owner: 'o', repo: 'r' },
          sha: 'h'.repeat(40),
          payload: { pull_request: { number: 7, head: { sha: 'h'.repeat(40) } } },
        },
        core: { warning: () => {}, setOutput: () => {} },
      }

      await run(runtime)

      const sticky = calls.find((c) => c.method === 'createComment')
      expect(sticky).toBeDefined()
      const body = sticky!.params.body as string
      expect(body).toContain('## argus-reviewer ❌ FAILED')
      expect(body).toContain('| a0 | 🟡 inconclusive | 0 | unmetered |')
      // The manifest aggregate is the verdict — no run.json exists.
      const status = calls.find((c) => c.method === 'createCommitStatus')
      expect(status!.params.state).toBe('failure')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  })

  it('the manifest body masks secret-shaped lane evidence', () => {
    const m = fixtureManifest()
    m.lanes.flow.reason = 'provider rejected sk-or-v1-abcdef12345'
    const body = renderManifestBody(m, undefined, undefined)
    expect(body).not.toContain('sk-or-v1-abcdef12345')
    expect(body).toContain('•••')
  })

  it('a manifest bound to another head is ignored for the verdict and the comment says so', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'argus-stale-manifest-'))
    const saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      ARGUS_RUN_DISABLED: process.env.ARGUS_RUN_DISABLED,
      ARGUS_REPORT_DIR: process.env.ARGUS_REPORT_DIR,
    }
    try {
      process.env.OPENROUTER_API_KEY = 'test-key'
      process.env.GITHUB_WORKSPACE = workspace
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      process.env.GITHUB_RUN_ID = '1'
      process.env.GITHUB_RUN_ATTEMPT = '1'
      delete process.env.ARGUS_RUN_DISABLED
      delete process.env.ARGUS_REPORT_DIR
      await mkdir(join(workspace, 'argus-reviewer-report'), { recursive: true })
      // A passing manifest whose identity binds a DIFFERENT head — residue
      // or plant must never launder a verdict for this commit.
      const stale = fixtureManifest()
      stale.aggregate.ok = true
      stale.aggregate.status = 'passed'
      stale.identity.intendedHeadSha = 'f'.repeat(40)
      stale.identity.runNonce = '1:1'
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'run-manifest.json'),
        JSON.stringify(stale),
      )
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'code-review.json'),
        JSON.stringify({ ok: false, skipped: false, findings: [], reviewComments: [] }),
      )
      const calls: { method: string; params: Record<string, unknown> }[] = []
      const record =
        (method: string, impl?: (params: Record<string, unknown>) => Promise<unknown>) =>
        async (params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (impl !== undefined) return impl(params)
          return { data: {} }
        }
      const runtime = {
        github: {
          rest: {
            pulls: {
              listReviewComments: async () => ({ data: [] }),
              listFiles: async () => ({ data: [] }),
              listReviews: async () => ({ data: [] }),
              createReview: record('createReview'),
              dismissReview: record('dismissReview'),
            },
            issues: {
              listComments: record('listComments', async () => ({ data: [] })),
              createComment: record('createComment'),
              updateComment: record('updateComment'),
            },
            repos: { createCommitStatus: record('createCommitStatus') },
          },
        },
        context: {
          actor: 'github-actions[bot]',
          repo: { owner: 'o', repo: 'r' },
          sha: 'h'.repeat(40),
          payload: { pull_request: { number: 7, head: { sha: 'h'.repeat(40) } } },
        },
        core: { warning: () => {}, setOutput: () => {} },
      }

      await run(runtime)

      // code-review.json failed → verdict must stay failure even though a
      // "passing" manifest exists on disk.
      const status = calls.find((c) => c.method === 'createCommitStatus')
      expect(status!.params.state).toBe('failure')
      const sticky = calls.find((c) => c.method === 'createComment')
      const body = sticky!.params.body as string
      expect(body).toContain('head/run binding does not')
      expect(body).not.toContain('| a0 |')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  })

  it('a manifest bound to this head but not this run is ignored — the plant vector', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'argus-nonce-manifest-'))
    const saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      ARGUS_RUN_DISABLED: process.env.ARGUS_RUN_DISABLED,
      ARGUS_REPORT_DIR: process.env.ARGUS_REPORT_DIR,
    }
    try {
      process.env.OPENROUTER_API_KEY = 'test-key'
      process.env.GITHUB_WORKSPACE = workspace
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      process.env.GITHUB_RUN_ID = '1'
      process.env.GITHUB_RUN_ATTEMPT = '1'
      delete process.env.ARGUS_RUN_DISABLED
      delete process.env.ARGUS_REPORT_DIR
      await mkdir(join(workspace, 'argus-reviewer-report'), { recursive: true })
      // The head sha is public — a planted manifest can always present it.
      // The run nonce is not, so a perfect-looking manifest with a foreign
      // (or absent) nonce must not launder a verdict.
      const planted = fixtureManifest()
      planted.aggregate.ok = true
      planted.aggregate.status = 'passed'
      planted.identity.intendedHeadSha = 'h'.repeat(40)
      planted.identity.runNonce = '999:1'
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'run-manifest.json'),
        JSON.stringify(planted),
      )
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'code-review.json'),
        JSON.stringify({ ok: false, skipped: false, findings: [], reviewComments: [] }),
      )
      const calls: { method: string; params: Record<string, unknown> }[] = []
      const record =
        (method: string, impl?: (params: Record<string, unknown>) => Promise<unknown>) =>
        async (params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (impl !== undefined) return impl(params)
          return { data: {} }
        }
      const runtime = {
        github: {
          rest: {
            pulls: {
              listReviewComments: async () => ({ data: [] }),
              listFiles: async () => ({ data: [] }),
              listReviews: async () => ({ data: [] }),
              createReview: record('createReview'),
              dismissReview: record('dismissReview'),
            },
            issues: {
              listComments: record('listComments', async () => ({ data: [] })),
              createComment: record('createComment'),
              updateComment: record('updateComment'),
            },
            repos: { createCommitStatus: record('createCommitStatus') },
          },
        },
        context: {
          actor: 'github-actions[bot]',
          repo: { owner: 'o', repo: 'r' },
          sha: 'h'.repeat(40),
          payload: { pull_request: { number: 7, head: { sha: 'h'.repeat(40) } } },
        },
        core: { warning: () => {}, setOutput: () => {} },
      }

      await run(runtime)

      const status = calls.find((c) => c.method === 'createCommitStatus')
      expect(status!.params.state).toBe('failure')
      const sticky = calls.find((c) => c.method === 'createComment')
      const body = sticky!.params.body as string
      expect(body).toContain('head/run binding does not')
      expect(body).not.toContain('| a0 |')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  })

  it('a shallow manifest-shaped file fails validation — aggregate.ok alone is not evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'argus-forge-manifest-'))
    const saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      ARGUS_RUN_DISABLED: process.env.ARGUS_RUN_DISABLED,
      ARGUS_REPORT_DIR: process.env.ARGUS_REPORT_DIR,
    }
    try {
      process.env.OPENROUTER_API_KEY = 'test-key'
      process.env.GITHUB_WORKSPACE = workspace
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      process.env.GITHUB_RUN_ID = '1'
      process.env.GITHUB_RUN_ATTEMPT = '1'
      delete process.env.ARGUS_RUN_DISABLED
      delete process.env.ARGUS_REPORT_DIR
      await mkdir(join(workspace, 'argus-reviewer-report'), { recursive: true })
      // The minimal forge: aggregate.ok + lanes + correct head binding —
      // rejected because it lacks the manifest's full shape (schemaVersion,
      // per-lane usage/budget, known statuses).
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'run-manifest.json'),
        JSON.stringify({
          aggregate: { ok: true, status: 'passed' },
          lanes: {},
          identity: { intendedHeadSha: 'h'.repeat(40) },
        }),
      )
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'code-review.json'),
        JSON.stringify({ ok: false, skipped: false, findings: [], reviewComments: [] }),
      )
      const calls: { method: string; params: Record<string, unknown> }[] = []
      const record =
        (method: string, impl?: (params: Record<string, unknown>) => Promise<unknown>) =>
        async (params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (impl !== undefined) return impl(params)
          return { data: {} }
        }
      const runtime = {
        github: {
          rest: {
            pulls: {
              listReviewComments: async () => ({ data: [] }),
              listFiles: async () => ({ data: [] }),
              listReviews: async () => ({ data: [] }),
              createReview: record('createReview'),
              dismissReview: record('dismissReview'),
            },
            issues: {
              listComments: record('listComments', async () => ({ data: [] })),
              createComment: record('createComment'),
              updateComment: record('updateComment'),
            },
            repos: { createCommitStatus: record('createCommitStatus') },
          },
        },
        context: {
          actor: 'github-actions[bot]',
          repo: { owner: 'o', repo: 'r' },
          sha: 'h'.repeat(40),
          payload: { pull_request: { number: 7, head: { sha: 'h'.repeat(40) } } },
        },
        core: { warning: () => {}, setOutput: () => {} },
      }

      await run(runtime)

      const status = calls.find((c) => c.method === 'createCommitStatus')
      expect(status!.params.state).toBe('failure')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  })

  it('an all-skipped manifest resolves neutral, not failure — the push-event contract', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'argus-skipped-manifest-'))
    const saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      ARGUS_RUN_DISABLED: process.env.ARGUS_RUN_DISABLED,
      ARGUS_REPORT_DIR: process.env.ARGUS_REPORT_DIR,
    }
    try {
      process.env.OPENROUTER_API_KEY = 'test-key'
      process.env.GITHUB_WORKSPACE = workspace
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      process.env.GITHUB_RUN_ID = '1'
      process.env.GITHUB_RUN_ATTEMPT = '1'
      delete process.env.ARGUS_RUN_DISABLED
      delete process.env.ARGUS_REPORT_DIR
      await mkdir(join(workspace, 'argus-reviewer-report'), { recursive: true })
      // Push event shape: no pull_request in the payload; the review lane
      // legitimately skipped. A 'failure' status here punishes a lane that
      // could never run.
      const skipped = fixtureManifest()
      for (const id of ['review', 'flow', 'app', 'a0'] as const) {
        skipped.lanes[id] = fixtureLane(id, { selected: true, status: 'skipped' })
      }
      skipped.aggregate.status = 'skipped'
      skipped.aggregate.ok = false
      skipped.aggregate.calls = 0
      skipped.aggregate.tokens = 0
      skipped.aggregate.costUsd = 0
      skipped.identity.intendedHeadSha = 'h'.repeat(40)
      skipped.identity.runNonce = '1:1'
      await writeFile(
        join(workspace, 'argus-reviewer-report', 'run-manifest.json'),
        JSON.stringify(skipped),
      )
      const calls: { method: string; params: Record<string, unknown> }[] = []
      const record =
        (method: string, impl?: (params: Record<string, unknown>) => Promise<unknown>) =>
        async (params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (impl !== undefined) return impl(params)
          return { data: {} }
        }
      const runtime = {
        github: {
          rest: {
            pulls: {
              listReviewComments: async () => ({ data: [] }),
              listFiles: async () => ({ data: [] }),
              listReviews: async () => ({ data: [] }),
              createReview: record('createReview'),
              dismissReview: record('dismissReview'),
            },
            issues: {
              listComments: record('listComments', async () => ({ data: [] })),
              createComment: record('createComment'),
              updateComment: record('updateComment'),
            },
            repos: { createCommitStatus: record('createCommitStatus') },
          },
        },
        context: {
          actor: 'github-actions[bot]',
          repo: { owner: 'o', repo: 'r' },
          sha: 'h'.repeat(40),
          payload: {},
        },
        core: { warning: () => {}, setOutput: () => {} },
      }

      await run(runtime)

      const status = calls.find((c) => c.method === 'createCommitStatus')
      expect(status!.params.state).toBe('success')
      expect(status!.params.description).toBe('argus-reviewer skipped (no lanes ran)')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  })
})

// Validator parity — the same manifest reaches three independent validators
// (viewmodel.isRunManifest, collect.mjs's stale-dist fallback, and the action
// poster's gate). They are maintained in parallel by design (no shared dep),
// so this corpus is the lockstep enforcement: every entry must get an
// identical accept/reject from all three.
describe('manifest validator parity', () => {
  const mut = (fn: (m: ReturnType<typeof fixtureManifest>) => void) => {
    const m = fixtureManifest()
    fn(m)
    return m
  }
  const corpus: [string, unknown][] = [
    ['a well-formed manifest is accepted', fixtureManifest()],
    ['shallow forge — aggregate.ok alone', { aggregate: { ok: true, status: 'passed' }, lanes: {}, identity: {} }],
    ['top-level array', []],
    ['schemaVersion drift', mut((m) => ((m as { schemaVersion: number }).schemaVersion = 2))],
    ['runId is not a string', mut((m) => ((m as { runId: unknown }).runId = 42))],
    ['missing startedAt', mut((m) => delete (m as { startedAt?: string }).startedAt)],
    ['identity is an array', mut((m) => ((m as { identity: unknown }).identity = []))],
    ['identity.runNonce is a number', mut((m) => ((m.identity as { runNonce: unknown }).runNonce = 99))],
    ['identity.intendedHeadSha is a number', mut((m) => ((m.identity as { intendedHeadSha: unknown }).intendedHeadSha = 42))],
    ['aggregate is null', mut((m) => ((m as { aggregate: unknown }).aggregate = null))],
    ['identity is null', mut((m) => ((m as { identity: unknown }).identity = null))],
    ['aggregate.ok is a string', mut((m) => ((m.aggregate as { ok: unknown }).ok = 'true'))],
    ['aggregate.status is not a lane status', mut((m) => ((m.aggregate as { status: string }).status = 'green'))],
    ['aggregate.calls is a string', mut((m) => ((m.aggregate as { calls: unknown }).calls = '4'))],
    ['aggregate.tokens is NaN', mut((m) => ((m.aggregate as { tokens: number }).tokens = NaN))],
    ['a canonical lane is missing', mut((m) => delete (m.lanes as { app?: unknown }).app)],
    ['lane.lane mismatches its key', mut((m) => ((m.lanes.app as { lane: string }).lane = 'review'))],
    ['lane.status is not a lane status', mut((m) => ((m.lanes.flow as { status: string }).status = 'green'))],
    ['lane.selected is a string', mut((m) => ((m.lanes.review as { selected: unknown }).selected = 'yes'))],
    ['lane.usage.calls is a string', mut((m) => ((m.lanes.review.usage as { calls: unknown }).calls = 'x'))],
    ['lane.budget is null', mut((m) => ((m.lanes.a0 as { budget: unknown }).budget = null))],
    ['lane.usage is null', mut((m) => ((m.lanes.app as { usage: unknown }).usage = null))],
    ['lane itself is null', mut((m) => ((m.lanes as { flow: unknown }).flow = null))],
    ['lanes is null', mut((m) => ((m as { lanes: unknown }).lanes = null))],
  ]

  it.each(corpus)('all three validators agree: %s', async (_name, m) => {
    const { isRunManifest } = await import('../../src/report/viewmodel.js')
    // @ts-expect-error plain-node collector — no type declarations
    const { validManifest: collectValid } = await import('../../scripts/collect.mjs')
    // @ts-expect-error plain-node action helper — no type declarations
    const { validManifest: stickyValid } = await import('../../action/sticky-comment.cjs')
    const verdicts = [isRunManifest(m), collectValid(m), stickyValid(m)]
    expect(new Set(verdicts).size, `verdicts ${JSON.stringify(verdicts)}`).toBe(1)
  })
})
