import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BRAND_DIR, deskFile, UI_DIR } from '../../electron/desk-files.mjs'

// The desk protocol serves local files: every path must stay inside its root
// (plan KTD9; SECURITY.md fail closed on path errors).
describe('deskFile', () => {
  const reportDir = '/work/argus-reviewer-report'

  it('maps the front end, brand assets and report images', () => {
    expect(deskFile('/')).toBe(join(UI_DIR, 'index.html'))
    expect(deskFile('/app.js')).toBe(join(UI_DIR, 'app.js'))
    expect(deskFile('/brand/tokens.css')).toBe(join(BRAND_DIR, 'tokens.css'))
    expect(deskFile('/brand/export/glyphs.svg')).toBe(join(BRAND_DIR, 'export/glyphs.svg'))
    expect(deskFile('/report/flow/before.png', { reportDir })).toBe('/work/argus-reviewer-report/flow/before.png')
  })

  it('refuses traversal out of every root, plain or encoded', () => {
    expect(deskFile('/../main.mjs')).toBeUndefined()
    expect(deskFile('/%2e%2e/main.mjs')).toBeUndefined()
    expect(deskFile('/brand/../../package.json')).toBeUndefined()
    expect(deskFile('/brand/%2e%2e%2f%2e%2e%2fpackage.json')).toBeUndefined()
    expect(deskFile('/report/../config.png', { reportDir })).toBeUndefined()
    expect(deskFile('/report/%2e%2e/%2e%2e/home/x.png', { reportDir })).toBeUndefined()
    expect(deskFile('/%E0%A4%A')).toBeUndefined()
    expect(deskFile('/a%00.js')).toBeUndefined()
  })

  it('serves only images from the report dir, and nothing without one', () => {
    expect(deskFile('/report/run-manifest.json', { reportDir })).toBeUndefined()
    expect(deskFile('/report/flow/before.png')).toBeUndefined()
  })

  it('refuses types the desk never loads', () => {
    expect(deskFile('/brand/fonts/LICENSE-DejaVu.txt')).toBeUndefined()
    expect(deskFile('/preload.mjs')).toBeUndefined()
  })
})
