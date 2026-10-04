/**
 * Per-run temp root.
 *
 * Many suites (and the CLI/Playwright subprocesses they spawn) create dirs
 * under os.tmpdir(). Pointing TMPDIR at one directory for the whole run and
 * deleting it at teardown guarantees a full `vitest run` leaves zero new
 * entries in the real OS tmpdir, even when an individual test forgets to
 * clean up or a run is aborted mid-test (teardown still runs on normal exit
 * and on vitest's SIGINT path). Workers inherit the env set here.
 *
 * Set ARGUS_TEST_KEEP_TMP=1 to keep the root for post-mortem inspection.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup(): () => void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'argus-vitest-'))
  mkdirSync(join(root, 'tmp'))
  const dir = join(root, 'tmp')
  process.env.TMPDIR = dir
  process.env.TMP = dir
  process.env.TEMP = dir
  process.env.ARGUS_TEST_TMP_ROOT = root
  return () => {
    if (process.env.ARGUS_TEST_KEEP_TMP === '1') {
      console.warn(`[argus] keeping test tmp root: ${root}`)
      return
    }
    rmSync(root, { recursive: true, force: true })
  }
}
