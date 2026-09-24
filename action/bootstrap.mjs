#!/usr/bin/env node
import { copyFile, mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  assertRegularFile,
  assertRegularFileInside,
  parseCommand,
  resolveWorkingDirectory,
  setActionOutput,
  validateBrowser,
  validateBudget,
  validateMaxComments,
  validatePathInput,
  validateVersion,
} from './runtime.mjs'

const actionDir = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd())
const cwd = resolveWorkingDirectory(workspace, process.env.ARGUS_WORKING_DIRECTORY)
const configInput = validatePathInput(process.env.ARGUS_CONFIG_PATH, 'config')
const reportDir = validatePathInput(
  process.env.ARGUS_REPORT_DIR || 'argus-reviewer-report',
  'report-dir',
)
validateBrowser(process.env.ARGUS_BROWSER || 'chromium')
validateBudget(process.env.ARGUS_BUDGET_USD)
validateMaxComments(process.env.ARGUS_MAX_COMMENTS)

async function stageConfig() {
  if (configInput === '' || configInput === 'argus-reviewer.config.ts') return
  const ext = configInput.slice(configInput.lastIndexOf('.')).toLowerCase()
  if (ext !== '.ts' && ext !== '.json') {
    throw new Error(`config must use .ts or .json, got: ${configInput}`)
  }
  const source = await assertRegularFile(
    assertRegularFileInside(cwd, configInput, 'config'),
    'config',
  )
  if (source === join(cwd, `argus-reviewer.config${ext}`)) return
  await copyFile(source, join(cwd, `argus-reviewer.config${ext}`))
}

await stageConfig()

let cli
const override = process.env.ARGUS_CLI?.trim() ?? ''
if (override !== '') {
  cli = parseCommand(override)
} else {
  const version = process.env.ARGUS_ARGUS_VERSION?.trim() ?? ''
  if (version === '') {
    const runtime = await mkdtemp(join(tmpdir(), 'argus-reviewer-action-pinned-'))
    const result = spawnSync(
      'npm',
      [
        'install',
        '--prefix',
        runtime,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        resolve(actionDir, '..'),
      ],
      { stdio: 'inherit', shell: false },
    )
    if (result.status !== 0) throw new Error('could not install the CLI from the pinned action ref')
    cli = [process.execPath, join(runtime, 'node_modules', 'argus-reviewer-e2e', 'dist', 'cli.js')]
  } else {
    validateVersion(version)
    const runtime = await mkdtemp(join(tmpdir(), `argus-reviewer-action-${version}-`))
    const result = spawnSync(
      'npm',
      [
        'install',
        '--prefix',
        runtime,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        `argus-reviewer-e2e@${version}`,
      ],
      { stdio: 'inherit', shell: false },
    )
    if (result.status !== 0) {
      throw new Error(`could not bootstrap pinned argus-reviewer-e2e@${version}`)
    }
    cli = [process.execPath, join(runtime, 'node_modules', 'argus-reviewer-e2e', 'dist', 'cli.js')]
  }
}

setActionOutput('cli-json', JSON.stringify(cli))
setActionOutput('working-directory', cwd)
setActionOutput('report-dir', reportDir)
console.log(`argus action: prepared ${cli[0]} in ${cwd}`)
