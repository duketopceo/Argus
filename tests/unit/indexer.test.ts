import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { readIndex, scanRepo, writeIndex } from '../../src/index/scan.js'

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'argus-index-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"2.3.4"}')
  await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b'\nexport const a = b\n")
  await writeFile(join(root, 'src', 'b.ts'), "export const b = 1\n")
  await writeFile(join(root, 'README.md'), '# docs only\n')
  await writeFile(join(root, 'node_modules', 'junk', 'x.js'), 'ignored')
  return root
}

describe('scanRepo', () => {
  it('produces import edges and reverse edges', async () => {
    const index = await scanRepo(await fixtureRepo())
    const a = index.entries.find((e) => e.path === 'src/a.ts')
    const b = index.entries.find((e) => e.path === 'src/b.ts')
    expect(a?.imports).toEqual(['src/b.ts'])
    expect(b?.importedBy).toEqual(['src/a.ts'])
  })

  it('captures package version and content hash; excludes node_modules', async () => {
    const index = await scanRepo(await fixtureRepo())
    expect(index.entries.find((e) => e.path === 'src/a.ts')?.packageVersion).toBe('2.3.4')
    expect(index.entries.every((e) => e.contentHash.length === 16)).toBe(true)
    expect(index.entries.some((e) => e.path.includes('node_modules'))).toBe(false)
  })

  it('round-trips through writeIndex/readIndex', async () => {
    const root = await fixtureRepo()
    const index = await scanRepo(root)
    const out = join(root, 'argus.index.json')
    await writeIndex(index, out)
    const loaded = await readIndex(out)
    expect(loaded?.entries.length).toBe(index.entries.length)
  })

  it('readIndex returns undefined for missing or corrupt files', async () => {
    expect(await readIndex('/nonexistent/argus.index.json')).toBeUndefined()
    const dir = await mkdtemp(join(tmpdir(), 'argus-index-'))
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{not json')
    expect(await readIndex(bad)).toBeUndefined()
  })
})
