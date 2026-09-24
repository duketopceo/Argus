import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// @ts-expect-error plain-node action helper — no type declarations
import {
  assertRegularFile,
  assertRegularFileInside,
  parseCommand,
  resolveWorkingDirectory,
  validateBrowser,
  validateBudget,
  validateMaxComments,
  validateVersion,
} from '../../action/runtime.mjs'

// @ts-expect-error plain-node action helper — no type declarations
import { renderBody as renderStickyBody } from '../../action/sticky-comment.cjs'

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
      { capped: [], dropped: 0, cap: 20 },
    )

    expect(body).toContain('**Fingerprint cache:** 3 hit(s) · 2 miss(es) · 1 heal(s)')
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
