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
    const html = readFileSync(join(process.cwd(), 'electron/ui/index.html'), 'utf8')
    expect(html).toContain('<title>Argus</title>')
  })
})

describe('run-eval IPC guard (PR #111, kept by U13)', async () => {
  // @ts-expect-error plain-node electron helper — no type declarations
  const { evalRefusal } = await import('../../electron/app-meta.mjs')
  const env = { OPENROUTER_API_KEY: 'k' }

  it('refuses unless the renderer passed { confirmed: true }', () => {
    for (const opts of [undefined, null, {}, { confirmed: 'true' }, { confirmed: 1 }]) {
      expect(evalRefusal(opts, { running: false, env })).toMatch(/needs to be confirmed/)
    }
    expect(evalRefusal({ confirmed: true }, { running: false, env })).toBeUndefined()
  })

  it('refuses a second eval and a missing key', () => {
    expect(evalRefusal({ confirmed: true }, { running: true, env })).toMatch(/already running/)
    expect(evalRefusal({ confirmed: true }, { running: false, env: {} })).toMatch(/OPENROUTER_API_KEY is not set/)
  })
})

describe('desk window background', async () => {
  // @ts-expect-error plain-node electron helper — no type declarations
  const { canvasColor } = await import('../../electron/app-meta.mjs')
  it('paints the canvas token for each theme before first frame', () => {
    expect(canvasColor(false)).toBe('#F4F5F7')
    expect(canvasColor(true)).toBe('#0C0E12')
  })
})
