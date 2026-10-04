import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { expect, it } from 'vitest'
import { useTmpDir } from '../helpers/tmp.js'

const mk = useTmpDir('argus-tmpiso')

it('routes os.tmpdir() into the per-run root removed at teardown', () => {
  const root = process.env.ARGUS_TEST_TMP_ROOT
  expect(root).toBeDefined()
  expect(basename(root as string)).toMatch(/^argus-vitest-/)
  expect(dirname(tmpdir())).toBe(root)
})

it('useTmpDir creates dirs under the per-run tmp', async () => {
  const dir = await mk()
  expect(existsSync(dir)).toBe(true)
  expect(dirname(dir)).toBe(tmpdir())
})
