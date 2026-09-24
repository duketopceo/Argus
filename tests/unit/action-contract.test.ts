import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// @ts-expect-error plain-node action helper — no type declarations
import {
  parseCommand,
  resolveWorkingDirectory,
  validateBrowser,
  validateBudget,
  validateMaxComments,
  validateVersion,
} from '../../action/runtime.mjs'

const execFileAsync = promisify(execFile)
const ACTION = join(process.cwd(), 'action')

describe('action input contract', () => {
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
    expect(resolveWorkingDirectory(root, 'apps/web')).toBe(join(root, 'apps/web'))
    expect(() => resolveWorkingDirectory(root, '../outside')).toThrow(/inside/)
  })

  it('uses safe action wiring: pinned bootstrap, no dynamic source evaluation, opt-in runtime install', async () => {
    const action = await readFile(join(ACTION, 'action.yml'), 'utf8')
    expect(action).toContain('argus-version:')
    expect(action).toContain("default: '0.2.0'")
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
  })

  it('keeps the repository workflow on a pinned action and runs local action checks without secrets', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/argus-reviewer.yml'),
      'utf8',
    )
    expect(workflow).toContain('uses: duketopceo/Argus/action@v0.2.0')
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
