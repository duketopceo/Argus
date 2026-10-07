// Rebuild action/parity.cjs to a temp file and diff it against the
// committed copy — fails if the bundle is stale relative to src/.
// The action loads this file via require(), so it is committed on purpose
// (same contract as dist/).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(mkdtempSync(join(tmpdir(), 'argus-parity-')), 'parity.cjs')
execFileSync(
  'npx',
  [
    'esbuild',
    'action/parity-entry.mjs',
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node20',
    '--banner:js=/* eslint-disable */ /* GENERATED - do not edit; npm run build:parity */',
    `--outfile=${out}`,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)
const fresh = readFileSync(out, 'utf8')
rmSync(out, { force: true, recursive: true })
const committed = readFileSync('action/parity.cjs', 'utf8')
if (fresh !== committed) {
  console.error('action/parity.cjs is stale - run `npm run build:parity` and commit the result.')
  process.exit(1)
}
console.log('action/parity.cjs is up to date.')
