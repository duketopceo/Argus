import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error plain-node electron helper — no type declarations
import { APP_TITLE, appVersion } from '../../electron/app-meta.mjs'

describe('electron app metadata (U3)', () => {
  it('reports the package.json version, not a hard-coded one', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    expect(appVersion()).toBe(pkg.version)
  })

  it('titles the window and page "Argus"', () => {
    expect(APP_TITLE).toBe('Argus')
    const html = readFileSync(join(process.cwd(), 'electron/index.html'), 'utf8')
    expect(html).toContain('<title>Argus</title>')
  })
})
