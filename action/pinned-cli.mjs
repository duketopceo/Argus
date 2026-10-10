#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Resolve the CLI for a pinned-action checkout. The checkout already carries
 * a committed dist/ — it only needs production deps. `npm install <folder>`
 * is wrong here: npm packs the folder and runs its `prepare` (tsc) without
 * devDependencies installed, which dies on @types/node. `npm ci --omit=dev
 * --ignore-scripts` installs the locked prod graph with every lifecycle
 * script off. Skipped when node_modules already exists (dev checkouts, test
 * runs) so bootstrap never clobbers a working install.
 *
 * deps are injectable so tests can assert the install contract without
 * running npm.
 */
export function resolvePinnedCli(
  repoRoot,
  deps = { existsSync, spawnSync, execPath: process.execPath },
) {
  if (!deps.existsSync(join(repoRoot, 'node_modules'))) {
    const result = deps.spawnSync(
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { stdio: 'inherit', shell: false, cwd: repoRoot },
    )
    if (result.status !== 0) {
      throw new Error('could not install CLI deps from the pinned action ref')
    }
  }
  return [deps.execPath, join(repoRoot, 'dist', 'cli.js')]
}
